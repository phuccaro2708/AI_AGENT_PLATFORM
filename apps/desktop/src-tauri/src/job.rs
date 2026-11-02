//! ADR-004: Windows Job Object that kills the sidecar's whole process tree when the app dies.
//!
//! The job has `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: when the last handle to the job is closed
//! (including when this process crashes or is killed), Windows terminates every process in it.
//! Descendants inherit job membership, so agent CLIs started later by the sidecar are covered too.
//!
//! The child is created suspended, assigned to the job, then resumed (`JobObject::spawn`), so it
//! cannot start a child of its own before it is in the job.
//!
//! Limits (see ADR-004): this protects against *app* death, not per-task cancel (that is `killTree` in the Node
//! process manager); on non-Windows platforms this module is a no-op.

#[cfg(windows)]
mod imp {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    pub struct JobObject(HANDLE);

    // The handle is an opaque kernel object handle; it is safe to move/share between threads.
    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}

    impl JobObject {
        pub fn new_kill_on_close() -> io::Result<Self> {
            // SAFETY: null attributes/name are valid; the returned handle is owned by `JobObject`.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = JobObject(handle);
            // SAFETY: zeroed is a valid bit pattern for this plain-data struct.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `info` outlives the call and the size matches the struct.
            let ok = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        /// Spawns `cmd` suspended (on top of `flags`), puts it in this job, then resumes it. On any
        /// failure the child is killed, so a process outside the job never runs.
        pub fn spawn(&self, cmd: &mut Command, flags: u32) -> io::Result<Child> {
            const CREATE_SUSPENDED: u32 = 0x0000_0004;
            cmd.creation_flags(flags | CREATE_SUSPENDED);
            let mut child = cmd.spawn()?;
            if let Err(e) = self.assign(&child).and_then(|()| resume(child.id())) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
            Ok(child)
        }

        fn assign(&self, child: &Child) -> io::Result<()> {
            // SAFETY: both handles are valid for the duration of the call.
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }

    /// Resumes the threads of a process created with CREATE_SUSPENDED (only its main thread exists).
    fn resume(pid: u32) -> io::Result<()> {
        // SAFETY: plain Win32 calls; every handle opened here is closed before returning.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snap == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut resumed = false;
            let mut more = Thread32First(snap, &mut entry) != 0;
            while more {
                if entry.th32OwnerProcessID == pid {
                    let th = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !th.is_null() {
                        resumed |= ResumeThread(th) != u32::MAX;
                        CloseHandle(th);
                    }
                }
                more = Thread32Next(snap, &mut entry) != 0;
            }
            CloseHandle(snap);
            if resumed {
                Ok(())
            } else {
                Err(io::Error::other("could not resume suspended process"))
            }
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            // SAFETY: we own the handle. Closing the last handle triggers KILL_ON_JOB_CLOSE.
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::io;
    use std::process::{Child, Command};

    /// No-op stand-in so the code compiles on Linux/macOS dev machines.
    pub struct JobObject;

    impl JobObject {
        pub fn new_kill_on_close() -> io::Result<Self> {
            Ok(JobObject)
        }
        pub fn spawn(&self, cmd: &mut Command, _flags: u32) -> io::Result<Child> {
            cmd.spawn()
        }
    }
}

pub use imp::JobObject;

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn powershell(script: &str) -> String {
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .expect("powershell");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn pid_alive(pid: u32) -> bool {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    fn wait_for(mut cond: impl FnMut() -> bool, secs: u64) -> bool {
        let end = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < end {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        cond()
    }

    /// Evidence for ADR-004: dropping the job (what happens when the app dies) kills the child
    /// AND its grandchild.
    #[test]
    fn closing_the_job_kills_child_and_grandchild() {
        let job = JobObject::new_kill_on_close().expect("create job");
        // cmd.exe starts ping.exe as its own child process (the grandchild).
        let mut child = job
            .spawn(
                Command::new("cmd.exe")
                    .args(["/C", "ping", "-n", "120", "127.0.0.1"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null()),
                0,
            )
            .expect("spawn cmd in job");

        let parent = child.id();
        let mut grandchild: Option<u32> = None;
        assert!(
            wait_for(
                || {
                    let s = powershell(&format!(
                        "(Get-CimInstance Win32_Process -Filter 'ParentProcessId={parent}' | Select-Object -First 1).ProcessId"
                    ));
                    grandchild = s.parse().ok();
                    grandchild.is_some()
                },
                20
            ),
            "grandchild ping.exe never appeared"
        );
        let grandchild = grandchild.unwrap();
        assert!(
            pid_alive(grandchild),
            "grandchild should be running before the job closes"
        );

        drop(job);

        assert!(
            wait_for(|| child.try_wait().ok().flatten().is_some(), 10),
            "child still running"
        );
        assert!(
            wait_for(|| !pid_alive(grandchild), 10),
            "grandchild still running"
        );
    }
}
