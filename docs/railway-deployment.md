# Grok-dev 部署到 Railway — 方案复盘

> **敏感性说明**：本文档不含任何密钥明文（API key / bot token / JWT / Railway token 一律以角色或前缀代替）。
> 但包含 Railway 项目/服务 ID、账号邮箱、Telegram user ID 等非机密标识。若要公开提交，建议先脱敏或移入 gitignore。
>
> 记录时间：2026-07-17 → 07-18。分支：`gateway`。

---

## 1. 结论先行（TL;DR）

把本仓库（`grok-dev`，Bun/OpenTUI 的第三方 Grok CLI）部署到了 Railway，现有**两种驱动方式**并存、共享同一套自刷新的 OAuth 登录：
- **Telegram 遥控**：手机 → 云端 agent → 调 xAI → 回手机。
- **HTTP API**（OpenAI 兼容）：任何 SDK/脚本可调，见独立文档 **[`app-server-api.md`](./app-server-api.md)**（外部接入用这份）。

> 本文档是**部署方复盘 + runbook**。外部服务只需接 API 的话，直接看 [`app-server-api.md`](./app-server-api.md)。

认证已从"临时复制短命 JWT"演进为 **OAuth device-code 自动登录 + 刷新**（§3、§8），无需静态 key、令牌自动续期。

关键线索链：
1. 本仓库**没有 HTTP 服务、没有登录**，只有 CLI/TUI + 一个进程内的 Telegram 桥。
2. 用户记忆里的"登录模式"属于**另一个同名程序**（xAI 官方 CLI），不是本仓库。
3. 官方 CLI 的 OAuth 令牌**恰好能被 `api.x.ai` 当作合法 Bearer**，于是本仓库无需改码即可复用它——但令牌短命。

---

## 2. 背景：两个都叫 "grok" 的程序

排查中最大的澄清点。用户本地 `~/.grok/bin/grok` 与本仓库是**两个不同的程序**，且共用 `~/.grok` 配置目录，极易混淆：

| | 本仓库（部署对象） | 用户本地在用的 |
|---|---|---|
| 名称 | `grok-dev` / superagent-ai | xAI 官方 "Grok Build TUI" |
| 版本 | 1.1.7 | 0.2.102 |
| 运行时 | Bun + OpenTUI | Rust |
| 认证 | 只能粘 `xai-` key（无登录） | `grok login`（`--oauth` / `--device-auth`），有真正登录 |
| 远程遥控 | ✅ Telegram 桥 | ❌ 无 telegram/serve/bridge 子命令 |
| 配置文件 | `~/.grok/user-settings.json` | `~/.grok/auth.json` + `config.toml` |

两者能力**互补但都不完整**：想要的"登录"在官方 CLI，想要的"云端手机遥控"在本仓库。本次选择部署本仓库（因为要的是远程遥控），并想办法复用了官方 CLI 的登录凭证。

---

## 3. 认证方案的演进（三次撞墙）

1. **裸 `xai-` key** → 用户提供的 key 背后 team `e4b2c88e` **零额度**，鉴权过但推理被 `permission-denied` 挡下。根因：那是个新建空 team，不是用户真实账号。
2. **以为有 OAuth 登录** → 查代码，本仓库 `submitApiKey` 只校验 `xai-` 前缀就保存，`CONNECT_CHANNELS` 只有 Telegram，**根本没有账号登录**。用户记忆错位到了官方 CLI。
3. **复用本地登录凭证** → 本地 `~/.grok/auth.json` 是 OIDC：一个短命 JWT（`.key`）+ `refresh_token` + `expires_at`，由 `auth.x.ai` 签发，绑在有额度的 team `24bb91d7`。

**关键实证**：把该 JWT 当 Bearer 打 `api.x.ai/v1`，不仅列出 10 个模型，还真跑通了一次 `chat/completions`（grok-4.3 → "PONG"）。因为本仓库就是 `Authorization: Bearer <apiKey>` 打同一个端点，所以 `GROK_API_KEY = <该 JWT>` 无需改码即可工作。

**代价**：JWT 短命（当天 ~19:53Z 过期），本仓库无任何刷新/OIDC 代码——它能用纯属 Bearer 兼容的巧合，令牌一过期即停摆。

---

## 4. 最终架构

```
 手机 Telegram App
        │  (你发消息给 @xiasou_bot)
        ▼
 Telegram Bot API  ──long polling──►  Railway 容器 (单实例)
                                       ├─ docker/entrypoint.sh (supervisor)
                                       │    ├─ 用 env 生成 ~/.grok/user-settings.json (jq merge)
                                       │    ├─ docker/health.ts  → 监听 $PORT，供 Railway 健康检查
                                       │    └─ grok telegram-bridge (进程内 new Agent())
                                       │            │  Authorization: Bearer $GROK_API_KEY
                                       │            ▼
                                       │        api.x.ai/v1  (xAI 推理)
                                       └─ 卷 /data  (HOME=/data → 配置/会话/日志持久化)
```

要点：
- **进程内桥**：桥直接 `new Agent()`，不像 codex 微信桥那样连独立 app-server。所以本阶段**不需要服务端模式**。
- **健康检查**：桥是 long-polling、不监听端口，所以并排跑 `health.ts` 占 `$PORT` 给 Railway 探活。
- **单实例硬约束**：long-polling 多副本会 409，必须 `numReplicas=1`。
- **HOME=/data**：本仓库配置路径写死 `os.homedir()/.grok`，Linux 认 `$HOME`，故设 `HOME=/data` 即让配置落到卷上，**零改码**。

---

## 5. 部署产物清单

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 基于 `oven/bun:1-debian`（必须 bun，因 `src/storage/db.ts` 用 `bun:sqlite`）。装 git/ripgrep/jq + python3/make/g++（`utf-8-validate` 经 `@coinbase/agentkit` 需原生编译）。`bun install` 后设 `HOME=/data`。 |
| `railway.toml` | `builder=DOCKERFILE`，`healthcheckPath=/healthz`，`restartPolicyType=ALWAYS`。 |
| `.dockerignore` | deny-all 白名单，只放 `package.json`/`bun.lock`/`tsconfig.json`/`src`/`docker`。 |
| `docker/entrypoint.sh` | supervisor：jq **合并**（非覆盖）env 到 user-settings.json → 起 health server → 齐备时起桥。合并是硬要求（`approvedUserIds`/`sessionsByUserId` 运行时会回写，覆盖会丢会话）。 |
| `docker/health.ts` | `/healthz` 探活（报告 key/bot 是否存在，不泄值）；`/selftest`（**demo 用，公开无鉴权、每次花 token，后续须删或加鉴权**）在容器内真打一次推理。 |

---

## 6. 部署步骤（可复现 runbook）

前提：`railway` CLI、`docker`、`bun`、`jq` 就绪；`RAILWAY_API_TOKEN` 为账号级 token。

```bash
export RAILWAY_API_TOKEN=<account-token>

# 1. 建项目 + 服务 + 卷 + 域名
railway init --name grok-gateway
railway add --service grok-gateway
railway volume add --mount-path /data      # 服务已链接时无需 --service
railway domain                              # 生成公网域名

# 2. 设密钥（--skip-deploys 可先攒着不触发部署）
railway variables --set "GROK_API_KEY=<xai-key 或 复用的 JWT>" \
                  --set "TELEGRAM_BOT_TOKEN=<botfather-token>" \
                  --set "TELEGRAM_APPROVED_USER_IDS=<你的-telegram-数字id>" \
                  --service grok-gateway

# 3. 构建部署（Railway 用 Dockerfile 构建；本地 docker 只用于快速排错）
railway up --service grok-gateway --detach

# 4. 验证
curl -s https://<domain>/healthz          # 期望 grokApiKey:true, telegramBot:true
curl -s https://<domain>/selftest         # 期望 {ok:true, reply:"PONG"}（demo 端点）
# 然后手机给 bot 发一条新消息（旧消息因 drop_pending_updates 被丢弃）
```

**拿 Telegram user ID 的技巧**：设好 bot token 后、桥启动前，让本人给 bot 发一条消息，然后 `curl .../getUpdates` 从 `message.from.id` 读到数字 ID，省去 @userinfobot。

**构建避坑**：
- 本地 docker 构建仅用于快速验证；本机网络慢/易 502 时直接让 Railway 构建（同一个 Dockerfile）。
- 首次因缺 python3/make/g++ 导致 `utf-8-validate` node-gyp 失败——已在 Dockerfile 修复。

---

## 7. 环境变量清单

| 变量 | 必需 | 说明 |
|---|---|---|
| `GROK_API_KEY` | 是 | Bearer 打 `api.x.ai/v1`。可为长期 `xai-` key，或（临时）复用的 OIDC JWT。 |
| `TELEGRAM_BOT_TOKEN` | 起桥必需 | @BotFather 的 bot token。 |
| `TELEGRAM_APPROVED_USER_IDS` | 起桥必需 | 逗号分隔的 Telegram 数字 ID 白名单，预置以跳过云端无法进行的配对。 |
| `GROK_BASE_URL` | 否 | 覆盖 API 端点（未来接计费网关的钩子）。 |
| `GROK_MODEL` | 否 | 默认 grok-4.3。 |
| `HOME` | 是（Dockerfile 已设 `/data`） | 让配置/会话落到卷。 |
| `PORT` | Railway 注入 | health server 监听。 |

桥仅在 `TELEGRAM_BOT_TOKEN` 与 `GROK_API_KEY` 同时存在时启动，否则退化为 health-only，避免崩溃循环。

---

## 8. 当前状态与已知限制

**已验证 ✅**：Railway 构建 → 容器启动 → 健康检查 → 复用登录凭证在云端跑推理 → Telegram 桥常驻 → 手机端到端遥控。

**限制 ⚠️**：
1. **临时凭证**：当前 `GROK_API_KEY` 是短命 JWT，过期后 bot 停止回复。
2. **`/selftest` 裸奔**：公开、无鉴权、每次花 token。须删除或加鉴权。
3. **空工作目录**：agent 在云端 `/data/workspace` 空目录干活，不碰任何真实 repo。若要它操作具体项目，需另设计（clone / 挂载代码 / deploy key）。
4. **试用账号限额**：部署所在 Railway 账号是试用级（0.5GB 卷 / 1GB 内存）。
5. **产物未提交**：`Dockerfile`/`railway.toml`/`docker/` 仍在 `gateway` 分支工作区，未 commit。

---

## 9. 后续路线

- **固化长期可用**：用有额度的 team（`24bb91d7`）在 console.x.ai 签一个长期 `xai-` key，替换 JWT；删除/加固 `/selftest`。零改码即稳定长跑。
- **让 agent 操作真实项目**：容器启动时 clone 目标 repo 到 `/data/workspace`，配 deploy key / GitHub token；考虑 push 回写。
- **阶段二 gateway（更大工程）**：给本仓库加服务端模式（对标 `codex app-server`），让多客户端/多频道连入；或做计费网关（`GROK_BASE_URL` 指向自建代理，容器不再直接持有 xAI key）。
- **认证的"真·复用登录"**：若坚持用 OAuth 而非 `xai-` key，需在容器内实现 `refresh_token` → JWT 的定期刷新（脆弱，等价于重实现官方 CLI 认证）。

---

## 10. 安全待办

- [ ] **Rotate Railway 账号 API token**（排查期间在对话中明文出现过）。
- [ ] 删除或加鉴权 `docker/health.ts` 的 `/selftest`。
- [ ] JWT / bot token 若不再使用，及时作废。
- [ ] 决定本文档是否入库；如入库先脱敏 ID。

---

## 附：本次部署实例标识（非机密）

- Railway 项目 `grok-gateway` = `83e9ae62-1ad0-4d9d-a5e1-4b8a003f4f5a`
- 服务 = `893fc4b6-35e8-4c7e-8504-6da0e9c5e418`，环境 production = `f29f1c1a-eeda-4167-8c72-c38979dcda12`
- 域名 = `https://grok-gateway-production-acba.up.railway.app`，卷挂载 `/data`
- Railway 账号 = `gracelin26@xialiao.app`（xialiao 试用账号）
- Telegram bot = `@xiasou_bot`，白名单 user = `6465438790`
- 复用凭证来源 team = `24bb91d7`（有额度）；失败的空 team = `e4b2c88e`
