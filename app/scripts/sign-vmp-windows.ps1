param([string]$Target)
$ErrorActionPreference = 'Stop'

$spikeRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$python = Join-Path $spikeRoot '.evs-venv\Scripts\python.exe'
# Sem -Target assina o ECS de desenvolvimento em node_modules; no empacotamento passe a pasta dist-win\DalariCine.
$dist = if ($Target) { (Resolve-Path -LiteralPath $Target).Path } else { Join-Path $spikeRoot 'node_modules\electron\dist' }
$executable = if ($Target) { Join-Path $dist 'DalariCine.exe' } else { Join-Path $dist 'electron.exe' }

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  throw 'Cliente EVS ausente. Crie .evs-venv e instale castlabs-evs antes de assinar.'
}
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw 'Executável ECS ausente. Execute npm run install:runtime antes de assinar.'
}

$running = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($executable, [StringComparison]::OrdinalIgnoreCase) }
if ($running) {
  throw 'Feche a janela experimental do Dalari Cine antes de assinar o executável.'
}

Write-Host 'Assinando o ECS para streaming com EVS. O cliente poderá pedir as credenciais da sua conta EVS neste terminal.'
& $python -m castlabs_evs.vmp --no-ask sign-pkg $dist
if ($LASTEXITCODE -ne 0) { throw "A assinatura VMP falhou (código $LASTEXITCODE)." }

& $python -m castlabs_evs.vmp --no-ask verify-pkg $dist
if ($LASTEXITCODE -ne 0) { throw "A verificação VMP falhou (código $LASTEXITCODE)." }

Write-Host 'Assinatura VMP verificada. Abra novamente o Dalari Cine experimental e teste a reprodução.'
