# Test helper for the opt-in real-CLI checks (Windows only). Usage:
#   pwsh -File proc-tools.ps1 list <substring>     -> JSON [{pid,ppid,name,cmd}] of processes whose command line contains <substring>
#   pwsh -File proc-tools.ps1 suspend <pid>        -> suspends every thread of the process (NtSuspendProcess)
#   pwsh -File proc-tools.ps1 resume <pid>
param([string]$Action, [string]$Arg)
$ErrorActionPreference = 'Stop'
if ($Action -eq 'list') {
  $me = $PID
  $rows = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Arg) -and $_.ProcessId -ne $me } |
    ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine.Substring(0, [Math]::Min(400, $_.CommandLine.Length)) } }
  ConvertTo-Json -InputObject @($rows) -Compress
  exit 0
}
Add-Type -Namespace Native -Name Nt -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr h);
'@
$p = [System.Diagnostics.Process]::GetProcessById([int]$Arg)
if ($Action -eq 'suspend') { $r = [Native.Nt]::NtSuspendProcess($p.Handle) } else { $r = [Native.Nt]::NtResumeProcess($p.Handle) }
Write-Output "status=$r"
exit ([int]($r -ne 0))
