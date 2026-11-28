param(
  [string]$AppId = 'Fanrongbo.DSH.NotifyActions',
  [string]$Title = 'DeepSeek Harness',
  [string]$Body = '',
  [Parameter(Mandatory = $true)][string]$AllowUri,
  [Parameter(Mandatory = $true)][string]$RejectUri,
  [Parameter(Mandatory = $true)][string]$OpenUri,
  [string]$AllowLabel = 'Allow once',
  [string]$RejectLabel = 'Reject',
  [string]$Tag = '',
  [string]$Level = '1'
)

$ErrorActionPreference = 'Stop'

if (-not ('Native.Shell' -as [type])) {
  Add-Type -Namespace Native -Name Shell -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
public static extern void SetCurrentProcessExplicitAppUserModelID(string appId);
'@
}
[Native.Shell]::SetCurrentProcessExplicitAppUserModelID($AppId)

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$esc = { param($s) $s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;' }

$xmlString = @"
<toast activationType="protocol" launch="$(& $esc $OpenUri)" duration="long" useButtonStyle="true">
  <visual>
    <binding template="ToastGeneric">
      <text>$(& $esc $Title)</text>
      <text>$(& $esc $Body)</text>
      <text placement="attribution">DeepSeek Harness</text>
    </binding>
  </visual>
  <actions>
    <action content="$(& $esc $AllowLabel)" arguments="$(& $esc $AllowUri)" activationType="protocol" hint-buttonStyle="Success" />
    <action content="$(& $esc $RejectLabel)" arguments="$(& $esc $RejectUri)" activationType="protocol" />
  </actions>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlString)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
if ($Tag) { $toast.Tag = $Tag }
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
$notifier.Show($toast)
