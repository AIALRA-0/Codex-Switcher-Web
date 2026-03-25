# Codex Switcher Web

[中文说明](./README.zh-CN.md)

Codex Switcher Web is a self-hosted control panel for teams or operators who manage more than one Codex account on the same server. It focuses on account metadata, device-code auth tasks, active-profile switching, quota visibility, drift detection, lightweight account probes, and code-server integration.

## Features

- Manage multiple Codex accounts from one web dashboard.
- Create, retry, cancel, and review device-code authentication tasks.
- Switch the active shared Codex profile used by the current runtime.
- Track 5-hour and 1-week quota usage from the backend.
- Run manual or automatic low-cost availability probes without changing the active account.
- Detect local auth drift when `auth.json` changes outside the dashboard.
- Keep stored profile tokens warm in the background for better stability.
- Integrate with an existing code-server or deploy a bundled one.

## Screenshots

Add screenshots to `docs/screenshots/` and replace the placeholders below.

### Dashboard

> Screenshot placeholder
<!-- ![Dashboard](./docs/screenshots/dashboard-overview.png) -->

### Account Detail

> Screenshot placeholder
<!-- ![Account Detail](./docs/screenshots/account-detail.png) -->

### code-server Integration

> Screenshot placeholder
<!-- ![code-server Integration](./docs/screenshots/code-server-integration.png) -->

## Quick Start

1. Prepare an Ubuntu 22.04 or 24.04 host.
2. Make sure Docker and Docker Compose are available.
3. Run the installer in `deploy/install.sh`.
4. Open the web console and sign in with the seeded admin account.
5. Add an account, save its metadata, and create an auth task.
6. Open the generated OpenAI auth link in your browser and complete authorization.
7. Switch the active account when the profile becomes ready.

## Deployment Modes

### External code-server

Use this mode when you already have a running code-server and only want Codex Switcher Web to connect to it.

### Bundled code-server

Use this mode when you want the installer to deploy a new code-server next to Codex Switcher Web. The bundled service shares the managed Codex auth path automatically.

## Installation

```bash
cd deploy
bash install.sh
```

The installer asks for:

- install root
- web domain
- deployment mode
- default UI language
- bind ports
- initial admin account and password
- existing code-server URL or bundled code-server domain/password

Generated files:

- `.env`
- `docker-compose.yml`
- `generated/nginx/*.conf`

## Configuration

Core settings live in environment variables.

### App

- `APP_URL`
- `HOST`
- `PORT`
- `SESSION_COOKIE_DOMAIN`
- `SESSION_SECURE`
- `TRUST_PROXY`
- `DEFAULT_UI_LANGUAGE`

### Security

- `SESSION_SECRET`
- `CODEX_PROFILE_ENCRYPTION_KEY`
- `CODEX_AGENT_SHARED_SECRET`

### Runtime

- `CODEX_SWITCHER_DATA_DIR`
- `DB_PATH`
- `AUDIT_LOG_PATH`
- `CODEX_AGENT_SOCKET_PATH`
- `CODEX_ACTIVE_HOME`
- `CODEX_ACTIVE_AUTH_PATH`

### Stability

- `QUOTA_SAMPLE_INTERVAL_MS`
- `PROFILE_KEEPALIVE_INTERVAL_MS`
- `AVAILABILITY_PROBE_SWEEP_MS`
- `SWITCH_LOCK_MS`

### code-server

- `CODE_ORIGIN`
- `CODE_WORKSPACE_URL`
- `CODE_SERVER_PASSWORD`
- `CODE_SERVER_BIND_PORT`

See [`deploy/env.example`](./deploy/env.example) for a full template.

## Roadmap

See [`docs/ROADMAP.md`](./docs/ROADMAP.md).

## License

MIT
