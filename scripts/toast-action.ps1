param(
  [string]$Uri = '',
  [string]$LogPath = (Join-Path $env:TEMP 'dsh-window-focus.log')
)

$ErrorActionPreference = 'SilentlyContinue'

# Only our own protocol may reach the HTTP callback: a stray handler invocation
# with an arbitrary URI must not become an outbound request.
if (-not $Uri -or -not $Uri.StartsWith('dsh-window-focus:')) { exit 0 }

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

# Never post credentials anywhere except the local Host route that produced the
# toast; the protocol can be invoked with a hand-written URI as well.
if (-not $id -or -not $token -or -not $endpoint) { exit 0 }
if ($token -notmatch '^[0-9a-fA-F]{32}$') { exit 0 }
if ($endpoint -notmatch '^http://(127\.0\.0\.1|localhost):\d+/dsh-window-focus/result$') { exit 0 }

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
