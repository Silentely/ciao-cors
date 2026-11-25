# CIAO-CORS

高性能、开箱即用的跨平台 CORS 跨域代理服务。支持标准 **Docker 容器**、**Docker Compose**、各类主流云平台容器与 Serverless 环境、**Deno Deploy** 以及普通 **Linux VPS** 部署。

> 💖 **致谢与鸣谢**：
> 本项目基于 **[bestZwei/ciao-cors](https://github.com/bestZwei/ciao-cors)** 进行全方位升级，在保留原项目完备功能的基础上，进行了**生产级 Docker 容器化重构**、**轻量低内存专项优化**与**全链路安全加固**。
> 感谢 **[DreamCloud](https://whmcs.as211392.com)** 为原项目提供的服务器与高防演示支持。

---

## ✨ 本项目核心增强与特性

相比原版，本项目针对生产环境（特别是低成本云容器与 Serverless 环境）进行了深度打磨：

- 🐳 **生产级 Docker 容器化**：基于官方 Deno 2 稳定版镜像，非 root 安全用户运行，内置零外部网络依赖的健康检查探针（`/health`），多架构（`linux/amd64` 与 `linux/arm64`）自动发布。
- 🚀 **超轻量低内存适配**：专为低内存规格调优（`RESOURCE_PROFILE=low-memory`），即使在 128MB 极低配环境下实测常驻内存也仅需 16~21 MB，运行稳定不 OOM。
- 📦 **双重有界 LRU 缓存**：同时限制最大条目数与内存总字节数。采用旁路 Tap 采集，彻底杜绝原有 `Response.clone()` 带来的内存无界膨胀；自动隔离 Authorization 与 Set-Cookie，防跨用户缓存污染。
- 🛡️ **严格 SSRF 深度防御**：完整拦截 IPv4、IPv6、IPv4-mapped IPv6、NAT64、6to4、链路本地及保留网段；精准阻断云厂商内部元数据（`169.254.169.254`、`169.254.42.42` 等）；DNS 解析坚持 fail-closed 策略（解析失败立即拦截，杜绝绕过）。
- ⚡ **流式防打爆与精准并发控制**：超大 chunked 上传实时按块统计，超限立即中断并返回 413；并发计数与流生命周期（SSE、长连接）强绑定，彻底解决计数漂移。
- 🔑 **独立代理访问鉴权**：新增可选的 `PROXY_API_KEY`（支持 `X-Proxy-Key`、`Proxy-Authorization` 或 `?proxy_key=`，鉴权参数不会转发给上游），不污染客户端发向上游的真实 `Authorization` 请求头，浏览器 OPTIONS 预检自动友好放行。

---

## 🎯 怎么使用？

服务部署完成后，您可以通过以下几种简单方式进行跨域请求：

### 1. 路径模式（推荐）
在您的代理服务地址后直接拼接目标完整 URL：
```text
https://your-proxy-domain.com/https://httpbin.org/get
```
或者简写为：
```text
https://your-proxy-domain.com/httpbin.org/get
```

### 2. 查询参数模式
通过 `?url=` 参数传递目标地址：
```text
https://your-proxy-domain.com/?url=https://httpbin.org/get
```

### 3. 前端 JavaScript 使用示例
前端 `fetch` 示例（浏览器会自动携带 `Origin` 头部）：
```javascript
// GET 请求
fetch('https://your-proxy-domain.com/https://api.github.com/users/octocat')
  .then(res => res.json())
  .then(data => console.log(data));

// POST 请求
fetch('https://your-proxy-domain.com/https://httpbin.org/post', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ message: 'Hello from CIAO-CORS' })
})
  .then(res => res.json())
  .then(data => console.log(data));
```

### 4. 携带代理访问密钥（若配置了 PROXY_API_KEY）
```bash
curl -H "X-Proxy-Key: your-proxy-key" \
     -H "Origin: https://my-app.com" \
     "https://your-proxy-domain.com/https://httpbin.org/get"
```

---

## 🚀 快速上手部署

### 方案 A：Docker 快速启动（推荐）

#### 1. 单命令启动
```bash
# 标准启动（默认 3000 端口）
docker run -d \
  --name ciao-cors \
  -p 3000:3000 \
  ghcr.io/silentely/ciao-cors:latest

# 低内存模式启动（限制 128MB 内存，适合低配 VPS）
docker run -d \
  --name ciao-cors \
  --memory=128m \
  -e RESOURCE_PROFILE=low-memory \
  -p 3000:3000 \
  ghcr.io/silentely/ciao-cors:latest
```

#### 2. Docker Compose 启动
使用项目自带的 [`compose.yaml`](compose.yaml)：
```bash
docker compose up -d
```

---

### 方案 B：云容器 / Serverless 部署

直接使用公开 GHCR 镜像部署到任意支持容器的云平台：
- **镜像地址 (Image)**：`ghcr.io/silentely/ciao-cors:latest`（多架构）。也可使用 `amd64`（main 分支的 amd64 专用标签）、`sha-<短提交号>` 与 `sha-<短提交号>-amd64` 追踪具体构建；打 Git Tag 后会额外发布 SemVer 版本标签（如 `1.3.2`、`1.3`、`1`，以及对应的 `1.3.2-amd64`）。
- **端口 (Port)**：`3000`
- **健康检查 (Health Check)**：`/health`
- **环境变量 (可选)**：低配容器推荐设置 `RESOURCE_PROFILE=low-memory`


---

### 方案 C：Deno Deploy 一键部署

1. Fork 本项目到您的 GitHub 账号。
2. 登录 [Deno Deploy 控制台](https://dash.deno.com)，创建新项目。
3. 关联您的 GitHub 仓库，入口文件选择 `server.ts`。
4. 在项目设置中按需添加环境变量（如 `PROXY_API_KEY`、`RESOURCE_PROFILE` 等），保存后几秒内自动上线全球 CDN！

---

### 方案 D：普通 Linux VPS 原生部署

项目保留了原有的一键安装脚本，支持系统服务与自动配置：
```bash
sudo ./deploy.sh
```

---

## ⚙️ 常用环境变量说明

所有参数均有合理的默认值，零配置即可直接运行。

| 环境变量名 | 默认值 | 简要说明 |
|---|---|---|
| `PORT` | `3000` | 服务监听端口（各云平台通常会自动注入） |
| `RESOURCE_PROFILE` | `standard` | **资源配置模式**。低配容器/VPS 请设为 `low-memory` |
| `PROXY_API_KEY` | *(未设置)* | **代理使用密钥**。配置后客户端必须携带此密钥才允许代理 |
| `API_KEY` | *(未设置)* | **管理接口密钥**。保护 `/_api/stats`、`/_api/config` 等运维接口 |
| `ENABLE_MANAGEMENT_API` | `true` | 是否启用 `/_api/*` 管理接口。设为 `false` 可完全关闭 |
| `ENABLE_CACHE` | `true` | 是否启用内置 GET 响应缓存 |
| `MAX_CACHE_BYTES` | `33554432`（低内存 `8388608`） | 缓存总字节上限 |
| `MAX_CACHE_ENTRIES` | `1000`（低内存 `32`） | 缓存条目数上限 |
| `CACHE_TTL` | `60000`（低内存 `15000`） | 缓存有效期（毫秒） |
| `MAX_CACHE_ENTRY_BYTES` | `2097152`（低内存 `262144`） | 单条缓存响应的最大字节数 |
| `FORWARD_SET_COOKIE` | `false` | 是否把上游 `Set-Cookie` 透传给客户端 |
| `DROP_HEADERS` | *(未设置)* | 转发上游前额外剥离的请求头（逗号分隔） |
| `TIMEOUT` | `30000` | 上游请求超时（毫秒） |
| `REQUIRE_HEADERS` | `true` | 是否要求客户端携带 `Origin` 或 `X-Requested-With` 头部 |
| `REQUIRE_HEADERS_EXEMPT_DOMAINS` | *(未设置)* | **请求头豁免目标域名**（精确匹配，逗号分隔或 JSON 数组），仅跳过上述 `Origin` / `X-Requested-With` 校验 |
| `REMOVE_ORIGIN_HEADER` | `false` | 转发上游时是否去除 Origin 头（防目标网站防盗链拦截） |
| `ENABLE_KEYWORD_BLOCK` | `true` | 是否拦截常见流媒体切片及高频滥用链接（如 `.m3u8`, `.ts` 等） |
| `ALLOWED_DOMAINS` | *(未设置)* | 允许代理的目标域名白名单（逗号分隔，如 `api.github.com,httpbin.org`） |
| `BLOCKED_DOMAINS` | *(未设置)* | 禁止代理的目标域名黑名单（逗号分隔） |
| `ALLOWED_ORIGINS` | *(未设置)* | 允许访问本代理的前端 Origin 域名（支持 `*` 或特定域名） |
| `ALLOW_CREDENTIALS` | `false` | **CORS 凭证模式**。仅在 `ALLOWED_ORIGINS` 为显式域名列表时生效，用于 `credentials: include` |
| `TRUSTED_PROXIES` | *(未设置)* | 受信的反向代理 IP/CIDR 列表（用于准确获取客户端真实 IP） |

---

## 🔐 请求头豁免与原生客户端兼容

默认情况下，代理要求请求携带 `Origin` 或 `X-Requested-With`，以拦截纯浏览器场景之外的滥用。浏览器会自动携带 `Origin`，但命令行工具、桌面/移动原生客户端和标准 API SDK 通常不会，可能因此收到 `403`。

通过 `REQUIRE_HEADERS_EXEMPT_DOMAINS` 可只针对指定目标域名跳过这一项校验：

```env
REQUIRE_HEADERS=true
REQUIRE_HEADERS_EXEMPT_DOMAINS=api.example.com,translate.example.org
```

也支持 JSON 数组写法：

```env
REQUIRE_HEADERS_EXEMPT_DOMAINS=["api.example.com","translate.example.org"]
```

豁免后，标准 HTTP 客户端即可直接使用代理：

```bash
# 无 Origin / X-Requested-With，携带上游 Bearer 凭证
curl -X POST "https://your-proxy-domain.com/api.example.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-upstream-token" \
  -d '{"model":"your-model","messages":[{"role":"user","content":"hello"}]}'
```

**匹配规则与安全边界：**

- 使用规范化后的目标 URL 主机名做**精确匹配**，大小写、末尾根点（`api.example.com.`）自动归一；不会隐式豁免子域名。
- 不支持通配符、路径、端口或协议前缀；非法条目会在启动日志中被忽略。国际化域名按 punycode 比较。
- 豁免仅作用于 `Origin` / `X-Requested-With` 这一项校验。`PROXY_API_KEY`、`API_KEY`、`ALLOWED_DOMAINS`、`BLOCKED_DOMAINS`、`ALLOWED_ORIGINS`、`BLOCKED_IPS`、SSRF/DNS 校验、关键字拦截、限流、并发限制、请求体大小限制与缓存策略全部照常生效。
- 依靠豁免进入代理的无头部请求，若上游返回重定向，重定向目标必须同样在豁免名单内；否则请求会被拦截，防止借豁免域名跳转到非豁免域名绕过校验。
- 目标域名白名单（`ALLOWED_DOMAINS`）与请求头豁免名单用途不同：前者限制“能代理谁”，后者只决定“是否需要浏览器特征头部”。

---

## 🍪 CORS 凭证模式

默认情况下代理返回 `Access-Control-Allow-Origin: *`，适用于无需 Cookie 的普通跨域请求。若前端需要 `fetch(url, { credentials: 'include' })`，可显式开启凭证模式：

```env
ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
ALLOW_CREDENTIALS=true
```

- 凭证模式仅在 `ALLOWED_ORIGINS` 为**显式域名列表**时生效；未配置或仅为 `*` 时会自动关闭并在启动日志中提示，避免浏览器拒绝的 `*` + `Access-Control-Allow-Credentials: true` 组合。
- 只有列表内的 Origin 才会收到 `Access-Control-Allow-Origin: <该 Origin>` 与 `Access-Control-Allow-Credentials: true`，不会反射任意来源。
- `OPTIONS` 预检与实际请求使用同一套策略；凭证模式下 `Access-Control-Expose-Headers` 会改为显式列表。
- 上游响应自带的 `Access-Control-*` 头不会透传，CORS 策略始终由本代理按当前配置重建。
- 原生 HTTP 客户端与不使用凭证的浏览器请求不受影响。

---

## 🧭 启动入口说明

- **Docker / Docker Compose / 本地开发**：入口为 `main.ts`（`deno task start` 同样使用它），由它调用 `server.ts` 导出的 `startServer()`。
- **Deno Deploy 与单文件部署**：继续使用 `server.ts`。它保留默认 `{ fetch }` 导出用于托管运行时，同时保留 `import.meta.main` 自启动逻辑，因此 `deno run --allow-net --allow-env server.ts` 与 `deploy.sh` 的单文件安装/升级方式保持不变。直接运行 `server.ts` 时，Deno 可能打印 `did you mean to run "deno serve"?` 的提示信息；该提示不影响运行，如需无提示启动请改用 `main.ts`。

---

## 🛠️ 管理与运维 API

管理接口使用 `API_KEY` 保护，支持两种携带方式：

```bash
# 查询参数
curl "https://your-proxy-domain.com/_api/stats?key=your-secret-key"
# Authorization: Bearer
curl -H "Authorization: Bearer your-secret-key" \
     "https://your-proxy-domain.com/_api/stats"
```

> ⚠️ 若未设置 `API_KEY`，`/_api/*` 默认对外开放（启动日志会给出警告）。生产环境请务必设置 `API_KEY`，或通过 `ENABLE_MANAGEMENT_API=false` 完全关闭管理接口。

可用接口：

- **健康状态**：`GET /_api/health`（查看服务状态与内存 RSS）
- **性能统计**：`GET /_api/stats`（查看请求数、耗时与缓存占用）
- **实时性能**：`GET /_api/performance`（查看每分钟请求数、错误率与热门目标）
- **运行版本**：`GET /_api/version`
- **在线重载配置**：`GET /_api/reload-config`（支持 `SIGHUP` 触发）
- **重置统计**：`GET /_api/reset-stats`
- **清理内存缓存**：`GET /_api/clear-cache`
- **查看脱敏配置**：`GET /_api/config`

---

## 📄 镜像发布与开源协议

- **容器镜像仓库**：`ghcr.io/silentely/ciao-cors`
- **开源许可证**：本项目采用 [Anti-Capitalist Software License](LICENSE)。
