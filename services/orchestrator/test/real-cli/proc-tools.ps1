# Test helper for the opt-in real-CLI checks (Windows only). Usage:
#   pwsh -File proc-tools.ps1 list <substring>     -> JSON [{pid,ppid,name,cmd}] of processes whose command line contains <substring>
#   pwsh -File proc-tools.ps1 suspend <pid>        -> suspends every thread of the process (NtSuspendProcess)
#   pwsh -File proc-tools.ps1 resume <pid>
#   pwsh -File proc-tools.ps1 tree <pid>           -> JSON [{pid,ppid,name,created}] of all descendants of <pid>
#   pwsh -File proc-tools.ps1 alive <pid:created,..> -> JSON of the listed processes that are still alive (pid AND creation time match)
#   pwsh -File proc-tools.ps1 launch <exe> <script> <arg> -> re-enables Ctrl+C for this console (a parent may have disabled it; children inherit that), then runs <exe> <script> <arg> and waits
#   pwsh -File proc-tools.ps1 ctrlc                -> sends CTRL_C to the console this helper is attached to (the caller must ignore it)
param([string]$Action, [string]$Arg, [string]$Arg2, [string]$Arg3)
$ErrorActionPreference = 'Stop'
if ($Action -eq 'list') {
  $me = $PID
  $rows = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Arg) -and $_.ProcessId -ne $me } |
    ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine.Substring(0, [Math]::Min(400, $_.CommandLine.Length)) } }
  ConvertTo-Json -InputObject @($rows) -Compress
  exit 0
}
if ($Action -eq 'tree') {
  $all = @(Get-CimInstance Win32_Process)
  $want = [System.Collections.Generic.HashSet[int]]::new(); [void]$want.Add([int]$Arg)
  do { $n = $want.Count; foreach ($p in $all) { if ($want.Contains([int]$p.ParentProcessId)) { [void]$want.Add([int]$p.ProcessId) } } } while ($want.Count -ne $n)
  $rows = $all | Where-Object { $want.Contains([int]$_.ProcessId) -and $_.ProcessId -ne [int]$Arg -and $_.ProcessId -ne $PID } |
    ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; created = $_.CreationDate.ToString('o') } }
  ConvertTo-Json -InputObject @($rows) -Compress
  exit 0
}
if ($Action -eq 'alive') {
  $all = @{}; foreach ($p in (Get-CimInstance Win32_Process)) { $all[[int]$p.ProcessId] = $p }
  $rows = foreach ($spec in ($Arg -split ',')) {
    if ($spec -eq '') { continue }
    $i = $spec.IndexOf(':'); $id = [int]$spec.Substring(0, $i); $created = $spec.Substring($i + 1)
    $p = $all[$id]
    if ($p -and $p.CreationDate.ToString('o') -eq $created) { [pscustomobject]@{ pid = $id; name = $p.Name } }
  }
  ConvertTo-Json -InputObject @($rows) -Compress
  exit 0
}
if ($Action -eq 'launch') {
  Add-Type -Namespace Native -Name K32b -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add);
'@
  [void][Native.K32b]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $false)
  & $Arg $Arg2 $Arg3
  exit 0
}
if ($Action -eq 'ctrlc') {
  Add-Type -Namespace Native -Name K32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint grp);
'@
  [void][Native.K32]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true)
  $ok = [Native.K32]::GenerateConsoleCtrlEvent(0, 0)
  Start-Sleep -Milliseconds 500
  Write-Output "sent=$ok"
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
