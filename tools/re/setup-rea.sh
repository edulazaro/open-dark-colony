#!/usr/bin/env bash
# Prepara el entorno de ingeniería inversa en .re/ (no se versiona):
#   Node 22 portátil (REA lo exige), JDK 21, Ghidra 12.1.4 y rea-agents.
# Uso (Git Bash en Windows):  bash tools/re/setup-rea.sh
set -euo pipefail
RE_HOME="${RE_HOME:-.re}"
NODE_VER=v22.23.3
GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip
JDK_URL="https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse"

mkdir -p "$RE_HOME"/{dl,node22,jdk21,ghidra,rea,out}
cd "$RE_HOME"
[ -d node22/node-$NODE_VER-win-x64 ] || { curl -fSL -o dl/node22.zip https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip; (cd node22 && unzip -q ../dl/node22.zip); }
[ -n "$(ls jdk21)" ] || { curl -fSL -o dl/jdk21.zip "$JDK_URL"; (cd jdk21 && unzip -q ../dl/jdk21.zip); }
[ -n "$(ls ghidra)" ] || { curl -fSL -o dl/ghidra.zip "$GHIDRA_URL"; (cd ghidra && unzip -q ../dl/ghidra.zip); }
rm -f dl/*.zip
export PATH="$PWD/node22/node-$NODE_VER-win-x64:$PATH"
(cd rea && { [ -f package.json ] || npm init -y >/dev/null; } && npm install rea-agents@6.7.0)

export JAVA_HOME="$(cygpath -w "$PWD/jdk21/$(ls jdk21)")"
export GHIDRA_INSTALL_DIR="$(cygpath -w "$PWD/ghidra/$(ls ghidra)")"
export REA_ANALYSIS_PROVIDER=ghidra
(cd rea && npx rea doctor --json | head -c 2000)
echo
echo "Listo. Prueba: python tools/re/rea_client.py x:0x46e964"
