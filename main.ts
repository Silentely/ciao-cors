/**
 * CIAO-CORS - 主动启动入口
 *
 * 与 server.ts 的请求处理逻辑分离：server.ts 保留托管运行时所需的默认 `{ fetch }`
 * 导出，本文件仅负责在当前进程内启动 HTTP 服务。Deno CLI 只对直接运行的入口模块
 * 检查默认 fetch 导出，因此通过本入口启动不会再出现 `deno serve` 提示。
 *
 * 作者: Silentely
 * 项目: https://github.com/Silentely/ciao-cors
 */
import { startServer } from './server.ts';

await startServer();
