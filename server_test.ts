import { assertEquals, assertMatch, assertNotEquals, assertRejects } from 'jsr:@std/assert@1.0.19';
import defaultExport, {
  buildProxyHeaders,
  buildTargetPath,
  ByteLRUCache,
  type CachedResponseEntry,
  CiaoCorsServer,
  type Config,
  isHeaderExemptDomain,
  isPrivateOrReservedIP,
  isTrustedIP,
  loadConfig,
  normalizeExemptDomainEntry,
  normalizeHostname,
  parseExemptDomains,
  processRequestBody,
  resolveClientIP,
  resolveTargetHostname,
  stripQueryParam,
} from './server.ts';

// ==================== 测试辅助 ====================

/**
 * 替换 DNS 解析与 fetch，避免测试依赖外部网络。
 * 所有测试使用互不相同的域名，防止模块级 DNS 缓存串场。
 */
function installNetworkStub(handler?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  const originalResolveDns = (Deno as any).resolveDns;
  const calls: string[] = [];
  const inits: RequestInit[] = [];

  (Deno as any).resolveDns = (_hostname: string, recordType: string) =>
    Promise.resolve(recordType === 'A' ? ['93.184.216.34'] : []);
  (globalThis as any).fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    inits.push(init ?? {});
    if (handler) {
      return Promise.resolve(handler(url, init));
    }
    return Promise.resolve(
      new Response('stub-body', {
        status: 200,
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=60' },
      }),
    );
  };

  return {
    calls,
    inits,
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
    statusText: 'OK',
    headers: [['content-type', 'text/plain']],
    body: bytes,
    timestamp: Date.now(),
    size: bytes.byteLength + 512,
    vary: {},
    ...overrides,
  };
}

// ==================== 健康检查与基础路由 ====================

Deno.test('Health check endpoint (/health and /_health)', async () => {
  await withServer({}, async (server) => {
    const res1 = await server.handleRequest(new Request('http://localhost:3000/health'));
    assertEquals(res1.status, 200);
    const data1 = await res1.json();
    assertEquals(data1.status, 'healthy');
    assertEquals(data1.healthy, true);
    assertMatch(data1.version, /^\d+\.\d+\.\d+$/);

    const res2 = await server.handleRequest(new Request('http://localhost:3000/_health'));
    assertEquals(res2.status, 200);
    const data2 = await res2.json();
    assertEquals(data2.status, 'healthy');
  });
});

Deno.test('OPTIONS preflight handling', async () => {
  await withServer({}, async (server) => {
    const req = new Request('http://localhost:3000/example.com', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://myapp.com',
        'Access-Control-Request-Headers': 'X-Custom-Header, Authorization',
      },
    });

    const res = await server.handleRequest(req);
    assertEquals(res.status, 204);
    assertEquals(res.headers.get('Access-Control-Allow-Origin'), '*');
    assertMatch(res.headers.get('Access-Control-Allow-Headers') || '', /X-Custom-Header/);
  });
});

Deno.test('Path mode vs ?url= query parameter mode', () => {
  const pathUrl = new URL('http://localhost:3000/httpbin.org/get?a=1&b=2');
  assertEquals(buildTargetPath(pathUrl, false), 'httpbin.org/get?a=1&b=2');

  const encodedUrl = new URL('http://localhost:3000/https%3A%2F%2Fhttpbin.org%2Fget%3Fa%3D1');
  assertEquals(buildTargetPath(encodedUrl, false), 'https://httpbin.org/get?a=1');

  const queryMode = new URL('http://localhost:3000/?url=%20httpbin.org%2Fget%3Fa%3D1%20');
  assertEquals(buildTargetPath(queryMode, false), 'httpbin.org/get?a=1');
});

Deno.test('Proxy key is stripped from forwarded target URL', () => {
  const url = new URL('http://localhost:3000/upstream-strip.example.net/data?proxy_key=secret&keep=1');
  assertEquals(buildTargetPath(url, true), 'upstream-strip.example.net/data?keep=1');
  assertEquals(buildTargetPath(url, false), 'upstream-strip.example.net/data?proxy_key=secret&keep=1');
});

Deno.test('stripQueryParam preserves other parameters and encoding', () => {
  assertEquals(stripQueryParam('?proxy_key=x&a=1&b=2', 'proxy_key'), '?a=1&b=2');
  assertEquals(stripQueryParam('?a=1&proxy_key=x&b=2', 'proxy_key'), '?a=1&b=2');
  assertEquals(stripQueryParam('?a=1&proxy_key=x', 'proxy_key'), '?a=1');
  assertEquals(stripQueryParam('?proxy_key=x', 'proxy_key'), '');
  assertEquals(stripQueryParam('', 'proxy_key'), '');
  assertEquals(stripQueryParam('?a=%2F&proxy_key=x&b=1+2', 'proxy_key'), '?a=%2F&b=1+2');
  assertEquals(stripQueryParam('?proxy%5Fkey=x&a=1', 'proxy_key'), '?a=1');
});

// ==================== SSRF 与安全防护 ====================

Deno.test('SSRF Protection: Blocks loopback and private IPv4', async () => {
  await withServer({}, async (server) => {
    const blockedTargets = [
      'http://127.0.0.1/secret',
      'http://127.0.0.2:8080/',
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.42.42/', // Cloud metadata
      'http://100.100.100.200/', // Alibaba Cloud metadata
    ];

    for (const target of blockedTargets) {
      const req = new Request(`http://localhost:3000/${target}`, { headers: { 'Origin': 'https://test.client.com' } });
      const res = await server.handleRequest(req);
      assertEquals(res.status, 403, `Target should be blocked: ${target}`);
    }
  });
});

Deno.test('SSRF Protection: Blocks IPv6 and IPv4-mapped IPv6', async () => {
  await withServer({}, async (server) => {
    const blockedTargets = [
      'http://[::1]/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
      'http://[ff02::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:192.168.1.1]/',
      'http://[64:ff9b::127.0.0.1]/',
    ];

    for (const target of blockedTargets) {
      const req = new Request(`http://localhost:3000/${target}`, { headers: { 'Origin': 'https://test.client.com' } });
      const res = await server.handleRequest(req);
      assertEquals(res.status, 403, `Target should be blocked: ${target}`);
    }
  });
});

Deno.test('SSRF Protection: Blocks restricted domains, ports and userinfo', async () => {
  await withServer({}, async (server) => {
    const blockedUrls = [
      'http://localhost/',
      'http://sub.localhost/',
      'http://metadata.google.internal/',
      'http://metadata.goog/',
      'http://8.8.8.8:22/', // SSH port (direct IP avoids DNS)
      'http://8.8.8.8:3306/', // MySQL port
      'http://8.8.8.8:6379/', // Redis port
      'http://user:pass@8.8.8.8/', // Userinfo credentials
    ];

    for (const target of blockedUrls) {
      const req = new Request(`http://localhost:3000/${target}`, { headers: { 'Origin': 'https://test.client.com' } });
      const res = await server.handleRequest(req);
      assertEquals(res.status, 403, `URL should be blocked: ${target}`);
    }
  });
});

Deno.test('SSRF Protection: Blocks 6to4 private IPv4 embedding', async () => {
  await withServer({}, async (server) => {
    const req = new Request('http://localhost:3000/http://[2002:7f00:0001::]/', {
      headers: { 'Origin': 'https://test.client.com' },
    });
    const res = await server.handleRequest(req);
    assertEquals(res.status, 403);
  });
});

Deno.test('SSRF: ALLOWED_DOMAINS does not bypass private IP blocking', async () => {
  await withServer({ ALLOWED_DOMAINS: '127.0.0.1,localhost' }, async (server) => {
    const req = new Request('http://localhost:3000/http://127.0.0.1:8080/', {
      headers: { 'Origin': 'https://test.client.com' },
    });
    const res = await server.handleRequest(req);
    assertEquals(res.status, 403);
  });
});

Deno.test('SSRF Protection: blocks redirects to private addresses', async () => {
  const stub = installNetworkStub(() =>
    new Response(null, {
      status: 302,
      headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
    })
  );

  try {
    await withServer({ REQUIRE_HEADERS: 'false', ENABLE_LOGGING: 'false' }, async (server) => {
      const res = await server.handleRequest(new Request('http://localhost:3000/redirect.example.com/start'));
      assertEquals(res.status, 500);
      const body = await res.json();
      assertEquals(body.error, true);
      assertMatch(body.message, /Redirect blocked/);
      assertEquals(stub.calls.length, 1, 'redirect target must not be fetched');
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Proxy retries transient 502 responses', async () => {
  let calls = 0;
  const stub = installNetworkStub(() => {
    calls++;
    return calls === 1
      ? new Response('upstream down', { status: 502, headers: { 'Content-Type': 'text/plain' } })
      : new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  });

  try {
    await withServer({ REQUIRE_HEADERS: 'false', ENABLE_LOGGING: 'false' }, async (server) => {
      const res = await server.handleRequest(new Request('http://localhost:3000/retry.example.com/'));
      assertEquals(res.status, 200);
      assertEquals(await res.text(), 'ok');
    });
    assertEquals(calls, 2, '502 should be retried exactly once');
  } finally {
    stub.restore();
  }
});

Deno.test('isPrivateOrReservedIP: IPv4 matrix', () => {
  const blocked = [
    '0.0.0.1',
    '10.1.2.3',
    '100.64.0.1',
    '100.100.100.200',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.1',
    '203.0.113.5',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '0177.0.0.1', // 八进制混淆，无法解析时应 fail-closed
    'not-an-ip',
  ];
  for (const ip of blocked) {
    assertEquals(isPrivateOrReservedIP(ip), true, `${ip} should be blocked`);
  }

  const allowed = ['1.1.1.1', '8.8.8.8', '11.0.0.1', '93.184.216.34', '100.128.0.1', '172.32.0.1'];
  for (const ip of allowed) {
    assertEquals(isPrivateOrReservedIP(ip), false, `${ip} should be allowed`);
  }
});

Deno.test('isPrivateOrReservedIP: IPv6 and IPv4-mapped matrix', () => {
  const blocked = [
    '::',
    '::1',
    'fc00::1',
    'fd00:ec2::254',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '100::1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.1.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2002:c0a8:101::',
  ];
  for (const ip of blocked) {
    assertEquals(isPrivateOrReservedIP(ip), true, `${ip} should be blocked`);
  }

  const allowed = ['2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::'];
  for (const ip of allowed) {
    assertEquals(isPrivateOrReservedIP(ip), false, `${ip} should be allowed`);
  }
});

Deno.test('isTrustedIP: exact IP and IPv4 CIDR', () => {
  assertEquals(isTrustedIP('10.0.0.1', ['10.0.0.1']), true);
  assertEquals(isTrustedIP('10.0.0.2', ['10.0.0.1']), false);
  assertEquals(isTrustedIP('10.9.9.9', ['10.0.0.0/8']), true);
  assertEquals(isTrustedIP('11.0.0.1', ['10.0.0.0/8']), false);
  assertEquals(isTrustedIP('172.31.0.1', ['172.16.0.0/12']), true);
  assertEquals(isTrustedIP('172.32.0.1', ['172.16.0.0/12']), false);
  assertEquals(isTrustedIP('198.51.100.7', ['*']), true);
  assertEquals(isTrustedIP('[::1]', ['::1']), true);
  assertEquals(isTrustedIP('10.0.0.1', []), false);
});

Deno.test('resolveClientIP: only trusts forwarding headers from trusted peers', () => {
  const originalTrusted = Deno.env.get('TRUSTED_PROXIES');
  Deno.env.set('TRUSTED_PROXIES', '10.0.0.1,172.16.0.0/12');
  const config: Config = loadConfig();

  try {
    const spoofed = new Request('http://localhost/', {
      headers: {
        'X-Forwarded-For': '203.0.113.199, 10.0.0.1',
        'X-Real-IP': '203.0.113.200',
        'CF-Connecting-IP': '203.0.113.201',
      },
    });
    // 非受信对端：忽略所有转发头
    assertEquals(resolveClientIP(spoofed, { hostname: '198.51.100.5' }, config), '198.51.100.5');

    // 受信对端：优先 CF-Connecting-IP
    assertEquals(resolveClientIP(spoofed, { hostname: '10.0.0.1' }, config), '203.0.113.201');

    const xffOnly = new Request('http://localhost/', {
      headers: { 'X-Forwarded-For': '203.0.113.199, 172.16.0.9' },
    });
    assertEquals(resolveClientIP(xffOnly, { hostname: '10.0.0.1' }, config), '203.0.113.199');

    // 无 remoteAddr（Deno Deploy）：回退到请求头
    assertEquals(resolveClientIP(xffOnly, undefined, config), '203.0.113.199');
  } finally {
    if (originalTrusted === undefined) {
      Deno.env.delete('TRUSTED_PROXIES');
    } else {
      Deno.env.set('TRUSTED_PROXIES', originalTrusted);
    }
  }
});

// ==================== 鉴权与管理接口 ====================

Deno.test('Proxy API Key Authentication (PROXY_API_KEY)', async () => {
  await withServer({ PROXY_API_KEY: 'secret-proxy-pass-123', ENABLE_LOGGING: 'false' }, async (server) => {
    // 1. 无 key 访问代理应返回 401
    const res1 = await server.handleRequest(new Request('http://localhost:3000/httpbin.org/get'));
    assertEquals(res1.status, 401);
    assertEquals(res1.headers.get('Access-Control-Allow-Origin'), '*');

    // 2. 正确 key + 内网目标：通过鉴权后由 SSRF 防护返回 403
    const res2 = await server.handleRequest(
      new Request('http://localhost:3000/http://127.0.0.1/', {
        headers: { 'X-Proxy-Key': 'secret-proxy-pass-123' },
      }),
    );
    assertEquals(res2.status, 403);

    // 3. OPTIONS 请求不阻断
    const res3 = await server.handleRequest(
      new Request('http://localhost:3000/httpbin.org/get', {
        method: 'OPTIONS',
        headers: { 'Origin': 'https://example.com' },
      }),
    );
    assertEquals(res3.status, 204);

    // 4. 健康检查无需 key
    const res4 = await server.handleRequest(new Request('http://localhost:3000/health'));
    assertEquals(res4.status, 200);
  });
});

Deno.test('Proxy API Key: query-string key authenticates and is not forwarded upstream', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({
      PROXY_API_KEY: 'query-secret',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
      REQUIRE_HEADERS: 'false',
    }, async (server) => {
      const res = await server.handleRequest(
        new Request(
          'http://localhost:3000/upstream-query-key.example.net/data?proxy_key=query-secret&keep=1',
        ),
      );
      assertEquals(res.status, 200);
      assertEquals(stub.calls[0], 'https://upstream-query-key.example.net/data?keep=1');
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Management API endpoints, masking and auth', async () => {
  await withServer({ API_KEY: 'admin-secret-999', ENABLE_LOGGING: 'false' }, async (server) => {
    // 1. 未授权访问管理 API 应返回 401
    const res1 = await server.handleRequest(new Request('http://localhost:3000/_api/stats'));
    assertEquals(res1.status, 401);

    // 2. 授权访问 _api/health
    const res2 = await server.handleRequest(
      new Request('http://localhost:3000/_api/health', {
        headers: { 'Authorization': 'Bearer admin-secret-999' },
      }),
    );
    assertEquals(res2.status, 200);
    const healthData = await res2.json();
    assertEquals(healthData.status, 'healthy');

    // 3. 授权访问 _api/config 脱敏验证
    const res3 = await server.handleRequest(
      new Request('http://localhost:3000/_api/config', {
        headers: { 'Authorization': 'Bearer admin-secret-999' },
      }),
    );
    assertEquals(res3.status, 200);
    const configData = await res3.json();
    assertEquals(configData.apiKey, '***');

    // 4. 授权访问 _api/clear-cache
    const res4 = await server.handleRequest(
      new Request('http://localhost:3000/_api/clear-cache', {
        headers: { 'Authorization': 'Bearer admin-secret-999' },
      }),
    );
    assertEquals(res4.status, 200);
  });
});

Deno.test('Management API routing: tolerates trailing slash', async () => {
  await withServer({ ENABLE_LOGGING: 'false' }, async (server) => {
    const res = await server.handleRequest(new Request('http://localhost:3000/_api/health/'));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.status, 'healthy');
  });
});

Deno.test('Management API can be disabled', async () => {
  await withServer({ ENABLE_MANAGEMENT_API: 'false', ENABLE_LOGGING: 'false' }, async (server) => {
    const res = await server.handleRequest(new Request('http://localhost:3000/_api/health'));
    assertEquals(res.status, 404);
  });
});

// ==================== 请求体限制 ====================

Deno.test('Request body size limitation and 413 response', async () => {
  await withServer({ MAX_BODY_SIZE: '1024', ENABLE_LOGGING: 'false' }, async (server) => {
    const req = new Request('http://localhost:3000/8.8.8.8/upload', {
      method: 'POST',
      headers: {
        'Origin': 'https://test.client.com',
        'Content-Type': 'application/octet-stream',
        'Content-Length': '2048',
      },
      body: new Uint8Array(2048),
    });

    const res = await server.handleRequest(req);
    assertEquals(res.status, 413);
  });
});

Deno.test('processRequestBody: rejects oversized streamed body', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(800));
      controller.enqueue(new Uint8Array(800));
      controller.close();
    },
  });
  const req = new Request('http://localhost/upload', { method: 'POST', body: stream });

  await assertRejects(
    () => processRequestBody(req, 1024),
    Error,
    'Request body too large',
  );
});

// ==================== 代理行为 ====================

Deno.test('buildProxyHeaders: strips hop-by-hop and proxy credentials', () => {
  const headers = new Headers({
    'Origin': 'https://client.example',
    'Authorization': 'Bearer user-token',
    'Cookie': 'session=abc',
    'X-Proxy-Key': 'proxy-secret',
    'Proxy-Authorization': 'Bearer proxy-secret',
    'X-Forwarded-For': '203.0.113.5',
    'CF-Connecting-IP': '203.0.113.5',
    'Connection': 'keep-alive',
    'Content-Length': '10',
    'X-Remove-Origin': 'true',
  });

  const result = buildProxyHeaders(headers);
  assertEquals(result.get('origin'), null);
  assertEquals(result.get('x-proxy-key'), null);
  assertEquals(result.get('proxy-authorization'), null);
  assertEquals(result.get('x-forwarded-for'), null);
  assertEquals(result.get('cf-connecting-ip'), null);
  assertEquals(result.get('connection'), null);
  assertEquals(result.get('content-length'), null);
  assertEquals(result.get('x-remove-origin'), null);
  assertEquals(result.get('authorization'), 'Bearer user-token');
  assertEquals(result.get('cookie'), 'session=abc');
  assertEquals(result.get('user-agent') !== null, true);
  assertEquals(result.get('accept') !== null, true);
  assertEquals(result.get('accept-encoding'), 'gzip, deflate, br');
});

Deno.test('buildProxyHeaders: honours REMOVE_ORIGIN_HEADER and DROP_HEADERS', () => {
  const originalDrop = Deno.env.get('DROP_HEADERS');
  const originalRemove = Deno.env.get('REMOVE_ORIGIN_HEADER');
  Deno.env.set('DROP_HEADERS', 'X-Internal, x-secret');
  Deno.env.set('REMOVE_ORIGIN_HEADER', 'true');
  try {
    const config = loadConfig();
    const result = buildProxyHeaders(
      new Headers({
        'Origin': 'https://client.example',
        'X-Internal': '1',
        'X-Secret': '2',
        'X-Keep': '3',
      }),
      config,
    );

    assertEquals(result.get('origin'), null);
    assertEquals(result.get('x-internal'), null);
    assertEquals(result.get('x-secret'), null);
    assertEquals(result.get('x-keep'), '3');
  } finally {
    if (originalDrop === undefined) Deno.env.delete('DROP_HEADERS');
    else Deno.env.set('DROP_HEADERS', originalDrop);
    if (originalRemove === undefined) Deno.env.delete('REMOVE_ORIGIN_HEADER');
    else Deno.env.set('REMOVE_ORIGIN_HEADER', originalRemove);
  }
});

Deno.test('Set-Cookie: stripped by default, preserved when FORWARD_SET_COOKIE=true', async () => {
  const upstream = () => {
    const headers = new Headers({ 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', 'a=1; Path=/');
    headers.append('Set-Cookie', 'b=2; Path=/');
    return new Response('ok', { headers });
  };

  for (const forward of [false, true]) {
    const stub = installNetworkStub(upstream);
    try {
      const env: Record<string, string> = { ENABLE_LOGGING: 'false', ENABLE_CACHE: 'false', REQUIRE_HEADERS: 'false' };
      env.FORWARD_SET_COOKIE = String(forward);
      await withServer(env, async (server) => {
        const res = await server.handleRequest(
          new Request(
            `http://localhost:3000/upstream-cookie-${forward}.example.net/`,
          ),
        );
        assertEquals(res.status, 200);
        assertEquals(res.headers.getSetCookie().length, forward ? 2 : 0);
        await res.body?.cancel();
      });
    } finally {
      stub.restore();
    }
  }
});

Deno.test('Response cache: serves repeats, bypasses auth and no-cache requests', async () => {
  const stub = installNetworkStub(() =>
    new Response('cached-body', {
      status: 200,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=60' },
    })
  );

  try {
    const env = {
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'true',
      CACHE_TTL: '60000',
      MAX_CACHE_ENTRIES: '10',
      MAX_CACHE_BYTES: '65536',
      MAX_CACHE_ENTRY_BYTES: '8192',
      REQUIRE_HEADERS: 'false',
    };
    await withServer(env, async (server) => {
      const first = await server.handleRequest(new Request('http://localhost:3000/upstream-cache.example.net/data'));
      assertEquals(first.status, 200);
      assertEquals(await first.text(), 'cached-body');
      assertEquals(stub.calls.length, 1);

      // 命中缓存：不再访问上游
      const second = await server.handleRequest(new Request('http://localhost:3000/upstream-cache.example.net/data'));
      assertEquals(await second.text(), 'cached-body');
      assertEquals(stub.calls.length, 1);

      // 带 Authorization 的请求禁用缓存
      const authReq = await server.handleRequest(
        new Request('http://localhost:3000/upstream-cache.example.net/data', {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      await authReq.text();
      assertEquals(stub.calls.length, 2);

      // no-cache 请求禁用缓存
      const noCacheReq = await server.handleRequest(
        new Request('http://localhost:3000/upstream-cache.example.net/data', {
          headers: { 'Cache-Control': 'no-cache' },
        }),
      );
      await noCacheReq.text();
      assertEquals(stub.calls.length, 3);

      // 管理接口可观测缓存占用
      const statsRes = await server.handleRequest(new Request('http://localhost:3000/_api/stats'));
      const stats = await statsRes.json();
      assertEquals(stats.cache.entries >= 1, true);
    });
  } finally {
    stub.restore();
  }
});

// ==================== 缓存实现 ====================

Deno.test('Logger redacts tokens nested in ?url= targets', async () => {
  const stub = installNetworkStub();
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  try {
    await withServer({ REQUIRE_HEADERS: 'false', ENABLE_LOGGING: 'true' }, async (server) => {
      const target = 'log.example.com/path?access_token=nestedTokenValue123';
      const res = await server.handleRequest(
        new Request(`http://localhost:3000/?url=${encodeURIComponent(target)}`),
      );
      assertEquals(res.status, 200);
      await res.text();
    });
  } finally {
    console.log = originalLog;
    stub.restore();
  }

  const output = lines.join('\n');
  assertNotEquals(output.length, 0);
  assertEquals(output.includes('nestedTokenValue123'), false, 'nested token must not reach logs');
});

Deno.test('ByteLRUCache: evicts by max entries and refreshes LRU order', () => {
  const cache = new ByteLRUCache(2, 1024 * 1024, 1024 * 1024);
  cache.set('a', cacheEntry('a'));
  cache.set('b', cacheEntry('b'));
  assertEquals(cache.get('a') !== undefined, true); // 刷新 a 的 LRU 位置
  cache.set('c', cacheEntry('c'));

  assertEquals(cache.size, 2);
  assertEquals(cache.get('b'), undefined);
  assertEquals(cache.get('a') !== undefined, true);
  assertEquals(cache.get('c') !== undefined, true);
});

Deno.test('ByteLRUCache: enforces total byte budget', () => {
  const cache = new ByteLRUCache(10, 1200, 1200);
  const entry1 = cacheEntry('x'.repeat(300)); // size 812
  const entry2 = cacheEntry('y'.repeat(300)); // size 812
  assertEquals(cache.set('one', entry1), true);
  assertEquals(cache.set('two', entry2), true); // 需要驱逐 one

  assertEquals(cache.size, 1);
  assertEquals(cache.get('one'), undefined);
  assertEquals(cache.totalBytes, entry2.size);
});

Deno.test('ByteLRUCache: rejects oversized entries and handles clear', () => {
  const cache = new ByteLRUCache(10, 10 * 1024, 1000);
  assertEquals(cache.set('big', cacheEntry('z'.repeat(1000))), false); // 1000 + 512 > 1000
  assertEquals(cache.size, 0);

  cache.set('ok', cacheEntry('small'));
  assertEquals(cache.delete('ok'), true);
  assertEquals(cache.totalBytes, 0);

  cache.set('again', cacheEntry('small'));
  cache.clear();
  assertEquals(cache.size, 0);
});

Deno.test('ByteLRUCache: Vary mismatch and TTL cleanup', () => {
  const cache = new ByteLRUCache(10, 1024 * 1024, 1024 * 1024);
  const vary = { 'accept-language': 'zh-CN' };
  cache.set('v', cacheEntry('vary', { vary }));

  assertEquals(cache.get('v', new Headers({ 'Accept-Language': 'en-US' })), undefined);
  assertEquals(cache.get('v', new Headers({ 'Accept-Language': 'zh-CN' })) !== undefined, true);

  const old = cacheEntry('old', { timestamp: Date.now() - 10000 });
  cache.set('old', old);
  cache.cleanup(1000);
  assertEquals(cache.get('old'), undefined);
  assertEquals(cache.totalBytes, cacheEntry('vary').size);
});

// ==================== 限流与并发 ====================

Deno.test('RateLimiter: intercepts requests exceeding threshold', async () => {
  await withServer({
    RATE_LIMIT: '2',
    RATE_LIMIT_WINDOW: '60000',
    REQUIRE_HEADERS: 'false',
    ENABLE_LOGGING: 'false',
  }, async (server) => {
    const first = await server.handleRequest(new Request('http://localhost:3000/http://127.0.0.1/'));
    assertEquals(first.status, 403);
    const second = await server.handleRequest(new Request('http://localhost:3000/http://127.0.0.1/'));
    assertEquals(second.status, 403);

    // 第 3 次请求应触发 429
    const third = await server.handleRequest(new Request('http://localhost:3000/http://127.0.0.1/'));
    assertEquals(third.status, 429);
  });
});

Deno.test('ConcurrencyLimiter: releases lease after blocked request', async () => {
  await withServer({
    CONCURRENT_LIMIT: '2',
    TOTAL_CONCURRENT_LIMIT: '5',
    REQUIRE_HEADERS: 'false',
    ENABLE_LOGGING: 'false',
  }, async (server) => {
    // 该请求会获取并发槽，随后被 SSRF 校验拒绝；槽位必须归还
    const res = await server.handleRequest(new Request('http://localhost:3000/http://127.0.0.1/'));
    assertEquals(res.status, 403);

    const statsRes = await server.handleRequest(new Request('http://localhost:3000/_api/stats'));
    const stats = await statsRes.json();
    assertEquals(stats.concurrency.totalCount, 0);
  });
});

// ==================== 配置与 CORS ====================

Deno.test('Configuration hot reload via reloadConfig()', () => {
  const originalProfile = Deno.env.get('RESOURCE_PROFILE');
  const server = new CiaoCorsServer();
  try {
    Deno.env.set('RESOURCE_PROFILE', 'low-memory');
    server.reloadConfig();
    Deno.env.delete('RESOURCE_PROFILE');
    server.reloadConfig();
  } finally {
    if (originalProfile === undefined) Deno.env.delete('RESOURCE_PROFILE');
    else Deno.env.set('RESOURCE_PROFILE', originalProfile);
    server.cleanup();
  }
});

Deno.test('CORS Headers: merges Vary header with Origin', async () => {
  await withServer({ ALLOWED_ORIGINS: 'https://frontend.example.com' }, async (server) => {
    const res = await server.handleRequest(
      new Request('http://localhost:3000/health', {
        headers: { 'Origin': 'https://frontend.example.com' },
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('Access-Control-Allow-Origin'), 'https://frontend.example.com');
    assertMatch(res.headers.get('Vary') || '', /Origin/i);

    const denied = await server.handleRequest(
      new Request('http://localhost:3000/health', {
        headers: { 'Origin': 'https://evil.example.com' },
      }),
    );
    assertEquals(denied.headers.get('Access-Control-Allow-Origin'), null);
  });
});

Deno.test('Deno Deploy compatibility default.fetch', async () => {
  const req = new Request('http://localhost:3000/health');
  const res = await defaultExport.fetch(req);
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.status, 'healthy');
});

Deno.test('Path mode returns 400 for malformed target', async () => {
  await withServer({ ENABLE_LOGGING: 'false' }, async (server) => {
    const res = await server.handleRequest(new Request('http://localhost:3000/%E0%A4%A'));
    assertEquals(res.status, 400);
    assertNotEquals((await res.json()).message, undefined);
  });
});

// ==================== 请求头豁免域名 ====================

Deno.test('normalizeHostname / normalizeExemptDomainEntry: canonical forms and rejected rules', () => {
  assertEquals(normalizeHostname('API.Example.COM'), 'api.example.com');
  assertEquals(normalizeHostname('api.example.com.'), 'api.example.com');
  assertEquals(normalizeHostname('api.example.com:8443'), null);
  assertEquals(normalizeHostname('https://api.example.com/path'), null);
  assertEquals(normalizeHostname('münchen.example'), 'xn--mnchen-3ya.example');
  assertEquals(normalizeHostname('[::1]'), '[::1]');
  // 连续点（空标签）视为非法域名，直接拒绝而不是静默截断
  assertEquals(normalizeHostname('api.example.com..'), null);

  assertEquals(normalizeExemptDomainEntry('api.example.com'), 'api.example.com');
  assertEquals(normalizeExemptDomainEntry(' API.Example.COM. '), 'api.example.com');
  assertEquals(normalizeExemptDomainEntry('*.example.com'), null);
  assertEquals(normalizeExemptDomainEntry('https://api.example.com'), null);
  assertEquals(normalizeExemptDomainEntry('api.example.com/path'), null);
  assertEquals(normalizeExemptDomainEntry('api.example.com:8443'), null);
  assertEquals(normalizeExemptDomainEntry('exa_mple.com'), null);
  assertEquals(normalizeExemptDomainEntry('a..b'), null);
  assertEquals(normalizeExemptDomainEntry('0x7f.1'), null);
  assertEquals(normalizeExemptDomainEntry(''), null);
  assertEquals(normalizeExemptDomainEntry('münchen.example'), 'xn--mnchen-3ya.example');
});

Deno.test('parseExemptDomains: dedupes, normalizes and drops invalid entries', () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    const result = parseExemptDomains([
      'API.Example.COM.',
      'api.example.com',
      '*.bad.example',
      'https://bad.example/path',
      'münchen.example',
    ]);
    assertEquals(result, ['api.example.com', 'xn--mnchen-3ya.example']);
    assertEquals(warnings.length, 2);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test('isHeaderExemptDomain: exact hostname match only', () => {
  const exempt = ['api.example.com', 'xn--mnchen-3ya.example'];
  assertEquals(isHeaderExemptDomain('api.example.com', exempt), true);
  assertEquals(isHeaderExemptDomain('API.Example.COM.', exempt), true);
  assertEquals(isHeaderExemptDomain('api.example.com:443', exempt), false);
  assertEquals(isHeaderExemptDomain('sub.api.example.com', exempt), false);
  assertEquals(isHeaderExemptDomain('api.example.com.evil.test', exempt), false);
  assertEquals(isHeaderExemptDomain('münchen.example', exempt), true);
  assertEquals(isHeaderExemptDomain('api.example.com', []), false);
});

Deno.test('resolveTargetHostname: single normalization path for all target modes', () => {
  assertEquals(resolveTargetHostname('https://API.Example.COM./path'), 'api.example.com');
  assertEquals(resolveTargetHostname('api.example.com/path'), 'api.example.com');
  assertEquals(resolveTargetHostname('http://api.example.com:8443/path'), 'api.example.com');
  assertEquals(resolveTargetHostname('münchen.example/x'), 'xn--mnchen-3ya.example');
  assertEquals(resolveTargetHostname('ftp://api.example.com/x'), null);
  assertEquals(resolveTargetHostname('https://user:pass@api.example.com/x'), null);
  assertEquals(resolveTargetHostname('not a url'), null);
  // 含下划线的主机名虽可被 URL 解析，但无法进入豁免名单（严格校验拒绝该写法），
  // 因此 resolveTargetHostname 的宽松结果不会造成误豁免。
  assertEquals(normalizeExemptDomainEntry('exa_mple.com'), null);
  assertEquals(isHeaderExemptDomain('exa_mple.com', parseExemptDomains(['exa_mple.com'])), false);
});

Deno.test('Header exemption: default behaviour unchanged without settings', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({ ENABLE_LOGGING: 'false' }, async (server) => {
      const res = await server.handleRequest(new Request('http://localhost:3000/default.example.net/data'));
      assertEquals(res.status, 403);
      assertEquals(stub.calls.length, 0);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: REQUIRE_HEADERS=false keeps global bypass', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({
      REQUIRE_HEADERS: 'false',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      const res = await server.handleRequest(new Request('http://localhost:3000/disabled.example.net/data'));
      assertEquals(res.status, 200);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: empty list keeps original 403 behaviour', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: '',
      ENABLE_LOGGING: 'false',
    }, async (server) => {
      const res = await server.handleRequest(new Request('http://localhost:3000/empty-list.example.net/data'));
      assertEquals(res.status, 403);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: listed domain needs no Origin or X-Requested-With', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'api.example.com, translate.example.org',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      for (const target of ['api.example.com/data', 'translate.example.org/v1/translate']) {
        const res = await server.handleRequest(new Request(`http://localhost:3000/${target}`));
        assertEquals(res.status, 200, `exempt target should pass: ${target}`);
      }
      assertEquals(stub.calls.length, 2);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: non-exempt domain still requires and accepts headers', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'api.example.com',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      const blocked = await server.handleRequest(new Request('http://localhost:3000/other.example.net/data'));
      assertEquals(blocked.status, 403);
      assertEquals(stub.calls.length, 0);

      const withOrigin = await server.handleRequest(
        new Request('http://localhost:3000/other.example.net/data', {
          headers: { 'Origin': 'https://app.example.com' },
        }),
      );
      assertEquals(withOrigin.status, 200);

      const withXrw = await server.handleRequest(
        new Request('http://localhost:3000/other.example.net/data', {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        }),
      );
      assertEquals(withXrw.status, 200);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: case, trailing dot and port normalization', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'API.Example.COM.',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      const res = await server.handleRequest(
        new Request('http://localhost:3000/https://API.Example.COM.:8443/data'),
      );
      assertEquals(res.status, 200);
      // 代理转发保持客户端原始 URL 形式，匹配逻辑本身在规范化后的 hostname 上完成
      assertEquals(new URL(stub.calls[0]).hostname, 'api.example.com.');
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: URL confusion forms resolve consistently with validation', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'api.example.com',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      // 反斜杠与百分号编码点均被 URL 解析为 api.example.com，豁免与代理目标一致
      const backslash = await server.handleRequest(
        new Request('http://localhost:3000/https://api.example.com\\@evil.com/x'),
      );
      assertEquals(backslash.status, 200);
      assertEquals(new URL(stub.calls.at(-1)!).hostname, 'api.example.com');

      const encodedDot = await server.handleRequest(
        new Request('http://localhost:3000/https://api%2Eexample.com/x'),
      );
      assertEquals(encodedDot.status, 200);
      assertEquals(new URL(stub.calls.at(-1)!).hostname, 'api.example.com');

      // 看似 userinfo 的写法实际落在豁免域名的路径上，代理目标仍是 api.example.com
      const lookalikePath = 'http://localhost:3000/https://api.example.com' + '/@evil.example.org/x';
      const userinfoLookalike = await server.handleRequest(new Request(lookalikePath));
      assertEquals(userinfoLookalike.status, 200);
      assertEquals(new URL(stub.calls.at(-1)!).hostname, 'api.example.com');

      // 反向构造：真实主机不是豁免域名时，不能被 URL 中的 api.example.com 字样误导
      const reversed = await server.handleRequest(
        new Request('http://localhost:3000/https://evil.example.org%2F@api.example.com/x'),
      );
      assertEquals(reversed.status, 403);

      // fragment 不能作为豁免域的伪装
      const fragment = await server.handleRequest(
        new Request('http://localhost:3000/https://evil.example.org#@api.example.com'),
      );
      assertEquals(fragment.status, 403);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: lookalike domains and suffixes are not exempt', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'api.example.com',
      ENABLE_LOGGING: 'false',
    }, async (server) => {
      const targets = [
        'evil-api.example.com/data',
        'api.example.com.evil.test/data',
        'api.example.co/data',
      ];
      for (const target of targets) {
        const res = await server.handleRequest(new Request(`http://localhost:3000/${target}`));
        assertEquals(res.status, 403, `must not be exempt: ${target}`);
      }
      assertEquals(stub.calls.length, 0);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: invalid or unsupported target URL does not enter exempt flow', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'api.example.com',
      ENABLE_LOGGING: 'false',
    }, async (server) => {
      const unsupported = await server.handleRequest(
        new Request('http://localhost:3000/?url=ftp://api.example.com/file'),
      );
      assertEquals(unsupported.status, 403);

      const malformed = await server.handleRequest(new Request('http://localhost:3000/%E0%A4%A'));
      assertEquals(malformed.status, 400);
      assertEquals(stub.calls.length, 0);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: ?url= mode resolves the same hostname', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'api.example.com',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      const target = encodeURIComponent('https://api.example.com/v1/items?limit=1');
      const res = await server.handleRequest(new Request(`http://localhost:3000/?url=${target}`));
      assertEquals(res.status, 200);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: redirect to non-exempt domain cannot bypass header check', async () => {
  const stub = installNetworkStub((url) => {
    if (url.includes('redir-exempt.example.net')) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://non-exempt.example.org/secret' },
      });
    }
    return new Response('should-not-reach', { status: 200 });
  });

  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'redir-exempt.example.net',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      const res = await server.handleRequest(
        new Request('http://localhost:3000/redir-exempt.example.net/start'),
      );
      assertEquals(res.status, 500);
      const body = await res.json();
      assertMatch(body.message, /Redirect blocked/);
      assertEquals(stub.calls.length, 1, 'redirect target must not be fetched');
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: cached response cannot bypass redirect re-check', async () => {
  const stub = installNetworkStub((url) => {
    if (url.includes('cache-exempt.example.net')) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://non-exempt.example.org/secret' },
      });
    }
    return new Response('secret', {
      status: 200,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=60' },
    });
  });

  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'cache-exempt.example.net',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'true',
    }, async (server) => {
      const target = 'http://localhost:3000/cache-exempt.example.net/start';

      // 空 Origin 头被视作“已提供”，允许经豁免域名跳转到非豁免域名，并把结果写入缓存。
      const primed = await server.handleRequest(
        new Request(target, { headers: { 'Origin': '' } }),
      );
      assertEquals(primed.status, 200);
      assertEquals(await primed.text(), 'secret');
      assertEquals(stub.calls.length, 2);

      // 同路径的无头请求必须重新执行头校验与重定向复检，不能命中上面写入的缓存。
      const res = await server.handleRequest(new Request(target));
      assertEquals(res.status, 500);
      const body = await res.json();
      assertMatch(body.message, /Redirect blocked/);
      assertEquals(stub.calls.length, 3, 'header-less request must not reuse the cached response');
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: header-less requests keep their own cache entries', async () => {
  const stub = installNetworkStub(() =>
    new Response('ok', {
      status: 200,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=60' },
    })
  );

  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'cache-direct.example.net',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'true',
    }, async (server) => {
      const target = 'http://localhost:3000/cache-direct.example.net/ok';
      const first = await server.handleRequest(new Request(target));
      assertEquals(first.status, 200);
      assertEquals(await first.text(), 'ok');
      assertEquals(stub.calls.length, 1);

      // 分区缓存不应退化为禁用缓存：同一无头请求仍可复用自己写入的条目。
      const second = await server.handleRequest(new Request(target));
      assertEquals(second.status, 200);
      assertEquals(await second.text(), 'ok');
      assertEquals(stub.calls.length, 1, 'header-less exempt request should reuse its own cache entry');
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: redirect between exempt domains is allowed', async () => {
  const stub = installNetworkStub((url) => {
    if (url.includes('first-exempt.example.net')) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://second-exempt.example.net/ok' },
      });
    }
    return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  });

  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'first-exempt.example.net,second-exempt.example.net',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      const res = await server.handleRequest(
        new Request('http://localhost:3000/first-exempt.example.net/start'),
      );
      assertEquals(res.status, 200);
      assertEquals(await res.text(), 'ok');
      assertEquals(stub.calls.length, 2);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: requests carrying headers may redirect to non-exempt domains', async () => {
  const stub = installNetworkStub((url) => {
    if (url.includes('headers-present.example.net')) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://non-exempt.example.org/ok' },
      });
    }
    return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  });

  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'headers-present.example.net',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      const res = await server.handleRequest(
        new Request('http://localhost:3000/headers-present.example.net/start', {
          headers: { 'Origin': 'https://app.example.com' },
        }),
      );
      assertEquals(res.status, 200);
      assertEquals(stub.calls.length, 2);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: other security policies still apply', async () => {
  const stub = installNetworkStub();
  try {
    // SSRF：豁免域名解析到内网地址仍然被拦截
    (Deno as any).resolveDns = () => Promise.resolve(['127.0.0.1']);
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'ssrf-exempt.example.net',
      ENABLE_LOGGING: 'false',
    }, async (server) => {
      const res = await server.handleRequest(new Request('http://localhost:3000/ssrf-exempt.example.net/'));
      assertEquals(res.status, 403);
    });

    // 域名黑名单仍然生效
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'blocked-exempt.example.net',
      BLOCKED_DOMAINS: 'blocked-exempt.example.net',
      ENABLE_LOGGING: 'false',
    }, async (server) => {
      const res = await server.handleRequest(new Request('http://localhost:3000/blocked-exempt.example.net/'));
      assertEquals(res.status, 403);
    });

    // 代理访问鉴权仍然生效
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'key-exempt.example.net',
      PROXY_API_KEY: 'exempt-proxy-key',
      ENABLE_LOGGING: 'false',
    }, async (server) => {
      const res = await server.handleRequest(new Request('http://localhost:3000/key-exempt.example.net/'));
      assertEquals(res.status, 401);
    });

    // 目标域名白名单仍然生效：豁免名单不会扩大可代理范围
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'not-in-allowlist.example.net',
      ALLOWED_DOMAINS: 'allowed-only.example.net',
      ENABLE_LOGGING: 'false',
    }, async (server) => {
      const res = await server.handleRequest(new Request('http://localhost:3000/not-in-allowlist.example.net/'));
      assertEquals(res.status, 403);
    });

    // 来源白名单仍然生效
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'origin-exempt.example.net',
      ALLOWED_ORIGINS: 'https://trusted.example.com',
      ENABLE_LOGGING: 'false',
    }, async (server) => {
      const res = await server.handleRequest(
        new Request('http://localhost:3000/origin-exempt.example.net/', {
          headers: { Origin: 'https://evil.example.com' },
        }),
      );
      assertEquals(res.status, 403);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: hot reload adds and removes entries immediately', async () => {
  const stub = installNetworkStub();
  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'reload-a.example.net',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      const before = await server.handleRequest(new Request('http://localhost:3000/reload-a.example.net/'));
      assertEquals(before.status, 200);

      Deno.env.set('REQUIRE_HEADERS_EXEMPT_DOMAINS', 'reload-b.example.net');
      server.reloadConfig();

      const removed = await server.handleRequest(new Request('http://localhost:3000/reload-a.example.net/'));
      assertEquals(removed.status, 403);

      const added = await server.handleRequest(new Request('http://localhost:3000/reload-b.example.net/'));
      assertEquals(added.status, 200);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Header exemption: exposed in /_api/config', async () => {
  await withServer({
    REQUIRE_HEADERS_EXEMPT_DOMAINS: 'API.Example.COM.,other.example.org',
    ENABLE_LOGGING: 'false',
  }, async (server) => {
    const res = await server.handleRequest(new Request('http://localhost:3000/_api/config'));
    assertEquals(res.status, 200);
    const config = await res.json();
    assertEquals(config.requireHeadersExemptDomains, ['api.example.com', 'other.example.org']);
  });
});

// ==================== 内部请求头与逐跳头部 ====================

Deno.test('buildProxyHeaders: strips infrastructure headers and Connection-nominated fields', () => {
  const result = buildProxyHeaders(
    new Headers({
      'Origin': 'https://client.example',
      'Authorization': 'Bearer upstream-token',
      'Cookie': 'session=abc',
      'K-Proxy-Request': 'internal-route-marker',
      'CDN-Loop': 'cdn.example.net',
      'X-Forwarded-For': '203.0.113.5',
      'X-Forwarded-Host': 'proxy.internal',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Port': '443',
      'X-Real-IP': '203.0.113.5',
      'Forwarded': 'for=203.0.113.5',
      'Proxy-Connection': 'keep-alive',
      'Connection': 'X-Custom-Hop, Keep-Alive',
      'X-Custom-Hop': 'hop-value',
      'X-Business-Header': 'business-value',
    }),
  );

  for (
    const name of [
      'k-proxy-request',
      'cdn-loop',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-forwarded-port',
      'x-real-ip',
      'forwarded',
      'proxy-connection',
      'connection',
      'x-custom-hop',
    ]
  ) {
    assertEquals(result.get(name), null, `${name} must not be forwarded`);
  }

  // 业务请求头与上游鉴权头必须保留
  assertEquals(result.get('authorization'), 'Bearer upstream-token');
  assertEquals(result.get('cookie'), 'session=abc');
  assertEquals(result.get('x-business-header'), 'business-value');
});

Deno.test('buildProxyHeaders: DROP_HEADERS matching is case-insensitive', () => {
  const originalDrop = Deno.env.get('DROP_HEADERS');
  Deno.env.set('DROP_HEADERS', 'X-Internal-Trace, X-Another');
  try {
    const config = loadConfig();
    const result = buildProxyHeaders(
      new Headers({
        'x-internal-trace': 'abc',
        'X-INTERNAL-TRACE': 'ignored-duplicate',
        'X-Another': '1',
        'X-Keep': '2',
      }),
      config,
    );
    assertEquals(result.get('x-internal-trace'), null);
    assertEquals(result.get('x-another'), null);
    assertEquals(result.get('x-keep'), '2');
    assertEquals(config.dropHeaders, ['x-internal-trace', 'x-another']);
  } finally {
    if (originalDrop === undefined) Deno.env.delete('DROP_HEADERS');
    else Deno.env.set('DROP_HEADERS', originalDrop);
  }
});

// ==================== CORS 策略 ====================

Deno.test('CORS: upstream wildcard + credentials combination is never emitted', async () => {
  const stub = installNetworkStub(() =>
    new Response('cors-upstream-body', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'X-Upstream-Only',
        'Access-Control-Expose-Headers': 'X-Upstream-Expose',
        'Vary': 'Accept-Encoding',
      },
    })
  );

  try {
    await withServer({
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
      REQUIRE_HEADERS: 'false',
    }, async (server) => {
      const res = await server.handleRequest(new Request('http://localhost:3000/cors-upstream.example.net/data'));
      assertEquals(res.status, 200);
      await res.text();

      assertEquals(res.headers.get('Access-Control-Allow-Origin'), '*');
      assertEquals(res.headers.get('Access-Control-Allow-Credentials'), null);
      // 上游 CORS 策略不得被继承
      assertNotEquals(res.headers.get('Access-Control-Allow-Headers'), 'X-Upstream-Only');
      assertNotEquals(res.headers.get('Access-Control-Expose-Headers'), 'X-Upstream-Expose');

      // 既有 Vary 必须保留，通配符模式不追加 Origin
      const vary = (res.headers.get('Vary') || '').toLowerCase();
      assertMatch(vary, /accept-encoding/);
      assertEquals(vary.includes('origin'), false);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('CORS credentials: only explicit allowlist origins receive credentialed headers', async () => {
  const stub = installNetworkStub(() =>
    new Response('credential-body', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Accept-Encoding',
      },
    })
  );

  try {
    await withServer({
      ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com',
      ALLOW_CREDENTIALS: 'true',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
      REQUIRE_HEADERS: 'false',
    }, async (server) => {
      const allowed = await server.handleRequest(
        new Request('http://localhost:3000/cors-cred.example.net/data', {
          headers: { Origin: 'https://app.example.com' },
        }),
      );
      await allowed.text();
      assertEquals(allowed.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com');
      assertEquals(allowed.headers.get('Access-Control-Allow-Credentials'), 'true');
      assertMatch(allowed.headers.get('Vary') || '', /Accept-Encoding/i);
      assertMatch(allowed.headers.get('Vary') || '', /Origin/i);
      // 凭证模式下 Expose-Headers 不得使用通配符
      assertNotEquals(allowed.headers.get('Access-Control-Expose-Headers'), '*');

      const denied = await server.handleRequest(
        new Request('http://localhost:3000/cors-cred.example.net/data', {
          headers: { Origin: 'https://evil.example.com' },
        }),
      );
      await denied.text();
      assertEquals(denied.headers.get('Access-Control-Allow-Origin'), null);
      assertEquals(denied.headers.get('Access-Control-Allow-Credentials'), null);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('CORS credentials: enabled only with an explicit non-wildcard allowlist', () => {
  const keys = ['ALLOW_CREDENTIALS', 'ALLOWED_ORIGINS'] as const;
  const previous = new Map<string, string | undefined>();
  for (const key of keys) previous.set(key, Deno.env.get(key));

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

  try {
    Deno.env.set('ALLOW_CREDENTIALS', 'true');
    Deno.env.delete('ALLOWED_ORIGINS');
    assertEquals(loadConfig().allowCredentials, false);

    Deno.env.set('ALLOWED_ORIGINS', '*');
    assertEquals(loadConfig().allowCredentials, false);

    Deno.env.set('ALLOWED_ORIGINS', 'https://app.example.com');
    assertEquals(loadConfig().allowCredentials, true);
  } finally {
    console.warn = originalWarn;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }

  assertEquals(warnings.some((line) => line.includes('ALLOW_CREDENTIALS')), true);
});

Deno.test('CORS: OPTIONS preflight mirrors the actual request policy', async () => {
  await withServer({
    ALLOWED_ORIGINS: 'https://app.example.com',
    ALLOW_CREDENTIALS: 'true',
    ENABLE_LOGGING: 'false',
  }, async (server) => {
    const allowed = await server.handleRequest(
      new Request('http://localhost:3000/preflight.example.net/data', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization, content-type',
        },
      }),
    );
    assertEquals(allowed.status, 204);
    assertEquals(allowed.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com');
    assertEquals(allowed.headers.get('Access-Control-Allow-Credentials'), 'true');
    assertMatch(allowed.headers.get('Access-Control-Allow-Headers') || '', /authorization/i);
    assertMatch(allowed.headers.get('Access-Control-Allow-Methods') || '', /POST/);

    const denied = await server.handleRequest(
      new Request('http://localhost:3000/preflight.example.net/data', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example.com' },
      }),
    );
    assertEquals(denied.status, 204);
    assertEquals(denied.headers.get('Access-Control-Allow-Origin'), null);
    assertEquals(denied.headers.get('Access-Control-Allow-Credentials'), null);
  });

  await withServer({
    ENABLE_LOGGING: 'false',
  }, async (server) => {
    const wildcard = await server.handleRequest(
      new Request('http://localhost:3000/preflight-wildcard.example.net/data', {
        method: 'OPTIONS',
        headers: { Origin: 'https://any.example.com' },
      }),
    );
    assertEquals(wildcard.status, 204);
    assertEquals(wildcard.headers.get('Access-Control-Allow-Origin'), '*');
    assertEquals(wildcard.headers.get('Access-Control-Allow-Credentials'), null);
  });
});

Deno.test('CORS: cached responses are rebuilt for the current request origin', async () => {
  const stub = installNetworkStub(() =>
    new Response('cached-cors-body', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
      },
    })
  );

  try {
    await withServer({
      ALLOWED_ORIGINS: 'https://a.example.com,https://b.example.com',
      ALLOW_CREDENTIALS: 'true',
      ENABLE_CACHE: 'true',
      CACHE_TTL: '60000',
      MAX_CACHE_ENTRIES: '10',
      MAX_CACHE_BYTES: '65536',
      MAX_CACHE_ENTRY_BYTES: '8192',
      ENABLE_LOGGING: 'false',
      REQUIRE_HEADERS: 'false',
    }, async (server) => {
      const first = await server.handleRequest(
        new Request('http://localhost:3000/cache-cors.example.net/data', {
          headers: { Origin: 'https://a.example.com' },
        }),
      );
      assertEquals(await first.text(), 'cached-cors-body');
      assertEquals(first.headers.get('Access-Control-Allow-Origin'), 'https://a.example.com');
      assertEquals(first.headers.get('Access-Control-Allow-Credentials'), 'true');
      assertEquals(stub.calls.length, 1);

      // 同一 Origin 命中缓存，CORS 仍按当前请求重建
      const second = await server.handleRequest(
        new Request('http://localhost:3000/cache-cors.example.net/data', {
          headers: { Origin: 'https://a.example.com' },
        }),
      );
      assertEquals(await second.text(), 'cached-cors-body');
      assertEquals(stub.calls.length, 1);
      assertEquals(second.headers.get('Access-Control-Allow-Origin'), 'https://a.example.com');

      // 不同 Origin 不得复用其他 Origin 的缓存 CORS 策略
      const third = await server.handleRequest(
        new Request('http://localhost:3000/cache-cors.example.net/data', {
          headers: { Origin: 'https://b.example.com' },
        }),
      );
      assertEquals(await third.text(), 'cached-cors-body');
      assertEquals(third.headers.get('Access-Control-Allow-Origin'), 'https://b.example.com');
      assertNotEquals(third.headers.get('Access-Control-Allow-Origin'), 'https://a.example.com');

      // 未在白名单内的 Origin 即使命中同目标也不会获得 CORS 授权
      const fourth = await server.handleRequest(
        new Request('http://localhost:3000/cache-cors.example.net/data', {
          headers: { Origin: 'https://evil.example.com' },
        }),
      );
      await fourth.text();
      assertEquals(fourth.headers.get('Access-Control-Allow-Origin'), null);
      assertEquals(fourth.headers.get('Access-Control-Allow-Credentials'), null);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('CORS: Vary merge keeps existing values and avoids duplicate Origin', async () => {
  const stub = installNetworkStub(() =>
    new Response('vary-body', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        'Vary': 'Accept-Encoding, User-Agent',
      },
    })
  );

  try {
    await withServer({
      ALLOWED_ORIGINS: 'https://vary.example.com',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
      REQUIRE_HEADERS: 'false',
    }, async (server) => {
      const res = await server.handleRequest(
        new Request('http://localhost:3000/vary-merge.example.net/data', {
          headers: { Origin: 'https://vary.example.com' },
        }),
      );
      await res.text();
      const vary = res.headers.get('Vary') || '';
      assertMatch(vary, /Accept-Encoding/i);
      assertMatch(vary, /User-Agent/i);
      assertEquals(vary.toLowerCase().split(',').filter((v) => v.trim() === 'origin').length, 1);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('CORS: upstream Connection-nominated headers are not forwarded', async () => {
  const stub = installNetworkStub(() =>
    new Response('conn-body', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        'Connection': 'X-Hop-Only',
        'X-Hop-Only': 'should-be-dropped',
        'X-Normal': 'kept',
      },
    })
  );

  try {
    await withServer({
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
      REQUIRE_HEADERS: 'false',
    }, async (server) => {
      const res = await server.handleRequest(new Request('http://localhost:3000/conn-hop.example.net/data'));
      await res.text();
      assertEquals(res.headers.get('x-hop-only'), null);
      assertEquals(res.headers.get('x-normal'), 'kept');
      assertEquals(res.headers.get('connection'), null);
    });
  } finally {
    stub.restore();
  }
});

// ==================== 原生客户端与流式请求 ====================

Deno.test('Native client: Bearer JSON POST without Origin is proxied and tagged correctly', async () => {
  const stub = installNetworkStub(() =>
    new Response(JSON.stringify({ ok: true, echo: 'json' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  );

  try {
    await withServer({
      REQUIRE_HEADERS: 'true',
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'api.native-client.example.net',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      const payload = JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] });
      const res = await server.handleRequest(
        new Request('http://localhost:3000/api.native-client.example.net/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer client-token',
            'X-Custom-Client': 'native-app',
          },
          body: payload,
        }),
      );

      assertEquals(res.status, 200);
      assertEquals((await res.json()).ok, true);

      assertEquals(stub.inits.length, 1);
      const init = stub.inits[0];
      assertEquals(init.method, 'POST');
      assertEquals(new TextDecoder().decode(init.body as Uint8Array), payload);
      const forwarded = new Headers(init.headers as HeadersInit);
      assertEquals(forwarded.get('authorization'), 'Bearer client-token');
      assertEquals(forwarded.get('content-type'), 'application/json');
      assertEquals(forwarded.get('x-custom-client'), 'native-app');
      // 代理自身鉴权头不得泄露给上游
      assertEquals(forwarded.get('x-proxy-key'), null);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('SSE streaming: chunks pass through and are never cached', async () => {
  const encoder = new TextEncoder();
  let upstreamClosed = false;
  const stub = installNetworkStub(() => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"delta":"a"}\n\n'));
        controller.enqueue(encoder.encode('data: {"delta":"b"}\n\n'));
        controller.close();
      },
      cancel() {
        upstreamClosed = true;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'public, max-age=60' },
    });
  });

  try {
    await withServer({
      REQUIRE_HEADERS: 'false',
      ENABLE_CACHE: 'true',
      ENABLE_LOGGING: 'false',
    }, async (server) => {
      for (let i = 0; i < 2; i++) {
        const res = await server.handleRequest(
          new Request('http://localhost:3000/sse.example.net/v1/stream'),
        );
        assertEquals(res.status, 200);
        assertMatch(res.headers.get('Content-Type') || '', /text\/event-stream/);
        const text = await res.text();
        assertMatch(text, /delta/);
        assertEquals(text.includes('"a"'), true);
        assertEquals(text.includes('"b"'), true);
      }

      // 流式响应不入缓存
      assertEquals(stub.calls.length, 2);
      const statsRes = await server.handleRequest(new Request('http://localhost:3000/_api/stats'));
      const stats = await statsRes.json();
      assertEquals(stats.cache.entries, 0);
    });
  } finally {
    stub.restore();
    assertEquals(upstreamClosed, false); // 正常读完，无需 cancel 上游
  }
});

Deno.test('Client abort: cancels the upstream stream and releases the concurrency lease', async () => {
  const encoder = new TextEncoder();
  let upstreamCancelled = false;
  const stub = installNetworkStub(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: first\n\n'));
          // 保持流打开，模拟持续的 SSE 连接
        },
        cancel() {
          upstreamCancelled = true;
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  );

  try {
    await withServer({
      REQUIRE_HEADERS: 'false',
      ENABLE_CACHE: 'false',
      ENABLE_LOGGING: 'false',
    }, async (server) => {
      const res = await server.handleRequest(
        new Request('http://localhost:3000/abort-stream.example.net/events'),
      );
      assertEquals(res.status, 200);

      const reader = res.body!.getReader();
      const first = await reader.read();
      assertEquals(first.done, false);
      assertMatch(new TextDecoder().decode(first.value), /first/);

      await reader.cancel();
      // 等待取消传播到上游流
      for (let i = 0; i < 20 && !upstreamCancelled; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assertEquals(upstreamCancelled, true);

      const statsRes = await server.handleRequest(new Request('http://localhost:3000/_api/stats'));
      const stats = await statsRes.json();
      assertEquals(stats.concurrency.totalCount, 0);
    });
  } finally {
    stub.restore();
  }
});

Deno.test('Non-streaming JSON response keeps status, body and content type', async () => {
  const stub = installNetworkStub(() =>
    new Response(JSON.stringify({ result: 'plain-json' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  );

  try {
    await withServer({
      REQUIRE_HEADERS_EXEMPT_DOMAINS: 'json.native-client.example.net',
      REQUIRE_HEADERS: 'true',
      ENABLE_LOGGING: 'false',
      ENABLE_CACHE: 'false',
    }, async (server) => {
      const res = await server.handleRequest(
        new Request('http://localhost:3000/json.native-client.example.net/v1/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"name":"x"}',
        }),
      );
      assertEquals(res.status, 201);
      assertMatch(res.headers.get('Content-Type') || '', /application\/json/);
      assertEquals(await res.json(), { result: 'plain-json' });
    });
  } finally {
    stub.restore();
  }
});

// ==================== 启动机制 ====================

/**
 * 启动子进程并等待 /health 可用；返回子进程与已捕获的 stderr。
 * 仅使用本地回环地址与随机端口，不依赖外部网络。
 */
async function spawnServerProcess(
  entrypoint: string,
  env: Record<string, string>,
): Promise<{
  child: Deno.ChildProcess;
  port: number;
  stdout: () => string;
  stderr: () => string;
  stop: () => Promise<number>;
}> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  // 通过 PATH 调用 deno，而不是 Deno.execPath()：run 权限按命令名匹配 `--allow-run=deno`，
  // 绝对路径在部分 Deno 版本需要额外授权到该路径，换机器或换安装位置就会 NotCapable。
  const child = new Deno.Command('deno', {
    args: ['run', '--allow-net', '--allow-env', '--allow-read', '--no-prompt', entrypoint],
    cwd: new URL('.', import.meta.url).pathname,
    env: { ...env, PORT: String(port), HOST: '127.0.0.1' },
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

  let stderrText = '';
  const stderrReader = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      stderrText += decoder.decode(chunk);
    }
  })();
  let stdoutText = '';
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      stdoutText += decoder.decode(chunk);
    }
  })();

  const stop = async () => {
    try {
      child.kill('SIGTERM');
    } catch {
      // 已退出
    }
    const status = await child.status;
    await Promise.all([stderrReader.catch(() => {}), stdoutDrain.catch(() => {})]);
    return status.code;
  };

  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        await res.body?.cancel();
        return { child, port, stdout: () => stdoutText, stderr: () => stderrText, stop };
      }
    } catch {
      // 尚未监听
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await stop();
  throw new Error(`Server on port ${port} did not become healthy. stderr:\n${stderrText}`);
}

Deno.test('Startup: main.ts entry starts without the deno serve warning', async () => {
  const proc = await spawnServerProcess('main.ts', { ENABLE_LOGGING: 'false', REQUIRE_HEADERS: 'false' });
  try {
    const health = await fetch(`http://127.0.0.1:${proc.port}/health`);
    assertEquals(health.status, 200);
    const body = await health.json();
    assertEquals(body.status, 'healthy');
    assertEquals(body.healthy, true);

    const adminHealth = await fetch(`http://127.0.0.1:${proc.port}/_health`);
    assertEquals(adminHealth.status, 200);
    assertEquals((await adminHealth.json()).status, 'healthy');
  } finally {
    const code = await proc.stop();
    assertEquals(code, 0, 'SIGTERM must lead to a graceful exit code 0');
  }

  // 启动日志必须体现自定义 PORT / HOST 与优雅退出，且不含 deno serve 提示
  const output = proc.stdout() + proc.stderr();
  assertMatch(output, new RegExp(`Listen: 127\\.0\\.0\\.1:${proc.port}`));
  assertMatch(output, /Starting server on http:\/\/127\.0\.0\.1:\d+/);
  assertMatch(output, /Shutting down gracefully/);
  assertEquals(output.includes('did you mean to run'), false);
  // 通过 main.ts 启动时 server.ts 的 import.meta.main 为 false，只应启动一次
  assertEquals(output.split('CIAO-CORS Server').length - 1, 1);
});

Deno.test('Startup: server.ts remains a valid self-starting entrypoint', async () => {
  const proc = await spawnServerProcess('server.ts', { ENABLE_LOGGING: 'false', REQUIRE_HEADERS: 'false' });
  try {
    const health = await fetch(`http://127.0.0.1:${proc.port}/_health`);
    assertEquals(health.status, 200);
    await health.body?.cancel();
  } finally {
    assertEquals(await proc.stop(), 0);
  }
});
