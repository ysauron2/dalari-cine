#!/bin/sh
# Empacota dist-macos/Dalari Cine.app em um .dmg (arrastar para Aplicativos). Só roda em macOS.
# Uso: ./scripts/package-macos-dmg.sh [versão]
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/dist-macos/Dalari Cine.app"
VERSION="${1:-0.0.0}"

[ "$(uname -s)" = "Darwin" ] || { echo "Este script só roda em macOS." >&2; exit 1; }
[ -d "$APP" ] || { echo "Bundle ausente. Execute build-macos-app.sh e sign-macos-app.sh antes." >&2; exit 1; }

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Arquitetura não suportada: $(uname -m)" >&2; exit 1 ;;
esac

OUT="$ROOT/dist-macos/DalariCine-$VERSION-mac-$ARCH.dmg"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

ditto "$APP" "$STAGE/Dalari Cine.app"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/LEIA-ME.txt" <<'TXT'
Dalari Cine no Mac
1. Arraste Dalari Cine para Aplicativos.
2. Na primeira vez, o macOS avisa que o app não é de um desenvolvedor identificado.
   Abra Ajustes do Sistema > Privacidade e Segurança, role até o aviso do Dalari Cine e clique em
   "Abrir Mesmo Assim" (ou: botão direito no app > Abrir).
3. Na primeira abertura o app baixa o módulo de reprodução protegida (precisa de internet).
O aplicativo não é assinado pela Apple porque isso exige uma assinatura paga; o Dalari Cine não lê sua senha da Netflix.
TXT

rm -f "$OUT"
hdiutil create -volname "Dalari Cine" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
echo "Pronto: $OUT"
