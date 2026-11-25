import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import defaultExport, {
  buildProxyHeaders,
  buildTargetPath,
  ByteLRUCache,
  CiaoCorsServer,
  isPrivateOrReservedIP,
  isTrustedIP,
  loadConfig,
  processRequestBody,
  resolveClientIP,
  stripQueryParam,
  type CachedResponseEntry,
  type Config,
} from "./server.ts";

// ==================== 测试辅助 ====================

/**
 * 替换 DNS 解析与 fetch，避免测试依赖外部网络。
 * 所有测试使用互不相同的域名，防止模块级 DNS 缓存串场。
 */
function installNetworkStub(handler?: (url: string) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  const originalResolveDns = (Deno as any).resolveDns;
  const calls: string[] = [];

  (Deno as any).resolveDns = (_hostname: string, recordType: string) =>
    Promise.resolve(recordType === "A" ? ["93.184.216.34"] : []);
  (globalThis as any).fetch = (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (handler) {
      return Promise.resolve(handler(url));
    }
    return Promise.resolve(new Response("stub-body", {
      status: 200,
      headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=60" },
    }));
  };

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      (Deno as any).resolveDns = originalResolveDns;
    },
  };
}

/**
 * 以指定的环境变量构造服务器，结束后恢复环境并释放定时器
 */
async function withServer(env: Record<string, string>, fn: (server: CiaoCorsServer) => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }

  const server = new CiaoCorsServer();
  try {
    await fn(server);
  } finally {
    server.cleanup();
    for (const [key, value] of previous) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

function cacheEntry(body: string, overrides: Partial<CachedResponseEntry> = {}): CachedResponseEntry {
  const bytes = new TextEncoder().encode(body);
  return {
    status: 200,
    statusText: "OK",
    headers: [["content-type", "text/plain"]],
    body: bytes,
    timestamp: Date.now(),
    size: bytes.byteLength + 512,
    vary: {},
    ...overrides,
  };
}

// ==================== 健康检查与基础路由 ====================

Deno.test("Health check endpoint (/health and /_health)", async () => {
  await withServer({}, async (server) => {
    const res1 = await server.handleRequest(new Request("http://localhost:3000/health"));
    assertEquals(res1.status, 200);
    const data1 = await res1.json();
    assertEquals(data1.status, "healthy");
    assertEquals(data1.healthy, true);
    assertMatch(data1.version, /^\d+\.\d+\.\d+$/);

    const res2 = await server.handleRequest(new Request("http://localhost:3000/_health"));
    assertEquals(res2.status, 200);
    const data2 = await res2.json();
    assertEquals(data2.status, "healthy");
  });
});

Deno.test("OPTIONS preflight handling", async () => {
  await withServer({}, async (server) => {
    const req = new Request("http://localhost:3000/example.com", {
      method: "OPTIONS",
      headers: {
        "Origin": "https://myapp.com",
        "Access-Control-Request-Headers": "X-Custom-Header, Authorization",
      },
    });

    const res = await server.handleRequest(req);
    assertEquals(res.status, 204);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
    assertMatch(res.headers.get("Access-Control-Allow-Headers") || "", /X-Custom-Header/);
  });
});

Deno.test("Path mode vs ?url= query parameter mode", () => {
  const pathUrl = new URL("http://localhost:3000/httpbin.org/get?a=1&b=2");
  assertEquals(buildTargetPath(pathUrl, false), "httpbin.org/get?a=1&b=2");

  const encodedUrl = new URL("http://localhost:3000/https%3A%2F%2Fhttpbin.org%2Fget%3Fa%3D1");
  assertEquals(buildTargetPath(encodedUrl, false), "https://httpbin.org/get?a=1");

  const queryMode = new URL("http://localhost:3000/?url=%20httpbin.org%2Fget%3Fa%3D1%20");
  assertEquals(buildTargetPath(queryMode, false), "httpbin.org/get?a=1");
});

Deno.test("Proxy key is stripped from forwarded target URL", () => {
  const url = new URL("http://localhost:3000/upstream-strip.example.net/data?proxy_key=secret&keep=1");
  assertEquals(buildTargetPath(url, true), "upstream-strip.example.net/data?keep=1");
  assertEquals(buildTargetPath(url, false), "upstream-strip.example.net/data?proxy_key=secret&keep=1");
});

Deno.test("stripQueryParam preserves other parameters and encoding", () => {
  assertEquals(stripQueryParam("?proxy_key=x&a=1&b=2", "proxy_key"), "?a=1&b=2");
  assertEquals(stripQueryParam("?a=1&proxy_key=x&b=2", "proxy_key"), "?a=1&b=2");
  assertEquals(stripQueryParam("?a=1&proxy_key=x", "proxy_key"), "?a=1");
  assertEquals(stripQueryParam("?proxy_key=x", "proxy_key"), "");
  assertEquals(stripQueryParam("", "proxy_key"), "");
  assertEquals(stripQueryParam("?a=%2F&proxy_key=x&b=1+2", "proxy_key"), "?a=%2F&b=1+2");
  assertEquals(stripQueryParam("?proxy%5Fkey=x&a=1", "proxy_key"), "?a=1");
});

// ==================== SSRF 与安全防护 ====================

Deno.test("SSRF Protection: Blocks loopback and private IPv4", async () => {
  await withServer({}, async (server) => {
    const blockedTargets = [
      "http://127.0.0.1/secret",
      "http://127.0.0.2:8080/",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.42.42/", // Cloud metadata
      "http://100.100.100.200/", // Alibaba Cloud metadata
    ];

    for (const target of blockedTargets) {
      const req = new Request(`http://localhost:3000/${target}`, { headers: { "Origin": "https://test.client.com" } });
      const res = await server.handleRequest(req);
      assertEquals(res.status, 403, `Target should be blocked: ${target}`);
    }
  });
});

Deno.test("SSRF Protection: Blocks IPv6 and IPv4-mapped IPv6", async () => {
  await withServer({}, async (server) => {
    const blockedTargets = [
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:192.168.1.1]/",
      "http://[64:ff9b::127.0.0.1]/",
    ];

    for (const target of blockedTargets) {
      const req = new Request(`http://localhost:3000/${target}`, { headers: { "Origin": "https://test.client.com" } });
      const res = await server.handleRequest(req);
      assertEquals(res.status, 403, `Target should be blocked: ${target}`);
    }
  });
});

Deno.test("SSRF Protection: Blocks restricted domains, ports and userinfo", async () => {
  await withServer({}, async (server) => {
    const blockedUrls = [
      "http://localhost/",
      "http://sub.localhost/",
      "http://metadata.google.internal/",
      "http://metadata.goog/",
      "http://8.8.8.8:22/", // SSH port (direct IP avoids DNS)
      "http://8.8.8.8:3306/", // MySQL port
      "http://8.8.8.8:6379/", // Redis port
      "http://user:pass@8.8.8.8/", // Userinfo credentials
    ];

    for (const target of blockedUrls) {
      const req = new Request(`http://localhost:3000/${target}`, { headers: { "Origin": "https://test.client.com" } });
      const res = await server.handleRequest(req);
      assertEquals(res.status, 403, `URL should be blocked: ${target}`);
    }
  });
});

Deno.test("SSRF Protection: Blocks 6to4 private IPv4 embedding", async () => {
  await withServer({}, async (server) => {
    const req = new Request("http://localhost:3000/http://[2002:7f00:0001::]/", {
      headers: { "Origin": "https://test.client.com" },
    });
    const res = await server.handleRequest(req);
    assertEquals(res.status, 403);
  });
});

Deno.test("SSRF: ALLOWED_DOMAINS does not bypass private IP blocking", async () => {
  await withServer({ ALLOWED_DOMAINS: "127.0.0.1,localhost" }, async (server) => {
    const req = new Request("http://localhost:3000/http://127.0.0.1:8080/", {
      headers: { "Origin": "https://test.client.com" },
    });
    const res = await server.handleRequest(req);
    assertEquals(res.status, 403);
  });
});

Deno.test("SSRF Protection: blocks redirects to private addresses", async () => {
  const stub = installNetworkStub(() =>
    new Response(null, {
      status: 302,
      headers: { Location: "http://169.254.169.254/latest/meta-data/" },
    })
  );

  try {
    await withServer({ REQUIRE_HEADERS: "false", ENABLE_LOGGING: "false" }, async (server) => {
      const res = await server.handleRequest(new Request("http://localhost:3000/redirect.example.com/start"));
      assertEquals(res.status, 500);
      const body = await res.json();
      assertEquals(body.error, true);
      assertMatch(body.message, /Redirect blocked/);
      assertEquals(stub.calls.length, 1, "redirect target must not be fetched");
    });
  } finally {
    stub.restore();
  }
});

Deno.test("Proxy retries transient 502 responses", async () => {
  let calls = 0;
  const stub = installNetworkStub(() => {
    calls++;
    return calls === 1
      ? new Response("upstream down", { status: 502, headers: { "Content-Type": "text/plain" } })
      : new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
  });

  try {
    await withServer({ REQUIRE_HEADERS: "false", ENABLE_LOGGING: "false" }, async (server) => {
      const res = await server.handleRequest(new Request("http://localhost:3000/retry.example.com/"));
      assertEquals(res.status, 200);
      assertEquals(await res.text(), "ok");
    });
    assertEquals(calls, 2, "502 should be retried exactly once");
  } finally {
    stub.restore();
  }
});

Deno.test("isPrivateOrReservedIP: IPv4 matrix", () => {
  const blocked = [
    "0.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "100.100.100.200",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.5",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "0177.0.0.1", // 八进制混淆，无法解析时应 fail-closed
    "not-an-ip",
  ];
  for (const ip of blocked) {
    assertEquals(isPrivateOrReservedIP(ip), true, `${ip} should be blocked`);
  }

  const allowed = ["1.1.1.1", "8.8.8.8", "11.0.0.1", "93.184.216.34", "100.128.0.1", "172.32.0.1"];
  for (const ip of allowed) {
    assertEquals(isPrivateOrReservedIP(ip), false, `${ip} should be allowed`);
  }
});

Deno.test("isPrivateOrReservedIP: IPv6 and IPv4-mapped matrix", () => {
  const blocked = [
    "::",
    "::1",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "100::1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.1.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2002:c0a8:101::",
  ];
  for (const ip of blocked) {
    assertEquals(isPrivateOrReservedIP(ip), true, `${ip} should be blocked`);
  }

  const allowed = ["2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::"];
  for (const ip of allowed) {
    assertEquals(isPrivateOrReservedIP(ip), false, `${ip} should be allowed`);
  }
});

Deno.test("isTrustedIP: exact IP and IPv4 CIDR", () => {
  assertEquals(isTrustedIP("10.0.0.1", ["10.0.0.1"]), true);
  assertEquals(isTrustedIP("10.0.0.2", ["10.0.0.1"]), false);
  assertEquals(isTrustedIP("10.9.9.9", ["10.0.0.0/8"]), true);
  assertEquals(isTrustedIP("11.0.0.1", ["10.0.0.0/8"]), false);
  assertEquals(isTrustedIP("172.31.0.1", ["172.16.0.0/12"]), true);
  assertEquals(isTrustedIP("172.32.0.1", ["172.16.0.0/12"]), false);
  assertEquals(isTrustedIP("198.51.100.7", ["*"]), true);
  assertEquals(isTrustedIP("[::1]", ["::1"]), true);
  assertEquals(isTrustedIP("10.0.0.1", []), false);
});

Deno.test("resolveClientIP: only trusts forwarding headers from trusted peers", () => {
  const originalTrusted = Deno.env.get("TRUSTED_PROXIES");
  Deno.env.set("TRUSTED_PROXIES", "10.0.0.1,172.16.0.0/12");
  const config: Config = loadConfig();

  try {
    const spoofed = new Request("http://localhost/", {
      headers: {
        "X-Forwarded-For": "203.0.113.199, 10.0.0.1",
        "X-Real-IP": "203.0.113.200",
        "CF-Connecting-IP": "203.0.113.201",
      },
    });
    // 非受信对端：忽略所有转发头
    assertEquals(resolveClientIP(spoofed, { hostname: "198.51.100.5" }, config), "198.51.100.5");

    // 受信对端：优先 CF-Connecting-IP
    assertEquals(resolveClientIP(spoofed, { hostname: "10.0.0.1" }, config), "203.0.113.201");

    const xffOnly = new Request("http://localhost/", {
      headers: { "X-Forwarded-For": "203.0.113.199, 172.16.0.9" },
    });
    assertEquals(resolveClientIP(xffOnly, { hostname: "10.0.0.1" }, config), "203.0.113.199");

    // 无 remoteAddr（Deno Deploy）：回退到请求头
    assertEquals(resolveClientIP(xffOnly, undefined, config), "203.0.113.199");
  } finally {
    if (originalTrusted === undefined) {
      Deno.env.delete("TRUSTED_PROXIES");
    } else {
      Deno.env.set("TRUSTED_PROXIES", originalTrusted);
    }
  }
});

// ==================== 鉴权与管理接口 ====================

Deno.test("Proxy API Key Authentication (PROXY_API_KEY)", async () => {
  await withServer({ PROXY_API_KEY: "secret-proxy-pass-123", ENABLE_LOGGING: "false" }, async (server) => {
    // 1. 无 key 访问代理应返回 401
    const res1 = await server.handleRequest(new Request("http://localhost:3000/httpbin.org/get"));
    assertEquals(res1.status, 401);
    assertEquals(res1.headers.get("Access-Control-Allow-Origin"), "*");

    // 2. 正确 key + 内网目标：通过鉴权后由 SSRF 防护返回 403
    const res2 = await server.handleRequest(new Request("http://localhost:3000/http://127.0.0.1/", {
      headers: { "X-Proxy-Key": "secret-proxy-pass-123" },
    }));
    assertEquals(res2.status, 403);

    // 3. OPTIONS 请求不阻断
    const res3 = await server.handleRequest(new Request("http://localhost:3000/httpbin.org/get", {
      method: "OPTIONS",
      headers: { "Origin": "https://example.com" },
    }));
    assertEquals(res3.status, 204);

    // 4. 健康检查无需 key
    const res4 = await server.handleRequest(new Request("http://localhost:3000/health"));
    assertEquals(res4.status, 200);
  });
});

Deno.test("Proxy API Key: query-string key authenticates and is not forwarded upstream", async () => {
  const stub = installNetworkStub();
  try {
    await withServer({ PROXY_API_KEY: "query-secret", ENABLE_LOGGING: "false", ENABLE_CACHE: "false", REQUIRE_HEADERS: "false" }, async (server) => {
      const res = await server.handleRequest(new Request(
        "http://localhost:3000/upstream-query-key.example.net/data?proxy_key=query-secret&keep=1",
      ));
      assertEquals(res.status, 200);
      assertEquals(stub.calls[0], "https://upstream-query-key.example.net/data?keep=1");
    });
  } finally {
    stub.restore();
  }
});

Deno.test("Management API endpoints, masking and auth", async () => {
  await withServer({ API_KEY: "admin-secret-999", ENABLE_LOGGING: "false" }, async (server) => {
    // 1. 未授权访问管理 API 应返回 401
    const res1 = await server.handleRequest(new Request("http://localhost:3000/_api/stats"));
    assertEquals(res1.status, 401);

    // 2. 授权访问 _api/health
    const res2 = await server.handleRequest(new Request("http://localhost:3000/_api/health", {
      headers: { "Authorization": "Bearer admin-secret-999" },
    }));
    assertEquals(res2.status, 200);
    const healthData = await res2.json();
    assertEquals(healthData.status, "healthy");

    // 3. 授权访问 _api/config 脱敏验证
    const res3 = await server.handleRequest(new Request("http://localhost:3000/_api/config", {
      headers: { "Authorization": "Bearer admin-secret-999" },
    }));
    assertEquals(res3.status, 200);
    const configData = await res3.json();
    assertEquals(configData.apiKey, "***");

    // 4. 授权访问 _api/clear-cache
    const res4 = await server.handleRequest(new Request("http://localhost:3000/_api/clear-cache", {
      headers: { "Authorization": "Bearer admin-secret-999" },
    }));
    assertEquals(res4.status, 200);
  });
});

Deno.test("Management API routing: tolerates trailing slash", async () => {
  await withServer({ ENABLE_LOGGING: "false" }, async (server) => {
    const res = await server.handleRequest(new Request("http://localhost:3000/_api/health/"));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.status, "healthy");
  });
});

Deno.test("Management API can be disabled", async () => {
  await withServer({ ENABLE_MANAGEMENT_API: "false", ENABLE_LOGGING: "false" }, async (server) => {
    const res = await server.handleRequest(new Request("http://localhost:3000/_api/health"));
    assertEquals(res.status, 404);
  });
});

// ==================== 请求体限制 ====================

Deno.test("Request body size limitation and 413 response", async () => {
  await withServer({ MAX_BODY_SIZE: "1024", ENABLE_LOGGING: "false" }, async (server) => {
    const req = new Request("http://localhost:3000/8.8.8.8/upload", {
      method: "POST",
      headers: {
        "Origin": "https://test.client.com",
        "Content-Type": "application/octet-stream",
        "Content-Length": "2048",
      },
      body: new Uint8Array(2048),
    });

    const res = await server.handleRequest(req);
    assertEquals(res.status, 413);
  });
});

Deno.test("processRequestBody: rejects oversized streamed body", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(800));
      controller.enqueue(new Uint8Array(800));
      controller.close();
    },
  });
  const req = new Request("http://localhost/upload", { method: "POST", body: stream });

  await assertRejects(
    () => processRequestBody(req, 1024),
    Error,
    "Request body too large",
  );
});

// ==================== 代理行为 ====================

Deno.test("buildProxyHeaders: strips hop-by-hop and proxy credentials", () => {
  const headers = new Headers({
    "Origin": "https://client.example",
    "Authorization": "Bearer user-token",
    "Cookie": "session=abc",
    "X-Proxy-Key": "proxy-secret",
    "Proxy-Authorization": "Bearer proxy-secret",
    "X-Forwarded-For": "203.0.113.5",
    "CF-Connecting-IP": "203.0.113.5",
    "Connection": "keep-alive",
    "Content-Length": "10",
    "X-Remove-Origin": "true",
  });

  const result = buildProxyHeaders(headers);
  assertEquals(result.get("origin"), null);
  assertEquals(result.get("x-proxy-key"), null);
  assertEquals(result.get("proxy-authorization"), null);
  assertEquals(result.get("x-forwarded-for"), null);
  assertEquals(result.get("cf-connecting-ip"), null);
  assertEquals(result.get("connection"), null);
  assertEquals(result.get("content-length"), null);
  assertEquals(result.get("x-remove-origin"), null);
  assertEquals(result.get("authorization"), "Bearer user-token");
  assertEquals(result.get("cookie"), "session=abc");
  assertEquals(result.get("user-agent") !== null, true);
  assertEquals(result.get("accept") !== null, true);
  assertEquals(result.get("accept-encoding"), "gzip, deflate, br");
});

Deno.test("buildProxyHeaders: honours REMOVE_ORIGIN_HEADER and DROP_HEADERS", () => {
  const originalDrop = Deno.env.get("DROP_HEADERS");
  const originalRemove = Deno.env.get("REMOVE_ORIGIN_HEADER");
  Deno.env.set("DROP_HEADERS", "X-Internal, x-secret");
  Deno.env.set("REMOVE_ORIGIN_HEADER", "true");
  try {
    const config = loadConfig();
    const result = buildProxyHeaders(new Headers({
      "Origin": "https://client.example",
      "X-Internal": "1",
      "X-Secret": "2",
      "X-Keep": "3",
    }), config);

    assertEquals(result.get("origin"), null);
    assertEquals(result.get("x-internal"), null);
    assertEquals(result.get("x-secret"), null);
    assertEquals(result.get("x-keep"), "3");
  } finally {
    if (originalDrop === undefined) Deno.env.delete("DROP_HEADERS");
    else Deno.env.set("DROP_HEADERS", originalDrop);
    if (originalRemove === undefined) Deno.env.delete("REMOVE_ORIGIN_HEADER");
    else Deno.env.set("REMOVE_ORIGIN_HEADER", originalRemove);
  }
});

Deno.test("Set-Cookie: stripped by default, preserved when FORWARD_SET_COOKIE=true", async () => {
  const upstream = () => {
    const headers = new Headers({ "Content-Type": "text/plain", "Cache-Control": "no-store" });
    headers.append("Set-Cookie", "a=1; Path=/");
    headers.append("Set-Cookie", "b=2; Path=/");
    return new Response("ok", { headers });
  };

  for (const forward of [false, true]) {
    const stub = installNetworkStub(upstream);
    try {
      const env: Record<string, string> = { ENABLE_LOGGING: "false", ENABLE_CACHE: "false", REQUIRE_HEADERS: "false" };
      env.FORWARD_SET_COOKIE = String(forward);
      await withServer(env, async (server) => {
        const res = await server.handleRequest(new Request(
          `http://localhost:3000/upstream-cookie-${forward}.example.net/`,
        ));
        assertEquals(res.status, 200);
        assertEquals(res.headers.getSetCookie().length, forward ? 2 : 0);
        await res.body?.cancel();
      });
    } finally {
      stub.restore();
    }
  }
});

Deno.test("Response cache: serves repeats, bypasses auth and no-cache requests", async () => {
  const stub = installNetworkStub(() =>
    new Response("cached-body", {
      status: 200,
      headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=60" },
    })
  );

  try {
    const env = {
      ENABLE_LOGGING: "false",
      ENABLE_CACHE: "true",
      CACHE_TTL: "60000",
      MAX_CACHE_ENTRIES: "10",
      MAX_CACHE_BYTES: "65536",
      MAX_CACHE_ENTRY_BYTES: "8192",
      REQUIRE_HEADERS: "false",
    };
    await withServer(env, async (server) => {
      const first = await server.handleRequest(new Request("http://localhost:3000/upstream-cache.example.net/data"));
      assertEquals(first.status, 200);
      assertEquals(await first.text(), "cached-body");
      assertEquals(stub.calls.length, 1);

      // 命中缓存：不再访问上游
      const second = await server.handleRequest(new Request("http://localhost:3000/upstream-cache.example.net/data"));
      assertEquals(await second.text(), "cached-body");
      assertEquals(stub.calls.length, 1);

      // 带 Authorization 的请求禁用缓存
      const authReq = await server.handleRequest(new Request("http://localhost:3000/upstream-cache.example.net/data", {
        headers: { Authorization: "Bearer user-token" },
      }));
      await authReq.text();
      assertEquals(stub.calls.length, 2);

      // no-cache 请求禁用缓存
      const noCacheReq = await server.handleRequest(new Request("http://localhost:3000/upstream-cache.example.net/data", {
        headers: { "Cache-Control": "no-cache" },
      }));
      await noCacheReq.text();
      assertEquals(stub.calls.length, 3);

      // 管理接口可观测缓存占用
      const statsRes = await server.handleRequest(new Request("http://localhost:3000/_api/stats"));
      const stats = await statsRes.json();
      assertEquals(stats.cache.entries >= 1, true);
    });
  } finally {
    stub.restore();
  }
});

// ==================== 缓存实现 ====================

Deno.test("Logger redacts tokens nested in ?url= targets", async () => {
  const stub = installNetworkStub();
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  try {
    await withServer({ REQUIRE_HEADERS: "false", ENABLE_LOGGING: "true" }, async (server) => {
      const target = "log.example.com/path?access_token=nestedTokenValue123";
      const res = await server.handleRequest(
        new Request(`http://localhost:3000/?url=${encodeURIComponent(target)}`)
      );
      assertEquals(res.status, 200);
      await res.text();
    });
  } finally {
    console.log = originalLog;
    stub.restore();
  }

  const output = lines.join("\n");
  assertNotEquals(output.length, 0);
  assertEquals(output.includes("nestedTokenValue123"), false, "nested token must not reach logs");
});

Deno.test("ByteLRUCache: evicts by max entries and refreshes LRU order", () => {
  const cache = new ByteLRUCache(2, 1024 * 1024, 1024 * 1024);
  cache.set("a", cacheEntry("a"));
  cache.set("b", cacheEntry("b"));
  assertEquals(cache.get("a") !== undefined, true); // 刷新 a 的 LRU 位置
  cache.set("c", cacheEntry("c"));

  assertEquals(cache.size, 2);
  assertEquals(cache.get("b"), undefined);
  assertEquals(cache.get("a") !== undefined, true);
  assertEquals(cache.get("c") !== undefined, true);
});

Deno.test("ByteLRUCache: enforces total byte budget", () => {
  const cache = new ByteLRUCache(10, 1200, 1200);
  const entry1 = cacheEntry("x".repeat(300)); // size 812
  const entry2 = cacheEntry("y".repeat(300)); // size 812
  assertEquals(cache.set("one", entry1), true);
  assertEquals(cache.set("two", entry2), true); // 需要驱逐 one

  assertEquals(cache.size, 1);
  assertEquals(cache.get("one"), undefined);
  assertEquals(cache.totalBytes, entry2.size);
});

Deno.test("ByteLRUCache: rejects oversized entries and handles clear", () => {
  const cache = new ByteLRUCache(10, 10 * 1024, 1000);
  assertEquals(cache.set("big", cacheEntry("z".repeat(1000))), false); // 1000 + 512 > 1000
  assertEquals(cache.size, 0);

  cache.set("ok", cacheEntry("small"));
  assertEquals(cache.delete("ok"), true);
  assertEquals(cache.totalBytes, 0);

  cache.set("again", cacheEntry("small"));
  cache.clear();
  assertEquals(cache.size, 0);
});

Deno.test("ByteLRUCache: Vary mismatch and TTL cleanup", () => {
  const cache = new ByteLRUCache(10, 1024 * 1024, 1024 * 1024);
  const vary = { "accept-language": "zh-CN" };
  cache.set("v", cacheEntry("vary", { vary }));

  assertEquals(cache.get("v", new Headers({ "Accept-Language": "en-US" })), undefined);
  assertEquals(cache.get("v", new Headers({ "Accept-Language": "zh-CN" })) !== undefined, true);

  const old = cacheEntry("old", { timestamp: Date.now() - 10000 });
  cache.set("old", old);
  cache.cleanup(1000);
  assertEquals(cache.get("old"), undefined);
  assertEquals(cache.totalBytes, cacheEntry("vary").size);
});

// ==================== 限流与并发 ====================

Deno.test("RateLimiter: intercepts requests exceeding threshold", async () => {
  await withServer({
    RATE_LIMIT: "2",
    RATE_LIMIT_WINDOW: "60000",
    REQUIRE_HEADERS: "false",
    ENABLE_LOGGING: "false",
  }, async (server) => {
    const first = await server.handleRequest(new Request("http://localhost:3000/http://127.0.0.1/"));
    assertEquals(first.status, 403);
    const second = await server.handleRequest(new Request("http://localhost:3000/http://127.0.0.1/"));
    assertEquals(second.status, 403);

    // 第 3 次请求应触发 429
    const third = await server.handleRequest(new Request("http://localhost:3000/http://127.0.0.1/"));
    assertEquals(third.status, 429);
  });
});

Deno.test("ConcurrencyLimiter: releases lease after blocked request", async () => {
  await withServer({
    CONCURRENT_LIMIT: "2",
    TOTAL_CONCURRENT_LIMIT: "5",
    REQUIRE_HEADERS: "false",
    ENABLE_LOGGING: "false",
  }, async (server) => {
    // 该请求会获取并发槽，随后被 SSRF 校验拒绝；槽位必须归还
    const res = await server.handleRequest(new Request("http://localhost:3000/http://127.0.0.1/"));
    assertEquals(res.status, 403);

    const statsRes = await server.handleRequest(new Request("http://localhost:3000/_api/stats"));
    const stats = await statsRes.json();
    assertEquals(stats.concurrency.totalCount, 0);
  });
});

// ==================== 配置与 CORS ====================

Deno.test("Configuration hot reload via reloadConfig()", () => {
  const originalProfile = Deno.env.get("RESOURCE_PROFILE");
  const server = new CiaoCorsServer();
  try {
    Deno.env.set("RESOURCE_PROFILE", "low-memory");
    server.reloadConfig();
    Deno.env.delete("RESOURCE_PROFILE");
    server.reloadConfig();
  } finally {
    if (originalProfile === undefined) Deno.env.delete("RESOURCE_PROFILE");
    else Deno.env.set("RESOURCE_PROFILE", originalProfile);
    server.cleanup();
  }
});

Deno.test("CORS Headers: merges Vary header with Origin", async () => {
  await withServer({ ALLOWED_ORIGINS: "https://frontend.example.com" }, async (server) => {
    const res = await server.handleRequest(new Request("http://localhost:3000/health", {
      headers: { "Origin": "https://frontend.example.com" },
    }));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://frontend.example.com");
    assertMatch(res.headers.get("Vary") || "", /Origin/i);

    const denied = await server.handleRequest(new Request("http://localhost:3000/health", {
      headers: { "Origin": "https://evil.example.com" },
    }));
    assertEquals(denied.headers.get("Access-Control-Allow-Origin"), null);
  });
});

Deno.test("Deno Deploy compatibility default.fetch", async () => {
  const req = new Request("http://localhost:3000/health");
  const res = await defaultExport.fetch(req);
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.status, "healthy");
});

Deno.test("Path mode returns 400 for malformed target", async () => {
  await withServer({ ENABLE_LOGGING: "false" }, async (server) => {
    const res = await server.handleRequest(new Request("http://localhost:3000/%E0%A4%A"));
    assertEquals(res.status, 400);
    assertNotEquals((await res.json()).message, undefined);
  });
});
