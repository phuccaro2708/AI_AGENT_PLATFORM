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
//!
//! **This is NOT a security sandbox.** A Job Object only (a) kills the process tree when its last
//! handle closes and (b) optionally caps the memory the whole job may commit. It does not restrict
//! files, network, registry or the user token; a process in the job can still read and write
//! anything the user can. Do not describe it as isolation (ADR-002).
//!
//! The same type serves two callers: the app puts the sidecar in one job, and the small
//! `agent-job-wrap` binary puts each task's CLI in its own job.

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
        QueryInformationJobObject, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    pub struct JobObject(HANDLE);

    // The handle is an opaque kernel object handle; it is safe to move/share between threads.
    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}

    impl JobObject {
        pub fn new_kill_on_close() -> io::Result<Self> {
            Self::with_memory_limit(None)
        }

        /// Kill-on-close job, optionally capping the memory each process in the job may commit
        /// (`JOB_OBJECT_LIMIT_PROCESS_MEMORY`, per process, NOT the sum over the tree). For a cap on
        /// the whole tree use [`JobObject::with_limits`].
        pub fn with_memory_limit(limit_bytes: Option<u64>) -> io::Result<Self> {
            Self::with_limits(limit_bytes, None)
        }

        /// Kill-on-close job with a per-process commit cap (`JOB_OBJECT_LIMIT_PROCESS_MEMORY`)
        /// and/or a job-wide cap on the SUM of committed memory of the whole tree
        /// (`JOB_OBJECT_LIMIT_JOB_MEMORY` + `JobMemoryLimit`). Past either cap the allocation that
        /// would exceed it FAILS; Windows does not kill the process. R4 measurement: the job-wide
        /// limit works as long as `JobMemoryLimit` is filled in next to the flag (docs/ASSUMPTIONS.md).
        pub fn with_limits(process_bytes: Option<u64>, job_bytes: Option<u64>) -> io::Result<Self> {
            let limit_bytes = process_bytes;
            // SAFETY: null attributes/name are valid; the returned handle is owned by `JobObject`.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = JobObject(handle);
            // SAFETY: zeroed is a valid bit pattern for this plain-data struct.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Some(bytes) = limit_bytes {
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                info.ProcessMemoryLimit = usize::try_from(bytes).unwrap_or(usize::MAX);
            }
            if let Some(bytes) = job_bytes {
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
                info.JobMemoryLimit = usize::try_from(bytes).unwrap_or(usize::MAX);
            }
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

        /// Highest committed memory (bytes) of all processes in the job so far, as reported by
        /// Windows (`PeakJobMemoryUsed`). Committed, not resident. Measured: it reads 0 under a
        /// per-process limit; under a job-wide limit it also counts the attempt that was refused
        /// (602 MB for a refused 600 MB request), so use it on uncapped jobs.
        pub fn peak_job_memory(&self) -> io::Result<u64> {
            // SAFETY: zeroed is valid for this plain-data struct; the size matches; the return
            // length pointer may be null.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            let ok = unsafe {
                QueryInformationJobObject(
                    self.0,
                    JobObjectExtendedLimitInformation,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(info.PeakJobMemoryUsed as u64)
            }
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
        pub fn with_memory_limit(_limit_bytes: Option<u64>) -> io::Result<Self> {
            Ok(JobObject)
        }
        pub fn with_limits(_process: Option<u64>, _job: Option<u64>) -> io::Result<Self> {
            Ok(JobObject)
        }
        pub fn peak_job_memory(&self) -> io::Result<u64> {
            Err(io::Error::other("job objects exist only on Windows"))
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
                60
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
            wait_for(|| child.try_wait().ok().flatten().is_some(), 30),
            "child still running"
        );
        assert!(
            wait_for(|| !pid_alive(grandchild), 30),
            "grandchild still running"
        );
    }

    /// Test-helper "test": does nothing normally. When `AGENT_STUDIO_ALLOC_MB` is set (by the
    /// real test below, in a child process) it commits and touches that much memory and prints
    /// `ALLOC_OK` or `ALLOC_FAIL`. Plain Rust allocation, so no runtime second-guesses the limit.
    #[test]
    fn alloc_helper() {
        let Some(mb) = std::env::var("AGENT_STUDIO_ALLOC_MB")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
        else {
            return;
        };
        let mut v: Vec<u8> = Vec::new();
        if v.try_reserve_exact(mb * 1024 * 1024).is_err() {
            println!("ALLOC_FAIL");
            return;
        }
        v.resize(mb * 1024 * 1024, 1); // touch every page
        println!("ALLOC_OK {}", v[v.len() - 1]);
    }

    /// Runs the helper in a job with `limit`; returns (stdout, peak job memory).
    fn run_alloc_in_job(limit: Option<u64>, mb: u64) -> (String, u64) {
        let job = JobObject::with_memory_limit(limit).expect("create job");
        let child = job
            .spawn(
                Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "job::tests::alloc_helper", "--nocapture"])
                    .env("AGENT_STUDIO_ALLOC_MB", mb.to_string())
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null()),
                0,
            )
            .expect("spawn helper in job");
        let out = child.wait_with_output().expect("wait");
        let peak = job.peak_job_memory().expect("peak");
        (String::from_utf8_lossy(&out.stdout).to_string(), peak)
    }

    /// Real measurement (P4-4): Windows-reported peak with no cap, and the cap changing the outcome.
    #[test]
    fn memory_limit_caps_what_a_process_can_commit() {
        const MB: u64 = 1024 * 1024;
        let (out, free_peak) = run_alloc_in_job(None, 600);
        assert!(out.contains("ALLOC_OK"), "control run failed: {out}");
        assert!(
            free_peak >= 600 * MB,
            "uncapped peak only {} MB",
            free_peak / MB
        );
        eprintln!(
            "uncapped job memory peak for a 600 MB allocation: {} MB",
            free_peak / MB
        );

        // Cap above the need: still works, so the cap below is what makes the difference.
        let (out, _) = run_alloc_in_job(Some(1000 * MB), 600);
        assert!(
            out.contains("ALLOC_OK"),
            "1000 MB cap blocked a 600 MB allocation: {out}"
        );

        let (out, _) = run_alloc_in_job(Some(300 * MB), 600);
        assert!(
            !out.contains("ALLOC_OK"),
            "allocation survived the 300 MB cap: {out}"
        );
    }

    /// R4: the job-wide cap is a real cap (control: a roomy job-wide cap lets the same request pass).
    #[test]
    fn job_wide_limit_caps_what_a_process_can_commit() {
        const MB: u64 = 1024 * 1024;
        let run = |job_limit: u64| {
            let job = JobObject::with_limits(None, Some(job_limit)).expect("create job");
            let child = job
                .spawn(
                    Command::new(std::env::current_exe().unwrap())
                        .args(["--exact", "job::tests::alloc_helper", "--nocapture"])
                        .env("AGENT_STUDIO_ALLOC_MB", "600")
                        .stdin(Stdio::null())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::null()),
                    0,
                )
                .expect("spawn helper in job");
            let out = child.wait_with_output().expect("wait");
            String::from_utf8_lossy(&out.stdout).to_string()
        };
        assert!(run(1000 * MB).contains("ALLOC_OK"), "roomy cap blocked");
        assert!(
            !run(300 * MB).contains("ALLOC_OK"),
            "allocation survived the 300 MB job-wide cap"
        );
    }
}
