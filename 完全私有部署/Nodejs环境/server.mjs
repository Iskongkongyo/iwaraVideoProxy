// ============================================================
// server.mjs —— Iwara 站点 Worker 的 Node.js 运行时适配层
//
// 原 worker.js 是 Cloudflare Worker 写法（export default fetch +
// Cache API + Durable Object + ASSETS 绑定）。本文件不改业务逻辑，
// 只在 Node 里补齐这四样 CF 专属能力，然后把每个 HTTP 请求翻译成
// Web 标准的 Request 交给 worker.mjs 的 fetch 处理：
//
//   1) caches.default        -> 进程内内存缓存（按 max-age 过期）
//   2) ONLINE_COUNTER (DO)   -> 用 ws 实现的在线人数中枢，语义与原 DO 一致：
//                               sid 去重计数、重复 sid 踢旧连接、
//                               连接/断开广播 site_online_count、ping->pong
//   3) env.ASSETS.fetch      -> ./public 目录静态文件，未命中返回 404
//   4) env 变量              -> process.env（启动时自动读取同目录 .env）
//
// 运行要求：Node.js >= 18（建议 20+）。除 ws 外无其他依赖。
// ============================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { installFlareSolverrFetch } from './flaresolverr.mjs';

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- .env 加载（不覆盖已存在的环境变量） ---------------- */
try {
  const envFile = path.join(BASE_DIR, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const key = match[1];
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
} catch (error) {
  console.warn('[node-adapter] 读取 .env 失败：', error && error.message || error);
}

// 注意：PORT/HOST 必须在 .env 加载之后再读取，否则 .env 里改端口不生效。
const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

/* ---------------- 1) Cache API 垫片（caches.default） ---------------- */
class MemoryCache {
  constructor() { this.store = new Map(); }
  _key(request) { return typeof request === 'string' ? request : request.url; }
  async match(request) {
    const entry = this.store.get(this._key(request));
    if (!entry) return undefined;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(this._key(request));
      return undefined;
    }
    return new Response(entry.body.slice(0), { status: entry.status, headers: entry.headers });
  }
  async put(request, response) {
    try {
      const body = await response.clone().arrayBuffer();
      const headers = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      const maxAge = /max-age=(\d+)/i.exec(headers['cache-control'] || '');
      this.store.set(this._key(request), {
        status: response.status,
        headers,
        body,
        expiresAt: maxAge ? Date.now() + Number(maxAge[1]) * 1000 : 0,
      });
    } catch (_) { /* 缓存写入失败不影响主流程 */ }
  }
  async delete(request) { return this.store.delete(this._key(request)); }
}
globalThis.caches = { default: new MemoryCache() };

/* ---------------- 2) 在线人数中枢（替代 Durable Object） ---------------- */
const presenceSockets = new Set();
function normalizePresenceSessionId(value) {
  const v = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{12,120}$/.test(v) ? v : '';
}
function presenceOnlineCount() {
  const ids = new Set();
  for (const ws of presenceSockets) if (ws.sessionId) ids.add(ws.sessionId);
  return ids.size;
}
function presenceBroadcast() {
  const payload = JSON.stringify({ type: 'site_online_count', online: presenceOnlineCount(), ts: Date.now() });
  for (const ws of presenceSockets) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(payload); } catch (_) { }
  }
}
const onlineCounterBinding = {
  idFromName(name) { return String(name || 'global'); },
  get(id) {
    return {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/count') {
          return new Response(JSON.stringify({ online: presenceOnlineCount() }), {
            headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store' },
          });
        }
        // 非升级方式访问 /ws：与原 DO 一致返回 426（真正的 WS 在 HTTP upgrade 层接管）
        return new Response(JSON.stringify({ error: '预期 WebSocket 升级请求！' }), {
          status: 426,
          headers: { 'content-type': 'application/json;charset=UTF-8', 'upgrade': 'websocket' },
        });
      },
    };
  },
};

/* ---------------- 3) ASSETS 垫片（./public 静态文件） ---------------- */
const MIME_TYPES = {
  '.html': 'text/html;charset=UTF-8', '.css': 'text/css;charset=UTF-8',
  '.js': 'text/javascript;charset=UTF-8', '.mjs': 'text/javascript;charset=UTF-8',
  '.json': 'application/json;charset=UTF-8', '.txt': 'text/plain;charset=UTF-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const assetsBinding = {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const filePath = path.join(BASE_DIR, 'public', rel);
      if (!filePath.startsWith(path.join(BASE_DIR, 'public'))) {
        return new Response('Forbidden', { status: 403 });
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const data = fs.readFileSync(filePath);
        const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        return new Response(data, { headers: { 'content-type': type } });
      }
    } catch (_) { }
    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain;charset=UTF-8' } });
  },
};

/* ---------------- 5) 可选：FlareSolverr 过盾（包裹全局 fetch） ----------------
   仅在配置了 FLARESOLVERR_URL 时安装；worker.mjs 的全部上游请求都走全局
   fetch，因此在这里换掉 fetch 即可让业务代码无感获得过盾能力：
   检测到 Cloudflare 挑战 -> 找 FlareSolverr 取 cf_clearance+UA -> 注入重试。
   FlareSolverr 必须与本服务同机/同出口部署（clearance 绑定 UA+出口 IP）。 */
const flareSolverrEnabled = installFlareSolverrFetch({
  url: process.env.FLARESOLVERR_URL || '',
  maxTimeout: Number.parseInt(process.env.FLARESOLVERR_MAX_TIMEOUT || '60000', 10),
  session: process.env.FLARESOLVERR_SESSION || '',
  hosts: process.env.FLARESOLVERR_HOSTS || '',
  browserFetch: !/^(off|0|false)$/i.test(process.env.FLARESOLVERR_BROWSER_FETCH || ''),
  useImpit: process.env.FLARESOLVERR_USE_IMPIT || 'auto',
});
if (flareSolverrEnabled) {
  console.log('[iwara-node] FlareSolverr 过盾已启用：', process.env.FLARESOLVERR_URL);
}

/* ---------------- 加载业务代码并组装 env ---------------- */
const worker = (await import('./worker.mjs')).default;

function buildEnv() {
  return {
    ...process.env,
    ASSETS: assetsBinding,
    ONLINE_COUNTER: onlineCounterBinding,
  };
}

/* ---------------- HTTP 请求 -> Worker fetch ---------------- */
function requestFromNode(req, bodyBuffer) {
  // 关键适配：Worker 代码对 /video、/file 路由只替换 URL 的 hostname 后直连上游，
  // 会保留原请求的协议与端口。在 Cloudflare 上请求恒为 https+默认端口所以没问题；
  // 但 Node 本地监听是 http+自定义端口（如 3100），若原样传入，上游地址会变成
  // http://apiq.iwara.tv:3100 并一直挂起。因此这里按 CF 的方式，只把“公开 Origin”
  // （协议+域名，不带内部监听端口）交给 Worker。可用环境变量 PUBLIC_ORIGIN 固定，
  // 例如反代后的公开地址 https://ss.example.com；未设置时取 X-Forwarded-Proto /
  // X-Forwarded-Host 或 Host 头（去掉端口）。
  let origin = (process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
  if (!origin) {
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
    const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    origin = proto + '://' + rawHost.replace(/:\d+$/, '');
  }
  const url = origin + (req.url || '/');
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]); } catch (_) { }
  }
  const init = { method: req.method || 'GET', headers };
  if (bodyBuffer && bodyBuffer.length && init.method !== 'GET' && init.method !== 'HEAD') {
    init.body = bodyBuffer;
  }
  return new Request(url, init);
}

async function writeResponse(res, response) {
  res.statusCode = response.status;
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    // undici fetch 会自动解压上游 gzip/deflate/br 并保留原编码头；
    // 此时 content-length/content-encoding 已与实际流不一致，必须去掉。
    const enc = (response.headers.get('content-encoding') || '').toLowerCase();
    if ((enc === 'gzip' || enc === 'deflate' || enc === 'br') &&
      (key.toLowerCase() === 'content-encoding' || key.toLowerCase() === 'content-length')) return;
    try { res.setHeader(key, value); } catch (_) { }
  });
  if (setCookies.length) res.setHeader('set-cookie', setCookies);
  if (!response.body) { res.end(); return; }
  Readable.fromWeb(response.body).pipe(res);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const request = requestFromNode(req, Buffer.concat(chunks));
      const response = await worker.fetch(request, buildEnv(), {});
      await writeResponse(res, response);
    } catch (error) {
      console.error('[node-adapter] 请求处理失败：', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json;charset=UTF-8');
      }
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  });
  req.on('error', () => { try { res.destroy(); } catch (_) { } });
});

/* ---------------- WebSocket upgrade -> 在线人数 ---------------- */
const wss = new WebSocketServer({ noServer: true });

function checkBasicAuth(req) {
  const user = (process.env.BASIC_AUTH_USER || '').trim();
  const pass = process.env.BASIC_AUTH_PASS || '';
  if (!user && !pass) return true;
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const u = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const p = idx >= 0 ? decoded.slice(idx + 1) : '';
    return u === user && p === pass;
  } catch (_) { return false; }
}

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch (_) { }
  if (pathname !== '/online-presence') { socket.destroy(); return; }
  if (!checkBasicAuth(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="IwaraProxy", charset="UTF-8"\r\n\r\n');
    socket.destroy();
    return;
  }
  const query = new URL(req.url || '/', 'http://localhost').searchParams;
  const sessionId = normalizePresenceSessionId(query.get('sid'));
  if (!sessionId) {
    socket.write('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json;charset=UTF-8\r\n\r\n{"error":"缺少有效的会话标识！"}');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    // 与原 DO 一致：同一 sid 的旧连接以 1000/session replaced 关闭
    for (const other of [...presenceSockets]) {
      if (other.sessionId === sessionId) {
        try { other.close(1000, 'session replaced'); } catch (_) { }
        presenceSockets.delete(other);
      }
    }
    ws.sessionId = sessionId;
    presenceSockets.add(ws);
    presenceBroadcast();
    ws.on('message', data => {
      if (String(data || '').trim().toLowerCase() === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch (_) { }
      }
    });
    const cleanup = () => { if (presenceSockets.delete(ws)) presenceBroadcast(); };
    ws.on('close', cleanup);
    ws.on('error', () => { try { ws.close(1011, 'socket error'); } catch (_) { } cleanup(); });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[iwara-node] 服务已启动：http://${HOST}:${PORT}`);
});
