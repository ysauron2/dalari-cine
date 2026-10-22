$ErrorActionPreference = 'Stop'
$secureToken = Read-Host 'Cole o TMDB API Read Access Token' -AsSecureString
$plainToken = [System.Net.NetworkCredential]::new('', $secureToken).Password
Remove-Variable secureToken
if ($plainToken -notmatch '^[A-Za-z0-9_.-]+$') {
    Remove-Variable plainToken
    throw 'Token inválido. Use o API Read Access Token, sem espaços ou quebras de linha.'
}
$env:TMDB_READ_ACCESS_TOKEN = $plainToken
Remove-Variable plainToken
$env:PORT = '8789'
node "$PSScriptRoot\server\index.js"
