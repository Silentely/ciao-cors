# CIAO-CORS

高性能、开箱即用的跨平台 CORS 跨域代理服务。支持标准 **Docker 容器**、**Scaleway Serverless Containers 原地平滑迁移**、**Fly.io**、**Northflank**、**ClawCloud Run**、**Deno Deploy** 以及普通 **Linux VPS** 部署。

> 💖 **致谢与鸣谢**：
> 本项目基于 **[bestZwei/ciao-cors](https://github.com/bestZwei/ciao-cors)** 进行全方位升级，在保留原项目完备功能的基础上，进行了**生产级 Docker 容器化重构**、**Scaleway 极低资源（128MB）专项优化**与**全链路安全加固**。
> 感谢 **[DreamCloud](https://whmcs.as211392.com)** 为原项目提供的服务器与高防演示支持。

---

## ✨ 本项目核心增强与特性

相比原版，本项目针对生产环境（特别是低成本云容器与 Serverless 环境）进行了深度打磨：

- 🐳 **生产级 Docker 容器化**：基于官方 Deno 2 稳定版镜像，非 root 安全用户运行，内置零外部网络依赖的健康检查探针（`/health`），多架构（`linux/amd64` 与 `linux/arm64`）自动发布。
- 🚀 **Scaleway 极致低内存适配**：专为 **70mVCPU / 128MB RAM** 极低规格调优（`RESOURCE_PROFILE=low-memory`），实测常驻内存仅 **16.6 MB ~ 21.6 MB**，安全富余度超 80%，永不 OOM。
- 🔄 **Scaleway 现存容器原地替换**：无需删除重建云资源，仅需在现有 Container 的 Settings 中替换镜像地址，即可保留原有 Container ID、访问链接、自定义域名及 SSL 证书。
- 📦 **双重有界 LRU 缓存**：同时限制最大条目数与内存总字节数。采用旁路 Tap 采集，彻底杜绝原有 `Response.clone()` 带来的内存无界膨胀；自动隔离 Authorization 与 Set-Cookie，防跨用户缓存污染。
- 🛡️ **严格 SSRF 深度防御**：完整拦截 IPv4、IPv6、IPv4-mapped IPv6、NAT64、6to4、链路本地及保留网段；精准阻断云厂商内部元数据（Scaleway `169.254.42.42`、AWS/GCP `169.254.169.254` 等）；DNS 解析坚持 fail-closed 策略（解析失败立即拦截，杜绝绕过）。
- ⚡ **流式防打爆与精准并发控制**：超大 chunked 上传实时按块统计，超限立即中断并返回 413；并发计数与流生命周期（SSE、长连接）强绑定，彻底解决计数漂移。
- 🔑 **独立代理访问鉴权**：新增可选的 `PROXY_API_KEY`（支持 `X-Proxy-Key` 或 `Proxy-Authorization`），不污染客户端发向上游的真实 `Authorization` 请求头，浏览器 OPTIONS 预检自动友好放行。

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
  ghcr.io/silentely/ciao-cors:1.3.2

# 低内存模式启动（限制 128MB 内存，适合极低配 VPS）
docker run -d \
  --name ciao-cors \
  --memory=128m \
  --cpus=0.07 \
  -e RESOURCE_PROFILE=low-memory \
  -p 3000:3000 \
  ghcr.io/silentely/ciao-cors:1.3.2
```

#### 2. Docker Compose 启动
使用项目自带的 [`compose.yaml`](compose.yaml)：
```bash
docker compose up -d
```

---

### 方案 B：Scaleway Serverless Containers 原地迁移

如果您在 Scaleway 上已经有一个正在运行的旧容器，**无需删除或重新创建**，只需 3 步即可完成原地平滑迁移（**保留原域名、Container ID 与 HTTPS 证书**）：

1. 打开 Scaleway 控制台 -> 进入您的 Container -> 点击 **Settings**。
2. 在 **Advanced options** 中清空可能残留的旧 **Command** 和 **Arguments**。
3. 修改配置：
   - **Image URL**: `ghcr.io/silentely/ciao-cors:1.3.2-amd64`（或 `1.3.2`）
   - **Port**: `3000`
   - **CPU / Memory**: `70 mVCPU` / `128 MB`（常驻推荐）或 `140 mVCPU` / `256 MB`
   - **Environment Variables**: 添加 `RESOURCE_PROFILE` = `low-memory`
   - **Health check path**: `/health`
4. 点击右上角 **Deploy container**（或 Redeploy）即可！

> 📖 详细的分步说明、两套部署方案（常驻模式 vs 按需休眠模式）及免费额度测算，请参阅：  
> **[Scaleway 原地替换部署手册 (docs/deploy/scaleway.md)](docs/deploy/scaleway.md)**

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
| `RESOURCE_PROFILE` | `standard` | **资源配置模式**。在 128MB 容器中请设为 `low-memory` |
| `PROXY_API_KEY` | *(未设置)* | **代理使用密钥**。配置后客户端必须携带此密钥才允许代理 |
| `API_KEY` | *(未设置)* | **管理接口密钥**。保护 `/_api/stats`、`/_api/config` 等运维接口 |
| `ENABLE_CACHE` | `true` | 是否启用内置 GET 响应缓存 |
| `REQUIRE_HEADERS` | `true` | 是否要求客户端携带 `Origin` 或 `X-Requested-With` 头部 |
| `REMOVE_ORIGIN_HEADER` | `false` | 转发上游时是否去除 Origin 头（防目标网站防盗链拦截） |
| `ENABLE_KEYWORD_BLOCK` | `true` | 是否拦截常见流媒体切片及高频滥用链接（如 `.m3u8`, `.ts` 等） |
| `ALLOWED_DOMAINS` | *(未设置)* | 允许代理的目标域名白名单（逗号分隔，如 `api.github.com,httpbin.org`） |
| `BLOCKED_DOMAINS` | *(未设置)* | 禁止代理的目标域名黑名单（逗号分隔） |
| `ALLOWED_ORIGINS` | *(未设置)* | 允许访问本代理的前端 Origin 域名（支持 `*` 或特定域名） |
| `TRUSTED_PROXIES` | *(未设置)* | 受信的反向代理 IP/CIDR 列表（用于准确获取客户端真实 IP） |

---

## 🛠️ 管理与运维 API

如果您配置了 `API_KEY=your-secret-key`，可以通过管理接口监控与维护服务：

- **健康状态**：`GET /_api/health?key=your-secret-key`（查看服务状态与内存 RSS）
- **性能统计**：`GET /_api/stats?key=your-secret-key`（查看请求数、耗时与缓存占用）
- **在线重载配置**：`GET /_api/reload-config?key=your-secret-key`
- **清理内存缓存**：`GET /_api/clear-cache?key=your-secret-key`
- **查看脱敏配置**：`GET /_api/config?key=your-secret-key`

---

## 📄 镜像发布与开源协议

- **容器镜像仓库**：`ghcr.io/silentely/ciao-cors`
- **开源许可证**：本项目采用 [Anti-Capitalist Software License](LICENSE)。
