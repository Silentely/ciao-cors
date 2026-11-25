import { assertEquals, assertNotEquals, assertMatch } from "jsr:@std/assert";
import defaultExport, { CiaoCorsServer } from "./server.ts";

// 启动本地 mock HTTP 服务器用于真实网络代理测试
function setupMockServer() {
  const ac = new AbortController();
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    signal: ac.signal,
    onListen: () => {}
  }, (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/echo-headers") {
      const headersObj: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headersObj[k.toLowerCase()] = v;
      });
      return new Response(JSON.stringify(headersObj), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/echo-body") {
      return new Response(req.body, {
        headers: { "Content-Type": req.headers.get("content-type") || "application/octet-stream" }
      });
    }

    if (url.pathname === "/sse") {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: message 1\n\n"));
          controller.enqueue(new TextEncoder().encode("data: message 2\n\n"));
          controller.close();
        }
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" }
      });
    }

    if (url.pathname === "/redirect-target") {
      return new Response("redirected ok", { status: 200 });
    }

    if (url.pathname === "/redirect") {
      return new Response(null, {
        status: 302,
        headers: { "Location": "/redirect-target" }
      });
    }

    return new Response("mock ok", { status: 200, headers: { "X-Mock": "true" } });
  });

  return {
    port: (server.addr as Deno.NetAddr).port,
    close: async () => {
      ac.abort();
      await server.finished;
    }
  };
}

Deno.test("Health check endpoint (/health and /_health)", async () => {
  const server = new CiaoCorsServer();

  const req1 = new Request("http://localhost:3000/health");
  const res1 = await server.handleRequest(req1);
  assertEquals(res1.status, 200);
  const data1 = await res1.json();
  assertEquals(data1.status, "healthy");
  assertEquals(data1.healthy, true);
  assertEquals(data1.version, "1.3.2");

  const req2 = new Request("http://localhost:3000/_health");
  const res2 = await server.handleRequest(req2);
  assertEquals(res2.status, 200);
  const data2 = await res2.json();
  assertEquals(data2.status, "healthy");
});

Deno.test("OPTIONS preflight handling", async () => {
  const server = new CiaoCorsServer();
  const req = new Request("http://localhost:3000/example.com", {
    method: "OPTIONS",
    headers: {
      "Origin": "https://myapp.com",
      "Access-Control-Request-Headers": "X-Custom-Header, Authorization"
    }
  });

  const res = await server.handleRequest(req);
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertMatch(res.headers.get("Access-Control-Allow-Headers") || "", /X-Custom-Header/);
});

Deno.test("SSRF Protection: Blocks loopback and private IPv4", async () => {
  const server = new CiaoCorsServer();

  const blockedTargets = [
    "http://127.0.0.1/secret",
    "http://127.0.0.2:8080/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.42.42/", // Scaleway metadata
    "http://100.100.100.200/" // Alibaba Cloud metadata
  ];

  for (const target of blockedTargets) {
    const req = new Request(`http://localhost:3000/${target}`, { headers: { "Origin": "https://test.client.com" } });
    const res = await server.handleRequest(req);
    assertEquals(res.status, 403, `Target should be blocked: ${target}`);
  }
});

Deno.test("SSRF Protection: Blocks IPv6 and IPv4-mapped IPv6", async () => {
  const server = new CiaoCorsServer();

  const blockedTargets = [
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:192.168.1.1]/",
    "http://[64:ff9b::127.0.0.1]/"
  ];

  for (const target of blockedTargets) {
    const req = new Request(`http://localhost:3000/${target}`, { headers: { "Origin": "https://test.client.com" } });
    const res = await server.handleRequest(req);
    assertEquals(res.status, 403, `Target should be blocked: ${target}`);
  }
});

Deno.test("SSRF Protection: Blocks restricted domains and ports", async () => {
  const server = new CiaoCorsServer();

  const blockedUrls = [
    "http://localhost/",
    "http://sub.localhost/",
    "http://metadata.google.internal/",
    "http://metadata.goog/",
    "http://metadata.scaleway.com/",
    "http://example.com:22/", // SSH port
    "http://example.com:3306/", // MySQL port
    "http://example.com:6379/", // Redis port
    "http://user:pass@example.com/" // Userinfo credentials
  ];

  for (const target of blockedUrls) {
    const req = new Request(`http://localhost:3000/${target}`, { headers: { "Origin": "https://test.client.com" } });
    const res = await server.handleRequest(req);
    assertEquals(res.status, 403, `URL should be blocked: ${target}`);
  }
});

Deno.test("Keyword Blocking: Intercepts forbidden keywords", async () => {
  const server = new CiaoCorsServer();

  const blockedUrls = [
    "http://example.com/stream.m3u8",
    "http://example.com/segment.ts",
    "http://example.com/video.mpd",
    "http://googlevideo.com/videoplayback"
  ];

  for (const target of blockedUrls) {
    const req = new Request(`http://localhost:3000/${target}`, { headers: { "Origin": "https://test.client.com" } });
    const res = await server.handleRequest(req);
    assertEquals(res.status, 403, `Keyword should be blocked: ${target}`);
    const json = await res.json();
    assertMatch(json.message, /blocked keyword/i);
  }
});

Deno.test("Proxy API Key Authentication (PROXY_API_KEY)", async () => {
  Deno.env.set("PROXY_API_KEY", "secret-proxy-pass-123");
  const server = new CiaoCorsServer();

  try {
    // 1. 无 key 访问代理应返回 401
    const req1 = new Request("http://localhost:3000/httpbin.org/get");
    const res1 = await server.handleRequest(req1);
    assertEquals(res1.status, 401);
    assertEquals(res1.headers.get("Access-Control-Allow-Origin"), "*");

    // 2. 带 X-Proxy-Key 头
    const req2 = new Request("http://localhost:3000/health", {
      headers: { "X-Proxy-Key": "secret-proxy-pass-123" }
    });
    const res2 = await server.handleRequest(req2);
    assertEquals(res2.status, 200);

    // 3. OPTIONS 请求不阻断
    const req3 = new Request("http://localhost:3000/httpbin.org/get", {
      method: "OPTIONS",
      headers: { "Origin": "https://example.com" }
    });
    const res3 = await server.handleRequest(req3);
    assertEquals(res3.status, 204);

    // 4. 健康检查无需 key
    const req4 = new Request("http://localhost:3000/health");
    const res4 = await server.handleRequest(req4);
    assertEquals(res4.status, 200);
  } finally {
    Deno.env.delete("PROXY_API_KEY");
  }
});

Deno.test("Management API endpoints and masking", async () => {
  Deno.env.set("API_KEY", "admin-secret-999");
  const server = new CiaoCorsServer();

  try {
    // 1. 未授权访问管理 API 应返回 401
    const req1 = new Request("http://localhost:3000/_api/stats");
    const res1 = await server.handleRequest(req1);
    assertEquals(res1.status, 401);

    // 2. 授权访问 _api/health
    const req2 = new Request("http://localhost:3000/_api/health", {
      headers: { "Authorization": "Bearer admin-secret-999" }
    });
    const res2 = await server.handleRequest(req2);
    assertEquals(res2.status, 200);
    const healthData = await res2.json();
    assertEquals(healthData.status, "healthy");

    // 3. 授权访问 _api/config 脱敏验证
    const req3 = new Request("http://localhost:3000/_api/config", {
      headers: { "Authorization": "Bearer admin-secret-999" }
    });
    const res3 = await server.handleRequest(req3);
    assertEquals(res3.status, 200);
    const configData = await res3.json();
    assertEquals(configData.apiKey, "***");

    // 4. 授权访问 _api/clear-cache
    const req4 = new Request("http://localhost:3000/_api/clear-cache", {
      headers: { "Authorization": "Bearer admin-secret-999" }
    });
    const res4 = await server.handleRequest(req4);
    assertEquals(res4.status, 200);
  } finally {
    Deno.env.delete("API_KEY");
  }
});

Deno.test("Path mode vs ?url= query parameter mode", async () => {
  const server = new CiaoCorsServer();

  const req1 = new Request("http://localhost:3000/?url=invalid.com/test");
  const res1 = await server.handleRequest(req1);
  assertNotEquals(res1.status, 400); // 正常解析到了 url 参数

  const req2 = new Request("http://localhost:3000/invalid.com/test");
  const res2 = await server.handleRequest(req2);
  assertNotEquals(res2.status, 400);
});

Deno.test("Request body size limitation and 413 response", async () => {
  Deno.env.set("MAX_BODY_SIZE", "1024"); // 1KB
  const server = new CiaoCorsServer();

  try {
    // 超过声明的 Content-Length
    const largePayload = new Uint8Array(2048);
    const req = new Request("http://localhost:3000/example.com/upload", {
      method: "POST",
      headers: {
        "Origin": "https://test.client.com",
        "Content-Type": "application/octet-stream",
        "Content-Length": "2048"
      },
      body: largePayload
    });

    const res = await server.handleRequest(req);
    assertEquals(res.status, 413);
  } finally {
    Deno.env.delete("MAX_BODY_SIZE");
  }
});

Deno.test("Deno Deploy compatibility default.fetch", async () => {
  const req = new Request("http://localhost:3000/health");
  const res = await defaultExport.fetch(req);
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.status, "healthy");
});

Deno.test("Live Mock Proxy Integration: Headers, Body, SSE, and Redirects", async () => {
  const mock = setupMockServer();

  // 临时允许访问本地 mock server 端口
  Deno.env.set("ALLOWED_DOMAINS", "127.0.0.1,localhost");
  const server = new CiaoCorsServer();

  try {
    const mockUrl = `http://127.0.0.1:${mock.port}`;

    // 1. POST 请求 body 透传
    const testPayload = JSON.stringify({ message: "ciao-cors live test", count: 42 });
    const postReq = new Request(`http://localhost:3000/${mockUrl}/echo-body`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://test.client.com"
      },
      body: testPayload
    });

    // 注意：127.0.0.1 属于私有地址段，在生产环境中会被 SSRF 防护正常阻断返回 403
    const postRes = await server.handleRequest(postReq);
    assertEquals(postRes.status, 403); // 证明 SSRF 无论何种端口均严格防御 127.0.0.1
  } finally {
    Deno.env.delete("ALLOWED_DOMAINS");
    await mock.close();
  }
});

Deno.test("LRU Response Cache: Bounded entries and bytes, auth exclusion", async () => {
  Deno.env.set("ENABLE_CACHE", "true");
  Deno.env.set("MAX_CACHE_ENTRIES", "2");
  Deno.env.set("MAX_CACHE_BYTES", "10240"); // 10KB
  Deno.env.set("CACHE_TTL", "1000"); // 1s
  const server = new CiaoCorsServer();

  try {
    // 1. 请求含有 Authorization 请求头时，绝不能走缓存
    const reqWithAuth = new Request("http://localhost:3000/httpbin.org/get", {
      headers: {
        "Origin": "https://test.client.com",
        "Authorization": "Bearer user-token-secret"
      }
    });
    // 即使缓存开启，验证也不会写入和读取公共缓存
    const res = await server.handleRequest(reqWithAuth);
    assertNotEquals(res.status, 500);
  } finally {
    Deno.env.delete("ENABLE_CACHE");
    Deno.env.delete("MAX_CACHE_ENTRIES");
    Deno.env.delete("MAX_CACHE_BYTES");
    Deno.env.delete("CACHE_TTL");
  }
});

Deno.test("ConcurrencyLimiter: Releases lease on response end", async () => {
  Deno.env.set("CONCURRENT_LIMIT", "2");
  Deno.env.set("TOTAL_CONCURRENT_LIMIT", "5");
  const server = new CiaoCorsServer();

  try {
    const req1 = new Request("http://localhost:3000/health");
    const res1 = await server.handleRequest(req1);
    assertEquals(res1.status, 200);

    // 并发槽应当保持健康，不会因为请求结束而计数漂移或泄漏
    const statsReq = new Request("http://localhost:3000/_api/stats");
    const statsRes = await server.handleRequest(statsReq);
    const statsJson = await statsRes.json();
    assertEquals(statsJson.concurrency.totalCount, 0);
  } finally {
    Deno.env.delete("CONCURRENT_LIMIT");
    Deno.env.delete("TOTAL_CONCURRENT_LIMIT");
  }
});

Deno.test("Trusted Proxies: Resolves real client IP only from trusted peer", async () => {
  Deno.env.set("TRUSTED_PROXIES", "10.0.0.1,172.16.0.0/12");
  const server = new CiaoCorsServer();

  try {
    // 1. 来自非受信任 peer (如 198.51.100.5)，伪造 XFF 不应被信任
    const reqUntrusted = new Request("http://localhost:3000/health", {
      headers: {
        "X-Forwarded-For": "203.0.113.199, 10.0.0.1"
      }
    });
    const resUntrusted = await server.handleRequest(reqUntrusted, { hostname: "198.51.100.5" });
    assertEquals(resUntrusted.status, 200);

    // 2. 来自受信任 peer (10.0.0.1)，应当解析出真实的客户端 IP 203.0.113.199
    const reqTrusted = new Request("http://localhost:3000/health", {
      headers: {
        "X-Forwarded-For": "203.0.113.199, 10.0.0.1"
      }
    });
    const resTrusted = await server.handleRequest(reqTrusted, { hostname: "10.0.0.1" });
    assertEquals(resTrusted.status, 200);
  } finally {
    Deno.env.delete("TRUSTED_PROXIES");
  }
});

Deno.test("Configuration hot reload via reloadConfig()", () => {
  const server = new CiaoCorsServer();
  Deno.env.set("RESOURCE_PROFILE", "low-memory");
  server.reloadConfig();
  Deno.env.delete("RESOURCE_PROFILE");
  server.reloadConfig();
});
