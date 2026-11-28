param(
  [string]$AppId = 'Fanrongbo.DSH.WindowFocus',
  [string]$Tag = '',
  [switch]$NoClear
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'dsh-window-focus-close.log'

function Write-Log([string]$message) {
  try {
    Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $message) -Encoding UTF8
  } catch {
    # logging is best effort only
  }
}

if (-not $Tag) {
  Write-Log 'no tag given'
  exit 0
}

Write-Log "remove tag=$Tag app=$AppId"

try {
  # WinRT notification history is scoped to the calling process app id. Without
  # this the Remove/GetHistory calls look under the default identity and report
  # 0x80070490 (element not found) even though the toast is on screen.
  if (-not ('Native.Shell' -as [type])) {
    Add-Type -Namespace Native -Name Shell -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
public static extern void SetCurrentProcessExplicitAppUserModelID(string appId);
'@
  }
  [Native.Shell]::SetCurrentProcessExplicitAppUserModelID($AppId)

  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $history = [Windows.UI.Notifications.ToastNotificationManager]::History
  try {
    # Each toast is shown without a group, so the single-argument overload is
    # the one that matches by tag. Passing the app id as the group (the old
    # code) never matched and left the toast on screen.
    $history.Remove($Tag)
    Write-Log 'removed by tag'
  } catch {
    Write-Log ("tag remove failed: " + $_.Exception.Message)
    try {
      foreach ($item in $history.GetHistory($AppId)) {
        Write-Log ("history item tag=[{0}] group=[{1}] id={2}" -f $item.Tag, $item.Group, $item.Id)
      }
    } catch {
      Write-Log ("history dump failed: " + $_.Exception.Message)
    }
  }

  Start-Sleep -Milliseconds 120
  $left = @($history.GetHistory($AppId))
  Write-Log ("after remove count={0}" -f $left.Count)
  if ($NoClear) {
    # Question toasts are closed lazily: clearing the whole group here could
    # wipe approval toasts that the user has not answered yet.
    Write-Log 'no-clear requested, keeping remaining notifications'
    exit 0
  }
  if ($left.Count -gt 0) {
    # Tag matching can miss (protocol-activated toasts are not always indexed by
    # tag); clearing the app's group is the fallback. The Host promotes any
    # other pending request to its in-app card when this happens.
    $history.Clear($AppId)
    Start-Sleep -Milliseconds 120
    $left2 = @($history.GetHistory($AppId))
    Write-Log ("after clear count={0}" -f $left2.Count)
  }
  exit 0
} catch {
  Write-Log ("error: " + $_.Exception.Message)
  exit 1
}
