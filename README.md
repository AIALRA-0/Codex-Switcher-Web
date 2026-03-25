# Codex Switcher Web

Codex Switcher Web is a self-hosted control panel for teams or operators who manage more than one Codex account on the same server. It provides a browser UI for account metadata, device-code authentication tasks, active-profile switching, quota visibility, and code-server integration.

Codex Switcher Web 是一个面向服务器场景的自托管控制台，适合在同一台机器上管理多个 Codex 账号的团队或个人使用。它提供浏览器界面来完成账号资料管理、device code 认证任务、活动账号切换、额度查看，以及与 code-server 的联动。

## Table of Contents / 目录

- [Highlights / 核心特性](#highlights--核心特性)
- [Screenshots / 截图占位](#screenshots--截图占位)
- [Architecture / 架构概览](#architecture--架构概览)
- [Quick Start / 快速开始](#quick-start--快速开始)
- [Deployment Modes / 部署模式](#deployment-modes--部署模式)
- [Installation / 安装方式](#installation--安装方式)
- [Configuration / 配置说明](#configuration--配置说明)
- [Security Model / 安全模型](#security-model--安全模型)
- [Development / 本地开发](#development--本地开发)
- [Roadmap / 路线图](#roadmap--路线图)
- [License / 许可证](#license--许可证)

## Highlights / 核心特性

- Manage multiple Codex accounts from one web dashboard.
- Start, retry, cancel, and track device-code authentication tasks.
- Switch the active Codex profile used by the shared runtime.
- Monitor quota freshness and usage from one place.
- Integrate with an existing code-server instance or deploy a bundled one.
- Mask account emails globally in the UI when presenting or screen-sharing.

- 在一个网页控制台里管理多个 Codex 账号。
- 创建、重试、取消并追踪 device code 认证任务。
- 切换共享运行环境实际使用的 Codex 活动身份。
- 在一个界面内查看额度和同步新鲜度。
- 支持接入已有 code-server，或由安装器一并部署新的 code-server。
- 演示或共享屏幕时可全局隐藏邮箱信息。

## Screenshots / 截图占位

Add your screenshots to `docs/screenshots/` and uncomment or replace the placeholders below.

将截图放到 `docs/screenshots/` 目录后，把下面的占位内容替换成实际图片即可。

### Dashboard Overview / 控制台总览

> Screenshot placeholder: dashboard / 截图占位：控制台首页
<!-- ![Dashboard Overview](./docs/screenshots/dashboard-overview.png) -->

### Account Detail And Auth Tasks / 账号详情与认证任务

> Screenshot placeholder: account detail / 截图占位：账号详情页
<!-- ![Account Detail](./docs/screenshots/account-detail.png) -->

### code-server Integration / code-server 集成

> Screenshot placeholder: code-server integration / 截图占位：code-server 联动
<!-- ![Code Server Integration](./docs/screenshots/code-server-integration.png) -->

## Architecture / 架构概览

### Runtime Components

- `web`: serves the dashboard, admin APIs, and status endpoints.
- `agent`: runs local Codex CLI operations, manages bootstrap sessions, captures auth results, and swaps the active auth profile.
- `sqlite`: stores accounts, encrypted profile payloads, bootstrap state, logs, and runtime markers.
- `code-server`: optional companion service, either external or bundled.

### 运行时组件

- `web`：提供管理界面、管理员 API 和状态接口。
- `agent`：执行本地 Codex CLI 操作，管理 bootstrap 会话，回填认证结果，并切换活动认证文件。
- `sqlite`：保存账号、加密后的 profile、认证任务、日志和运行时状态。
- `code-server`：可选组件，可接入外部实例，也可随安装器一并部署。

### Project Layout

- [`public`](./public): browser UI
- [`server`](./server): Express app, security, service layer, agent client integration
- [`tests`](./tests): Node test suite
- [`fixtures`](./fixtures): quota parsing fixtures
- [`deploy`](./deploy): installer, compose template, env example, reverse-proxy templates

## Quick Start / 快速开始

### Recommended Path

1. Prepare an Ubuntu 22.04 or 24.04 host.
2. Make sure Docker and Docker Compose are available.
3. Run the interactive installer.
4. Open the web console, sign in as the admin user, add accounts, and start authentication tasks.
5. Open the generated auth link in your browser, finish OpenAI authentication, then return to the dashboard.

### 推荐流程

1. 准备一台 Ubuntu 22.04 或 24.04 机器。
2. 确认已安装 Docker 和 Docker Compose。
3. 运行交互式安装脚本。
4. 打开控制台，用管理员账号登录，添加账号并发起认证任务。
5. 用浏览器打开生成的认证链接，完成 OpenAI 登录授权后回到控制台。

## Deployment Modes / 部署模式

### `external` code-server

Use this mode if you already have a running code-server and only want Codex Switcher Web to connect to it.

如果你已经有现成的 code-server，只想让 Codex Switcher Web 接入它，请使用这个模式。

### `bundled` code-server

Use this mode if you want the installer to deploy a new code-server alongside Codex Switcher Web. The installer will prepare a minimal code-server service and wire it to the shared Codex auth path.

如果你希望安装器一并部署新的 code-server，请使用这个模式。安装器会准备最小可运行的 code-server 服务，并把它接到共享的 Codex auth 路径上。

## Installation / 安装方式

### Interactive Installer

```bash
cd deploy
bash install.sh
```

The installer will ask for:

- deployment root
- web domain
- deployment mode (`external` or `bundled`)
- default UI language (`zh-CN` or `en`)
- bind ports
- initial admin email and password
- code-server URL or bundled code-server domain/password

安装器会依次询问：

- 安装目录
- Web 域名
- 部署模式（`external` 或 `bundled`）
- 默认界面语言（`zh-CN` 或 `en`）
- 绑定端口
- 初始管理员邮箱与密码
- code-server 地址，或 bundled 模式下的域名与密码

### Generated Assets

The installer generates:

- `.env`
- `docker-compose.yml`
- reverse-proxy configs under `generated/nginx/`

安装器会自动生成：

- `.env`
- `docker-compose.yml`
- `generated/nginx/` 下的反代配置

### Upgrade

```bash
docker compose pull
docker compose up -d --build
```

## Configuration / 配置说明

The project uses environment variables instead of built-in site values.

项目使用环境变量配置，不内置任何具体站点参数。

### Core App

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

### Data Paths

- `CODEX_SWITCHER_DATA_DIR`
- `DB_PATH`
- `AUDIT_LOG_PATH`
- `CODEX_AGENT_SOCKET_PATH`
- `CODEX_ACTIVE_HOME`
- `CODEX_ACTIVE_AUTH_PATH`

### code-server

- `CODE_ORIGIN`
- `CODE_WORKSPACE_URL`
- `CODE_SERVER_PASSWORD` (bundled mode only)
- `CODE_SERVER_BIND_PORT` (bundled mode only)

See [`deploy/env.example`](./deploy/env.example) for the starter template.

完整样例请参考 [`deploy/env.example`](./deploy/env.example)。

## Security Model / 安全模型

- Admin passwords are stored with `bcrypt`.
- Managed auth payloads are encrypted at rest.
- The agent is the only process that writes the active shared auth file.
- CSRF protection is enforced for state-changing admin requests.
- Login and write APIs are rate-limited.
- Placeholder secrets are rejected at startup.

- 管理员密码使用 `bcrypt` 哈希保存。
- 受管认证内容以加密形式落盘。
- 只有 agent 进程可以写共享的活动认证文件。
- 所有会改变状态的管理员请求都要求 CSRF 校验。
- 登录与写操作接口都做了限流。
- 占位 secret 不能直接启动，避免误上生产。

## Development / 本地开发

Install dependencies:

```bash
npm install
```

Start the web service:

```bash
npm start
```

Start the agent in another terminal:

```bash
npm run start:agent
```

Run tests:

```bash
npm test -- --runInBand
```

## Roadmap / 路线图

### Planned

- better first-run onboarding
- packaged desktop GUI companion
- cleaner release automation
- richer status and diagnostic surfaces

### 计划中

- 更顺滑的首次使用引导
- 配套桌面 GUI 客户端
- 更成熟的发布自动化
- 更丰富的状态与诊断能力

## License / 许可证

MIT
