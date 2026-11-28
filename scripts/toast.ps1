param(
  [string]$AppId = 'Fanrongbo.DSH.WindowFocus',
  [string]$Title = 'DeepSeek Harness',
  [string]$Body = '',
  [Parameter(Mandatory = $true)][string]$AllowUri,
  [Parameter(Mandatory = $true)][string]$RejectUri,
  [Parameter(Mandatory = $true)][string]$OpenUri,
  [string]$AllowLabel = 'Allow once',
  [string]$RejectLabel = 'Reject',
  [string]$Tag = '',
  [string]$Level = '1',
  [string]$IconPath = '',
  [switch]$DryRun,
  [switch]$EmitXml
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

$imageXml = ''
if ($IconPath -and (Test-Path -LiteralPath $IconPath)) {
  $iconUri = ([System.Uri](Resolve-Path -LiteralPath $IconPath).Path).AbsoluteUri
  $imageXml = '      <image placement="appLogoOverride" hint-crop="circle" src="' + (& $esc $iconUri) + '" />'
}

$xmlString = @"
<toast activationType="protocol" launch="$(& $esc $OpenUri)" duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>$(& $esc $Title)</text>
      <text>$(& $esc $Body)</text>
$imageXml
    </binding>
  </visual>
  <actions>
    <action content="$(& $esc $AllowLabel)" arguments="$(& $esc $AllowUri)" activationType="protocol" />
    <action content="$(& $esc $RejectLabel)" arguments="$(& $esc $RejectUri)" activationType="protocol" />
  </actions>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlString)
if ($DryRun) {
  if ($EmitXml) { Write-Output $xmlString } else { Write-Output 'ok' }
  return
}
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
if ($Tag) { $toast.Tag = $Tag }
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
$notifier.Show($toast)
