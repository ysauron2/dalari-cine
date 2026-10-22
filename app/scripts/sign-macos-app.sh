#!/bin/sh
# Assina dist-macos/Dalari Cine.app: (1) VMP/EVS de produção da Castlabs, (2) assinatura ad hoc local do macOS
# (sem Apple Developer Program, sem notarização). A ordem importa: VMP primeiro, codesign depois,
# e qualquer alteração posterior no bundle exige refazer ambos.
# DUOTELA_SKIP_VMP=1 pula a etapa VMP (build sem conta EVS: YouTube funciona, Netflix mostra E100).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/dist-macos/Dalari Cine.app"
PY="$ROOT/.evs-venv/bin/python"
# A Castlabs documenta o argumento do VMP como a pasta que CONTÉM o .app (não o .app em si).
PKG_DIR=$(dirname "$APP")

[ "$(uname -s)" = "Darwin" ] || { echo "Este script só roda em macOS." >&2; exit 1; }
[ -d "$APP" ] || { echo "Bundle ausente. Execute ./scripts/build-macos-app.sh antes." >&2; exit 1; }

if [ "${DUOTELA_SKIP_VMP:-}" = "1" ]; then
  echo "AVISO: assinatura VMP pulada (DUOTELA_SKIP_VMP=1). A Netflix não vai reproduzir neste pacote."
else
  [ -x "$PY" ] || { echo "Cliente EVS ausente. Crie com: python3 -m venv .evs-venv && .evs-venv/bin/pip install castlabs-evs" >&2; exit 1; }
  echo "Assinando VMP (EVS). O cliente pode pedir suas credenciais EVS neste terminal (ou use EVS_ACCOUNT_NAME/EVS_PASSWD/EVS_NO_ASK)."
  "$PY" -m castlabs_evs.vmp sign-pkg "$PKG_DIR"
  "$PY" -m castlabs_evs.vmp verify-pkg "$PKG_DIR"
fi

echo "Assinatura ad hoc do macOS (não é assinatura Apple Developer)."
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
if [ "${DUOTELA_SKIP_VMP:-}" != "1" ]; then "$PY" -m castlabs_evs.vmp verify-pkg "$PKG_DIR"; fi

echo "Pronto: $APP"
echo "Primeira abertura: Finder > botão direito em Dalari Cine.app > Abrir (ou Ajustes do Sistema > Privacidade e Segurança > Abrir Mesmo Assim)."
