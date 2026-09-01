#!/usr/bin/env bash
#
# Encrypt/decrypt the fairness-log bundle (data/) so the dashboard can be
# published without ever committing real reviewer names in the clear.
#
#   ./scripts/log-crypt.sh encrypt   # data/  -> data.enc   (run locally, then commit data.enc)
#   ./scripts/log-crypt.sh decrypt   # data.enc -> data/    (run in CI before generating)
#
# Symmetric AES-256 via openssl (preinstalled on macOS + ubuntu-latest). The
# passphrase comes from $SIARA_LOG_KEY — locally an out-of-band shared secret,
# in CI the repo secret of the same name. plaintext data/ stays gitignored;
# only the encrypted data.enc is committed.
set -euo pipefail

mode="${1:-}"

# When invoked from a non-interactive shell, load the exported key from the
# user's zsh environment if it was not already passed to this process.
if [ -z "${SIARA_LOG_KEY:-}" ] && command -v zsh >/dev/null 2>&1; then
  SIARA_LOG_KEY="$(zsh -ic 'printf %s "${SIARA_LOG_KEY:-}" >&3' 3>&1 >/dev/null 2>/dev/null)"
  export SIARA_LOG_KEY
fi

: "${SIARA_LOG_KEY:?Set SIARA_LOG_KEY (out-of-band shared secret; same value as the CI secret)}"

BUNDLE="data.enc"
DIR="data"
TAR="data.tar"

# Never leave the plaintext tar behind — even on a failed/partial openssl run.
trap 'rm -f "$TAR"' EXIT

case "$mode" in
  encrypt)
    if [ ! -d "$DIR" ] || [ -z "$(ls -A "$DIR" 2>/dev/null)" ]; then
      echo "error: $DIR/ is empty — run 'siara daily' or 'siara shadow' first" >&2
      exit 1
    fi
    tar -cf "$TAR" -C "$DIR" .
    openssl enc -aes-256-cbc -pbkdf2 -salt -in "$TAR" -out "$BUNDLE" -pass env:SIARA_LOG_KEY
    rm -f "$TAR"
    echo "Wrote $BUNDLE — commit it to publish the dashboard."
    ;;
  decrypt)
    if [ ! -f "$BUNDLE" ]; then
      echo "error: $BUNDLE not found — nothing to decrypt" >&2
      exit 1
    fi
    openssl enc -d -aes-256-cbc -pbkdf2 -in "$BUNDLE" -out "$TAR" -pass env:SIARA_LOG_KEY
    mkdir -p "$DIR"
    tar -xf "$TAR" -C "$DIR"
    rm -f "$TAR"
    echo "Restored $DIR/ from $BUNDLE."
    ;;
  *)
    echo "usage: $0 {encrypt|decrypt}" >&2
    exit 2
    ;;
esac
