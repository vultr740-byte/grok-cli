# Grok App-Server API — 外部接入文档

> 面向外部服务的接入说明。这是一个 **OpenAI 兼容**的 HTTP 接口,让你用标准 SDK 或 curl 远程驱动部署在 Railway 上的 grok agent。
>
> 重要:这不是一个纯模型代理,而是一个**会干活的智能体**——每次请求都会在云端工作目录里运行完整的 agent(可执行 shell、读写文件)。把它当"远程编码/自动化 agent"用,而不是"聊天补全"。

---

## 1. 基本信息

| 项 | 值 |
|---|---|
| Base URL | `https://grok-gateway-production-acba.up.railway.app/v1` |
| 协议 | HTTPS,OpenAI Chat Completions 兼容 |
| 鉴权 | `Authorization: Bearer <APP_SERVER_TOKEN>` |
| 默认模型 | `grok-4.3` |
| 流式 | 支持(SSE,`stream: true`) |

**鉴权令牌**由部署方在 Railway 变量 `APP_SERVER_TOKEN` 中配置。请向部署方索取,不要提交到代码库。下文示例中的 `$GROK_APP_TOKEN` 代表它。

---

## 2. 快速开始

### curl

```bash
export GROK_APP_TOKEN="向部署方索取"
export GROK_BASE="https://grok-gateway-production-acba.up.railway.app/v1"

curl "$GROK_BASE/chat/completions" \
  -H "Authorization: Bearer $GROK_APP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "在 workspace 建一个 README.md 并写上项目简介"}],
    "session": "acme-project"
  }'
```

### Python(官方 openai SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://grok-gateway-production-acba.up.railway.app/v1",
    api_key="向部署方索取",
)

resp = client.chat.completions.create(
    model="grok-4.3",
    messages=[{"role": "user", "content": "列出当前目录的文件"}],
    extra_body={"session": "acme-project"},   # 会话隔离 + 记忆
)
print(resp.choices[0].message.content)
```

### Node(官方 openai SDK)

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://grok-gateway-production-acba.up.railway.app/v1",
  apiKey: process.env.GROK_APP_TOKEN,
});

const resp = await client.chat.completions.create({
  model: "grok-4.3",
  messages: [{ role: "user", content: "跑一下测试并总结结果" }],
  // OpenAI SDK 会把未知字段放进请求体;若类型报错可用 fetch(见下)
  // @ts-expect-error 传自定义 session
  session: "acme-project",
});
console.log(resp.choices[0].message.content);
```

---

## 3. 接口

### `POST /v1/chat/completions`

驱动 agent 跑一轮。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `messages` | array | 是 | OpenAI 消息数组。**只有最后一条 `role:"user"` 会被当作本轮输入**;历史由服务端按 `session` 维护,你不需要回传完整历史。 |
| `session` | string | 否 | 会话标识。相同 `session` 共享记忆与工作上下文,跨请求、跨重启延续。缺省为 `"default"`。也接受 OpenAI 的 `user` 字段作为回退。 |
| `stream` | bool | 否 | `true` 时以 SSE 流式返回。 |
| `model` | string | 否 | 仅回显在响应里;实际模型由服务端 `GROK_MODEL` 决定(默认 `grok-4.3`)。 |

**非流式响应**(标准 `chat.completion`)

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1784346057,
  "model": "grok-4.3",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" }
  ]
}
```

**流式响应**(SSE,`stream: true`)

逐条 `data:` 行,每条是一个 `chat.completion.chunk`,增量在 `choices[0].delta.content`;以 `finish_reason:"stop"` 的空 delta 收尾,最后 `data: [DONE]`。

```
data: {"id":"…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"1"},"finish_reason":null}]}
data: {"id":"…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

curl 流式:

```bash
curl -N "$GROK_BASE/chat/completions" \
  -H "Authorization: Bearer $GROK_APP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"从1数到5"}],"session":"demo","stream":true}'
```

### `GET /v1/models`

需鉴权,返回服务端当前模型:

```json
{ "object": "list", "data": [{ "id": "grok-4.3", "object": "model", "owned_by": "xai" }] }
```

### `GET /healthz`

公开,无需鉴权,用于探活/接入自检:

```json
{ "ok": true, "service": "grok-app-server", "authMode": "oauth", "apiEnabled": true, "telegramBot": true }
```

- `apiEnabled: false` 表示部署方未配置 `APP_SERVER_TOKEN`,`/v1/*` 会一律 401。

---

## 4. 会话(session)语义

- **隔离**:不同 `session` 是相互独立的 agent 实例与工作上下文。
- **记忆**:同一 `session` 内自动保留对话历史与工作目录状态,你**只需发最后一条用户消息**。
- **持久**:`session` 与真实会话的映射存在卷上,**重新部署后仍可续**。
- **并发**:不同 `session` 可并发;**同一 `session` 内请求会自动串行**(一次只跑一轮),后到的排队等待。
- 建议:每个外部用户/任务用一个稳定的 `session` 字符串(如 `user-123`、`ticket-456`)。

---

## 5. 错误码

| HTTP | 含义 | 处理 |
|---|---|---|
| `401` | 缺少/错误的 Bearer 令牌 | 检查 `Authorization` 头 |
| `400` | 请求体非法 / 没有用户消息 | 检查 JSON 与 `messages` |
| `502` | agent 执行出错 | 重试;持续失败联系部署方看日志 |
| `503` | 服务端暂无可用凭证(OAuth 令牌缺失/刷新中) | 稍后重试 |

错误体为 OpenAI 风格:`{"error":{"message":"…","type":"…"}}`。流式模式下,错误会作为一个文本 delta(前缀 `[error]`)推出后再收尾。

---

## 6. 使用须知与限制

- **这是 agent,不是模型**:它会真的执行命令、改文件(在云端 `/data/workspace`,`danger-full-access`)。给的指令要明确、可控。
- **单实例**:当前为单副本部署(Telegram 长轮询要求),不要横向扩容;高并发请用不同 `session` 并接受排队。
- **turn 可能较慢**:agent 一轮可能跑多步工具,响应从秒级到分钟级;客户端超时建议 ≥180s(服务端 `idleTimeout` 已设 255s)。流式可尽早看到输出。
- **凭证是账号级**:后端用某个 xAI 账号的 OAuth 身份运行,消耗其额度。
- **鉴权令牌要保密**:持有 `APP_SERVER_TOKEN` 即可在容器里执行任意代码,等同后端访问权。泄露请让部署方轮换。
- **试用资源**:当前部署在 Railway 试用账号(0.5GB 卷 / 1GB 内存),重负载或大文件可能受限。

---

## 7. 与 OpenAI 的差异速查

- 只实现 `messages` 里的**最后一条 user 消息**作为输入;历史由 `session` 托管,**不要依赖回传完整 messages 来"设定"历史**。
- 无 `temperature` / `tools` / `functions` 等参数(工具由 agent 内部自带并自动使用)。
- 无 `usage` token 统计字段。
- `model` 字段仅回显,不切换模型。
- 额外支持非标字段 `session`(OpenAI 无此语义)。
