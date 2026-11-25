# Scaleway Serverless Containers 原地迁移部署指南

本文档提供将现有 Scaleway Serverless Container **原地替换（In-Place Replacement）**迁移至 `CIAO-CORS` 容器镜像的生产级操作指南。

> [!IMPORTANT]
> **原地迁移核心原则**：
> 迁移通过直接修改现有 Container 的 **Settings（设置）** 中的镜像地址、端口与环境变量完成，**严禁删除现有 Container 或重建云资源**。
> 从而百分之百保留原有的：
> - **Namespace** 与 **Container ID**
> - **Container 平台访问域名**（`*.functions.fnc.<region>.scw.cloud`）
> - **已绑定的自定义域名**（Custom Domains）与自动签发的 **HTTPS SSL 证书**
> - 依然生效的其他环境变量及密钥 Secrets

---

## 一、旧镜像配置清理与准备

在填入新镜像之前，必须检查并清理旧容器遗留的可能导致启动失败的配置：

1. **清理自定义 Command 与 Arguments**：
   - 在 Scaleway 控制台打开目标 Container -> 进入 **Settings** 选项卡 -> 展开 **Advanced options**。
   - 检查 **Command** 和 **Arguments** 字段：如果旧镜像曾填写自定义执行指令（例如 `node index.js` 或 `/bin/sh`），**必须清空**。新镜像使用官方 Deno 启动入口，保留旧命令会导致容器启动时找不到文件崩溃退出。
2. **确认外部 Registry 为 Public**：
   - 新镜像发布于 GitHub Container Registry：`ghcr.io/silentely/ciao-cors`。
   - 首次在 GitHub 上发布 Package 时，请在 GitHub 个人/组织主页的 `Packages` 页面将 `ciao-cors` 的可见性（Visibility）设置为 **Public**，这样 Scaleway 即可无需配置 Registry 认证密钥直接拉取。
   - 若镜像为 Private，需在 Scaleway Namespace 级别的 **Registry Credentials** 中添加 GitHub Personal Access Token (`read:packages` 权限)。
3. **检查平台端口与监听地址**：
   - 旧容器若配置为 8080 或 80，请确保在环境变量中配置 `PORT=8080` 或将 Scaleway 控制台的 **Port** 修改为 `3000`（两者需严格一致）。

---

## 二、Scaleway 控制台逐项配置表

在 Scaleway Console -> **Serverless Containers** -> 点击目标 Container -> **Settings**：

| 配置项 | 推荐填写值 | 说明 |
|---|---|---|
| **Container Image (URL)** | `ghcr.io/silentely/ciao-cors:1.3.2` 或 `ghcr.io/silentely/ciao-cors:1.3.2-amd64` | 生产环境推荐锁定具体版本 Tag 或 Immutable SHA，避免最新变更非预期覆盖。Scaleway x86 节点可选用专有 `-amd64` 标签 |
| **Port** | `3000` | 容器监听端口，必须与环境变量 `PORT` 一致（默认 3000） |
| **CPU Limit** | `70 mVCPU` (极低) 或 `140 mVCPU` (标准) | 70 mVCPU 满足个人轻量调用；高并发或大文件建议 140~250 mVCPU |
| **Memory Limit** | `128 MB` (极低) 或 `256 MB` (标准) | 搭配 `RESOURCE_PROFILE=low-memory` 时实测内存占用仅 16~22MB |
| **Min Scale** | `1` (常驻保活) 或 `0` (按需休眠) | 详见下方方案对比 |
| **Max Scale** | `1` | 个人使用场景固定单实例，避免并发产生额外计费 |
| **Max Concurrency** | `8` ~ `16` | 单实例同时处理的最大请求数。128MB 规格建议 `8` |
| **Timeout** | `30s` | 请求处理超时时间，需大于等于应用内部 `TIMEOUT` |
| **Protocol** | `HTTP1` | 标准 HTTP 代理协议（支持 HTTP/1.1 SSE 流式） |
| **Sandbox** | `Sandbox v2` | Scaleway 最新运行沙箱，启动更快、内存占用更低 |
| **Health Check (Path)** | `/health` | 本地健康检查探针，零外部依赖，极速响应 200 |
| **Health Check Interval** | `30s` | 探针探测周期 |

### 环境变量与 Secrets 配置

在 **Environment variables** 选项卡下配置：

| 变量名 | 推荐值 | 说明 |
|---|---|---|
| `RESOURCE_PROFILE` | `low-memory` (128MB 时必选) | 启用低内存配置预设（条目 32、容量 8MB、并发 4/16、body 1MB） |
| `PORT` | `3000` | 保持与控制台 Port 设定一致 |
| `REQUIRE_HEADERS` | `true` (或 `false`) | 是否强制要求客户端提供 Origin 或 X-Requested-With |
| `ENABLE_CACHE` | `true` | 是否启用内置 LRU 响应缓存 |
| `ENABLE_KEYWORD_BLOCK` | `true` | 是否阻断流媒体切片及高频滥用关键字（如 .m3u8, .ts 等） |
| `TRUSTED_PROXIES` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | Scaleway 平台网关转发时信任内网反向代理头 |

在 **Secrets** 选项卡下安全配置（加密存储，不在控制台日志明文打印）：

| Secret 变量名 | 说明 |
|---|---|
| `PROXY_API_KEY` | *(可选)* 代理访问专用密钥。配置后客户端需在 `X-Proxy-Key` 或 `Proxy-Authorization` 头中携带，与上游 `Authorization` 完全隔离 |
| `API_KEY` | *(可选)* 管理接口专用密钥。保护 `/_api/stats`, `/_api/config`, `/_api/clear-cache` 等运维路由 |

---

## 三、两套精选部署方案

### 方案 A：最低规格常驻模式（推荐个人日常低延迟使用）
- **规格**：70 mVCPU / 128 MB RAM
- **弹性配置**：`Min Scale = 1`，`Max Scale = 1`
- **环境变量**：`RESOURCE_PROFILE=low-memory`
- **特点**：
  - 常驻运行，**无冷启动延迟**（零秒唤醒）。
  - 实测内存仅 **16.6 MB ~ 21.6 MB**，安全富余度超 80%，坚决不发生 OOM。
  - 单实例最大并发可承载 8~16 个同时请求。

### 方案 B：按需弹性休眠模式（零流量时极致省量）
- **规格**：140 mVCPU / 256 MB RAM
- **弹性配置**：`Min Scale = 0`，`Max Scale = 1`
- **环境变量**：`RESOURCE_PROFILE=standard`
- **特点**：
  - 无请求时自动缩容至 0 实例，不产生运行时长计费。
  - 发生调用时触发冷启动（借助 Sandbox v2，冷启动约 1.2s~2s）。
  - 适合调用频次极低（如每天仅几次）的极客场景。

---

## 四、免费额度、共享池与成本核实

根据 Scaleway 官方最新计费模型：
1. **免费额度范围**：
   - 每个 Scaleway 组织账号每月享有 **400,000 GB-秒** 的内存额度和 **200,000 vCPU-秒** 的计算额度。
   - **注意：此免费池由同一个账号下的所有 Serverless Functions 与 Serverless Containers 共同共享**。
2. **常驻单实例（方案 A）消耗测算**：
   - 128 MB（0.125 GB）× 70 mVCPU（0.07 vCPU）持续运行 30 天（2,592,000 秒）：
     - 内存消耗：$0.125 \times 2,592,000 = 324,000\text{ GB-s}$（占月免费额度的 81%）
     - CPU 消耗：$0.07 \times 2,592,000 = 181,440\text{ vCPU-s}$（占月免费额度的 90.7%）
   - **风险提醒**：如果在该账号下还部署了其他无服务器函数/容器，或者在**滚动发布更新时（新旧版本并发运行过渡阶段）**，短时间内产生的总资源可能轻微超出免费池，超额部分将按平台极低费率计费。因此**不能断言所有场景下均为绝对零费用**。

---

## 五、手动部署、版本更新与回滚

### 1. 手动应用更改（Redeploy）
在控制台修改完 Settings 之后，点击页面右上角的 **Deploy container** 或 **Redeploy** 按钮。
Scaleway 将启动一个新实例拉取新镜像，健康检查 `/health` 返回 200 成功后，自动将流量无缝平滑切至新实例，旧实例优雅退出。

### 2. 版本升级
当有新版本发布时（例如 `1.4.0`）：
只需进入 Settings 将镜像地址修改为 `ghcr.io/silentely/ciao-cors:1.4.0`（或对应的 commit SHA），点击 **Deploy** 即可。

### 3. 一键快速回滚
若新部署的镜像出现业务不兼容：
- **方案一（推荐）**：在 Settings 中将 Image URL 改回上一版本的固定标签（如 `1.3.2`）或 Digest，点击 **Redeploy**。
- **方案二（按 SHA 回滚）**：填入上一稳定版本的 SHA 镜像标签（例如 `ghcr.io/silentely/ciao-cors:sha-768495c`）。

---

## 六、原地自动化维护脚本 (`scripts/scaleway-update.sh`)

如果偏好通过命令行维护，项目提供了具备安全防护机制的更新脚本：

```bash
# 1. 默认预览模式 (dry-run)，仅检查并展示修改项与当前配置备份，不执行写入
./scripts/scaleway-update.sh \
  --region nl-ams \
  --container-id <YOUR-CONTAINER-ID> \
  --image ghcr.io/silentely/ciao-cors:1.3.2

# 2. 确认无误后添加 --apply 执行原地热更新
./scripts/scaleway-update.sh \
  --region nl-ams \
  --container-id <YOUR-CONTAINER-ID> \
  --image ghcr.io/silentely/ciao-cors:1.3.2 \
  --apply
```

### 脚本安全保证
- **绝不创建、删除或重建云资源**，仅对指定的 Container ID 执行 PATCH 更新。
- 执行前自动将现有容器配置导出备份至本地 `/tmp/scaleway-container-backup-*.json`。
- 自动检测并提醒旧 Command / Arguments 遗留问题。
- 部署后自动轮询 `/health` 验证可用性。
