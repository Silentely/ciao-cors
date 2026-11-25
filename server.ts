/**
 * CIAO-CORS - 高性能 CORS 代理服务
 * 支持环境变量配置、请求限制、黑白名单、统计、LRU 缓存与容器化部署
 * 作者: Silentely
 * 项目: https://github.com/Silentely/ciao-cors
 */

// ==================== 版本（单一数据源） ====================
// 仅在此处定义一次，所有接口/日志中的版本号都引用它，避免多处硬编码导致不一致。
// 需与 deno.json 中的 "version" 保持一致（由 update-version.sh 统一更新）。
const VERSION = '1.3.2';

// ==================== 配置管理模块 ===================
/**
 * 默认阻断的常见URL关键字（参考 netnr/workers）
 * 主要是流媒体分片切片、播放列表及高频被滥用消耗流量的流媒体站点
 */
const DEFAULT_BLOCKED_KEYWORDS: string[] = [
  '.m3u8',
  '.ts',
  '.m4s',
  '.mpd',
  '.acc',
  'googlevideo.com',
  'photocall.tv',
  'liveradio.ie'
];

interface Config {
  port: number;
  host: string;
  resourceProfile: 'standard' | 'low-memory';
  allowedOrigins: string[];
  blockedIPs: string[];
  blockedDomains: string[];
  allowedDomains: string[];
  rateLimit: number;
  rateLimitWindow: number;
  concurrentLimit: number;
  totalConcurrentLimit: number;
  apiKey?: string;
  proxyApiKey?: string;
  trustedProxies: string[];
  enableStats: boolean;
  enableLogging: boolean;
  logWebhook?: string;
  maxUrlLength: number;
  maxBodySize: number;
  timeout: number;
  streamIdleTimeout: number;
  requireHeaders: boolean;
  removeOriginHeader: boolean;
  enableKeywordBlock: boolean;
  blockedKeywords: string[];
  enableCache: boolean;
  maxCacheEntries: number;
  maxCacheBytes: number;
  maxCacheEntryBytes: number;
  cacheTtl: number;
  dropHeaders: string[];
  forwardSetCookie: boolean;
  enableManagementApi: boolean;
}

/**
 * 加载和解析环境变量配置
 * 支持 low-memory 预设配置，同时允许具体环境变量单独覆盖
 */
function loadConfig(): Config {
  const parseArray = (str?: string): string[] => {
    if (!str) return [];
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        return parsed.filter(Boolean);
      } else {
        return str.split(',').map(s => s.trim()).filter(Boolean);
      }
    } catch {
      return str.split(',').map(s => s.trim()).filter(Boolean);
    }
  };

  const validatePort = (port: number): number => {
    if (isNaN(port) || port < 1 || port > 65535) {
      console.warn(`Invalid port ${port}, using default 3000`);
      return 3000;
    }
    return port;
  };

  const validatePositiveInt = (value: number, defaultValue: number, name: string): number => {
    if (isNaN(value) || value < 0) {
      console.warn(`Invalid ${name} ${value}, using default ${defaultValue}`);
      return defaultValue;
    }
    return value;
  };

  const profileRaw = (Deno.env.get('RESOURCE_PROFILE') || '').toLowerCase().trim();
  const isLowMemory = profileRaw === 'low-memory' || profileRaw === 'low';
  const resourceProfile: 'standard' | 'low-memory' = isLowMemory ? 'low-memory' : 'standard';

  // 根据 profile 设置默认基准值
  const defaultRateLimit = isLowMemory ? 500 : 2500;
  const defaultConcurrentLimit = isLowMemory ? 4 : 10;
  const defaultTotalConcurrentLimit = isLowMemory ? 16 : 1000;
  const defaultMaxBodySize = isLowMemory ? 1 * 1024 * 1024 : 10 * 1024 * 1024; // 1MB vs 10MB
  const defaultMaxCacheEntries = isLowMemory ? 32 : 1000;
  const defaultMaxCacheBytes = isLowMemory ? 8 * 1024 * 1024 : 32 * 1024 * 1024; // 8MiB vs 32MiB
  const defaultMaxCacheEntryBytes = isLowMemory ? 256 * 1024 : 2 * 1024 * 1024; // 256KiB vs 2MiB
  const defaultCacheTtl = isLowMemory ? 15000 : 60000; // 15s vs 60s

  const config: Config = {
    port: validatePort(parseInt(Deno.env.get('PORT') || '3000')),
    host: Deno.env.get('HOST') || '0.0.0.0',
    resourceProfile,
    allowedOrigins: parseArray(Deno.env.get('ALLOWED_ORIGINS')),
    blockedIPs: parseArray(Deno.env.get('BLOCKED_IPS')),
    blockedDomains: parseArray(Deno.env.get('BLOCKED_DOMAINS')),
    allowedDomains: parseArray(Deno.env.get('ALLOWED_DOMAINS')),
    rateLimit: validatePositiveInt(parseInt(Deno.env.get('RATE_LIMIT') || String(defaultRateLimit)), defaultRateLimit, 'RATE_LIMIT'),
    rateLimitWindow: validatePositiveInt(parseInt(Deno.env.get('RATE_LIMIT_WINDOW') || '60000'), 60000, 'RATE_LIMIT_WINDOW'),
    concurrentLimit: validatePositiveInt(parseInt(Deno.env.get('CONCURRENT_LIMIT') || String(defaultConcurrentLimit)), defaultConcurrentLimit, 'CONCURRENT_LIMIT'),
    totalConcurrentLimit: validatePositiveInt(parseInt(Deno.env.get('TOTAL_CONCURRENT_LIMIT') || String(defaultTotalConcurrentLimit)), defaultTotalConcurrentLimit, 'TOTAL_CONCURRENT_LIMIT'),
    apiKey: Deno.env.get('API_KEY')?.trim() || undefined,
    proxyApiKey: Deno.env.get('PROXY_API_KEY')?.trim() || undefined,
    trustedProxies: parseArray(Deno.env.get('TRUSTED_PROXIES')),
    enableStats: Deno.env.get('ENABLE_STATS') !== 'false',
    enableLogging: Deno.env.get('ENABLE_LOGGING') !== 'false',
    logWebhook: Deno.env.get('LOG_WEBHOOK')?.trim() || undefined,
    maxUrlLength: validatePositiveInt(parseInt(Deno.env.get('MAX_URL_LENGTH') || '2048'), 2048, 'MAX_URL_LENGTH'),
    maxBodySize: validatePositiveInt(parseInt(Deno.env.get('MAX_BODY_SIZE') || String(defaultMaxBodySize)), defaultMaxBodySize, 'MAX_BODY_SIZE'),
    timeout: validatePositiveInt(parseInt(Deno.env.get('TIMEOUT') || '30000'), 30000, 'TIMEOUT'),
    streamIdleTimeout: validatePositiveInt(parseInt(Deno.env.get('STREAM_IDLE_TIMEOUT') || '30000'), 30000, 'STREAM_IDLE_TIMEOUT'),
    requireHeaders: Deno.env.get('REQUIRE_HEADERS') !== 'false',
    removeOriginHeader: Deno.env.get('REMOVE_ORIGIN_HEADER') === 'true' || Deno.env.get('DROP_ORIGIN_HEADER') === 'true',
    enableKeywordBlock: Deno.env.get('ENABLE_KEYWORD_BLOCK') !== 'false',
    blockedKeywords: (() => {
      const raw = Deno.env.get('BLOCKED_KEYWORDS') || Deno.env.get('BLOCK_KEYWORDS');
      return raw !== undefined ? parseArray(raw) : [...DEFAULT_BLOCKED_KEYWORDS];
    })(),
    enableCache: Deno.env.get('ENABLE_CACHE') !== 'false',
    maxCacheEntries: validatePositiveInt(parseInt(Deno.env.get('MAX_CACHE_ENTRIES') || String(defaultMaxCacheEntries)), defaultMaxCacheEntries, 'MAX_CACHE_ENTRIES'),
    maxCacheBytes: validatePositiveInt(parseInt(Deno.env.get('MAX_CACHE_BYTES') || String(defaultMaxCacheBytes)), defaultMaxCacheBytes, 'MAX_CACHE_BYTES'),
    maxCacheEntryBytes: validatePositiveInt(parseInt(Deno.env.get('MAX_CACHE_ENTRY_BYTES') || String(defaultMaxCacheEntryBytes)), defaultMaxCacheEntryBytes, 'MAX_CACHE_ENTRY_BYTES'),
    cacheTtl: validatePositiveInt(parseInt(Deno.env.get('CACHE_TTL') || String(defaultCacheTtl)), defaultCacheTtl, 'CACHE_TTL'),
    dropHeaders: parseArray(Deno.env.get('DROP_HEADERS')),
    forwardSetCookie: Deno.env.get('FORWARD_SET_COOKIE') === 'true',
    enableManagementApi: Deno.env.get('ENABLE_MANAGEMENT_API') !== 'false'
  };

  const validateArrayConfig = (arr: string[], name: string) => {
    if (arr.some(item => typeof item !== 'string' || item.trim() === '')) {
      console.warn(`Warning: ${name} contains invalid entries, filtering out empty values`);
      return arr.filter(item => typeof item === 'string' && item.trim() !== '');
    }
    return arr;
  };

  config.allowedOrigins = validateArrayConfig(config.allowedOrigins, 'ALLOWED_ORIGINS');
  config.blockedIPs = validateArrayConfig(config.blockedIPs, 'BLOCKED_IPS');
  config.blockedDomains = validateArrayConfig(config.blockedDomains, 'BLOCKED_DOMAINS');
  config.allowedDomains = validateArrayConfig(config.allowedDomains, 'ALLOWED_DOMAINS');
  config.blockedKeywords = validateArrayConfig(config.blockedKeywords, 'BLOCKED_KEYWORDS');
  config.dropHeaders = validateArrayConfig(config.dropHeaders, 'DROP_HEADERS').map(h => h.toLowerCase());
  config.trustedProxies = validateArrayConfig(config.trustedProxies, 'TRUSTED_PROXIES');

  return config;
}

// ==================== 限制与内存管理模块 ====================
/**
 * 定长/有界限流器，防止客户端 IP 集合无界膨胀
 */
class RateLimiter {
  private buckets: Map<string, { count: number; resetAt: number }> = new Map();
  private windowMs: number;
  private maxRequests: number;
  private maxKeys: number = 10000;
  private cleanupTimer: number | null = null;
  private isDestroyed: boolean = false;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;

    const cleanupInterval = Math.min(windowMs, 60000);
    this.cleanupTimer = setInterval(() => {
      if (!this.isDestroyed) {
        this.cleanup();
      }
    }, cleanupInterval) as unknown as number;
  }

  checkLimit(ip: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(ip);

    if (!bucket || now >= bucket.resetAt) {
      if (!bucket && this.buckets.size >= this.maxKeys) {
        this.evictOne(now);
      }
      bucket = { count: 1, resetAt: now + this.windowMs };
      this.buckets.set(ip, bucket);
      return true;
    }

    if (bucket.count >= this.maxRequests) {
      return false;
    }

    bucket.count++;
    return true;
  }

  private evictOne(now: number): void {
    for (const [key, b] of this.buckets.entries()) {
      if (now >= b.resetAt) {
        this.buckets.delete(key);
        return;
      }
    }
    const oldestKey = this.buckets.keys().next().value;
    if (oldestKey !== undefined) {
      this.buckets.delete(oldestKey);
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [ip, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(ip);
      }
    }
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
  }

  getStats(): { totalIPs: number; totalRequests: number } {
    let totalRequests = 0;
    for (const b of this.buckets.values()) {
      totalRequests += b.count;
    }
    return {
      totalIPs: this.buckets.size,
      totalRequests
    };
  }
}

/**
 * 缓存条目定义：只保存固定字节数组，彻底摆脱 Response.clone() 导致的内存泄露
 */
interface CachedResponseEntry {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
  timestamp: number;
  size: number;
  vary: Record<string, string | null>;
}

/**
 * 双限制 LRU 缓存：同时限制最大条目数与最大总字节数
 */
class ByteLRUCache {
  private map = new Map<string, CachedResponseEntry>();
  private maxEntries: number;
  private maxBytes: number;
  private maxEntryBytes: number;
  private currentBytes: number = 0;

  constructor(maxEntries = 1000, maxBytes = 32 * 1024 * 1024, maxEntryBytes = 2 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
  }

  get(key: string, requestHeaders?: Headers): CachedResponseEntry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    // 校验 Vary 维度
    if (requestHeaders && entry.vary) {
      for (const [headerName, expectedValue] of Object.entries(entry.vary)) {
        const actualValue = requestHeaders.get(headerName);
        if (actualValue !== expectedValue) {
          return undefined; // Vary 不匹配，视为未命中
        }
      }
    }

    // 刷新 LRU 顺序
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, entry: CachedResponseEntry): boolean {
    if (entry.size > this.maxEntryBytes || entry.size > this.maxBytes) {
      return false;
    }

    if (this.map.has(key)) {
      const old = this.map.get(key)!;
      this.currentBytes -= old.size;
      this.map.delete(key);
    }

    // 驱逐超出条目数或超出总字节限制的最旧条目
    while (this.map.size >= this.maxEntries || (this.currentBytes + entry.size > this.maxBytes && this.map.size > 0)) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      if (oldest) {
        this.currentBytes -= oldest.size;
      }
      this.map.delete(oldestKey);
    }

    if (this.currentBytes + entry.size > this.maxBytes) {
      return false;
    }

    this.map.set(key, entry);
    this.currentBytes += entry.size;
    return true;
  }

  delete(key: string): boolean {
    const entry = this.map.get(key);
    if (entry) {
      this.currentBytes -= entry.size;
      return this.map.delete(key);
    }
    return false;
  }

  clear(): void {
    this.map.clear();
    this.currentBytes = 0;
  }

  cleanup(ttl: number): void {
    const now = Date.now();
    for (const [key, entry] of this.map.entries()) {
      if (now - entry.timestamp > ttl) {
        this.currentBytes -= entry.size;
        this.map.delete(key);
      }
    }
  }

  get size(): number {
    return this.map.size;
  }

  get totalBytes(): number {
    return this.currentBytes;
  }

  entries(): IterableIterator<[string, CachedResponseEntry]> {
    return this.map.entries();
  }
}

/**
 * 并发租赁令牌，确保在流式传输或异常分支中精确释放，防止重复释放与计数漂移
 */
interface ConcurrencyLease {
  ip: string;
  released: boolean;
}

class ConcurrencyLimiter {
  private perIpCount: Map<string, number> = new Map();
  private totalCount = 0;
  private perIpLimit: number;
  private totalLimit: number;

  constructor(perIpLimit: number, totalLimit: number) {
    this.perIpLimit = perIpLimit;
    this.totalLimit = totalLimit;
  }

  acquire(ip: string): ConcurrencyLease | null {
    const currentPerIp = this.perIpCount.get(ip) || 0;
    if (currentPerIp >= this.perIpLimit || this.totalCount >= this.totalLimit) {
      return null;
    }
    this.perIpCount.set(ip, currentPerIp + 1);
    this.totalCount++;
    return { ip, released: false };
  }

  release(lease: ConcurrencyLease | null): void {
    if (!lease || lease.released) {
      return;
    }
    lease.released = true;
    const ip = lease.ip;
    const currentPerIp = this.perIpCount.get(ip) || 0;
    if (currentPerIp > 0) {
      if (currentPerIp === 1) {
        this.perIpCount.delete(ip);
      } else {
        this.perIpCount.set(ip, currentPerIp - 1);
      }
      this.totalCount = Math.max(0, this.totalCount - 1);
    }
  }

  getStats(): { perIpCount: Map<string, number>; totalCount: number } {
    return {
      perIpCount: new Map(this.perIpCount),
      totalCount: this.totalCount
    };
  }
}

// ==================== 安全与 SSRF 防护模块 ====================
/**
 * 解析 IPv4 地址字符串为 32 位无符号整数
 */
function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^\d{1,3}$/.test(part)) return null;
    // 严格禁止前导 0 混淆（八进制绕过）
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0;
}

/**
 * 解析 IPv6 地址为 8 个 16 位数字
 */
function parseIPv6(ip: string): number[] | null {
  let clean = ip.toLowerCase();
  const zoneIndex = clean.indexOf('%');
  if (zoneIndex !== -1) {
    clean = clean.substring(0, zoneIndex);
  }

  // 处理末尾带点分十进制的 IPv4-mapped IPv6，如 ::ffff:192.168.1.1
  const lastColon = clean.lastIndexOf(':');
  if (lastColon !== -1) {
    const potentialIpv4 = clean.substring(lastColon + 1);
    if (potentialIpv4.includes('.')) {
      const v4Num = parseIPv4(potentialIpv4);
      if (v4Num === null) return null;
      const part7 = (v4Num >>> 16) & 0xffff;
      const part8 = v4Num & 0xffff;
      clean = clean.substring(0, lastColon) + ':' + part7.toString(16) + ':' + part8.toString(16);
    }
  }

  const parts = clean.split('::');
  if (parts.length > 2) return null;

  const head: number[] = [];
  const tail: number[] = [];

  if (parts[0]) {
    const h = parts[0].split(':').filter(Boolean);
    for (const seg of h) {
      if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
      head.push(parseInt(seg, 16));
    }
  }

  if (parts.length === 2 && parts[1]) {
    const t = parts[1].split(':').filter(Boolean);
    for (const seg of t) {
      if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
      tail.push(parseInt(seg, 16));
    }
  }

  if (parts.length === 1) {
    if (head.length !== 8) return null;
    return head;
  }

  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const zeros = new Array(missing).fill(0);
  return [...head, ...zeros, ...tail];
}

/**
 * 完整校验 IPv4 和 IPv6 是否属于私有、保留、组播或受限地址段
 */
function isPrivateOrReservedIP(ip: string): boolean {
  const cleanIp = ip.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').trim();

  // 1. IPv4 检查
  const v4Int = parseIPv4(cleanIp);
  if (v4Int !== null) {
    return isPrivateIPv4(v4Int);
  }

  // 2. IPv6 检查
  const v6Parts = parseIPv6(cleanIp);
  if (v6Parts !== null) {
    // 检查是否为 IPv4-mapped IPv6 (::ffff:0:0/96) 或 NAT64 (64:ff9b::/96)
    if (v6Parts[0] === 0 && v6Parts[1] === 0 && v6Parts[2] === 0 && v6Parts[3] === 0 && v6Parts[4] === 0 && v6Parts[5] === 0xffff) {
      const embeddedV4 = ((v6Parts[6] << 16) | v6Parts[7]) >>> 0;
      return isPrivateIPv4(embeddedV4);
    }
    if (v6Parts[0] === 0x0064 && v6Parts[1] === 0xff9b && v6Parts[2] === 0 && v6Parts[3] === 0 && v6Parts[4] === 0 && v6Parts[5] === 0) {
      const embeddedV4 = ((v6Parts[6] << 16) | v6Parts[7]) >>> 0;
      return isPrivateIPv4(embeddedV4);
    }
    // 6to4 (2002::/16)
    if (v6Parts[0] === 0x2002) {
      const embeddedV4 = ((v6Parts[1] << 16) | v6Parts[2]) >>> 0;
      return isPrivateIPv4(embeddedV4);
    }

    // ::/128 (未指定地址)
    if (v6Parts.every(p => p === 0)) return true;
    // ::1/128 (回环)
    if (v6Parts.slice(0, 7).every(p => p === 0) && v6Parts[7] === 1) return true;
    // fc00::/7 (唯一本地地址 ULA，涵盖 fc00-fdff，含 AWS IMDSv6 fd00:ec2::254)
    if ((v6Parts[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10 (链路本地地址)
    if ((v6Parts[0] & 0xffc0) === 0xfe80) return true;
    // ff00::/8 (组播地址，如 ff02::1)
    if ((v6Parts[0] & 0xff00) === 0xff00) return true;
    // 2001:db8::/32 (文档地址)
    if (v6Parts[0] === 0x2001 && v6Parts[1] === 0x0db8) return true;
    // 100::/64 (丢弃前缀)
    if (v6Parts[0] === 0x0100 && v6Parts[1] === 0 && v6Parts[2] === 0 && v6Parts[3] === 0) return true;

    return false;
  }

  // 无法识别为合法 IPv4/IPv6，保守拒绝
  return true;
}

function isPrivateIPv4(n: number): boolean {
  const b0 = (n >>> 24) & 0xff;
  const b1 = (n >>> 16) & 0xff;
  const b2 = (n >>> 8) & 0xff;
  const b3 = n & 0xff;

  // 0.0.0.0/8
  if (b0 === 0) return true;
  // 10.0.0.0/8
  if (b0 === 10) return true;
  // 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  // 阿里云元数据服务精确地址 100.100.100.200
  if (b0 === 100 && b1 === 100 && b2 === 100 && b3 === 200) return true;
  // 127.0.0.0/8 (回环)
  if (b0 === 127) return true;
  // 169.254.0.0/16 (链路本地 / 云元数据：AWS 169.254.169.254, Scaleway 169.254.42.42, ECS 169.254.170.2)
  if (b0 === 169 && b1 === 254) return true;
  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.0.0.0/24 (IETF 协议分配)
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;
  // 192.168.0.0/16 (私网)
  if (b0 === 192 && b1 === 168) return true;
  // 198.18.0.0/15 (198.18.0.0 - 198.19.255.255)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;
  // 224.0.0.0/4 (组播 224.0.0.0 - 239.255.255.255)
  if (b0 >= 224 && b0 <= 239) return true;
  // 240.0.0.0/4 (保留/未来使用 240.0.0.0 - 255.255.255.255)
  if (b0 >= 240) return true;

  return false;
}

/**
 * 校验给定 IP 是否与 trustedProxies CIDR/IP 列表匹配
 */
function isTrustedIP(ip: string, trustedList: string[]): boolean {
  if (trustedList.length === 0) return false;
  const clean = ip.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').trim();

  for (const item of trustedList) {
    if (item === '*' || item === clean) return true;
    if (item.includes('/')) {
      const [cidrIp, prefixStr] = item.split('/');
      const prefix = parseInt(prefixStr, 10);
      const targetV4 = parseIPv4(clean);
      const cidrV4 = parseIPv4(cidrIp);
      if (targetV4 !== null && cidrV4 !== null && !isNaN(prefix) && prefix >= 0 && prefix <= 32) {
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
        if ((targetV4 & mask) === (cidrV4 & mask)) return true;
      }
    }
  }
  return false;
}

/**
 * DNS 短期缓存，缓解高频重复解析带来的性能与抖动问题，同时具有上限防护
 */
const dnsCache = new Map<string, { safe: boolean; reason?: string; expireAt: number }>();
const MAX_DNS_CACHE = 256;

/**
 * 动态解析域名真实 IP 并校验，防范 DNS Rebinding / 内网 SSRF 绕过
 * 坚持 fail-closed 原则：DNS 解析失败或无记录时阻断请求，杜绝静默放行
 */
async function verifyDomainResolution(hostname: string): Promise<{ safe: boolean; reason?: string }> {
  const cleanHost = hostname.replace(/^\[/, '').replace(/\]$/, '').trim();

  // 若目标为直接 IP，直接进行地址段校验
  const isDirectIP = parseIPv4(cleanHost) !== null || parseIPv6(cleanHost) !== null;
  if (isDirectIP) {
    if (isPrivateOrReservedIP(cleanHost)) {
      return { safe: false, reason: 'Access to private or reserved IP address is forbidden' };
    }
    return { safe: true };
  }

  // 检查 DNS 缓存
  const now = Date.now();
  const cached = dnsCache.get(cleanHost);
  if (cached && now < cached.expireAt) {
    return { safe: cached.safe, reason: cached.reason };
  }

  // 在 Deno 环境下解析真实 A 和 AAAA 记录
  if (typeof (globalThis as any).Deno !== 'undefined' && typeof (globalThis as any).Deno.resolveDns === 'function') {
    try {
      const timeoutMs = 2500;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DNS resolution timeout')), timeoutMs)
      );

      const resolveA = (globalThis as any).Deno.resolveDns(cleanHost, 'A').catch(() => []);
      const resolveAAAA = (globalThis as any).Deno.resolveDns(cleanHost, 'AAAA').catch(() => []);

      const [aRecords, aaaaRecords] = await Promise.race([
        Promise.all([resolveA, resolveAAAA]),
        timeoutPromise
      ]) as [string[], string[]];

      const records: string[] = [];
      if (Array.isArray(aRecords)) records.push(...aRecords);
      if (Array.isArray(aaaaRecords)) records.push(...aaaaRecords);

      // fail-closed：无法解析到任何有效记录时阻断请求
      if (records.length === 0) {
        return { safe: false, reason: `Target domain could not be resolved or returned no records: ${cleanHost}` };
      }

      for (const ip of records) {
        if (isPrivateOrReservedIP(ip)) {
          const res = { safe: false, reason: `Target domain resolves to restricted private IP: ${ip}` };
          if (dnsCache.size < MAX_DNS_CACHE) {
            dnsCache.set(cleanHost, { ...res, expireAt: now + 10000 }); // 失败短缓存 10s
          }
          return res;
        }
      }

      const res = { safe: true };
      if (dnsCache.size < MAX_DNS_CACHE) {
        dnsCache.set(cleanHost, { ...res, expireAt: now + 60000 }); // 成功缓存 60s
      }
      return res;
    } catch (e) {
      return {
        safe: false,
        reason: `Target domain DNS lookup failed: ${e instanceof Error ? e.message : 'Unknown DNS error'}`
      };
    }
  }

  return { safe: true };
}

/**
 * 校验目标 URL 自身的安全性：协议白名单、控制字符、凭证混淆、内网地址、受限端口、动态 DNS 解析等
 */
async function validateTargetUrl(rawUrl: string): Promise<{ valid: boolean; reason?: string; targetUrl?: URL }> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(fixUrl(rawUrl));
  } catch {
    return { valid: false, reason: 'Invalid URL' };
  }

  // 严格只允许 http/https 协议
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return { valid: false, reason: 'Unsupported URL protocol' };
  }

  // 阻断带有 userinfo (user:pass@host) 的 URL，防范主机混淆与凭证伪造
  if (targetUrl.username || targetUrl.password) {
    return { valid: false, reason: 'URLs with userinfo credentials are not allowed' };
  }

  // 检查是否包含控制字符
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/.test(rawUrl)) {
    return { valid: false, reason: 'URL contains control characters' };
  }

  const hostname = targetUrl.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');

  // 检查云平台内部元数据及特殊域名
  const restrictedDomains = [
    'localhost',
    'metadata.google.internal',
    'metadata.goog',
    'metadata.scaleway.com',
    '169.254.169.254',
    '169.254.42.42', // Scaleway 内部元数据地址
    'metadata',
    'instance-data',
    'consul',
    'vault.service.consul'
  ];

  if (restrictedDomains.some(domain => hostname === domain || hostname.endsWith('.' + domain))) {
    return { valid: false, reason: 'Access to restricted domains is not allowed' };
  }

  // 动态 DNS 解析与私网 IP 校验
  const dnsCheck = await verifyDomainResolution(hostname);
  if (!dnsCheck.safe) {
    return { valid: false, reason: dnsCheck.reason };
  }

  // 检查受限端口
  const port = targetUrl.port;
  if (port) {
    const portNum = parseInt(port, 10);
    const restrictedPorts = [22, 23, 25, 53, 135, 139, 445, 993, 995, 1433, 1521, 3306, 3389, 5432, 5984, 6379, 9200, 11211, 27017];
    if (restrictedPorts.includes(portNum)) {
      return { valid: false, reason: 'Access to restricted ports is not allowed' };
    }
  }

  return { valid: true, targetUrl };
}

/**
 * 综合安全检查：验证目标 URL 和请求来源
 */
async function validateRequest(url: string, ip: string, config: Config, origin?: string | null): Promise<{ valid: boolean; reason?: string }> {
  // 检查 IP 黑名单
  if (config.blockedIPs.length > 0 && config.blockedIPs.includes(ip)) {
    return { valid: false, reason: 'IP blocked' };
  }

  // 检查 URL 长度
  if (url.length > config.maxUrlLength) {
    return { valid: false, reason: 'URL too long' };
  }

  // 检查 URL 关键字黑名单
  if (config.enableKeywordBlock && config.blockedKeywords.length > 0) {
    let lowerUrl = url.toLowerCase();
    try {
      lowerUrl = decodeURIComponent(lowerUrl);
    } catch {
      // 解码失败继续使用原字符串
    }
    const matched = config.blockedKeywords.find(kw => lowerUrl.includes(kw.toLowerCase()));
    if (matched) {
      return { valid: false, reason: `URL contains blocked keyword: ${matched}` };
    }
  }

  // 校验目标 URL 安全性
  const check = await validateTargetUrl(url);
  if (!check.valid || !check.targetUrl) {
    return { valid: false, reason: check.reason };
  }

  const targetDomain = check.targetUrl.hostname.toLowerCase().replace(/\.$/, '');

  // 检查域名黑名单
  if (config.blockedDomains.length > 0) {
    const isBlocked = config.blockedDomains.some(blocked =>
      targetDomain === blocked || targetDomain.endsWith('.' + blocked)
    );
    if (isBlocked) {
      return { valid: false, reason: 'Domain blocked' };
    }
  }

  // 检查域名白名单
  if (config.allowedDomains.length > 0) {
    const isAllowed = config.allowedDomains.some(allowed =>
      targetDomain === allowed || targetDomain.endsWith('.' + allowed)
    );
    if (!isAllowed) {
      return { valid: false, reason: 'Domain not allowed' };
    }
  }

  // 检查来源白名单
  if (config.allowedOrigins.length > 0 && origin) {
    if (!config.allowedOrigins.includes('*') && !config.allowedOrigins.includes(origin)) {
      return { valid: false, reason: 'Origin not allowed' };
    }
  }

  return { valid: true };
}

// ==================== 请求处理与流式控制 ====================
function fixUrl(url: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    return url;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/(?!\/)/.test(url)) {
    return url.replace(':/', '://');
  }
  return 'https://' + url;
}

/**
 * 构建代理请求的 headers，无条件剥离代理鉴权头及敏感 hop-by-hop 头
 */
function buildProxyHeaders(originalHeaders: Headers, config?: Config): Headers {
  const headers = new Headers();
  const dropHeaders = new Set([
    'content-length', 'host', 'connection', 'keep-alive',
    'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
    'transfer-encoding', 'upgrade', 'cf-connecting-ip', 'cf-ray',
    'cf-visitor', 'cf-ipcountry', 'x-proxy-key', 'x-forwarded-for',
    'x-real-ip', 'forwarded'
  ]);

  const shouldRemoveOrigin = config?.removeOriginHeader ||
    originalHeaders.get('x-remove-origin') === 'true' ||
    originalHeaders.get('x-drop-origin') === 'true';

  if (shouldRemoveOrigin) {
    dropHeaders.add('origin');
  }
  dropHeaders.add('x-remove-origin');
  dropHeaders.add('x-drop-origin');

  if (config?.dropHeaders && config.dropHeaders.length > 0) {
    for (const h of config.dropHeaders) {
      dropHeaders.add(h.toLowerCase().trim());
    }
  }

  for (const [key, value] of originalHeaders.entries()) {
    const lower = key.toLowerCase();
    if (!dropHeaders.has(lower)) {
      headers.set(key, value);
    }
  }

  // 默认 User-Agent
  if (!headers.has('user-agent')) {
    headers.set('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  }
  if (!headers.has('accept')) {
    headers.set('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8');
  }
  if (!headers.has('accept-language')) {
    headers.set('accept-language', 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7');
  }
  if (!headers.has('accept-encoding')) {
    headers.set('accept-encoding', 'gzip, deflate, br');
  }

  return headers;
}

class PayloadTooLargeError extends Error {
  constructor(message = 'Request body too large') {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * 流式按块读取请求体，并在超过限制时立刻终止读取，防止无界 chunked 导致 OOM
 */
async function processRequestBody(request: Request, maxBodySize: number): Promise<Uint8Array | undefined> {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    return undefined;
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxBodySize) {
      throw new PayloadTooLargeError(`Request body too large. Maximum size: ${maxBodySize} bytes`);
    }
  }

  if (!request.body) {
    return undefined;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBodySize) {
          await reader.cancel();
          throw new PayloadTooLargeError(`Request body too large. Maximum size: ${maxBodySize} bytes`);
        }
        chunks.push(value);
      }
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * 执行代理请求（带重试与严格重定向校验）
 */
async function performProxy(
  request: Request,
  targetUrl: string,
  config: Config,
  cachedBody?: Uint8Array
): Promise<Response> {
  const headers = buildProxyHeaders(request.headers, config);
  const body = cachedBody !== undefined ? cachedBody : await processRequestBody(request, config.maxBodySize);

  const maxRetries = 2;
  const retryDelay = [100, 300];
  const maxRedirects = 5;
  const isIdempotent = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(request.method) || request.headers.has('idempotency-key');

  const shouldRetry = (error: any, attempt: number): boolean => {
    if (attempt >= maxRetries || !isIdempotent) return false;
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return message.includes('network') ||
             message.includes('connection') ||
             message.includes('econnrefused') ||
             message.includes('timeout') ||
             message.includes('fetch');
    }
    return false;
  };

  const shouldRetryStatus = (status: number, attempt: number): boolean => {
    if (attempt >= maxRetries || !isIdempotent) return false;
    return status === 502 || status === 503 || status === 504 || status === 429;
  };

  const validateRedirectTarget = async (location: string, baseUrl: string): Promise<string> => {
    let resolved: URL;
    try {
      resolved = new URL(location, baseUrl);
    } catch {
      throw new Error('Redirect blocked: Invalid Location');
    }

    const resolvedStr = resolved.toString();
    if (config.enableKeywordBlock && config.blockedKeywords.length > 0) {
      const lower = resolvedStr.toLowerCase();
      const matched = config.blockedKeywords.find(kw => lower.includes(kw.toLowerCase()));
      if (matched) {
        throw new Error(`Redirect blocked: contains blocked keyword: ${matched}`);
      }
    }

    const check = await validateTargetUrl(resolvedStr);
    if (!check.valid || !check.targetUrl) {
      throw new Error(`Redirect blocked: ${check.reason}`);
    }

    const domain = check.targetUrl.hostname.toLowerCase().replace(/\.$/, '');
    const domainBlocked = config.blockedDomains.some(blocked =>
      domain === blocked || domain.endsWith('.' + blocked)
    );
    const domainNotAllowed = config.allowedDomains.length > 0 && !config.allowedDomains.some(allowed =>
      domain === allowed || domain.endsWith('.' + allowed)
    );
    if (domainBlocked || domainNotAllowed) {
      throw new Error('Redirect target domain is not allowed');
    }

    return check.targetUrl.toString();
  };

  const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    try {
      let currentUrl = targetUrl;
      let method = request.method;
      let currentBody: any = body;
      let redirectCount = 0;

      while (true) {
        const response = await fetch(currentUrl, {
          method,
          headers,
          body: currentBody,
          signal: controller.signal,
          redirect: 'manual',
          cache: request.headers.get('cache-control')?.includes('no-cache') ? 'no-cache' : 'default'
        });

        const location = response.headers.get('location');
        if (REDIRECT_STATUS.has(response.status) && location) {
          if (redirectCount >= maxRedirects) {
            await response.body?.cancel();
            throw new Error('Too many redirects');
          }

          redirectCount++;
          await response.body?.cancel();

          // 核心修复：必须 await 异步校验重定向目标
          const nextUrl = await validateRedirectTarget(location, currentUrl);

          // 跨域重定向剥离凭证，防范向外部主机泄露敏感授权
          const prevOrigin = new URL(currentUrl).origin;
          const nextOrigin = new URL(nextUrl).origin;
          if (prevOrigin !== nextOrigin) {
            headers.delete('authorization');
            headers.delete('cookie');
            headers.delete('proxy-authorization');
          }

          // 303 以及 POST 遇 301/302 转换为 GET 并清空 body
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
            method = 'GET';
            currentBody = undefined;
            headers.delete('content-type');
            headers.delete('content-encoding');
          }

          currentUrl = nextUrl;
          continue;
        }

        if (attempt < maxRetries && shouldRetryStatus(response.status, attempt)) {
          console.warn(`Attempt ${attempt + 1} failed with status ${response.status}, retrying...`);
          await response.body?.cancel();
          await new Promise(resolve => setTimeout(resolve, retryDelay[attempt]));
          break;
        }

        clearTimeout(timeoutId);
        return response;
      }
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        if (attempt < maxRetries && isIdempotent) {
          console.warn(`Attempt ${attempt + 1} timed out, retrying...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay[attempt]));
          continue;
        }
        throw new Error('Request timeout after retries');
      }

      if (shouldRetry(error, attempt)) {
        console.warn(`Attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : 'Unknown error'}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay[attempt]));
        continue;
      }

      throw error;
    }
  }

  throw new Error('Proxy request failed after retries');
}

// ==================== 统计与日志模块 ====================
interface RequestStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  topDomains: Map<string, number>;
  topIPs: Map<string, number>;
  statusCodes: Map<number, number>;
  averageResponseTime: number;
  startTime: number;
}

class StatsCollector {
  private stats: RequestStats;
  private responseTimes: number[] = [];
  private maxResponseTimes = 1000;
  // 固定 60 秒环形滑动窗口，防止时间戳无限堆积
  private secondBuckets: number[] = new Array(60).fill(0);
  private currentBucketSec: number = Math.floor(Date.now() / 1000);
  private hourlyStats: { timestamp: number; requests: number }[] = [];
  private lastHourRequestCount: number = 0;
  private hourlyTimer: number | null = null;
  private isDestroyed: boolean = false;
  private enabled: boolean;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      topDomains: new Map(),
      topIPs: new Map(),
      statusCodes: new Map(),
      averageResponseTime: 0,
      startTime: Date.now()
    };

    if (this.enabled) {
      this.hourlyTimer = setInterval(() => {
        if (!this.isDestroyed) {
          this.recordHourlyStat();
        }
      }, 3600000) as unknown as number;
    }
  }

  recordRequest(ip: string, domain: string, statusCode: number, responseTime: number, success: boolean): void {
    if (!this.enabled) return;

    this.stats.totalRequests++;
    if (success) {
      this.stats.successfulRequests++;
    } else {
      this.stats.failedRequests++;
    }

    // 有界 Top Map，限制最大 512 个键
    const updateBoundedMap = (map: Map<any, number>, key: any) => {
      const count = map.get(key) || 0;
      map.set(key, count + 1);
      if (map.size > 512) {
        const lowestKey = map.keys().next().value;
        if (lowestKey !== undefined) map.delete(lowestKey);
      }
    };

    updateBoundedMap(this.stats.topDomains, domain);
    updateBoundedMap(this.stats.topIPs, ip);
    updateBoundedMap(this.stats.statusCodes, statusCode);

    // 环形响应时间缓冲
    this.responseTimes.push(responseTime);
    if (this.responseTimes.length > this.maxResponseTimes) {
      this.responseTimes.shift();
    }
    this.stats.averageResponseTime = this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length;

    // 环形秒级滑动窗口
    const nowSec = Math.floor(Date.now() / 1000);
    const diff = nowSec - this.currentBucketSec;
    if (diff > 0) {
      for (let i = 1; i <= Math.min(diff, 60); i++) {
        this.secondBuckets[(this.currentBucketSec + i) % 60] = 0;
      }
      this.currentBucketSec = nowSec;
    }
    this.secondBuckets[nowSec % 60]++;
  }

  private recordHourlyStat(): void {
    const now = Date.now();
    const currentRequests = this.stats.totalRequests;
    const hourlyIncrement = currentRequests - this.lastHourRequestCount;

    this.hourlyStats.push({
      timestamp: now,
      requests: Math.max(0, hourlyIncrement)
    });

    this.lastHourRequestCount = currentRequests;
    if (this.hourlyStats.length > 24) {
      this.hourlyStats.shift();
    }
  }

  getStats(): RequestStats & { hourlyStats?: { timestamp: number; requests: number }[] } {
    return {
      ...this.stats,
      topDomains: new Map(Array.from(this.stats.topDomains.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)),
      topIPs: new Map(Array.from(this.stats.topIPs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)),
      hourlyStats: this.hourlyStats
    };
  }

  getPerformanceData(): {
    requestsPerMinute: number;
    averageResponseTime: number;
    errorRate: number;
    topEndpoints: [string, number][];
  } {
    const nowSec = Math.floor(Date.now() / 1000);
    const diff = nowSec - this.currentBucketSec;
    if (diff > 0) {
      for (let i = 1; i <= Math.min(diff, 60); i++) {
        this.secondBuckets[(this.currentBucketSec + i) % 60] = 0;
      }
      this.currentBucketSec = nowSec;
    }

    const requestsLastMinute = this.secondBuckets.reduce((a, b) => a + b, 0);
    const errorRate = this.stats.totalRequests > 0 ? this.stats.failedRequests / this.stats.totalRequests : 0;
    const topEndpoints = Array.from(this.stats.topDomains.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

    return {
      requestsPerMinute: requestsLastMinute,
      averageResponseTime: this.stats.averageResponseTime,
      errorRate,
      topEndpoints
    };
  }

  reset(): void {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      topDomains: new Map(),
      topIPs: new Map(),
      statusCodes: new Map(),
      averageResponseTime: 0,
      startTime: Date.now()
    };
    this.responseTimes = [];
    this.secondBuckets.fill(0);
    this.lastHourRequestCount = 0;
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.hourlyTimer !== null) {
      clearInterval(this.hourlyTimer);
      this.hourlyTimer = null;
    }
  }
}

class Logger {
  private enableConsole: boolean;
  private webhookUrl?: string;
  private logBuffer: string[] = [];
  private bufferSize = 10;
  private maxBufferSize = 100;
  private bufferTimer: number | null = null;
  private isDestroyed: boolean = false;

  constructor(enableConsole: boolean, webhookUrl?: string) {
    this.enableConsole = enableConsole;
    this.webhookUrl = webhookUrl;

    if (this.webhookUrl) {
      this.bufferTimer = setInterval(() => {
        if (!this.isDestroyed) {
          this.flushLogBuffer();
        }
      }, 30000) as unknown as number;
    }
  }

  logRequest(request: Request, response: Response, proxyUrl?: string, responseTime?: number, clientIP?: string): void {
    if (!this.enableConsole && !this.webhookUrl) return;

    const sanitizedUrl = this.sanitizeUrl(request.url);
    const sanitizedProxyUrl = proxyUrl ? this.sanitizeUrl(proxyUrl) : undefined;
    const sanitizedUserAgent = this.sanitizeUserAgent(request.headers.get('user-agent'));

    const logData = {
      timestamp: new Date().toISOString(),
      method: request.method,
      url: sanitizedUrl,
      proxyUrl: sanitizedProxyUrl,
      statusCode: response.status,
      responseTime,
      userAgent: sanitizedUserAgent,
      ip: clientIP || 'unknown'
    };

    if (this.enableConsole) {
      console.log(`[${logData.timestamp}] ${logData.method} ${logData.url} -> ${logData.proxyUrl} (${logData.statusCode}) ${logData.responseTime}ms`);
    }

    if (this.webhookUrl) {
      if (this.logBuffer.length >= this.maxBufferSize) {
        this.logBuffer.shift(); // 丢弃最老数据
      }
      this.logBuffer.push(JSON.stringify(logData));
      if (this.logBuffer.length >= this.bufferSize) {
        this.flushLogBuffer();
      }
    }
  }

  logError(error: Error, context?: any): void {
    if (!this.enableConsole && !this.webhookUrl) return;

    const safeContext = { ...context };
    if (safeContext.url) {
      safeContext.url = this.sanitizeUrl(safeContext.url);
    }

    const logData = {
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: error.message,
      context: safeContext
    };

    if (this.enableConsole) {
      console.error(`[${logData.timestamp}] ERROR: ${error.message}`, safeContext);
    }

    if (this.webhookUrl) {
      fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(logData),
        signal: AbortSignal.timeout(5000)
      }).catch(() => {});
    }
  }

  private flushLogBuffer(): void {
    if (this.webhookUrl && this.logBuffer.length > 0) {
      const logs = [...this.logBuffer];
      this.logBuffer = [];

      fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs }),
        signal: AbortSignal.timeout(5000)
      }).catch(() => {});
    }
  }

  cleanup(): void {
    this.isDestroyed = true;
    if (this.bufferTimer !== null) {
      clearInterval(this.bufferTimer);
      this.bufferTimer = null;
    }
    this.flushLogBuffer();
  }

  private sanitizeUrl(url: string): string {
    try {
      const urlObj = new URL(url.startsWith('http') ? url : `http://example.com${url}`);
      const sensitiveParams = ['key', 'token', 'password', 'secret', 'auth', 'api_key', 'proxy_key'];
      sensitiveParams.forEach(param => {
        if (urlObj.searchParams.has(param)) {
          urlObj.searchParams.set(param, '***');
        }
      });
      return url.startsWith('http') ? urlObj.toString() : urlObj.pathname + urlObj.search;
    } catch {
      return url;
    }
  }

  private sanitizeUserAgent(userAgent: string | null): string | null {
    if (!userAgent) return null;
    return userAgent.replace(/\b[\w-]{32,}\b/g, '***');
  }
}

// ==================== 主服务模块 ====================
export class CiaoCorsServer {
  private config: Config;
  private rateLimiter: RateLimiter;
  private concurrencyLimiter: ConcurrencyLimiter;
  private statsCollector: StatsCollector;
  private logger: Logger;
  private responseCache: ByteLRUCache;
  private cacheCleanupTimer: number | null = null;
  private isDestroyed: boolean = false;

  constructor() {
    this.config = loadConfig();
    this.rateLimiter = new RateLimiter(this.config.rateLimitWindow, this.config.rateLimit);
    this.concurrencyLimiter = new ConcurrencyLimiter(this.config.concurrentLimit, this.config.totalConcurrentLimit);
    this.statsCollector = new StatsCollector(this.config.enableStats);
    this.logger = new Logger(this.config.enableLogging, this.config.logWebhook);
    this.responseCache = new ByteLRUCache(
      this.config.maxCacheEntries,
      this.config.maxCacheBytes,
      this.config.maxCacheEntryBytes
    );

    if (this.config.enableCache) {
      this.cacheCleanupTimer = setInterval(() => {
        if (!this.isDestroyed) {
          this.responseCache.cleanup(this.config.cacheTtl);
        }
      }, 30000) as unknown as number;
    }
  }

  async handleRequest(request: Request, remoteAddr?: { hostname: string }): Promise<Response> {
    const requestId = crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const startTime = Date.now();
    const clientIP = this.resolveClientIP(request, remoteAddr);
    const origin = request.headers.get('origin');

    try {
      // 1. 处理 OPTIONS 预检请求（放行鉴权与限流）
      if (request.method === 'OPTIONS') {
        return this.handlePreflight(request);
      }

      // 2. 解析目标路径
      const url = new URL(request.url);
      const queryUrl = url.searchParams.get('url');
      let targetPath: string;
      try {
        if (queryUrl) {
          targetPath = queryUrl.trim();
        } else {
          targetPath = decodeURIComponent(url.pathname.substring(1)) + url.search;
        }
      } catch {
        return this.createErrorResponse(400, 'Invalid URL encoding');
      }

      // 3. 处理健康检查路径（无外部依赖，不要求鉴权与并发槽）
      if (targetPath === 'health' || targetPath === '_health') {
        const healthHeaders = this.buildCorsHeaders(new Headers({
          'Content-Type': 'application/json'
        }), origin || undefined);
        return new Response(JSON.stringify({
          status: 'healthy',
          ok: true,
          healthy: true,
          timestamp: new Date().toISOString(),
          version: VERSION,
          profile: this.config.resourceProfile
        }), {
          headers: healthHeaders
        });
      }

      // 4. 处理管理 API 路由
      if (targetPath.startsWith('_api/')) {
        return this.handleManagementApi(request, targetPath);
      }

      // 5. 验证基本 URL 格式与长度
      if (targetPath.length > this.config.maxUrlLength) {
        return this.createErrorResponse(400, "URL too long");
      }
      if (targetPath.length < 3 || (!targetPath.includes('.') && !targetPath.includes(':') && !targetPath.startsWith('localhost')) ||
          targetPath === 'favicon.ico' || targetPath === 'robots.txt') {
        return this.createErrorResponse(400, 'Invalid URL format', {
          usage: 'https://your-domain.com/{target-url} or https://your-domain.com/?url={target-url}',
          example: 'https://your-domain.com/httpbin.org/get'
        });
      }

      // 6. 独立代理访问鉴权 (PROXY_API_KEY)
      if (this.config.proxyApiKey) {
        const proxyKey = request.headers.get('x-proxy-key') ||
                         request.headers.get('proxy-authorization')?.replace(/^Bearer\s+/i, '') ||
                         url.searchParams.get('proxy_key');

        if (!proxyKey || !this.constantTimeCompare(proxyKey, this.config.proxyApiKey)) {
          return this.createErrorResponse(401, 'Invalid or missing Proxy API Key', {
            header: 'X-Proxy-Key'
          }, origin || undefined);
        }
      }

      // 7. 必需头部验证（如 Origin / X-Requested-With）
      if (this.config.requireHeaders) {
        const hasOrigin = request.headers.has('origin');
        const hasXRequestedWith = request.headers.has('x-requested-with');
        if (!hasOrigin && !hasXRequestedWith) {
          return this.createErrorResponse(403, 'Missing required request header. Must specify one of: origin, x-requested-with', {
            usage: 'Add "Origin" or "X-Requested-With" header to your request'
          }, origin || undefined);
        }
      }

      // 8. 请求频率限制
      if (!this.rateLimiter.checkLimit(clientIP)) {
        return this.createErrorResponse(429, 'Rate limit exceeded', {
          retryAfter: Math.ceil(this.config.rateLimitWindow / 1000)
        }, origin || undefined);
      }

      // 9. 获取并发令牌 (Lease)
      const lease = this.concurrencyLimiter.acquire(clientIP);
      if (!lease) {
        return this.createErrorResponse(503, 'Concurrency limit exceeded', {
          retryAfter: 5
        }, origin || undefined);
      }

      let leaseReleased = false;
      const releaseLease = () => {
        if (!leaseReleased) {
          leaseReleased = true;
          this.concurrencyLimiter.release(lease);
        }
      };

      try {
        // 安全与黑白名单验证
        const validation = await validateRequest(targetPath, clientIP, this.config, origin || undefined);
        if (!validation.valid) {
          releaseLease();
          const isDnsFailure = validation.reason?.includes("could not be resolved") || validation.reason?.includes("DNS lookup failed");
          const statusCode = isDnsFailure ? 502 : 403;
          return this.createErrorResponse(statusCode, validation.reason || "Request blocked", undefined, origin || undefined);
        }

        const targetUrl = fixUrl(targetPath);

        // 缓存判断逻辑：
        // 1. 启用了缓存
        // 2. GET 请求
        // 3. 不含认证凭证（Authorization, Cookie, Token 等）
        const hasAuthHeader = request.headers.has('authorization') ||
                              request.headers.has('cookie') ||
                              request.headers.has('token') ||
                              request.headers.has('x-access-token');
        const canCheckCache = this.config.enableCache && request.method === 'GET' && !hasAuthHeader;
        const cacheKey = canCheckCache ? await this.generateCacheKey(request, targetUrl) : '';
        const cachedEntry = canCheckCache ? this.responseCache.get(cacheKey, request.headers) : undefined;

        if (cachedEntry && (Date.now() - cachedEntry.timestamp < this.config.cacheTtl)) {
          // 缓存命中：立即释放并发租赁，构造响应返回
          releaseLease();

          const cachedHeaders = new Headers();
          for (const [k, v] of cachedEntry.headers) {
            cachedHeaders.set(k, v);
          }

          const response = new Response(cachedEntry.body as any, {
            status: cachedEntry.status,
            statusText: cachedEntry.statusText,
            headers: this.buildCorsHeaders(cachedHeaders, origin || undefined)
          });

          if (this.config.enableStats) {
            this.statsCollector.recordRequest(clientIP, new URL(targetUrl).hostname, response.status, Date.now() - startTime, true);
          }
          this.logger.logRequest(request, response, targetUrl, Date.now() - startTime, clientIP);

          return response;
        }

        // 读取待转发的请求 body（对于 POST/PUT 等受限流式读取）
        const bodyBuffer = await processRequestBody(request, this.config.maxBodySize);

        // 执行上游代理请求
        const proxyResponse = await performProxy(request, targetUrl, this.config, bodyBuffer);
        const success = proxyResponse.status < 400;

        // 缓存准入评估
        const cc = (proxyResponse.headers.get('cache-control') || '').toLowerCase();
        const isNoStore = cc.includes('no-store') || cc.includes('no-cache') || cc.includes('private');
        const ct = (proxyResponse.headers.get('content-type') || '').toLowerCase();
        const isStreaming = ct.includes('text/event-stream') || ct.includes('application/x-ndjson') || ct.includes('multipart/x-mixed-replace');
        const hasSetCookie = proxyResponse.headers.has('set-cookie');
        const isVaryStar = (proxyResponse.headers.get('vary') || '').trim() === '*';

        const shouldCache = canCheckCache && success && !isNoStore && !isStreaming && !hasSetCookie && !isVaryStar && proxyResponse.status === 200;

        const corsHeaders = this.buildCorsHeaders(proxyResponse.headers, origin || undefined);

        // 如果不含 body（例如 204/304），立即释放并发槽
        if (!proxyResponse.body) {
          releaseLease();
          const response = new Response(null, {
            status: proxyResponse.status,
            statusText: proxyResponse.statusText,
            headers: corsHeaders
          });
          if (this.config.enableStats) {
            this.statsCollector.recordRequest(clientIP, new URL(targetUrl).hostname, response.status, Date.now() - startTime, success);
          }
          this.logger.logRequest(request, response, targetUrl, Date.now() - startTime, clientIP);
          return response;
        }

        // 如果需要缓存：使用带容量硬上限的 Tap Stream 进行旁路收集，不阻塞也不缓冲超大响应
        let finalStream: ReadableStream<Uint8Array>;

        if (shouldCache) {
          const maxEntryBytes = this.config.maxCacheEntryBytes;
          let bufferedBytes = 0;
          let cacheable = true;
          const chunks: Uint8Array[] = [];

          // 记录 Vary 头要求的字段
          const varyRecord: Record<string, string | null> = {};
          const varyHeader = proxyResponse.headers.get('vary');
          if (varyHeader) {
            for (const v of varyHeader.split(',')) {
              const name = v.trim().toLowerCase();
              if (name && name !== '*') {
                varyRecord[name] = request.headers.get(name);
              }
            }
          }

          // 提取上游响应头（过滤 hop-by-hop）
          const rawHeaders: [string, string][] = [];
          for (const [k, v] of proxyResponse.headers.entries()) {
            const lk = k.toLowerCase();
            if (!lk.startsWith('access-control-')) {
              rawHeaders.push([k, v]);
            }
          }

          const reader = proxyResponse.body.getReader();
          const responseCache = this.responseCache;

          finalStream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  releaseLease();

                  if (cacheable && chunks.length > 0) {
                    const fullBody = new Uint8Array(bufferedBytes);
                    let offset = 0;
                    for (const c of chunks) {
                      fullBody.set(c, offset);
                      offset += c.byteLength;
                    }

                    responseCache.set(cacheKey, {
                      status: proxyResponse.status,
                      statusText: proxyResponse.statusText,
                      headers: rawHeaders,
                      body: fullBody,
                      timestamp: Date.now(),
                      size: fullBody.byteLength + 512,
                      vary: varyRecord
                    });
                  }
                  return;
                }

                if (value) {
                  controller.enqueue(value);
                  if (cacheable) {
                    bufferedBytes += value.byteLength;
                    if (bufferedBytes > maxEntryBytes) {
                      cacheable = false;
                      chunks.length = 0; // 超过单条缓存上限，立即释放已缓冲切片
                    } else {
                      chunks.push(value);
                    }
                  }
                }
              } catch (err) {
                controller.error(err);
                releaseLease();
              }
            },
            cancel(reason) {
              releaseLease();
              return reader.cancel(reason);
            }
          });
        } else {
          // 普通流式响应（如 SSE 或大文件）：绑定 lease 生命周期，在真正传输完毕或断开时再释放槽位
          const reader = proxyResponse.body.getReader();

          finalStream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  releaseLease();
                  return;
                }
                if (value) {
                  controller.enqueue(value);
                }
              } catch (err) {
                controller.error(err);
                releaseLease();
              }
            },
            cancel(reason) {
              releaseLease();
              return reader.cancel(reason);
            }
          });
        }

        const response = new Response(finalStream, {
          status: proxyResponse.status,
          statusText: proxyResponse.statusText,
          headers: corsHeaders
        });

        if (this.config.enableStats) {
          this.statsCollector.recordRequest(clientIP, new URL(targetUrl).hostname, response.status, Date.now() - startTime, success);
        }
        this.logger.logRequest(request, response, targetUrl, Date.now() - startTime, clientIP);

        return response;

      } catch (innerError) {
        releaseLease();
        if (innerError instanceof PayloadTooLargeError) {
          return this.createErrorResponse(413, innerError.message, undefined, origin || undefined);
        }
        throw innerError;
      }

    } catch (error) {
      this.logger.logError(error as Error, {
        url: request.url,
        ip: clientIP,
        requestId,
        timestamp: new Date().toISOString()
      });

      if (this.config.enableStats) {
        this.statsCollector.recordRequest(clientIP, 'error', 500, Date.now() - startTime, false);
      }

      const sanitizedMessage = error instanceof Error
        ? (error.message.includes('ENOTFOUND') ? 'Target host not found' :
           error.message.includes('ECONNREFUSED') ? 'Connection refused' :
           error.message.includes('timeout') ? 'Request timeout' :
           error.message.includes('Too many redirects') ? 'Too many redirects' :
           error.message.includes('Redirect blocked') ? error.message :
           'Proxy error')
        : 'Unknown error';

      return this.createErrorResponse(500, 'Proxy error', { message: sanitizedMessage }, origin || undefined);
    }
  }

  handlePreflight(request: Request): Response {
    const origin = request.headers.get('origin');
    const headers = this.buildCorsHeaders(new Headers(), origin || undefined);

    const requestHeaders = request.headers.get('access-control-request-headers');
    if (requestHeaders) {
      // 过滤换行字符，防止头部注入
      const safeRequestHeaders = requestHeaders.replace(/[\r\n]/g, '').trim();
      const currentAllow = headers.get('Access-Control-Allow-Headers') || '';
      headers.set('Access-Control-Allow-Headers', `${currentAllow}, ${safeRequestHeaders}`);
    }

    return new Response(null, {
      status: 204,
      headers
    });
  }

  handleManagementApi(request: Request, path: string): Response {
    // 检查管理 API 是否全局启用
    if (!this.config.enableManagementApi) {
      return this.createErrorResponse(404, 'Management API disabled');
    }

    // API密钥验证
    if (this.config.apiKey) {
      const authHeader = request.headers.get('authorization');
      const providedKey = authHeader?.replace(/^Bearer\s+/i, '') ||
                          new URL(request.url).searchParams.get('key');

      if (!providedKey || !this.constantTimeCompare(providedKey, this.config.apiKey)) {
        return this.createErrorResponse(401, 'Invalid API key');
      }
    }

    const apiPath = path.substring(5).split('?')[0].replace(/\/+$/, ''); // 移除 '_api/' 前缀与 query 参数及末尾斜杠

    switch (apiPath) {
      case 'stats':
        if (!this.config.enableStats) {
          return this.createErrorResponse(404, 'Stats disabled');
        }
        {
          const stats = this.statsCollector.getStats();
          const rateLimiterStats = this.rateLimiter.getStats();
          const concurrencyStats = this.concurrencyLimiter.getStats();

          return new Response(JSON.stringify({
            stats: {
              ...stats,
              topDomains: Object.fromEntries(stats.topDomains),
              topIPs: Object.fromEntries(stats.topIPs),
              statusCodes: Object.fromEntries(stats.statusCodes),
              hourlyStats: stats.hourlyStats
            },
            rateLimiter: rateLimiterStats,
            concurrency: {
              totalCount: concurrencyStats.totalCount,
              activeIPs: concurrencyStats.perIpCount.size
            },
            cache: {
              entries: this.responseCache.size,
              bytes: this.responseCache.totalBytes,
              maxBytes: this.config.maxCacheBytes,
              maxEntries: this.config.maxCacheEntries
            },
            uptime: Date.now() - stats.startTime,
            version: VERSION
          }, null, 2), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

      case 'health':
        return new Response(JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          version: VERSION,
          profile: this.config.resourceProfile,
          memory: (Deno as any).memoryUsage ? {
            rss: (Deno as any).memoryUsage().rss,
            heapTotal: (Deno as any).memoryUsage().heapTotal,
            heapUsed: (Deno as any).memoryUsage().heapUsed
          } : undefined
        }), {
          headers: { 'Content-Type': 'application/json' }
        });

      case 'config': {
        const safeConfig = { ...this.config } as any;
        if (safeConfig.apiKey) safeConfig.apiKey = '***';
        if (safeConfig.proxyApiKey) safeConfig.proxyApiKey = '***';
        if (safeConfig.logWebhook) safeConfig.logWebhook = '***';

        return new Response(JSON.stringify(safeConfig, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'reset-stats':
        if (!this.config.enableStats) {
          return this.createErrorResponse(404, 'Stats disabled');
        }
        this.statsCollector.reset();
        return new Response(JSON.stringify({
          success: true,
          message: 'Statistics reset successfully'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });

      case 'clear-cache': {
        const cacheSize = this.responseCache.size;
        const cacheBytes = this.responseCache.totalBytes;
        this.responseCache.clear();
        return new Response(JSON.stringify({
          success: true,
          message: `Cache cleared successfully (${cacheSize} entries, ${cacheBytes} bytes)`
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'reload-config':
        try {
          this.reloadConfig();
          return new Response(JSON.stringify({
            success: true,
            message: 'Configuration reloaded successfully',
            timestamp: new Date().toISOString(),
            profile: this.config.resourceProfile
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to reload configuration',
            message: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString()
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }

      case 'performance':
        if (!this.config.enableStats) {
          return this.createErrorResponse(404, 'Stats disabled');
        }
        return new Response(JSON.stringify(this.statsCollector.getPerformanceData(), null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });

      case 'version':
        return new Response(JSON.stringify({
          version: VERSION,
          runtime: `Deno ${Deno.version.deno}`,
          typescript: Deno.version.typescript,
          v8: Deno.version.v8
        }), {
          headers: { 'Content-Type': 'application/json' }
        });

      default:
        return this.createErrorResponse(404, 'API endpoint not found');
    }
  }

  private buildCorsHeaders(originalHeaders: Headers, origin?: string): Headers {
    const headers = new Headers();

    const skipHeaders = new Set([
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'access-control-expose-headers',
      'connection',
      'keep-alive',
      'transfer-encoding'
    ]);

    if (!this.config.forwardSetCookie) {
      skipHeaders.add('set-cookie');
      skipHeaders.add('set-cookie2');
    }

    for (const [key, value] of originalHeaders.entries()) {
      if (!skipHeaders.has(key.toLowerCase())) {
        headers.set(key, value);
      }
    }

    // 设置 CORS 头
    if (this.config.allowedOrigins.length > 0) {
      if (this.config.allowedOrigins.includes('*')) {
        headers.set('Access-Control-Allow-Origin', '*');
      } else if (origin && this.config.allowedOrigins.includes(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        const existingVary = headers.get('Vary');
        if (existingVary) {
          if (!existingVary.toLowerCase().split(',').map(s => s.trim()).includes('origin')) {
            headers.set('Vary', `${existingVary}, Origin`);
          }
        } else {
          headers.set('Vary', 'Origin');
        }
      }
    } else {
      headers.set('Access-Control-Allow-Origin', '*');
    }

    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
    headers.set('Access-Control-Allow-Headers',
      'Accept, Authorization, Cache-Control, Content-Type, DNT, If-Modified-Since, Keep-Alive, Origin, User-Agent, X-Requested-With, Token, x-access-token, X-Proxy-Key, Proxy-Authorization');
    headers.set('Access-Control-Expose-Headers', '*');
    headers.set('Access-Control-Max-Age', '86400');

    return headers;
  }

  createErrorResponse(code: number, message: string, details?: any, origin?: string): Response {
    const body = {
      error: true,
      code,
      message,
      timestamp: new Date().toISOString(),
      ...details
    };

    const headers = new Headers({
      'Content-Type': 'application/json'
    });

    if (this.config.allowedOrigins.length > 0) {
      if (this.config.allowedOrigins.includes('*')) {
        headers.set('Access-Control-Allow-Origin', '*');
      } else if (origin && this.config.allowedOrigins.includes(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        const existingVary = headers.get('Vary');
        if (existingVary) {
          if (!existingVary.toLowerCase().split(',').map(s => s.trim()).includes('origin')) {
            headers.set('Vary', `${existingVary}, Origin`);
          }
        } else {
          headers.set('Vary', 'Origin');
        }
      }
    } else {
      headers.set('Access-Control-Allow-Origin', '*');
    }

    if (details?.retryAfter) {
      headers.set('Retry-After', String(details.retryAfter));
    }

    return new Response(JSON.stringify(body, null, 2), {
      status: code,
      headers
    });
  }

  /**
   * 解析客户端真实 IP，结合 TRUSTED_PROXIES 防止任意伪造
   */
  private resolveClientIP(request: Request, remoteAddr?: { hostname: string }): string {
    const peerIP = remoteAddr?.hostname ? remoteAddr.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '') : '';

    // 如果未传 remoteAddr（例如单元测试或 Deno Deploy），回退到 header
    if (!peerIP) {
      return request.headers.get('cf-connecting-ip') ||
             request.headers.get('x-real-ip') ||
             request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
             '127.0.0.1';
    }

    // 只有当对端 IP 在 TRUSTED_PROXIES 列表中时，才信任代理请求头
    if (this.config.trustedProxies.length > 0 && isTrustedIP(peerIP, this.config.trustedProxies)) {
      const cfIp = request.headers.get('cf-connecting-ip');
      if (cfIp) return cfIp.trim();

      const xRealIp = request.headers.get('x-real-ip');
      if (xRealIp) return xRealIp.trim();

      const xff = request.headers.get('x-forwarded-for');
      if (xff) {
        // 从右向左寻找第一个非受信代理的 IP
        const ips = xff.split(',').map(s => s.trim()).filter(Boolean);
        for (let i = ips.length - 1; i >= 0; i--) {
          const ip = ips[i];
          if (!isTrustedIP(ip, this.config.trustedProxies)) {
            return ip;
          }
        }
        return ips[0] || peerIP;
      }
    }

    return peerIP;
  }

  // 常量时间字符串比较，防止时序侧信道攻击
  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  // 生成缓存键
  private async generateCacheKey(request: Request, targetUrl: string): Promise<string> {
    const method = request.method;
    const accept = request.headers.get('accept') || '';
    const acceptLanguage = request.headers.get('accept-language') || '';
    const origin = request.headers.get('origin') || '';

    const keyData = `${method}:${targetUrl}:${origin}:${accept}:${acceptLanguage}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyData));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  reloadConfig(): void {
    const newConfig = loadConfig();

    this.logger.cleanup();
    this.rateLimiter.destroy();
    if (this.cacheCleanupTimer !== null) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
    }

    this.config = newConfig;

    this.rateLimiter = new RateLimiter(newConfig.rateLimitWindow, newConfig.rateLimit);
    this.concurrencyLimiter = new ConcurrencyLimiter(newConfig.concurrentLimit, newConfig.totalConcurrentLimit);
    this.logger = new Logger(newConfig.enableLogging, newConfig.logWebhook);
    this.responseCache = new ByteLRUCache(
      newConfig.maxCacheEntries,
      newConfig.maxCacheBytes,
      newConfig.maxCacheEntryBytes
    );

    if (newConfig.enableCache) {
      this.cacheCleanupTimer = setInterval(() => {
        if (!this.isDestroyed) {
          this.responseCache.cleanup(this.config.cacheTtl);
        }
      }, 30000) as unknown as number;
    }

    console.log(`✅ Configuration reloaded successfully [profile: ${newConfig.resourceProfile}]`);
  }

  cleanup(): void {
    this.isDestroyed = true;
    this.logger.cleanup();
    this.rateLimiter.destroy();
    this.statsCollector.destroy();
    if (this.cacheCleanupTimer !== null) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
    }
    this.responseCache.clear();
  }
}

// ==================== 服务启动模块 ====================
async function main() {
  const config = loadConfig();
  const server = new CiaoCorsServer();

  console.log(`
====================================================
  🚀 CIAO-CORS Server v${VERSION}
====================================================
  📌 Listen: ${config.host}:${config.port}
  🏷️ Profile: ${config.resourceProfile}
  📊 Stats: ${config.enableStats ? 'enabled' : 'disabled'}
  📝 Logging: ${config.enableLogging ? 'enabled' : 'disabled'}
  ⏱️ Rate limit: ${config.rateLimit} requests per ${config.rateLimitWindow / 1000}s
  🔄 Concurrent limit: ${config.concurrentLimit} per IP, ${config.totalConcurrentLimit} total
  🔒 API key (admin): ${config.apiKey ? 'configured' : 'not set'}
  🔑 Proxy API key: ${config.proxyApiKey ? 'configured' : 'disabled (open proxy)'}
  🛡️ Header validation: ${config.requireHeaders ? 'enabled' : 'disabled'}
  ✂️ Remove Origin header: ${config.removeOriginHeader ? 'enabled' : 'disabled'}
  🚫 Keyword blocking: ${config.enableKeywordBlock ? `enabled (${config.blockedKeywords.length} keywords)` : 'disabled'}
  📦 LRU Cache: ${config.enableCache ? `enabled (max ${config.maxCacheEntries} entries, ${Math.round(config.maxCacheBytes / 1024 / 1024)}MB total, max ${Math.round(config.maxCacheEntryBytes / 1024)}KB/entry)` : 'disabled'}
  ✂️ Drop upstream headers: ${config.dropHeaders.length > 0 ? config.dropHeaders.join(', ') : 'none'}
====================================================
  `);

  const abortController = new AbortController();

  const handleShutdown = () => {
    console.log('💤 Shutting down gracefully...');
    abortController.abort();
    server.cleanup();
  };

  if ((Deno as any).addSignalListener) {
    try {
      (Deno as any).addSignalListener('SIGINT', handleShutdown);
      (Deno as any).addSignalListener('SIGTERM', handleShutdown);
      (Deno as any).addSignalListener('SIGHUP', () => {
        console.log('🔄 Received SIGHUP, reloading configuration...');
        try {
          server.reloadConfig();
        } catch (error) {
          console.error('❌ Failed to reload configuration:', error);
        }
      });
    } catch (e) {
      console.warn('Unable to register signal listeners:', e);
    }
  }

  try {
    console.log(`🌐 Starting server on http://${config.host}:${config.port}...`);
    const serverInstance = Deno.serve({
      port: config.port,
      hostname: config.host,
      signal: abortController.signal,
      onError: (error) => {
        console.error('Server error:', error);
        return new Response('Internal Server Error', { status: 500 });
      }
    }, (request: Request, info: any) => {
      return server.handleRequest(request, info?.remoteAddr);
    });

    await serverInstance.finished;
    console.log('🛑 Server stopped gracefully');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.log('🛑 Server stopped by abort signal');
      return;
    }
    console.error('Failed to start server:', error);
    if (error instanceof Error && error.message.includes('Address already in use')) {
      console.error(`Port ${config.port} is already in use.`);
    }
    Deno.exit(1);
  }
}

// Deno Deploy 兼容的默认导出
let deployServer: CiaoCorsServer | null = null;

export default {
  fetch(request: Request, info?: any): Promise<Response> {
    if (!deployServer) {
      deployServer = new CiaoCorsServer();
    }
    return deployServer.handleRequest(request, info?.remoteAddr);
  }
};

if (import.meta.main) {
  main();
}
