// ============================================================
// flaresolverr.mjs —— 可选的 Cloudflare 挑战自动过盾模块（v2）
//
// 包裹全局 fetch，上游被 Cloudflare 挑战时按三级策略自动处理：
//   1) 常规取盾回放：找 FlareSolverr 取 cf_clearance + UA，注入后重试，
//      按源缓存复用。
//   2) 指纹回放（解决 clearance 与客户端 TLS 指纹绑定校验）：若装有
//      可选依赖 impit（冒充 Chrome 的 TLS/HTTP2 指纹），回放重试改走
//      impit 而不是 Node 自带 fetch——Node 指纹在某些站点（如
//      apiq.iwara.tv）即使带着有效 clearance 也会被拒。
//   3) 内容直取（解决「浏览器被静默放行、不签发 cookie」）：某些主机
//      对真实浏览器直接放行、根本不发 cf_clearance，此时无盾可回放，
//      改为直接采用 FlareSolverr 浏览器取回的正文（solution.response）
//      合成响应返回。仅用于无 body、无 Range 的 GET 请求（如视频信息
//      JSON），并会记住该源、后续同类 GET 直接直取。
//
// 回退保证：解盾失败时原样返回最初的挑战响应（响应体保持可读，
// 不再出现空 body）；任何一级失败都不会把异常抛给业务代码。
//
// 硬约束不变：cf_clearance 绑定「UA + 出口 IP(+指纹)」，FlareSolverr
// 必须与本服务同机/同出口部署。
// 仅在 server.mjs 检测到 FLARESOLVERR_URL 已配置时才安装。
// ============================================================

const CHALLENGE_BODY_RE = /just a moment|challenge-platform|_cf_chl|cf-challenge|attention required!?\s*\||enable javascript and cookies to continue/i;

export function createFlareSolverrFetch(baseFetch, options = {}) {
  const solverUrl = String(options.url || '').replace(/\/+$/, '');
  const maxTimeout = Number(options.maxTimeout) > 0 ? Number(options.maxTimeout) : 60_000;
  const session = String(options.session || '').trim();
  const hostAllow = String(options.hosts || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const browserFetchEnabled = options.browserFetch !== false; // 默认开
  const impitMode = String(options.useImpit || 'auto').toLowerCase(); // auto | on | off

  const clearanceByOrigin = new Map(); // origin -> { cookie, userAgent, expiresAt }
  const browserModeOrigins = new Set(); // origin -> 浏览器被静默放行，只能内容直取
  const pendingSolves = new Map();     // origin -> Promise<{entry, solution, solvedUrl}>
  let impitClientPromise = null;       // Promise<fetch-like|null>，只解析一次

  const log = (...args) => console.log('[flaresolverr]', ...args);
  const warn = (...args) => console.warn('[flaresolverr]', ...args);

  function isApplicable(urlString) {
    if (!solverUrl) return false;
    let url, solver;
    try { url = new URL(urlString); solver = new URL(solverUrl); } catch (_) { return false; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.host === solver.host) return false;
    if (hostAllow.length) {
      const host = url.hostname.toLowerCase();
      if (!hostAllow.some(h => host === h || host.endsWith('.' + h))) return false;
    }
    return true;
  }

  function validEntry(origin) {
    const entry = clearanceByOrigin.get(origin);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      clearanceByOrigin.delete(origin);
      return null;
    }
    return entry;
  }

  async function callSolver(targetUrl) {
    const payload = { cmd: 'request.get', url: targetUrl, maxTimeout };
    if (session) payload.session = session;
    const response = await baseFetch(solverUrl + '/v1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(maxTimeout + 30_000),
    });
    const data = await response.json().catch(() => null);
    if (!data || data.status !== 'ok' || !data.solution) {
      throw new Error('FlareSolverr 返回异常：' + ((data && data.message) || ('HTTP ' + response.status)));
    }
    return data.solution;
  }

  function entryFromSolution(solution, targetUrl) {
    const host = new URL(targetUrl).hostname.toLowerCase();
    const cookies = (Array.isArray(solution.cookies) ? solution.cookies : []).filter(cookie => {
      if (!cookie || !cookie.name) return false;
      const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
      return !domain || host === domain || host.endsWith('.' + domain);
    });
    if (!cookies.length) return null;
    let expiresAt = Date.now() + 20 * 60 * 1000;
    for (const cookie of cookies) {
      if (cookie.name === 'cf_clearance' && Number(cookie.expiry) > 0) {
        expiresAt = Number(cookie.expiry) * 1000;
      }
    }
    return {
      cookie: cookies.map(c => c.name + '=' + c.value).join('; '),
      userAgent: String(solution.userAgent || ''),
      expiresAt,
    };
  }

  // 取盾（按源去重并发）。返回 { entry|null, solution, solvedUrl }；
  // entry 为 null 表示浏览器被静默放行、没有签发任何 cookie。
  async function solve(origin, targetUrl) {
    if (pendingSolves.has(origin)) return pendingSolves.get(origin);
    const promise = (async () => {
      log('请求 FlareSolverr 处理：', targetUrl);
      const solution = await callSolver(targetUrl);
      const entry = entryFromSolution(solution, targetUrl);
      if (entry) {
        clearanceByOrigin.set(origin, entry);
        log('已缓存 clearance：', origin);
      } else {
        log('FlareSolverr 未签发 cookie（浏览器被静默放行）：', origin);
      }
      return { entry, solution, solvedUrl: targetUrl };
    })();
    pendingSolves.set(origin, promise);
    try {
      return await promise;
    } finally {
      pendingSolves.delete(origin);
    }
  }

  async function getImpitFetch() {
    if (impitMode === 'off') return null;
    if (!impitClientPromise) {
      impitClientPromise = (async () => {
        try {
          const mod = await import('impit');
          const client = new mod.Impit({ browser: 'chrome' });
          log('impit 指纹冒充已就绪（Chrome），回放重试将走 impit');
          return (url, init) => client.fetch(url, init);
        } catch (error) {
          if (impitMode === 'on') warn('已要求启用 impit 但加载失败，回放改走原生 fetch：', error && error.message || error);
          return null;
        }
      })();
    }
    return impitClientPromise;
  }

  async function isChallenged(response) {
    const mitigated = (response.headers.get('cf-mitigated') || '').toLowerCase();
    if (mitigated.includes('challenge')) return true;
    if (response.status !== 403 && response.status !== 503) return false;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html')) return false;
    try {
      const text = await response.clone().text();
      return CHALLENGE_BODY_RE.test(text);
    } catch (_) {
      return false;
    }
  }

  function normalize(input, init) {
    if (typeof input === 'string' || input instanceof URL) {
      return { url: String(input), method: (init && init.method) || 'GET', headers: new Headers(init && init.headers), body: init && init.body, init: init || {} };
    }
    return {
      url: input.url,
      method: (init && init.method) || input.method,
      headers: new Headers((init && init.headers) || input.headers),
      body: init && init.body !== undefined ? init.body : undefined,
      init: init || {},
      request: input,
    };
  }

  function mergedHeaders(parts, entry) {
    const headers = new Headers(parts.headers);
    if (entry) {
      if (entry.userAgent) headers.set('user-agent', entry.userAgent);
      if (entry.cookie) {
        const existing = headers.get('cookie');
        headers.set('cookie', existing ? existing + '; ' + entry.cookie : entry.cookie);
      }
    }
    return headers;
  }

  function buildCall(parts, entry) {
    const headers = mergedHeaders(parts, entry);
    const init = { ...parts.init, method: parts.method, headers };
    if (parts.body !== undefined) init.body = parts.body;
    if (parts.request && parts.body === undefined && parts.method !== 'GET' && parts.method !== 'HEAD') {
      return [new Request(parts.request, init), undefined];
    }
    return [parts.url, init];
  }

  // 带 clearance 的回放：优先 impit 指纹（非 Range 请求），失败/不可用时回原生 fetch
  async function replayFetch(parts, entry) {
    const impitFetch = await getImpitFetch();
    const hasRange = parts.headers.has('range');
    if (impitFetch && !hasRange) {
      try {
        const headers = {};
        mergedHeaders(parts, entry).forEach((value, key) => { headers[key] = value; });
        const init = { method: parts.method, headers };
        if (parts.body !== undefined) init.body = parts.body;
        const res = await impitFetch(parts.url, init);
        const buf = await res.arrayBuffer();
        const outHeaders = new Headers();
        try {
          if (res.headers && typeof res.headers.forEach === 'function') {
            res.headers.forEach((value, key) => outHeaders.set(key, value));
          } else if (res.headers && typeof res.headers.get === 'function') {
            const ct = res.headers.get('content-type');
            if (ct) outHeaders.set('content-type', ct);
          }
        } catch (_) { }
        return new Response(buf.byteLength ? buf : null, { status: res.status || 200, headers: outHeaders });
      } catch (error) {
        warn('impit 回放失败，改走原生 fetch：', error && error.message || error);
      }
    }
    return baseFetch(...buildCall(parts, entry));
  }

  function isPlainGet(parts) {
    return parts.method === 'GET' && parts.body === undefined && !parts.headers.has('range');
  }

  // Chrome 将 text/plain 页面渲染成 DOM 时，通常会把原文放进 <pre>，
  // 并将其中的 HTML 特殊字符转义（例如 URL 查询参数中的 & 变成 &amp;）。
  // 这里仅解码 <pre> 内的文本，避免误改真正的 HTML 页面或裸 JSON 字符串。
  function decodeHtmlEntities(value) {
    const namedEntities = {
      amp: '&',
      apos: "'",
      gt: '>',
      lt: '<',
      nbsp: '\u00a0',
      quot: '"',
    };
    return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/gi, (match, entity) => {
      if (entity[0] !== '#') {
        return namedEntities[entity.toLowerCase()] ?? match;
      }
      const isHex = entity[1] && entity[1].toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return '\uFFFD';
      }
      return String.fromCodePoint(codePoint);
    });
  }

  function synthesizeFromSolution(solution, url) {
    const body = typeof solution.response === 'string' ? solution.response : '';
    const status = Number(solution.status) >= 100 && Number(solution.status) <= 599 ? Number(solution.status) : 200;
    if (!body || CHALLENGE_BODY_RE.test(body)) return null;

    let responseBody = body;
    let contentType = 'text/html; charset=utf-8';

    // 优先尝试提取 Chrome 包装的 <pre> 正文，再尝试原始响应（兼容原本就是裸 JSON 的情况）。
    const preMatch = /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/i.exec(body);
    const candidates = [];
    if (preMatch) candidates.push(decodeHtmlEntities(preMatch[1]));
    candidates.push(body);

    for (const candidate of candidates) {
      const jsonBody = candidate.trim();
      if (!jsonBody.startsWith('{') && !jsonBody.startsWith('[')) continue;
      try {
        JSON.parse(jsonBody);
        responseBody = jsonBody;
        contentType = 'application/json; charset=utf-8';
        break;
      } catch (_) { }
    }

    log('内容直取成功：', url, 'status', status);
    return new Response(responseBody, {
      status,
      headers: { 'content-type': contentType, 'x-flaresolverr': 'browser-fetch' },
    });
  }

  return async function flareSolverrFetch(input, init) {
    let parts;
    try { parts = normalize(input, init); } catch (_) { return baseFetch(input, init); }
    if (!isApplicable(parts.url)) return baseFetch(input, init);

    const origin = new URL(parts.url).origin;

    // 已知该源只能内容直取：GET 直接走浏览器取内容，失败再回落到普通流程
    if (browserFetchEnabled && browserModeOrigins.has(origin) && isPlainGet(parts)) {
      try {
        const solution = await callSolver(parts.url);
        const synthesized = synthesizeFromSolution(solution, parts.url);
        if (synthesized) return synthesized;
        warn('内容直取未得到有效正文，回落普通请求：', parts.url);
      } catch (error) {
        warn('内容直取失败，回落普通请求：', error && error.message || error);
      }
    }

    const entry = validEntry(origin);
    let response = await baseFetch(...buildCall(parts, entry));
    if (!(await isChallenged(response))) return response;

    // 被挑战。注意：此时不要动 response 的 body——解盾失败时要原样返回它。
    let solved = null;
    try {
      solved = await solve(origin, parts.url);
    } catch (error) {
      warn('解盾失败，本次请求按原挑战响应返回：', error && error.message || error);
      return response;
    }

    if (solved.entry) {
      try { response.body && response.body.cancel().catch(() => { }); } catch (_) { }
      const retryResponse = await replayFetch(parts, solved.entry);
      if (!(await isChallenged(retryResponse))) return retryResponse;
      warn('带 clearance 回放后仍被挑战：', parts.url);
      clearanceByOrigin.delete(origin);
      response = retryResponse;
    }

    // 无盾可回放（静默放行）或回放仍被挑战：内容直取兜底（同一次解盾的正文优先）
    if (browserFetchEnabled && isPlainGet(parts)) {
      let solution = solved.solution && solved.solvedUrl === parts.url ? solved.solution : null;
      if (!solution) {
        try { solution = await callSolver(parts.url); } catch (_) { solution = null; }
      }
      if (solution) {
        const synthesized = synthesizeFromSolution(solution, parts.url);
        if (synthesized) {
          browserModeOrigins.add(origin);
          return synthesized;
        }
      }
    }
    return response;
  };
}

/**
 * 若 url 非空则把全局 fetch 换成过盾版本，并返回 true；否则不动，返回 false。
 * options: { url, maxTimeout, session, hosts, browserFetch, useImpit }
 */
export function installFlareSolverrFetch(options = {}) {
  if (!options.url) return false;
  const baseFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createFlareSolverrFetch(baseFetch, options);
  return true;
}
