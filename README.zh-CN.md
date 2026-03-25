# Codex Switcher Web

[English](./README.md)

Codex Switcher Web 是一个面向服务器场景的自托管控制台，适合在同一台机器上管理多个 Codex 账号的团队或个人使用。它聚焦于账号资料、device code 认证任务、活动身份切换、额度可视化、本地漂移检测、轻量可用性探测，以及 code-server 集成。

## 功能特性

- 在一个网页控制台里管理多个 Codex 账号。
- 创建、重试、取消并查看 device code 认证任务。
- 切换当前运行环境实际使用的共享 Codex 活动身份。
- 从后端追踪 5 小时和 1 周额度使用情况。
- 用最小成本执行手动或自动账号可用性检测，且不会误切换当前账号。
- 当 `auth.json` 被控制台之外的操作改动时，自动提示本地漂移。
- 在后台定时保活已保存 profile 的 token，提高稳定性。
- 支持接入已有 code-server，或由安装器一并部署新的 code-server。

## 截图占位

把截图放到 `docs/screenshots/` 后，将下面的占位内容替换为实际图片即可。

### 控制台总览

> 截图占位
<!-- ![Dashboard](./docs/screenshots/dashboard-overview.png) -->

### 账号详情

> 截图占位
<!-- ![Account Detail](./docs/screenshots/account-detail.png) -->

### code-server 集成

> 截图占位
<!-- ![code-server Integration](./docs/screenshots/code-server-integration.png) -->

## 快速开始

1. 准备一台 Ubuntu 22.04 或 24.04 机器。
2. 确认已安装 Docker 和 Docker Compose。
3. 运行 `deploy/install.sh` 安装脚本。
4. 打开控制台，用初始化的管理员账号登录。
5. 添加账号，保存资料，并创建认证任务。
6. 用浏览器打开生成的 OpenAI 认证链接并完成授权。
7. 当 profile 变为可用后，再切换到目标账号。

## 部署模式

### 接入已有 code-server

如果你已经有现成的 code-server，只想让 Codex Switcher Web 接入它，请使用这个模式。

### 一并部署 bundled code-server

如果你希望安装器一并部署新的 code-server，请使用这个模式。bundled 服务会自动共享受管的 Codex auth 路径。

## 安装方式

```bash
cd deploy
bash install.sh
```

安装器会依次询问：

- 安装目录
- Web 域名
- 部署模式
- 默认界面语言
- 绑定端口
- 初始管理员账号与密码
- 已有 code-server 地址，或 bundled code-server 的域名与密码

安装完成后会生成：

- `.env`
- `docker-compose.yml`
- `generated/nginx/*.conf`

## 配置说明

核心配置全部通过环境变量提供。

### 应用

- `APP_URL`
- `HOST`
- `PORT`
- `SESSION_COOKIE_DOMAIN`
- `SESSION_SECURE`
- `TRUST_PROXY`
- `DEFAULT_UI_LANGUAGE`

### 安全

- `SESSION_SECRET`
- `CODEX_PROFILE_ENCRYPTION_KEY`
- `CODEX_AGENT_SHARED_SECRET`

### 运行时

- `CODEX_SWITCHER_DATA_DIR`
- `DB_PATH`
- `AUDIT_LOG_PATH`
- `CODEX_AGENT_SOCKET_PATH`
- `CODEX_ACTIVE_HOME`
- `CODEX_ACTIVE_AUTH_PATH`

### 稳定性

- `QUOTA_SAMPLE_INTERVAL_MS`
- `PROFILE_KEEPALIVE_INTERVAL_MS`
- `AVAILABILITY_PROBE_SWEEP_MS`
- `SWITCH_LOCK_MS`

### code-server

- `CODE_ORIGIN`
- `CODE_WORKSPACE_URL`
- `CODE_SERVER_PASSWORD`
- `CODE_SERVER_BIND_PORT`

完整模板请参考 [`deploy/env.example`](./deploy/env.example)。

## 路线图

请查看 [`docs/ROADMAP.md`](./docs/ROADMAP.md)。

## 许可证

MIT
