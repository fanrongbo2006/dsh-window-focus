param(
  [string]$Uri = '',
  [string]$LogPath = (Join-Path $env:TEMP 'dsh-notify-actions.log')
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not $Uri) { exit 0 }

$rest = $Uri
$colon = $rest.IndexOf(':')
if ($colon -ge 0) { $rest = $rest.Substring($colon + 1) }
$rest = $rest.TrimStart('/')

$queryText = ''
$q = $rest.IndexOf('?')
if ($q -ge 0) {
  $queryText = $rest.Substring($q + 1)
  $rest = $rest.Substring(0, $q)
}
$action = $rest

$query = @{}
if ($queryText) {
  foreach ($pair in $queryText.Split('&')) {
    $kv = $pair.Split('=', 2)
    if ($kv.Count -eq 2) { $query[$kv[0]] = [Uri]::UnescapeDataString($kv[1]) }
  }
}

$id = $query['id']
$token = $query['token']
$endpoint = $query['endpoint']

try { Add-Content -Path $LogPath -Value ("[{0}] action={1} id={2}" -f (Get-Date -Format 'HH:mm:ss'), $action, $id) } catch { }

if ($id -and $token -and $endpoint) {
  $payload = @{ id = $id; token = $token; decision = $action } | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Method Post -Uri $endpoint -ContentType 'application/json' -Body $payload -TimeoutSec 5 | Out-Null
  } catch {
    Add-Content -Path $LogPath -Value ("[{0}] post failed: {1}" -f (Get-Date -Format 'HH:mm:ss'), $_.Exception.Message)
  }
}

exit 0
