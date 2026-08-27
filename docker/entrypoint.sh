#!/usr/bin/env bash
set -euo pipefail

# Optional Clowder glue: map cdappconfig.json objectStore → Litestream env.
if [ -z "${ACG_CONFIG:-}" ] && [ -r /cdappconfig.json ]; then
  ACG_CONFIG=/cdappconfig.json
fi
if [ -n "${ACG_CONFIG:-}" ] && [ -r "${ACG_CONFIG}" ]; then
  # shellcheck disable=SC1090
  eval "$(node /opt/app-root/src/scripts/clowder-env.mjs "${ACG_CONFIG}")"
fi

: "${SIARA_DB:=/data/siara.db}"
: "${SIARA_CMD:=daily}"
: "${LITESTREAM_CONFIG:=/opt/app-root/src/litestream.yml}"

mkdir -p "$(dirname "${SIARA_DB}")"

if [ -n "${REPLICA_URL:-}" ]; then
  litestream restore -if-replica-exists -config "${LITESTREAM_CONFIG}" "${SIARA_DB}"
  exec litestream replicate -exec "siara ${SIARA_CMD}" -config "${LITESTREAM_CONFIG}"
else
  echo "[entrypoint] REPLICA_URL unset — running without Litestream (local/dev)" >&2
  exec siara "${SIARA_CMD}"
fi
