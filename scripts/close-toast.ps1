param(
  [string]$AppId = 'Fanrongbo.DSH.NotifyActions',
  [string]$Tag = ''
)

$ErrorActionPreference = 'SilentlyContinue'

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null

if (-not $Tag) { exit 0 }

$history = [Windows.UI.Notifications.ToastNotificationManager]::History
$history.Remove($Tag, $AppId)
