# Monta dist-win\DalariCine (pasta pronta para assinar com VMP e empacotar) a partir do ECS Castlabs instalado.
# Não assina, não instala nada: use antes `npm ci` e `npm run install:runtime`. Depois, sign-vmp-windows.ps1 -Target <pasta>.
param(
  [string]$Web = (Join-Path $PSScriptRoot '..\..\web'),
  [string]$Out = (Join-Path $PSScriptRoot '..\dist-win\DalariCine')
)
$ErrorActionPreference = 'Stop'

$appRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$dist = Join-Path $appRoot 'node_modules\electron\dist'
$Web = (Resolve-Path -LiteralPath $Web).Path

if (-not (Test-Path -LiteralPath (Join-Path $dist 'electron.exe') -PathType Leaf)) {
  throw 'ECS ausente. Execute: npm ci; npm run install:runtime'
}
foreach ($required in 'index.html', 'server\index.js', 'extension-bridge\src\bridge-protocol.js') {
  if (-not (Test-Path -LiteralPath (Join-Path $Web $required) -PathType Leaf)) { throw "Interface Dalari Cine incompleta em ${Web}: falta $required" }
}

$Out = [IO.Path]::GetFullPath($Out)
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Recurse -Force }
New-Item -ItemType Directory -Path $Out | Out-Null
Copy-Item -Path (Join-Path $dist '*') -Destination $Out -Recurse -Force

# O .sig antigo pertence ao electron.exe: a assinatura VMP precisa ser refeita para o executável renomeado.
Rename-Item -LiteralPath (Join-Path $Out 'electron.exe') -NewName 'DalariCine.exe'
Remove-Item -LiteralPath (Join-Path $Out 'electron.exe.sig') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $Out 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue

# Somente o código do app: nunca perfil, cache, node_modules, .evs-venv nem dados pessoais.
$res = Join-Path $Out 'resources\app'
New-Item -ItemType Directory -Path $res | Out-Null
Copy-Item -LiteralPath (Join-Path $appRoot 'main.cjs'), (Join-Path $appRoot 'package.json'), (Join-Path $appRoot 'update-config.json') -Destination $res
Copy-Item -LiteralPath (Join-Path $appRoot 'src') -Destination $res -Recurse
Copy-Item -LiteralPath (Join-Path $appRoot 'assets') -Destination $res -Recurse      # ícone da janela e dos atalhos
$preview = Join-Path $res 'preview'
New-Item -ItemType Directory -Path $preview | Out-Null
Copy-Item -LiteralPath (Join-Path $Web 'index.html') -Destination $preview
if (Test-Path -LiteralPath (Join-Path $Web 'stats-config.json')) { Copy-Item -LiteralPath (Join-Path $Web 'stats-config.json') -Destination $preview }
foreach ($section in 'assets', 'data', 'server', 'src') { Copy-Item -LiteralPath (Join-Path $Web $section) -Destination $preview -Recurse }
# Carimba a versão (variável VERSION, definida no GitHub Actions) em stats-config.json; sem BOM, para o Node ler.
$cfgPath = Join-Path $preview 'stats-config.json'
if ($env:VERSION -and (Test-Path -LiteralPath $cfgPath)) {
  $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
  $cfg.version = $env:VERSION
  [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
}
# Versão da tag no package.json (é o que o app compara nas atualizações) e repositório das Releases (GITHUB_REPOSITORY).
node (Join-Path $PSScriptRoot 'stamp-build.cjs') $res
if ($LASTEXITCODE -ne 0) { throw 'stamp-build falhou' }
New-Item -ItemType Directory -Path (Join-Path $preview 'extension-bridge') | Out-Null
Copy-Item -LiteralPath (Join-Path $Web 'extension-bridge\src') -Destination (Join-Path $preview 'extension-bridge') -Recurse

Write-Host "Pasta montada SEM assinatura VMP em: $Out"
Write-Host 'Próximo passo: .\scripts\sign-vmp-windows.ps1 -Target <essa pasta>  e depois o instalador (installer.nsi).'
