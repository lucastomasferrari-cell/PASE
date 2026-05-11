#!/usr/bin/env bash
# PostToolUse hook: typecheck del paquete tocado cuando se edita o escribe
# un .ts/.tsx en packages/pase/src o packages/comanda/src.
#
# Lee el JSON del hook por stdin, normaliza el path Windows→POSIX,
# routea al filtro pnpm correcto, y si typecheck falla devuelve un JSON
# con decision=block para que Claude vea el error y Lucas decida.
#
# Usa `node -e` para parsear/emitir JSON porque jq no está disponible en
# el Git Bash de Laragon. Node sí está en PATH.

set -u

input=$(cat)
file_path=$(printf '%s' "$input" | node -e 'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{try{const o=JSON.parse(d); process.stdout.write(o?.tool_input?.file_path||"")}catch{}})')
[ -z "$file_path" ] && exit 0

# Windows: paths llegan con backslashes — normalizar a forward slash.
norm=$(printf '%s' "$file_path" | tr '\\' '/')

case "$norm" in
  *packages/pase/src/*.ts|*packages/pase/src/*.tsx)
    pkg=pase ;;
  *packages/comanda/src/*.ts|*packages/comanda/src/*.tsx)
    pkg=comanda ;;
  *)
    exit 0 ;;
esac

# Capturar stdout+stderr. Typecheck es rápido (~3-5s) y silencioso si pasa.
if out=$(pnpm --filter "$pkg" typecheck 2>&1); then
  exit 0
fi

# Truncar a las últimas 60 líneas — suficiente para ver errores TS sin
# inundar el contexto del modelo.
trimmed=$(printf '%s' "$out" | tail -60)

# Emitir JSON con decision=block. node -e construye el JSON con escapes
# correctos para newlines/comillas en el output.
PKG="$pkg" OUT="$trimmed" node -e '
const reason = "Typecheck falló en packages/" + process.env.PKG + ":\n\n" + process.env.OUT;
process.stdout.write(JSON.stringify({decision:"block", reason}));
'
