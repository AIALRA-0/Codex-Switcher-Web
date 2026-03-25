#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ID="${CODE_SERVER_OPENAI_EXTENSION_ID:-openai.chatgpt}"
EXTENSIONS_DIR="${HOME}/.local/share/code-server/extensions"

mkdir -p "${EXTENSIONS_DIR}"

if ! code-server --list-extensions 2>/dev/null | grep -qx "${EXTENSION_ID}"; then
  echo "Installing code-server extension: ${EXTENSION_ID}"
  if ! code-server --install-extension "${EXTENSION_ID}" --force; then
    echo "Warning: failed to install ${EXTENSION_ID}; continuing without auto-installed extension" >&2
  fi
fi

exec code-server --bind-addr "0.0.0.0:8080" --auth "password" /workspace
