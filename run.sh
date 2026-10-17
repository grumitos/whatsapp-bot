#!/usr/bin/env bash
# Si el bot se detiene, se relanza a los 5 segundos
cd "$(dirname "$0")" || exit 1

while true; do
  if [ ! -d node_modules ]; then
    echo "Instalando dependencias..."
    PUPPETEER_SKIP_DOWNLOAD=true bun install --silent
  fi
  bun src/main.ts
  echo
  echo "Reiniciando en 5 segundos (Ctrl+C para salir)..."
  sleep 5
  echo
done
