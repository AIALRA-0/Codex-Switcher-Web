#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

prompt() {
  local __var_name="$1"
  local __label="$2"
  local __default="${3:-}"
  local __value=""
  if [[ -n "$__default" ]]; then
    read -r -p "$__label [$__default]: " __value
    __value="${__value:-$__default}"
  else
    read -r -p "$__label: " __value
  fi
  printf -v "$__var_name" '%s' "$__value"
}

prompt_secret() {
  local __var_name="$1"
  local __label="$2"
  local __value=""
  read -r -s -p "$__label: " __value
  echo
  printf -v "$__var_name" '%s' "$__value"
}

random_secret() {
  openssl rand -hex 32
}

derive_origin() {
  printf '%s' "$1" | sed -E 's#^(https?://[^/]+)/?.*$#\1#'
}

ensure_supported_os() {
  if [[ ! -f /etc/os-release ]]; then
    echo "Unsupported OS: /etc/os-release not found." >&2
    exit 1
  fi
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    echo "This installer currently supports Ubuntu 22.04 or 24.04." >&2
    exit 1
  fi
  case "${VERSION_ID:-}" in
    22.04|24.04) ;;
    *)
      echo "This installer currently supports Ubuntu 22.04 or 24.04." >&2
      exit 1
      ;;
  esac
}

render_nginx_template() {
  local template_path="$1"
  local output_path="$2"
  local app_domain="$3"
  local web_bind_port="$4"
  local code_domain="${5:-}"
  local code_bind_port="${6:-}"
  sed \
    -e "s#__APP_DOMAIN__#${app_domain}#g" \
    -e "s#__WEB_BIND_PORT__#${web_bind_port}#g" \
    -e "s#__CODE_DOMAIN__#${code_domain}#g" \
    -e "s#__CODE_SERVER_BIND_PORT__#${code_bind_port}#g" \
    "$template_path" > "$output_path"
}

write_env_file() {
  local env_path="$1"
  cat > "$env_path" <<EOF
APP_URL=${APP_URL}
HOST=0.0.0.0
PORT=29000
SESSION_COOKIE_DOMAIN=${APP_DOMAIN}
SESSION_SECURE=true
TRUST_PROXY=1
SESSION_SECRET=<generate-a-random-session-secret>
CODEX_PROFILE_ENCRYPTION_KEY=${CODEX_PROFILE_ENCRYPTION_KEY}
CODEX_AGENT_SHARED_SECRET=${CODEX_AGENT_SHARED_SECRET}
ADMIN_SEED_EMAIL=${ADMIN_SEED_EMAIL}
ADMIN_SEED_PASSWORD=<set-a-strong-admin-password>
CODEX_SWITCHER_DATA_DIR=/data
DB_PATH=/data/codex-switcher.db
AUDIT_LOG_PATH=/data/audit.log
CODEX_AGENT_SOCKET_PATH=/run/codex-switcher/agent.sock
CODEX_ACTIVE_HOME=/codex-home
CODEX_ACTIVE_AUTH_PATH=/codex-home/auth.json
CODEX_SHARED_AUTH_UID=1000
CODEX_SHARED_AUTH_GID=1000
CODEX_SHARED_AUTH_MODE=0640
CODEX_AGENT_BACKUP_DIR=/data/agent
CODEX_BOOTSTRAP_ROOT=/data/bootstrap
CODEX_BINARY=codex
CODE_ORIGIN=${CODE_ORIGIN}
CODE_WORKSPACE_URL=${CODE_WORKSPACE_URL}
DEFAULT_UI_LANGUAGE=${DEFAULT_UI_LANGUAGE}
AUTH_DEVICE_URL=https://auth.openai.com/codex/device
QUOTA_SAMPLE_INTERVAL_MS=30000
SWITCH_LOCK_MS=60000
SERVER_TIMEZONE=UTC
LOGIN_RATE_LIMIT_MAX=10
LOGIN_RATE_LIMIT_WINDOW_MS=900000
WRITE_RATE_LIMIT_MAX=120
WRITE_RATE_LIMIT_WINDOW_MS=900000
CODE_SERVER_PASSWORD=<set-a-strong-code-server-password>
WEB_BIND_PORT=${WEB_BIND_PORT}
CODE_SERVER_BIND_PORT=${CODE_SERVER_BIND_PORT}
EOF
}

ensure_env_key() {
  local env_path="$1"
  local key="$2"
  local value="$3"
  if ! grep -q "^${key}=" "$env_path"; then
    printf '%s=%s\n' "$key" "$value" >> "$env_path"
  fi
}

write_compose_file() {
  local compose_path="$1"
  cp "$REPO_ROOT/deploy/docker-compose.yml.template" "$compose_path"
}

install_nginx_site() {
  local source_conf="$1"
  local target_name="$2"
  local available="/etc/nginx/sites-available/${target_name}"
  local enabled="/etc/nginx/sites-enabled/${target_name}"
  if [[ -f "$available" ]]; then
    echo "Keeping existing nginx site: $available"
  else
    cp "$source_conf" "$available"
  fi
  ln -sfn "$available" "$enabled"
}

require_cmd docker
docker compose version >/dev/null
require_cmd rsync
require_cmd openssl
ensure_supported_os

echo "Codex Switcher Web installer"
echo

prompt INSTALL_ROOT "Install root" "/opt/codex-switcher-web"
prompt APP_DOMAIN "Codex Switcher domain" "codex-switcher.example.com"
prompt DEPLOY_MODE "Code Server mode (external/bundled)" "external"
prompt DEFAULT_UI_LANGUAGE "Default UI language (zh-CN/en)" "zh-CN"
prompt WEB_BIND_PORT "Codex Switcher bind port" "29000"
prompt ADMIN_SEED_EMAIL "Initial admin email" "admin@example.com"
prompt_secret ADMIN_SEED_PASSWORD "Initial admin password"

SESSION_SECRET=<generate-a-random-session-secret>
CODEX_PROFILE_ENCRYPTION_KEY="$(random_secret)"
CODEX_AGENT_SHARED_SECRET="$(random_secret)"
CODE_SERVER_BIND_PORT="17001"
APP_URL="https://${APP_DOMAIN}"

if [[ "${DEPLOY_MODE}" == "bundled" ]]; then
  prompt CODE_DOMAIN "Bundled code-server domain" "code.example.com"
  prompt CODE_SERVER_BIND_PORT "Bundled code-server bind port" "17001"
  prompt_secret CODE_SERVER_PASSWORD "Bundled code-server password"
  CODE_ORIGIN="https://${CODE_DOMAIN}"
  CODE_WORKSPACE_URL="${CODE_ORIGIN}/?folder=/workspace"
else
  prompt CODE_WORKSPACE_URL "Existing code-server workspace URL" "https://code.example.com/?folder=/workspace"
  CODE_ORIGIN="$(derive_origin "${CODE_WORKSPACE_URL}")"
  CODE_DOMAIN=""
  CODE_SERVER_PASSWORD=<set-a-strong-code-server-password>
fi

HTTPS_DEFAULT="yes"
if [[ "${APP_DOMAIN}" == *.example.com ]]; then
  HTTPS_DEFAULT="no"
fi
if [[ "${DEPLOY_MODE}" == "bundled" && "${CODE_DOMAIN}" == *.example.com ]]; then
  HTTPS_DEFAULT="no"
fi

if command -v certbot >/dev/null 2>&1 && [[ "${EUID}" -eq 0 ]]; then
  prompt ENABLE_HTTPS "Enable HTTPS with certbot (yes/no)" "${HTTPS_DEFAULT}"
else
  ENABLE_HTTPS="no"
fi

mkdir -p "${INSTALL_ROOT}/app" "${INSTALL_ROOT}/data" "${INSTALL_ROOT}/workspace" "${INSTALL_ROOT}/generated/nginx"

rsync -a \
  --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude 'workspace' \
  "${REPO_ROOT}/" "${INSTALL_ROOT}/app/"

if [[ ! -f "${INSTALL_ROOT}/.env" ]]; then
  write_env_file "${INSTALL_ROOT}/.env"
else
  echo "Keeping existing ${INSTALL_ROOT}/.env"
  ensure_env_key "${INSTALL_ROOT}/.env" "CODEX_SHARED_AUTH_UID" "1000"
  ensure_env_key "${INSTALL_ROOT}/.env" "CODEX_SHARED_AUTH_GID" "1000"
  ensure_env_key "${INSTALL_ROOT}/.env" "CODEX_SHARED_AUTH_MODE" "0640"
  ensure_env_key "${INSTALL_ROOT}/.env" "DEFAULT_UI_LANGUAGE" "${DEFAULT_UI_LANGUAGE}"
fi

write_compose_file "${INSTALL_ROOT}/docker-compose.yml"

render_nginx_template \
  "${REPO_ROOT}/deploy/nginx/codex-switcher.conf.template" \
  "${INSTALL_ROOT}/generated/nginx/codex-switcher.conf" \
  "${APP_DOMAIN}" \
  "${WEB_BIND_PORT}"

if [[ "${DEPLOY_MODE}" == "bundled" ]]; then
  render_nginx_template \
    "${REPO_ROOT}/deploy/nginx/code-server.conf.template" \
    "${INSTALL_ROOT}/generated/nginx/code-server.conf" \
    "${APP_DOMAIN}" \
    "${WEB_BIND_PORT}" \
    "${CODE_DOMAIN}" \
    "${CODE_SERVER_BIND_PORT}"
fi

if [[ -d /etc/nginx/sites-available ]] && [[ "${EUID}" -eq 0 ]]; then
  install_nginx_site "${INSTALL_ROOT}/generated/nginx/codex-switcher.conf" "${APP_DOMAIN}"
  if [[ "${DEPLOY_MODE}" == "bundled" ]]; then
    install_nginx_site "${INSTALL_ROOT}/generated/nginx/code-server.conf" "${CODE_DOMAIN}"
  fi
  nginx -t
  systemctl reload nginx

  if [[ "${ENABLE_HTTPS,,}" == "yes" ]]; then
    certbot_args=(--nginx --non-interactive --agree-tos --register-unsafely-without-email -d "${APP_DOMAIN}")
    if [[ "${DEPLOY_MODE}" == "bundled" ]]; then
      certbot_args+=(-d "${CODE_DOMAIN}")
    fi
    certbot "${certbot_args[@]}"
  fi
fi

cd "${INSTALL_ROOT}"
if [[ "${DEPLOY_MODE}" == "bundled" ]]; then
  docker compose --profile bundled up -d --build
else
  docker compose up -d --build web agent
fi

echo
echo "Installation complete."
echo "Web URL: ${APP_URL}"
if [[ "${DEPLOY_MODE}" == "bundled" ]]; then
  echo "Code Server URL: ${CODE_ORIGIN}"
else
  echo "Code Server URL: ${CODE_WORKSPACE_URL}"
fi
echo "Data directory: ${INSTALL_ROOT}/data"
echo "Upgrade command: cd ${INSTALL_ROOT} && docker compose pull && docker compose up -d --build"
