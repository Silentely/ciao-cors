# CIAO-CORS

高性能、生产级 CORS 代理服务，支持标准 Docker 容器化、Scaleway Serverless Containers 原地部署、Fly.io、Northflank、ClawCloud Run、VPS 原生与 Deno Deploy。专为跨域资源访问、低内存云函数及反代中继设计，提供严格的 SSRF 防护、有界 LRU 缓存、流式限额与独立代理鉴权。

🌐 **在线演示**: [cors.ciao.su](https://cors.ciao.su)

感谢 **[DreamCloud](https://whmcs.as211392.com)** 提供的高防服务器支持，为本项目提供稳定可靠的演示环境。

---

## 一、核心特性

- 🚀 **高性能 CORS 代理**：支持路径模式（`/{target-url}`）与查询参数模式（`/?url={target-url}`），支持 GET、POST、PUT、PATCH、DELETE、HEAD、OPTIONS 等全量 HTTP 方法。
- 📦 **有界 LRU 响应缓存**：同时限制条目数（`MAX_CACHE_ENTRIES`）与内存总字节数（`MAX_CACHE_BYTES`）。基于 Tap Stream 旁路采集，杜绝 `Response.clone()` 内存泄漏；针对 Authorization/Cookie 等敏感凭证自动隔离，尊重 `Cache-Control` 与 `Vary` 规范。
- 🛡️ **严格 SSRF 纵深防护**：全面防御 IPv4、IPv6、IPv4-mapped IPv6、NAT64、6to4、链路本地、CGNAT 及保留地址；精准阻断云厂商元数据接口（AWS/GCP `169.254.169.254`、Scaleway `169.254.42.42`、阿里云 `100.100.100.200` 等）；DNS 解析坚持 fail-closed 阻断策略。
- ⚡ **流式传输与并发租约**：请求体支持按 chunk 流式读取与大小截断（防超限 chunked OOM）；基于 Lease 机制绑定响应流生命周期，确保 SSE（Server-Sent Events）等长连接真正结束后释放并发资源，杜绝计数漂移。
- 🔑 **双轨密钥隔离**：
  - `API_KEY`：专门保护 `/_api/*` 运维管理路由（脱敏配置、实时统计、缓存清理）。
  - `PROXY_API_KEY`：专门保护代理数据转发路由。客户端可通过 `X-Proxy-Key` 或 `Proxy-Authorization: Bearer <key>` 鉴权，不污染客户端发向上游的真实 `Authorization` 请求头，对 OPTIONS 预检请求全自动友好放行。
- 🏷️ **低资源 Profile 预设**：专为 **Scaleway 70mVCPU / 128MB RAM** 等极致资源环境优化（`RESOURCE_PROFILE=low-memory`），空载内存仅 **16.6 MB**，20 并发实测仅 **21.6 MB**。
- 🐳 **生产级容器化**：官方 Deno 2 镜像、非 root 用户（UID 1993）、内置轻量零外部依赖健康检查（`/health`）、平滑捕获 SIGTERM/SIGINT 优雅退出。

---

## 二、快速开始

### 1. Docker 快速启动

```bash
# 1. 极简启动（默认标准规格，监听 3000 端口）
docker run -d \
  --name ciao-cors \
  -p 3000:3000 \
  ghcr.io/silentely/ciao-cors:1.3.2

# 2. 低内存模式启动（限制 128MB 内存，适合轻量 VPS / 边缘容器）
docker run -d \
  --name ciao-cors \
  --memory=128m \
  --memory-swap=128m \
  --cpus=0.07 \
  -e RESOURCE_PROFILE=low-memory \
  -e PROXY_API_KEY=your-proxy-key \
  -p 3000:3000 \
  ghcr.io/silentely/ciao-cors:1.3.2
```

### 2. Docker Compose 编排

使用项目内置的 `compose.yaml`：

```yaml
services:
  ciao-cors:
    image: ghcr.io/silentely/ciao-cors:1.3.2
    container_name: ciao-cors
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - RESOURCE_PROFILE=low-memory # 可选: standard / low-memory
      - PROXY_API_KEY=your-proxy-key # 可选: 代理使用鉴权
      - API_KEY=your-admin-key       # 可选: 管理接口鉴权
      - ENABLE_CACHE=true
      - REQUIRE_HEADERS=true
    healthcheck:
      test: ["CMD", "deno", "eval", "const p=Deno.env.get('PORT')||'3000';const r=await fetch('http://127.0.0.1:'+p+'/health');if(!r.ok)Deno.exit(1);"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s
```

启动命令：
```bash
docker compose up -d
```

### 3. Deno 本地运行

```bash
# 安装 Deno 2 后直接启动
deno task start

# 开发监听模式
deno task dev

# 执行自动化测试
deno task test
```

---

## 三、云平台部署与原地替换

### 1. Scaleway Serverless Containers 原地迁移（优先适配）

适用于已有正在运行的 Scaleway Container，希望通过替换镜像实现原地平滑迁移，**保留原有 Container ID、Namespace、自定义域名与 HTTPS SSL 证书**。

- 完整原地替换手册见：[docs/deploy/scaleway.md](docs/deploy/scaleway.md)
- 控制台关键配置表：
  - **Image URL**：`ghcr.io/silentely/ciao-cors:1.3.2`（或 `1.3.2-amd64`）
  - **Port**：`3000`
  - **CPU / Memory**：`70 mVCPU` / `128 MB`（常驻推荐）或 `140 mVCPU` / `256 MB`
  - **Min / Max Scale**：`Min=1, Max=1`（常驻无冷启动）或 `Min=0, Max=1`（按需冷启动）
  - **Health Check Path**：`/health`
  - **Environment Variables**：`RESOURCE_PROFILE=low-memory`
- 原地热替换运维脚本：
  ```bash
  # 安全预览检查 (Dry-run)
  ./scripts/scaleway-update.sh --region nl-ams --container-id <YOUR-CONTAINER-ID>

  # 确认执行原地热更新
  ./scripts/scaleway-update.sh --region nl-ams --container-id <YOUR-CONTAINER-ID> --apply
  ```

### 2. Fly.io 部署

在项目根目录下生成 `fly.toml`：
```toml
app = "your-ciao-cors"
primary_region = "hkg"

[build]
  image = "ghcr.io/silentely/ciao-cors:1.3.2"

[env]
  PORT = "3000"
  RESOURCE_PROFILE = "low-memory"

[[services]]
  internal_port = 3000
  protocol = "tcp"

  [[services.ports]]
    handlers = ["http"]
    port = 80

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443

  [[services.http_checks]]
    interval = "30s"
    method = "get"
    path = "/health"
    timeout = "5s"
```
运行 `fly deploy` 即可完成部署。

### 3. Northflank 部署

- 创建 **Deployment Service** -> 来源选择 **External Image**。
- 填写镜像：`ghcr.io/silentely/ciao-cors:1.3.2`。
- 端口配置：添加 HTTP 端口 `3000`，启用 Public 访问。
- 健康检查：路径设为 `/health`。
- 环境变量：设置 `RESOURCE_PROFILE=standard` 或 `low-memory`。

### 4. ClawCloud Run 部署

- 在 App/Container 创建界面输入镜像 `ghcr.io/silentely/ciao-cors:1.3.2`。
- 容器端口设置为 `3000`。
- 探针路径设置为 `/health`。

---

## 四、GHCR 镜像地址与发布规范

镜像托管于 GitHub Container Registry：
`ghcr.io/silentely/ciao-cors`

> [!TIP]
> **GHCR 公开权限提醒**：
> GitHub Actions 首次自动发布 Package 后，默认可能处于 Private 状态。
> 请前往 GitHub 组织/用户主页 -> **Packages** -> 点击 `ciao-cors` -> **Package settings** -> 最下方将其可见性切换为 **Public**，即可实现免密匿名拉取。

### 镜像标签规则
- `ghcr.io/silentely/ciao-cors:latest`：`main` 分支最新稳定构建（多架构 amd64/arm64）
- `ghcr.io/silentely/ciao-cors:1.3.2`：语义化正式版本（多架构）
- `ghcr.io/silentely/ciao-cors:1.3`、`1`：主要版本别名
- `ghcr.io/silentely/ciao-cors:1.3.2-amd64`：专为 Scaleway 等 x86_64 平台提供的单一架构标签
- `ghcr.io/silentely/ciao-cors:sha-<commit>`：与 Git Commit 绑定的不可变镜像版本，便于精确审计与回滚

---

## 五、完整环境变量参考

| 环境变量名 | 默认值 | low-memory 预设值 | 说明 |
|---|---|---|---|
| `PORT` | `3000` | `3000` | 服务监听端口（支持容器平台自动注入） |
| `HOST` | `0.0.0.0` | `0.0.0.0` | 绑定监听地址 |
| `RESOURCE_PROFILE` | `standard` | `low-memory` | 预设模式。设为 `low-memory` 自动将缓存/并发等调整为 128MB 优化值 |
| `PROXY_API_KEY` | *(未设置)* | *(未设置)* | **代理访问密钥**。配置后客户端必须带 `X-Proxy-Key` 或 `Proxy-Authorization` |
| `API_KEY` | *(未设置)* | *(未设置)* | **管理 API 密钥**。保护 `/_api/*` 路由 |
| `ENABLE_CACHE` | `true` | `true` | 是否启用内置 LRU 响应缓存 |
| `MAX_CACHE_ENTRIES` | `1000` | `32` | LRU 缓存条目上限 |
| `MAX_CACHE_BYTES` | `33554432` (32MB) | `8388608` (8MB) | 缓存占用的总内存字节上限 |
| `MAX_CACHE_ENTRY_BYTES` | `2097152` (2MB) | `262144` (256KB) | 单条响应能够进入缓存的最大字节数 |
| `CACHE_TTL` | `60000` (60s) | `15000` (15s) | 缓存有效时间（毫秒） |
| `RATE_LIMIT` | `2500` | `500` | 限流窗口内的单 IP 最大请求数 |
| `RATE_LIMIT_WINDOW` | `60000` (60s) | `60000` (60s) | 限流滑动时间窗口（毫秒） |
| `CONCURRENT_LIMIT` | `10` | `4` | 单 IP 最大允许的同时在途并发请求数 |
| `TOTAL_CONCURRENT_LIMIT` | `1000` | `16` | 实例全局最大允许的同时在途并发请求数 |
| `MAX_BODY_SIZE` | `10485760` (10MB) | `1048576` (1MB) | 请求体大小上限。超过立即中断流并返回 413 |
| `TIMEOUT` | `30000` (30s) | `30000` (30s) | 上游网络请求超时时间（毫秒） |
| `STREAM_IDLE_TIMEOUT` | `30000` (30s) | `30000` (30s) | 流式传输单 chunk 空闲超时时间（毫秒） |
| `ENABLE_STATS` | `true` | `true` | 是否启用实时统计数据收集 |
| `ENABLE_LOGGING` | `true` | `true` | 是否启用请求日志打印 |
| `LOG_WEBHOOK` | *(未设置)* | *(未设置)* | 批量异步发送日志的 Webhook 地址 |
| `REQUIRE_HEADERS` | `true` | `true` | 是否强制要求客户端提供 `Origin` 或 `X-Requested-With` 头部 |
| `REMOVE_ORIGIN_HEADER` | `false` | `false` | 转发上游请求时是否剥离 Origin 头（防止防盗链拦截） |
| `ENABLE_KEYWORD_BLOCK` | `true` | `true` | 是否拦截流媒体切片及高频滥用后缀 |
| `BLOCKED_KEYWORDS` | 默认切片关键字 | 默认切片关键字 | 自定义拦截关键字（JSON 数组或逗号分隔） |
| `DROP_HEADERS` | *(空)* | *(空)* | 自定义向上游转发时剔除的请求头列表（逗号分隔） |
| `TRUSTED_PROXIES` | *(空)* | *(空)* | 受信任的代理网段（CIDR 列表）。仅对受信对端解析 X-Forwarded-For |
| `FORWARD_SET_COOKIE` | `false` | `false` | 是否将目标服务的 `Set-Cookie` 头转发给客户端（默认 false 防污染） |
| `ENABLE_MANAGEMENT_API` | `true` | `true` | 是否开启 `/_api/*` 管理路由 |

---

## 六、代理使用说明

### 1. 基础请求格式

```bash
# 路径代理模式
https://your-proxy.com/{target-url}

# 参数代理模式
https://your-proxy.com/?url={target-url}
```

### 2. 携带代理访问密钥 (`PROXY_API_KEY`)

当服务端配置了 `PROXY_API_KEY=my-secret-key` 时：

```bash
# 推荐方式 1: 使用独立 X-Proxy-Key 请求头
curl -H "X-Proxy-Key: my-secret-key" \
     -H "Origin: https://my-frontend.com" \
     https://your-proxy.com/api.github.com/zen

# 推荐方式 2: 使用 Proxy-Authorization 请求头
curl -H "Proxy-Authorization: Bearer my-secret-key" \
     -H "Origin: https://my-frontend.com" \
     https://your-proxy.com/api.github.com/zen
```

> **注意**：`X-Proxy-Key` 会在转发前由代理服务彻底剥离，**绝不会传递给目标上游服务器**。客户端传给目标上游的业务 `Authorization` 头仍会完整、原样透传给目标服务器！

---

## 七、管理 API 与监控

设置 `API_KEY` 环境变量即可启用带鉴权保护的管理接口：

```bash
# 查看健康状态（包含系统内存 RSS 占用与 Profile）
GET /_api/health?key=your-admin-key

# 查看统计与 LRU 缓存指标（条目数与字节占用）
GET /_api/stats?key=your-admin-key

# 查看性能分析指标（每分钟请求数、平均耗时）
GET /_api/performance?key=your-admin-key

# 查看当前运行脱敏配置
GET /_api/config?key=your-admin-key

# 运行中热重载配置（重新加载环境变量）
GET /_api/reload-config?key=your-admin-key

# 清理内存响应缓存
GET /_api/clear-cache?key=your-admin-key
```

---

## 八、资源消耗实测与平台风险提示

### 实测资源基准（Docker Container 实测数据）

| 测试场景 | 规格限制 | 空闲 RSS | 20 并发请求活跃 RSS | 平均响应耗时 | 稳定性 / OOM 判定 |
|---|---|---|---|---|---|
| **极低规格 (low-memory)** | `--cpus=0.07 --memory=128m` | **16.63 MiB** | **21.60 MiB** | ~71ms | **稳定运行，0 次 OOM，内存利用率仅 16.8%** |
| **标准规格 (standard)** | `--cpus=0.25 --memory=256m` | **22.10 MiB** | **31.59 MiB** | ~63ms | **稳定运行，高富余** |

### 免费平台风险与计费须知
- **Scaleway 共享免费池**：Scaleway 账号每月提供 400,000 GB-s 与 200,000 vCPU-s 免费额度。单实例 70mVCPU/128MB 持续运行一个月消耗约 81% 内存额度与 90.7% CPU 额度。
- **并发与滚动发布注意**：在触发容器更新部署或账号内存在其他 Serverless 函数时，可能产生额外开销。**请结合个人用量监控账单，任何平台均不能保证绝对零费用**。

---

## 九、开源许可证

本项目采用 [Anti-Capitalist Software License](LICENSE)。
