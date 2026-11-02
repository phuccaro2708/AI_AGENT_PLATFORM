//! ADR-004: Windows Job Object that kills the sidecar's whole process tree when the app dies.
//!
//! The job has `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: when the last handle to the job is closed
//! (including when this process crashes or is killed), Windows terminates every process in it.
//! Descendants inherit job membership, so agent CLIs started later by the sidecar are covered too.
//!
//! Limits (see ADR-004): the child must be assigned right after spawn, before it starts children of
//! its own; this protects against *app* death, not per-task cancel (that is `killTree` in the Node
//! process manager); on non-Windows platforms this module is a no-op.

#[cfg(windows)]
mod imp {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

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

        pub fn assign(&self, child: &Child) -> io::Result<()> {
            // SAFETY: both handles are valid for the duration of the call.
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
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
    use std::process::Child;

    /// No-op stand-in so the code compiles on Linux/macOS dev machines.
    pub struct JobObject;

    impl JobObject {
        pub fn new_kill_on_close() -> io::Result<Self> {
            Ok(JobObject)
        }
        pub fn assign(&self, _child: &Child) -> io::Result<()> {
            Ok(())
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
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping", "-n", "120", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cmd");
        job.assign(&child).expect("assign to job");

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
