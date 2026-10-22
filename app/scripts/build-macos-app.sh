#!/bin/sh
# Monta dist-macos/Dalari Cine.app a partir do ECS Castlabs instalado neste Mac. Só roda em macOS.
# Não assina (VMP/Apple), não baixa nada além do que `npm run install:runtime` já instalou.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PREVIEW="${DUOTELA_WEB_DIR:-$ROOT/../web}"
SRC_APP="$ROOT/node_modules/electron/dist/Electron.app"
OUT_DIR="$ROOT/dist-macos"
APP="$OUT_DIR/Dalari Cine.app"
PLIST="$APP/Contents/Info.plist"
BIN="$APP/Contents/MacOS/Electron"

[ "$(uname -s)" = "Darwin" ] || { echo "Este script só roda em macOS (uname: $(uname -s))." >&2; exit 1; }
[ -d "$SRC_APP" ] || { echo "ECS ausente em $SRC_APP. Execute: npm ci --cache .npm-cache && npm run install:runtime" >&2; exit 1; }
[ -f "$PREVIEW/index.html" ] && [ -f "$PREVIEW/server/index.js" ] || { echo "Interface Dalari Cine ausente em $PREVIEW (pasta web/ ao lado de app/)." >&2; exit 1; }

HOST_ARCH=$(uname -m)
BIN_ARCHS=$(lipo -archs "$SRC_APP/Contents/MacOS/Electron")
case " $BIN_ARCHS " in
  *" $HOST_ARCH "*) ;;
  *) echo "O ECS instalado ($BIN_ARCHS) não corresponde a este Mac ($HOST_ARCH). Apague node_modules e reinstale neste Mac." >&2; exit 1 ;;
esac

rm -rf "$APP"
mkdir -p "$OUT_DIR"
# ditto preserva symlinks e metadados dos frameworks.
ditto "$SRC_APP" "$APP"

# Somente o código do app: nunca perfil, cache, node_modules, .evs-venv nem dados pessoais.
RES="$APP/Contents/Resources/app"
mkdir -p "$RES"
cp "$ROOT/main.cjs" "$ROOT/package.json" "$ROOT/update-config.json" "$RES/"
ditto "$ROOT/src" "$RES/src"
ditto "$ROOT/assets" "$RES/assets"
mkdir -p "$RES/preview"
cp "$PREVIEW/index.html" "$RES/preview/"
for section in assets data server src; do ditto "$PREVIEW/$section" "$RES/preview/$section"; done
[ -f "$PREVIEW/stats-config.json" ] && cp "$PREVIEW/stats-config.json" "$RES/preview/"
# O serviço entrega extension-bridge/src/bridge-protocol.js, exigido por server/netflix-bridge.js.
# Carimba a versão (variável VERSION, definida no GitHub Actions) em stats-config.json
if [ -n "${VERSION:-}" ] && [ -f "$RES/preview/stats-config.json" ]; then
  node -e 'const fs=require("fs");const [f,v]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(f,"utf8"));c.version=v;fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$RES/preview/stats-config.json" "$VERSION"
fi
# Versão da tag no package.json (é o que o app compara nas atualizações) e repositório das Releases (GITHUB_REPOSITORY)
node "$ROOT/scripts/stamp-build.cjs" "$RES"
mkdir -p "$RES/preview/extension-bridge"
ditto "$PREVIEW/extension-bridge/src" "$RES/preview/extension-bridge/src"

/usr/libexec/PlistBuddy -c "Set :CFBundleName Dalari Cine" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Dalari Cine" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier br.dalari.cine" "$PLIST"
# Convite com um toque: o Mac abre o Dalari Cine para links dalari://entrar/XXXX-XXXX
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string br.dalari.cine" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string dalari" "$PLIST"
# Ícone do Dalari Cine no Dock e no Finder (gerado por scripts/make-icons.cjs)
cp "$ROOT/assets/icon.icns" "$APP/Contents/Resources/DalariCine.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile DalariCine.icns" "$PLIST"

echo "Arquitetura do host: $HOST_ARCH | binário: $(lipo -archs "$BIN")"
echo "Bundle montado SEM assinatura em: $APP"
echo "Próximo passo: ./scripts/sign-macos-app.sh"
