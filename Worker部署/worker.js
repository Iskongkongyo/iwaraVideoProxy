// Basic Auth和默认Token既可使用下方常量，也可通过Cloudflare环境变量设置（优先级更高）。
// Iwara登录账号与密码仅支持IWARA_USERNAME、IWARA_PASSWORD环境变量，请务必保存为Secret！
// Basic Auth对应的环境变量名分别为BASIC_AUTH_USER和BASIC_AUTH_PASS！
// Iwara Token可设置IWARA_AUTHORIZATION；自动登录请使用Secret设置IWARA_USERNAME和IWARA_PASSWORD！
// 如果你设置了默认Iwara Token或自动登录凭据，强烈建议同时启用Basic Auth保护共享账号能力！
const DEFAULT_BASIC_AUTH_USER = ''; // 设置访问的用户名
const DEFAULT_BASIC_AUTH_PASS = ''; // 设置访问的密码
const DEFAULT_IWARA_AUTHORIZATION = ''; // 设置默认使用Iwara账号的Token
const DEFAULT_NOTICE_API_URL = ''; // 设置通知接口URL
const DEFAULT_NEW_SITE_URL = ''; // 设置请求数接近免费计划上限时引导访问的新网站
const BACKEND_TOKEN_STATUS_RETRY_AFTER_SECONDS = 86400; // 前端请求检测后端Token有效期间隔(单位秒，默认1天，后端未设置token生效)
const WORKERS_FREE_DAILY_REQUEST_LIMIT = 100000; // Cloudflare Workers Free 每日请求数限制
const DIRECT_MODE_REMAINING_REQUESTS_THRESHOLD = 100; // 当日剩余请求数低于等于该值时，新会话切换到直连模式
const PLAYBACK_MODE_CACHE_TTL_SECONDS = 300; // 播放模式决策缓存时长（秒）
const NOTICE_API_CACHE_TTL_SECONDS = 300; // 通知接口缓存时长（秒）
const IWARA_LOGIN_URL = 'https://api.iwara.tv/user/login';
const IWARA_LOGIN_RETRY_COOLDOWN_MS = 60000;
const IWARA_TOKEN_REFRESH_SKEW_SECONDS = 60;

let cachedAutoIwaraAuthorization = '';
let iwaraLoginPromise = null;
let iwaraLoginRetryAfter = 0;
let lastIwaraLoginError = null;
let lastIwaraLoginAttemptAt = '';
let lastIwaraLoginResponseStatus = null;
let lastIwaraLoginResponseContentType = '';
let lastIwaraLoginSucceededAt = '';
let lastIwaraLoginFailureReason = '';

function pickEnvOrDefault(envValue, defaultValue = '') {
	const v = typeof envValue === 'string' ? envValue.trim() : '';
	if (v) return v;
	return (defaultValue || '').trim();
}

function normalizeHttpUrl(value) {
	const raw = String(value || '').trim();
	if (!raw) return '';
	try {
		const url = new URL(raw);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
		return url.toString();
	} catch (_) {
		return '';
	}
}

function getUrlDisplayName(url) {
	if (!url) return '';
	try {
		return new URL(url).host;
	} catch (_) {
		return String(url || '').trim();
	}
}

function workerConfig(env) {
	return {
		basicUser: pickEnvOrDefault(env?.BASIC_AUTH_USER, DEFAULT_BASIC_AUTH_USER),
		basicPass: pickEnvOrDefault(env?.BASIC_AUTH_PASS, DEFAULT_BASIC_AUTH_PASS),
		iwaraAuthorization: pickEnvOrDefault(env?.IWARA_AUTHORIZATION, DEFAULT_IWARA_AUTHORIZATION),
		iwaraUsername: pickEnvOrDefault(env?.IWARA_USERNAME),
		iwaraPassword: typeof env?.IWARA_PASSWORD === 'string' ? env.IWARA_PASSWORD : ''
	};
}

function sanitizePlaybackMode(value) {
	return String(value || '').trim().toLowerCase() === 'direct' ? 'direct' : 'proxy';
}

function getPlaybackModeConfig(env) {
	const dailyLimitValue = Number.parseInt(pickEnvOrDefault(env?.WORKERS_DAILY_REQUEST_LIMIT, String(WORKERS_FREE_DAILY_REQUEST_LIMIT)), 10);
	const thresholdValue = Number.parseInt(pickEnvOrDefault(env?.DIRECT_MODE_REMAINING_REQUESTS_THRESHOLD, String(DIRECT_MODE_REMAINING_REQUESTS_THRESHOLD)), 10);
	const ttlValue = Number.parseInt(pickEnvOrDefault(env?.PLAYBACK_MODE_CACHE_TTL_SECONDS, String(PLAYBACK_MODE_CACHE_TTL_SECONDS)), 10);
	return {
		manualMode: sanitizePlaybackMode(pickEnvOrDefault(env?.FORCE_PLAYBACK_MODE, 'proxy')),
		manualModeRaw: pickEnvOrDefault(env?.FORCE_PLAYBACK_MODE, ''),
		accountTag: pickEnvOrDefault(env?.CF_ACCOUNT_TAG, ''),
		apiToken: pickEnvOrDefault(env?.CF_ANALYTICS_API_TOKEN, ''),
		scriptName: pickEnvOrDefault(env?.CF_WORKER_SCRIPT_NAME, ''),
		newSiteUrl: normalizeHttpUrl(pickEnvOrDefault(env?.NEW_SITE_URL, DEFAULT_NEW_SITE_URL)),
		dailyLimit: Number.isFinite(dailyLimitValue) && dailyLimitValue > 0 ? dailyLimitValue : WORKERS_FREE_DAILY_REQUEST_LIMIT,
		remainingThreshold: Number.isFinite(thresholdValue) && thresholdValue >= 0 ? thresholdValue : DIRECT_MODE_REMAINING_REQUESTS_THRESHOLD,
		cacheTtlSeconds: Number.isFinite(ttlValue) && ttlValue > 0 ? ttlValue : PLAYBACK_MODE_CACHE_TTL_SECONDS
	};
}

function getNoticeConfig(env) {
	const ttlValue = Number.parseInt(pickEnvOrDefault(env?.NOTICE_API_CACHE_TTL_SECONDS, String(NOTICE_API_CACHE_TTL_SECONDS)), 10);
	return {
		apiUrl: normalizeHttpUrl(pickEnvOrDefault(env?.NOTICE_API_URL, DEFAULT_NOTICE_API_URL)),
		cacheTtlSeconds: Number.isFinite(ttlValue) && ttlValue > 0 ? ttlValue : NOTICE_API_CACHE_TTL_SECONDS
	};
}

function unauthorizedResponse() {
	return new Response('Authentication required', {
		status: 401,
		headers: {
			'content-type': 'text/plain; charset=UTF-8',
			'WWW-Authenticate': 'Basic realm="IwaraProxy", charset="UTF-8"'
		}
	});
}

function verifyBasicAuth(request, env) {
	const cfg = workerConfig(env);
	const enabled = !!(cfg.basicUser || cfg.basicPass);
	if (!enabled) return null;

	const auth = request.headers.get('Authorization') || '';
	if (!auth.startsWith('Basic ')) return unauthorizedResponse();

	let decoded = '';
	try {
		decoded = atob(auth.slice(6));
	} catch {
		return unauthorizedResponse();
	}
	const idx = decoded.indexOf(':');
	const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
	const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
	if (user !== cfg.basicUser || pass !== cfg.basicPass) return unauthorizedResponse();
	return null;
}

function normalizeIwaraAuthorization(value) {
	const v = (value || '').trim();
	if (!v) return '';
	return /^Bearer\s+/i.test(v) ? v : ('Bearer ' + v);
}

function resolveUpstreamAuthorization(request, env) {
	const customizedToken = (request.headers.get('CustomizedToken') || '').trim();
	if (customizedToken) return normalizeIwaraAuthorization(customizedToken);
	const cfg = workerConfig(env);
	return normalizeIwaraAuthorization(cfg.iwaraAuthorization || '');
}

function buildProxyRequest(targetUrl, request, env, authorizationOverride) {
	const headers = new Headers(request.headers);

	headers.delete('Authorization');
	headers.delete('authorization');

	const customizedToken = (headers.get('CustomizedToken') || headers.get('customizedtoken') || '').trim();
	headers.delete('CustomizedToken');
	headers.delete('customizedtoken');

	const cfg = workerConfig(env);
	const backendAuthorization = authorizationOverride === undefined ? cfg.iwaraAuthorization : authorizationOverride;
	const upstreamAuthorization = normalizeIwaraAuthorization(customizedToken || backendAuthorization || '');
	if (upstreamAuthorization) {
		headers.set('Authorization', upstreamAuthorization);
	}

	return new Request(targetUrl, {
		method: request.method,
		headers,
		body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
		redirect: 'follow'
	});
}
function decodeJwtPayload(token) {
	try {
		const raw = (token || '').trim().replace(/^Bearer\s+/i, '');
		if (!raw) return null;
		const parts = raw.split('.');
		if (parts.length !== 3) return null;
		const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const padded = base64 + '='.repeat((4 - (base64.length % 4 || 4)) % 4);
		return JSON.parse(atob(padded));
	} catch {
		return null;
	}
}

function isIwaraAuthorizationFresh(authorization, skewSeconds = IWARA_TOKEN_REFRESH_SKEW_SECONDS) {
	const normalized = normalizeIwaraAuthorization(authorization);
	if (!normalized) return false;

	const payload = decodeJwtPayload(normalized);
	if (!payload || typeof payload.exp !== 'number') return true;
	return payload.exp > Math.floor(Date.now() / 1000) + Math.max(0, Number(skewSeconds) || 0);
}

function hasIwaraLoginCredentials(cfg) {
	return !!(cfg.iwaraUsername && cfg.iwaraPassword);
}

function hasPartialIwaraLoginCredentials(cfg) {
	return !!(cfg.iwaraUsername || cfg.iwaraPassword) && !hasIwaraLoginCredentials(cfg);
}

function invalidateAutoIwaraAuthorization() {
	cachedAutoIwaraAuthorization = '';
}

function safeIwaraLoginErrorMessage(error = lastIwaraLoginError) {
	return String(error?.message || error || '')
		.replace(/[\r\n\t]+/g, ' ')
		.trim()
		.slice(0, 300);
}

function classifyIwaraLoginFailure(responseStatus = lastIwaraLoginResponseStatus) {
	const status = Number(responseStatus);
	if (status === 429) return 'rate_limited';
	if (status === 400 || status === 401) return 'credentials_rejected';
	if (status === 403) return 'upstream_blocked';
	if (status >= 500 && status <= 599) return 'upstream_unavailable';
	if (status >= 200 && status <= 299) return 'invalid_response';
	if (!Number.isFinite(status) || status <= 0) return 'network_error';
	return 'unknown';
}

function getIwaraLoginRetryAfterSeconds() {
	return Math.max(0, Math.ceil((iwaraLoginRetryAfter - Date.now()) / 1000));
}

function getIwaraLoginFailurePublicInfo(reason = lastIwaraLoginFailureReason) {
	switch (reason) {
		case 'credentials_rejected':
			return {
				code: 'backend_login_credentials_rejected',
				message: 'Iwara登录凭据被拒绝，请站点管理员检查登录邮箱和密码。',
				shouldWarnUser: true
			};
		case 'invalid_response':
			return {
				code: 'backend_login_invalid_response',
				message: 'Iwara登录接口响应中没有可用Token，请站点管理员检查接口是否发生变化。',
				shouldWarnUser: true
			};
		case 'rate_limited':
			return {
				code: 'backend_login_rate_limited',
				message: 'Iwara登录接口暂时限流，Worker会在冷却结束后自动重试。',
				shouldWarnUser: false
			};
		case 'upstream_blocked':
			return {
				code: 'backend_login_upstream_blocked',
				message: 'Iwara登录接口暂时受到上游访问限制，Worker稍后会自动重试。',
				shouldWarnUser: false
			};
		case 'upstream_unavailable':
		case 'network_error':
		default:
			return {
				code: 'backend_login_temporarily_unavailable',
				message: 'Iwara登录接口暂时不可用，Worker稍后会自动重试。',
				shouldWarnUser: false
			};
	}
}

function logIwaraLoginEvent(level, event, details = {}) {
	const message = JSON.stringify({ event, ...details });
	if (level === 'warn') console.warn('[iwara-auto-login]', message);
	else console.info('[iwara-auto-login]', message);
}

function getAuthorizationExpiry(authorization) {
	const payload = decodeJwtPayload(authorization);
	if (!payload || typeof payload.exp !== 'number') return null;
	const date = new Date(payload.exp * 1000);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getIwaraLoginDiagnostics(env, backendStatus) {
	const cfg = workerConfig(env);
	const configuredAuthorization = normalizeIwaraAuthorization(cfg.iwaraAuthorization);
	const configuredTokenIsFresh = isIwaraAuthorizationFresh(configuredAuthorization, 0);
	const cachedTokenIsFresh = isIwaraAuthorizationFresh(cachedAutoIwaraAuthorization, 0);
	const retryAfterSeconds = getIwaraLoginRetryAfterSeconds();

	return {
		status: backendStatus?.status || 'unknown',
		configured: {
			manualToken: !!configuredAuthorization,
			username: !!cfg.iwaraUsername,
			password: !!cfg.iwaraPassword
		},
		authorizationSource: configuredTokenIsFresh
			? 'configured_token'
			: (cachedTokenIsFresh ? 'auto_login_cache' : 'none'),
		autoLogin: {
			endpoint: IWARA_LOGIN_URL,
			attempted: !!lastIwaraLoginAttemptAt,
			lastAttemptAt: lastIwaraLoginAttemptAt || null,
			lastResponseStatus: lastIwaraLoginResponseStatus,
			lastResponseContentType: lastIwaraLoginResponseContentType || null,
			lastSucceededAt: lastIwaraLoginSucceededAt || null,
			cachedTokenAvailable: cachedTokenIsFresh,
			cachedTokenExpiresAt: getAuthorizationExpiry(cachedAutoIwaraAuthorization),
			loginInFlight: !!iwaraLoginPromise,
			retryAfterSeconds,
			failureReason: lastIwaraLoginFailureReason || null,
			lastError: safeIwaraLoginErrorMessage() || null
		}
	};
}

async function getAutoIwaraAuthorization(env, forceRefresh = false) {
	const cfg = workerConfig(env);
	if (!hasIwaraLoginCredentials(cfg)) {
		throw new Error('Iwara自动登录账号或密码未完整配置');
	}

	if (!forceRefresh && isIwaraAuthorizationFresh(cachedAutoIwaraAuthorization)) {
		return cachedAutoIwaraAuthorization;
	}
	if (iwaraLoginPromise) return iwaraLoginPromise;
	if (Date.now() < iwaraLoginRetryAfter) {
		throw lastIwaraLoginError || new Error('Iwara自动登录暂时处于重试冷却中');
	}

	if (forceRefresh) invalidateAutoIwaraAuthorization();
	const currentPromise = (async () => {
		try {
			lastIwaraLoginAttemptAt = new Date().toISOString();
			lastIwaraLoginResponseStatus = null;
			lastIwaraLoginResponseContentType = '';
			logIwaraLoginEvent('info', 'request_started', {
				endpoint: IWARA_LOGIN_URL,
				forceRefresh: !!forceRefresh,
				hasUsername: !!cfg.iwaraUsername,
				hasPassword: !!cfg.iwaraPassword
			});
			const response = await fetch(IWARA_LOGIN_URL, {
				method: 'POST',
				headers: {
					'Accept': 'application/json',
					'Accept-Language': 'zh-CN,zh;q=0.9',
					'Content-Type': 'application/json',
					'Origin': 'https://www.iwara.tv',
					'Priority': 'u=1, i',
					'Referer': 'https://www.iwara.tv/',
					'Sec-CH-UA': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
					'Sec-CH-UA-Mobile': '?0',
					'Sec-CH-UA-Platform': '"Windows"',
					'Sec-Fetch-Dest': 'empty',
					'Sec-Fetch-Mode': 'cors',
					'Sec-Fetch-Site': 'same-site',
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
					'X-Site': 'www.iwara.tv'
				},
				body: JSON.stringify({
					email: cfg.iwaraUsername,
					password: cfg.iwaraPassword
				})
			});
			lastIwaraLoginResponseStatus = response.status;
			lastIwaraLoginResponseContentType = (response.headers.get('content-type') || '').slice(0, 200);
			logIwaraLoginEvent('info', 'response_received', {
				status: response.status,
				ok: response.ok,
				contentType: lastIwaraLoginResponseContentType || null
			});

			if (!response.ok) {
				const contentType = lastIwaraLoginResponseContentType
					? '（' + lastIwaraLoginResponseContentType + '）'
					: '';
				throw new Error('Iwara登录接口返回HTTP ' + response.status + contentType);
			}
			const data = await response.json().catch(() => null);
			const authorization = normalizeIwaraAuthorization(data && data.token);
			if (!authorization) {
				throw new Error('Iwara登录响应中缺少Token');
			}

			cachedAutoIwaraAuthorization = authorization;
			iwaraLoginRetryAfter = 0;
			lastIwaraLoginError = null;
			lastIwaraLoginFailureReason = '';
			lastIwaraLoginSucceededAt = new Date().toISOString();
			logIwaraLoginEvent('info', 'login_succeeded', {
				tokenType: decodeJwtPayload(authorization) ? 'jwt' : 'opaque',
				tokenExpiresAt: getAuthorizationExpiry(authorization)
			});
			return authorization;
		} catch (error) {
			invalidateAutoIwaraAuthorization();
			iwaraLoginRetryAfter = Date.now() + IWARA_LOGIN_RETRY_COOLDOWN_MS;
			lastIwaraLoginError = error instanceof Error ? error : new Error(String(error));
			lastIwaraLoginFailureReason = classifyIwaraLoginFailure();
			logIwaraLoginEvent('warn', 'login_failed', {
				error: safeIwaraLoginErrorMessage(lastIwaraLoginError),
				reason: lastIwaraLoginFailureReason,
				retryAfterSeconds: Math.ceil(IWARA_LOGIN_RETRY_COOLDOWN_MS / 1000)
			});
			throw lastIwaraLoginError;
		}
	})();

	iwaraLoginPromise = currentPromise;
	try {
		return await currentPromise;
	} finally {
		if (iwaraLoginPromise === currentPromise) iwaraLoginPromise = null;
	}
}

async function resolveBackendIwaraAuthorization(env) {
	const cfg = workerConfig(env);
	const configuredAuthorization = normalizeIwaraAuthorization(cfg.iwaraAuthorization);
	if (isIwaraAuthorizationFresh(configuredAuthorization)) return configuredAuthorization;

	if (hasIwaraLoginCredentials(cfg)) {
		try {
			return await getAutoIwaraAuthorization(env);
		} catch (_) {
			// 自动登录失败时仍保留原请求行为，让公开内容可以在无Token状态下继续访问。
		}
	}
	return configuredAuthorization;
}

async function fetchIwaraProxy(targetUrl, request, env) {
	const customizedToken = (request.headers.get('CustomizedToken') || '').trim();
	if (customizedToken) {
		return fetch(buildProxyRequest(targetUrl, request, env));
	}

	const authorization = await resolveBackendIwaraAuthorization(env);
	const response = await fetch(buildProxyRequest(targetUrl, request, env, authorization));
	if (response.status !== 401 || !hasIwaraLoginCredentials(workerConfig(env))) {
		return response;
	}

	try {
		const refreshedAuthorization = await getAutoIwaraAuthorization(env, true);
		return fetch(buildProxyRequest(targetUrl, request, env, refreshedAuthorization));
	} catch (_) {
		return response;
	}
}

async function getBackendTokenStatus(env) {
	const cfg = workerConfig(env);
	const token = normalizeIwaraAuthorization(cfg.iwaraAuthorization || '');
	if (isIwaraAuthorizationFresh(token, 0)) return { status: 'valid' };
	if (hasPartialIwaraLoginCredentials(cfg)) return { status: 'login_misconfigured' };

	if (hasIwaraLoginCredentials(cfg)) {
		try {
			await getAutoIwaraAuthorization(env);
			return { status: 'valid' };
		} catch (_) {
			return {
				status: 'login_failed',
				failureReason: lastIwaraLoginFailureReason || classifyIwaraLoginFailure(),
				retryAfterSeconds: getIwaraLoginRetryAfterSeconds() || Math.ceil(IWARA_LOGIN_RETRY_COOLDOWN_MS / 1000)
			};
		}
	}
	if (!token) return { status: 'not_configured' };

	const payload = decodeJwtPayload(token);
	if (!payload || typeof payload.exp !== 'number') {
		return { status: 'expired' };
	}
	const now = Math.floor(Date.now() / 1000);
	return payload.exp > now ? { status: 'valid' } : { status: 'expired' };
}

function buildDirectModeNotice(newSiteUrl) {
	const baseNotice = '今日 Worker 请求量已接近配置上限，新打开的页面已切换为视频直连模式。若当前网络无法直接访问 Iwara 视频源，请稍后重试；免费额度将在北京时间早上 8 点（UTC 0 点）重置。';
	if (!newSiteUrl) return baseNotice;
	const siteName = getUrlDisplayName(newSiteUrl);
	return baseNotice + (siteName ? ` 也可以前往备用站点 ${siteName} 继续观看。` : ' 也可以前往备用站点继续观看。');
}

function getUtcDayRange(now = new Date()) {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
	return {
		dayKey: start.toISOString().slice(0, 10),
		startIso: start.toISOString(),
		nowIso: now.toISOString()
	};
}

function buildPlaybackModeCacheKey(scriptName, dayKey) {
	return new Request(`https://playback-mode-cache.internal/${encodeURIComponent(scriptName || 'default')}?day=${encodeURIComponent(dayKey)}`);
}

function buildNoticeCacheKey(apiUrl) {
	return new Request(`https://notice-cache.internal/?url=${encodeURIComponent(apiUrl || '')}`);
}

function normalizeNoticeBootstrap(data) {
	return {
		hasNotice: !!(data && data.hasNotice),
		title: String(data && data.title || '通知').slice(0, 200),
		content: String(data && data.content || '').slice(0, 20000),
		showOnce: !!(data && data.showOnce),
		noticeId: String(data && data.noticeId || '').slice(0, 200),
		checkedAt: new Date().toISOString()
	};
}

async function queryWorkerRequestsToday(config) {
	const range = getUtcDayRange();
	const query = `query GetWorkersAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
		viewer {
			accounts(filter: { accountTag: $accountTag }) {
				workersInvocationsAdaptive(limit: 100, filter: {
					scriptName: $scriptName,
					datetime_geq: $datetimeStart,
					datetime_leq: $datetimeEnd
				}) {
					sum { requests }
				}
			}
		}
	}`;
	const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${config.apiToken}`,
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			query,
			variables: {
				accountTag: config.accountTag,
				datetimeStart: range.startIso,
				datetimeEnd: range.nowIso,
				scriptName: config.scriptName
			}
		})
	});
	if (!response.ok) {
		throw new Error(`Cloudflare Analytics API 返回状态异常：${response.status}`);
	}
	const result = await response.json().catch(() => null);
	const apiErrors = Array.isArray(result?.errors) ? result.errors : [];
	if (apiErrors.length > 0) {
		throw new Error(apiErrors[0]?.message || 'Cloudflare Analytics API 返回错误');
	}
	const rows = result?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
	if (!Array.isArray(rows)) {
		throw new Error('Cloudflare Analytics API 未返回有效的请求数据');
	}
	const requests = rows.reduce((total, row) => total + Number(row?.sum?.requests || 0), 0);
	if (!Number.isFinite(requests) || requests < 0) {
		throw new Error('Cloudflare Analytics API 未返回有效的请求数');
	}
	return { requests, checkedAt: range.nowIso, dayKey: range.dayKey };
}

async function getPlaybackModeBootstrap(env, options = {}) {
	const config = getPlaybackModeConfig(env);
	const checkedAt = new Date().toISOString();
	const bypassCache = !!options.bypassCache;
	if (config.manualModeRaw) {
		return {
			mode: config.manualMode,
			source: 'manual_override',
			requestLimit: config.dailyLimit,
			remainingThreshold: config.remainingThreshold,
			estimatedUsedRequests: null,
			estimatedRemainingRequests: null,
			checkedAt,
			notice: config.manualMode === 'direct' ? buildDirectModeNotice(config.newSiteUrl) : '',
			newSiteUrl: config.manualMode === 'direct' ? config.newSiteUrl : ''
		};
	}
	if (!config.accountTag || !config.apiToken || !config.scriptName) {
		return {
			mode: 'proxy',
			source: 'analytics_not_configured',
			requestLimit: config.dailyLimit,
			remainingThreshold: config.remainingThreshold,
			estimatedUsedRequests: null,
			estimatedRemainingRequests: null,
			checkedAt,
			notice: '',
			newSiteUrl: ''
		};
	}

	const range = getUtcDayRange();
	const cacheKey = buildPlaybackModeCacheKey(config.scriptName, range.dayKey);
	if (!bypassCache) {
		try {
			const cached = await caches.default.match(cacheKey);
			if (cached) {
				const data = await cached.json().catch(() => null);
				if (data && (data.mode === 'proxy' || data.mode === 'direct')) {
					return Object.assign({}, data, {
						cacheHit: true,
						notice: data.mode === 'direct' ? buildDirectModeNotice(config.newSiteUrl) : '',
						newSiteUrl: data.mode === 'direct' ? config.newSiteUrl : ''
					});
				}
			}
		} catch (_) { }
	}

	try {
		const usage = await queryWorkerRequestsToday(config);
		const estimatedRemainingRequests = Math.max(0, config.dailyLimit - usage.requests);
		const mode = estimatedRemainingRequests <= config.remainingThreshold ? 'direct' : 'proxy';
		const payload = {
			mode,
			source: 'cloudflare_graphql_analytics',
			requestLimit: config.dailyLimit,
			remainingThreshold: config.remainingThreshold,
			estimatedUsedRequests: usage.requests,
			estimatedRemainingRequests,
			checkedAt: usage.checkedAt,
			notice: mode === 'direct' ? buildDirectModeNotice(config.newSiteUrl) : '',
			newSiteUrl: mode === 'direct' ? config.newSiteUrl : '',
			cacheHit: false
		};
		try {
			await caches.default.put(cacheKey, new Response(JSON.stringify(payload), {
				headers: {
					'content-type': 'application/json;charset=UTF-8',
					'cache-control': `public, max-age=${config.cacheTtlSeconds}`
				}
			}));
		} catch (_) { }
		return payload;
	} catch (error) {
		return {
			mode: 'proxy',
			source: 'analytics_error',
			requestLimit: config.dailyLimit,
			remainingThreshold: config.remainingThreshold,
			estimatedUsedRequests: null,
			estimatedRemainingRequests: null,
			checkedAt,
			notice: '',
			newSiteUrl: '',
			cacheHit: false,
			error: error instanceof Error ? error.message : String(error || 'unknown_error')
		};
	}
}

async function getPlaybackModeDebugInfo(env, options = {}) {
	const config = getPlaybackModeConfig(env);
	const modeState = await getPlaybackModeBootstrap(env, options);
	const missingConfig = [];
	if (!config.accountTag) missingConfig.push('CF_ACCOUNT_TAG');
	if (!config.apiToken) missingConfig.push('CF_ANALYTICS_API_TOKEN');
	if (!config.scriptName) missingConfig.push('CF_WORKER_SCRIPT_NAME');
	return {
		mode: modeState.mode,
		source: modeState.source,
		cacheHit: !!modeState.cacheHit,
		bypassCache: !!options.bypassCache,
		requestLimit: modeState.requestLimit,
		remainingThreshold: modeState.remainingThreshold,
		estimatedUsedRequests: modeState.estimatedUsedRequests,
		estimatedRemainingRequests: modeState.estimatedRemainingRequests,
		checkedAt: modeState.checkedAt,
		notice: modeState.notice || '',
		error: modeState.error || '',
		config: {
			manualModeRaw: config.manualModeRaw,
			manualMode: config.manualMode,
			hasAccountTag: !!config.accountTag,
			scriptName: config.scriptName,
			newSiteUrl: config.newSiteUrl,
			hasApiToken: !!config.apiToken,
			dailyLimit: config.dailyLimit,
			remainingThreshold: config.remainingThreshold,
			cacheTtlSeconds: config.cacheTtlSeconds,
			missingConfig
		},
		utcDayRange: getUtcDayRange()
	};
}

async function getNoticeBootstrap(env) {
	const config = getNoticeConfig(env);
	if (!config.apiUrl) return normalizeNoticeBootstrap({ hasNotice: false });

	const cacheKey = buildNoticeCacheKey(config.apiUrl);
	try {
		const cached = await caches.default.match(cacheKey);
		if (cached) {
			const data = await cached.json().catch(() => null);
			if (data && typeof data === 'object') return normalizeNoticeBootstrap(data);
		}
	} catch (_) { }

	try {
		const response = await fetch(config.apiUrl, { headers: { 'Accept': 'application/json' } });
		if (!response.ok) throw new Error(`通知接口返回状态异常：${response.status}`);
		const data = normalizeNoticeBootstrap(await response.json().catch(() => null));
		try {
			await caches.default.put(cacheKey, new Response(JSON.stringify(data), {
				headers: {
					'content-type': 'application/json;charset=UTF-8',
					'cache-control': `public, max-age=${config.cacheTtlSeconds}`
				}
			}));
		} catch (_) { }
		return data;
	} catch (_) {
		return normalizeNoticeBootstrap({ hasNotice: false });
	}
}

function serializeForInlineScript(value) {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

async function renderHtml(env) {
	const [backendTokenStatus, playbackMode, noticeState] = await Promise.all([
		getBackendTokenStatus(env),
		getPlaybackModeBootstrap(env),
		getNoticeBootstrap(env)
	]);
	const retryAfterSeconds = backendTokenStatus.status === 'not_configured'
		? BACKEND_TOKEN_STATUS_RETRY_AFTER_SECONDS
		: (backendTokenStatus.status === 'login_failed'
			? (backendTokenStatus.retryAfterSeconds || Math.ceil(IWARA_LOGIN_RETRY_COOLDOWN_MS / 1000))
			: (backendTokenStatus.status === 'login_misconfigured' ? 60 : 0));
	const loginFailureInfo = backendTokenStatus.status === 'login_failed'
		? getIwaraLoginFailurePublicInfo(backendTokenStatus.failureReason)
		: null;
	const bootstrapPayload = {
		status: backendTokenStatus.status,
		retryAfterSeconds,
		failureReason: backendTokenStatus.failureReason || '',
		message: loginFailureInfo?.message || ''
	};
	return html
		.replace('__ONLINE_PRESENCE_ENABLED__', getOnlineCounterStub(env) ? 'true' : 'false')
		.replace('"__BACKEND_TOKEN_STATUS_BOOTSTRAP__"', serializeForInlineScript(bootstrapPayload))
		.replace('"__PLAYBACK_MODE_BOOTSTRAP__"', serializeForInlineScript(playbackMode))
		.replace('"__NOTICE_BOOTSTRAP__"', serializeForInlineScript(noticeState));
}

function isAllowedIwaraViewTarget(urlObj) {
	const protocol = String(urlObj.protocol || '').toLowerCase();
	const host = String(urlObj.hostname || '').toLowerCase();
	const pathname = String(urlObj.pathname || '');
	const query = String(urlObj.search || '');
	const protocolOk = protocol === 'http:' || protocol === 'https:';
	const hostOk = /^[a-z0-9-]+\.iwara\.tv$/i.test(host);
	const pathOk = pathname === '/view';
	const queryOk = query.length > 1;
	return protocolOk && hostOk && pathOk && queryOk;
}


function isAllowedProxyMethod(method) {
	const mth = String(method || '').toUpperCase();
	return mth === 'GET' || mth === 'OPTIONS';
}

function isProxyPath(pathname) {
	return pathname.startsWith('/video/') || pathname.startsWith('/videos') || pathname.startsWith('/file/') || pathname.startsWith('/view');
}

function normalizePresenceSessionId(value) {
	const v = String(value || '').trim();
	return /^[a-zA-Z0-9_-]{12,120}$/.test(v) ? v : '';
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: Object.assign({
			'content-type': 'application/json;charset=UTF-8',
			'cache-control': 'no-store'
		}, extraHeaders)
	});
}

function getOnlineCounterStub(env) {
	const namespace = env && env.ONLINE_COUNTER;
	if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
		return null;
	}
	return namespace.get(namespace.idFromName('global-site-presence'));
}

function buildDurableObjectRequest(targetUrl, request) {
	return new Request(targetUrl, request);
}

function getSocketSessionId(socket) {
	try {
		const attachment = socket.deserializeAttachment();
		return normalizePresenceSessionId(attachment && attachment.sessionId);
	} catch {
		return '';
	}
}

function countUniquePresenceSessions(sockets) {
	const sessionIds = new Set();
	for (const socket of sockets || []) {
		const sessionId = getSocketSessionId(socket);
		if (sessionId) sessionIds.add(sessionId);
	}
	return sessionIds.size;
}

function createPresencePayload(online) {
	return JSON.stringify({
		type: 'site_online_count',
		online: Math.max(0, Number(online) || 0),
		ts: Date.now()
	});
}

export class OnlineCounterDurableObject {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	getOnlineCount() {
		return countUniquePresenceSessions(this.state.getWebSockets());
	}

	broadcastOnlineCount() {
		const payload = createPresencePayload(this.getOnlineCount());
		for (const socket of this.state.getWebSockets()) {
			try {
				socket.send(payload);
			} catch (_) { }
		}
	}

	closeDuplicateSessions(sessionId, keepSocket = null) {
		for (const socket of this.state.getWebSockets()) {
			if (socket === keepSocket) continue;
			if (getSocketSessionId(socket) !== sessionId) continue;
			try {
				socket.close(1000, 'session replaced');
			} catch (_) { }
		}
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === '/count') {
			return jsonResponse({ online: this.getOnlineCount() });
		}

		const upgradeHeader = request.headers.get('Upgrade') || '';
		if (upgradeHeader.toLowerCase() !== 'websocket') {
			return jsonResponse({ error: '预期 WebSocket 升级请求！' }, 426, { 'upgrade': 'websocket' });
		}

		const sessionId = normalizePresenceSessionId(url.searchParams.get('sid'));
		if (!sessionId) {
			return jsonResponse({ error: '缺少有效的会话标识！' }, 400);
		}

		const webSocketPair = new WebSocketPair();
		const clientSocket = webSocketPair[0];
		const serverSocket = webSocketPair[1];

		this.closeDuplicateSessions(sessionId);
		this.state.acceptWebSocket(serverSocket);
		serverSocket.serializeAttachment({ sessionId });

		this.broadcastOnlineCount();
		return new Response(null, {
			status: 101,
			webSocket: clientSocket
		});
	}

	webSocketMessage(ws, message) {
		if (String(message || '').trim().toLowerCase() === 'ping') {
			try {
				ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
			} catch (_) { }
		}
	}

	webSocketClose() {
		this.broadcastOnlineCount();
	}

	webSocketError(ws) {
		try {
			ws.close(1011, 'socket error');
		} catch (_) { }
		this.broadcastOnlineCount();
	}
}

export default {
	async fetch(request, env) {
		const authFailed = verifyBasicAuth(request, env);
		if (authFailed) return authFailed;

		let url = new URL(request.url);
		if (isProxyPath(url.pathname) && !isAllowedProxyMethod(request.method)) {
			return new Response(JSON.stringify({ error: '仅允许代理GET和OPTIONS请求！' }), {
				status: 403,
				headers: { 'content-type': 'application/json;charset=UTF-8', 'allow': 'GET, OPTIONS' }
			});
		}
		if (isProxyPath(url.pathname) && String(request.method || '').toUpperCase() === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'allow': 'GET, OPTIONS',
					'access-control-allow-methods': 'GET, OPTIONS',
					'access-control-allow-origin': '*',
					'access-control-allow-headers': 'Content-Type, CustomizedToken, X-Version, Range'
				}
			});
		}

		if (url.pathname === '/token-status') {
			const status = await getBackendTokenStatus(env);
			if (url.searchParams.get('debug') === '1') {
				return jsonResponse(getIwaraLoginDiagnostics(env, status), 200, {
					'cache-control': 'no-store'
				});
			}
			if (status.status === 'not_configured') {
				return new Response(null, {
					status: 204,
					headers: { 'Retry-After': String(BACKEND_TOKEN_STATUS_RETRY_AFTER_SECONDS) }
				});
			}
			if (status.status === 'valid') {
				return new Response(null, { status: 204 });
			}
			if (status.status === 'login_misconfigured') {
				return jsonResponse({
					code: 'backend_login_misconfigured',
					message: 'Iwara自动登录配置不完整，请同时设置IWARA_USERNAME和IWARA_PASSWORD！'
				}, 200, { 'Retry-After': '60' });
			}
			if (status.status === 'login_failed') {
				const failureInfo = getIwaraLoginFailurePublicInfo(status.failureReason);
				return jsonResponse({
					code: failureInfo.code,
					reason: status.failureReason || 'unknown',
					message: failureInfo.message,
					shouldWarnUser: failureInfo.shouldWarnUser
				}, 200, { 'Retry-After': String(status.retryAfterSeconds || 60) });
			}
			return new Response(JSON.stringify({ code: 'backend_token_expired', message: '后端设置的token已过期！' }), {
				status: 200,
				headers: { 'content-type': 'application/json;charset=UTF-8' }
			});
		} else if (url.pathname === '/online-count' || url.pathname === '/online-presence') {
			const counterStub = getOnlineCounterStub(env);
			if (!counterStub) {
				return jsonResponse({ error: 'ONLINE_COUNTER Durable Object 未绑定！' }, 503);
			}

			const targetUrl = new URL(request.url);
			targetUrl.pathname = url.pathname === '/online-count' ? '/count' : '/ws';
			targetUrl.search = url.search;
			return counterStub.fetch(buildDurableObjectRequest(targetUrl.toString(), request));
		} else if (url.pathname === '/playback-mode-debug') {
			const cfg = workerConfig(env);
			const basicAuthEnabled = !!(cfg.basicUser || cfg.basicPass);
			const bypassCache = basicAuthEnabled && url.searchParams.get('refresh') === '1';
			return jsonResponse(await getPlaybackModeDebugInfo(env, { bypassCache }));
		} else if (url.pathname === '/') {
			return new Response(await renderHtml(env), {
				headers: {
					"content-type": "text/html;charset=UTF-8",
					"cache-control": "no-store",
				},
			});
		} else if (url.pathname.startsWith('/video/') || url.pathname.startsWith('/videos')) {
			url.hostname = 'apiq.iwara.tv';
			return fetchIwaraProxy(url.toString(), request, env);
		} else if (url.pathname.startsWith('/view')) {
			let finUrl = url.searchParams.get('url');
			if (!finUrl) {
				return new Response('{"error":"缺少url参数值！"}', {
					status: 400,
					headers: { "content-type": "application/json;charset=UTF-8" }
				});
			}

			let decoded;
			try {
				decoded = decodeURIComponent(finUrl);
			} catch {
				return new Response('{"error":"url参数格式错误！"}', {
					status: 400,
					headers: { "content-type": "application/json;charset=UTF-8" }
				});
			}

			let urlObj;
			try {
				urlObj = new URL(decoded);
			} catch {
				return new Response('{"error":"url参数格式错误！"}', {
					status: 400,
					headers: { "content-type": "application/json;charset=UTF-8" }
				});
			}

			if (!isAllowedIwaraViewTarget(urlObj)) {
				return new Response('{"error":"请勿滥用接口！"}', {
					status: 403,
					headers: { "content-type": "application/json;charset=UTF-8" },
				});
			}
			return fetchIwaraProxy(decoded, request, env);
		} else if (url.pathname.startsWith('/file/')) {
			url.hostname = 'filesq.iwara.tv';
			return fetchIwaraProxy(url.toString(), request, env);
		}
		return env.ASSETS.fetch(request);
	}

};



// 网站源码
const html = `
<!DOCTYPE html>
<html lang="zh-CN">

<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<meta name="theme-color" content="#f1f3f9" />
	<meta name="color-scheme" content="light dark" />
	<script>
		/* 首屏前应用已保存的明暗主题，避免闪烁 */
		try { var t = localStorage.getItem('ui_theme_v1'); if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t); } catch (e) { }
	</script>
	<title>Iwara 视频免梯播放网站</title>
	<meta name="description" content="一款免梯在线 Iwara 视频播放网站" />
	<meta name="keywords" content="免费视频 在线 视频 Iwara" />
	<link rel="icon"
		href="data:image/png;base64,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" />
	<script src="https://unpkg.com/sweetalert/dist/sweetalert.min.js"></script>
	<style>
		/* =========================================================
		   Argon 风格界面 · 仅样式层改动，不涉及任何业务脚本
		   设计令牌 -> 基础 -> 顶栏/横幅 -> 主卡片 -> 播放器 -> 弹窗
		   ========================================================= */
		:root {
			color-scheme: light;
			--font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", Roboto, "Helvetica Neue", Arial, sans-serif;
			--primary: #5e72e4;
			--primary-600: #4f63d8;
			--violet: #825ee4;
			--cyan: #11cdef;
			--green: #2dce89;
			--orange: #fb6340;
			--amber: #ffb020;
			--pink: #f3519c;
			--red: #f5365c;
			--bg: #f1f3f9;
			--surface: #ffffff;
			--surface-2: #f6f8fc;
			--field: #f6f8fc;
			--text: #32325d;
			--text-2: #525f7f;
			--muted: #8898aa;
			--line: #e6eaf2;
			--shadow-sm: 0 1px 3px rgba(50, 50, 93, .08), 0 1px 2px rgba(0, 0, 0, .05);
			--shadow: 0 24px 60px -24px rgba(50, 50, 93, .28), 0 4px 14px rgba(50, 50, 93, .06);
			--ring: 0 0 0 3px rgba(94, 114, 228, .26);
			--glass: rgba(255, 255, 255, .78);
			--mesh1: rgba(243, 81, 156, .17);
			--mesh2: rgba(130, 94, 228, .15);
			--mesh3: rgba(17, 205, 239, .15);
			--grid: rgba(50, 50, 93, .05);
			--sun: none;
			--moon: block;
		}

		:root[data-theme="dark"] {
			color-scheme: dark;
			--bg: #0e1220;
			--surface: #171c2e;
			--surface-2: #1d2338;
			--field: #1d2338;
			--text: #eef1fb;
			--text-2: #b4bcd6;
			--muted: #7f8aa8;
			--line: #2a3250;
			--shadow-sm: 0 1px 3px rgba(0, 0, 0, .4);
			--shadow: 0 24px 60px -24px rgba(0, 0, 0, .75), 0 4px 14px rgba(0, 0, 0, .35);
			--ring: 0 0 0 3px rgba(130, 150, 255, .32);
			--glass: rgba(23, 28, 46, .72);
			--mesh1: rgba(150, 80, 220, .26);
			--mesh2: rgba(94, 114, 228, .22);
			--mesh3: rgba(17, 150, 220, .14);
			--grid: rgba(255, 255, 255, .04);
			--sun: block;
			--moon: none;
		}

		@media (prefers-color-scheme: dark) {
			:root:not([data-theme="light"]) {
				color-scheme: dark;
				--bg: #0e1220;
				--surface: #171c2e;
				--surface-2: #1d2338;
				--field: #1d2338;
				--text: #eef1fb;
				--text-2: #b4bcd6;
				--muted: #7f8aa8;
				--line: #2a3250;
				--shadow-sm: 0 1px 3px rgba(0, 0, 0, .4);
				--shadow: 0 24px 60px -24px rgba(0, 0, 0, .75), 0 4px 14px rgba(0, 0, 0, .35);
				--ring: 0 0 0 3px rgba(130, 150, 255, .32);
				--glass: rgba(23, 28, 46, .72);
				--mesh1: rgba(150, 80, 220, .26);
				--mesh2: rgba(94, 114, 228, .22);
				--mesh3: rgba(17, 150, 220, .14);
				--grid: rgba(255, 255, 255, .04);
				--sun: block;
				--moon: none;
			}
		}

		/* ---------- 基础 ---------- */
		*,
		*::before,
		*::after {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}

		html {
			-webkit-text-size-adjust: 100%;
			background: var(--bg);
		}

		html,
		body,
		input,
		select,
		button {
			font-family: var(--font);
			font-size: 14px;
		}

		body {
			min-height: 100vh;
			min-height: 100dvh;
			display: flex;
			flex-direction: column;
			background: transparent;
			color: var(--text);
			-webkit-font-smoothing: antialiased;
			-moz-osx-font-smoothing: grayscale;
			transition: background .3s ease, color .3s ease;
		}

		button {
			cursor: pointer;
			border: 0;
			background: none;
			color: inherit;
		}

		select option {
			background: var(--surface);
			color: var(--text);
		}

		:focus-visible {
			outline: 2px solid var(--primary);
			outline-offset: 2px;
		}

		.sr-only {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
			white-space: nowrap;
		}

		svg.i {
			width: 20px;
			height: 20px;
			flex: none;
			fill: none;
			stroke: currentColor;
			stroke-width: 2;
			stroke-linecap: round;
			stroke-linejoin: round;
		}

		svg.i.fill {
			fill: currentColor;
			stroke: none;
		}

		/* ---------- 背景：渐变网格 ---------- */
		.bg-mesh {
			position: fixed;
			inset: 0;
			z-index: -1;
			pointer-events: none;
			overflow: hidden;
			background:
				radial-gradient(900px 620px at 4% 2%, var(--mesh1), transparent 62%),
				radial-gradient(820px 640px at 98% 28%, var(--mesh2), transparent 62%),
				radial-gradient(1000px 720px at 52% 112%, var(--mesh3), transparent 64%);
		}

		.bg-mesh::after {
			content: '';
			position: absolute;
			inset: 0;
			background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
			background-size: 46px 46px;
			-webkit-mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, #000 25%, transparent 78%);
			mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, #000 25%, transparent 78%);
		}

		/* ---------- 顶栏 ---------- */
		.topbar {
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			z-index: 20;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: calc(env(safe-area-inset-top, 0px) + 16px) max(20px, env(safe-area-inset-right, 0px)) 0 max(20px, env(safe-area-inset-left, 0px));
			color: var(--text);
		}

		.topbar-actions {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-left: auto;
		}

		.icon-btn,
		.presence-panel {
			background: var(--glass);
			border: 1px solid var(--line);
			box-shadow: var(--shadow-sm);
			-webkit-backdrop-filter: blur(12px);
			backdrop-filter: blur(12px);
		}

		.icon-btn {
			width: 40px;
			height: 40px;
			border-radius: 14px;
			display: inline-grid;
			place-items: center;
			color: var(--text-2);
			text-decoration: none;
			transition: color .2s ease, border-color .2s ease, transform .2s ease, box-shadow .2s ease;
		}

		.icon-btn:hover {
			color: var(--primary);
			border-color: rgba(94, 114, 228, .45);
			transform: translateY(-1px);
			box-shadow: 0 10px 22px -12px rgba(94, 114, 228, .6);
		}

		.icon-btn svg {
			width: 18px;
			height: 18px;
		}

		#themeToggle .sun {
			display: var(--sun);
		}

		#themeToggle .moon {
			display: var(--moon);
		}

		/* 在线会话数（Durable Object 启用时由脚本切换为 flex 显示） */
		.presence-panel {
			display: none;
			align-items: center;
			gap: 8px;
			height: 40px;
			padding: 0 18px 0 15px;
			border-radius: 999px;
			color: var(--text-2);
			font-size: 14px;
			white-space: nowrap;
		}

		.presence-dot {
			width: 10px;
			height: 10px;
			border-radius: 50%;
			background: #ffb347;
			box-shadow: 0 0 0 4px rgba(255, 179, 71, .22);
			animation: presencePulse 1.8s ease-in-out infinite;
		}

		.presence-panel[data-state="online"] .presence-dot {
			background: #2dce89;
			box-shadow: 0 0 0 4px rgba(45, 206, 137, .22);
			animation-duration: 1.5s;
		}

		.presence-panel[data-state="error"] .presence-dot {
			background: #f5365c;
			box-shadow: 0 0 0 4px rgba(245, 54, 92, .22);
			animation-duration: 1.2s;
		}

		@keyframes presencePulse {

			0%,
			100% {
				transform: scale(1);
				opacity: .95;
			}

			50% {
				transform: scale(1.25);
				opacity: .6;
			}
		}

		.presence-count {
			font-size: 17px;
			font-weight: 800;
			color: var(--red);
			min-width: 1ch;
		}

		/* ---------- 标题区 ---------- */
		.wrap {
			flex: 1 0 auto;
			display: flex;
			flex-direction: column;
			align-items: stretch;
		}

		.hero {
			position: relative;
			text-align: center;
			padding: clamp(104px, 18vh, 180px) 20px 40px;
		}

		.meta {
			max-width: 820px;
			margin: 0 auto;
		}

		.title {
			font-size: clamp(30px, 5.4vw, 56px);
			line-height: 1.18;
			font-weight: 800;
			letter-spacing: .5px;
			color: var(--text);
		}

		.title .grad {
			background: linear-gradient(90deg, var(--primary) 0%, var(--violet) 52%, var(--pink) 100%);
			-webkit-background-clip: text;
			background-clip: text;
			-webkit-text-fill-color: transparent;
		}

		.description {
			margin-top: 14px;
			font-size: clamp(15px, 2.2vw, 18px);
			font-weight: 400;
			line-height: 1.6;
			color: var(--text-2);
		}

		/* ---------- 主卡片 ---------- */
		.panel {
			position: relative;
			z-index: 3;
			width: min(920px, calc(100% - 32px));
			margin: 0 auto;
			padding: 26px 28px 28px;
			background: var(--surface);
			border: 1px solid var(--line);
			border-radius: 22px;
			box-shadow: var(--shadow);
			transition: background .3s ease, border-color .3s ease;
		}

		.panel-head {
			display: flex;
			align-items: flex-end;
			justify-content: space-between;
			gap: 12px;
			margin-bottom: 18px;
		}

		.panel-head h2 {
			font-size: 20px;
			font-weight: 800;
			letter-spacing: .2px;
		}

		.panel-head p {
			margin-top: 4px;
			color: var(--muted);
			font-size: 13.5px;
		}

		.kbd-hint {
			flex: none;
			color: var(--muted);
			font-size: 12.5px;
			white-space: nowrap;
		}

		.kbd-hint kbd {
			display: inline-block;
			min-width: 22px;
			padding: 2px 7px;
			margin-right: 4px;
			border-radius: 7px;
			border: 1px solid var(--line);
			border-bottom-width: 2px;
			background: var(--surface-2);
			color: var(--text-2);
			font-family: var(--font);
			font-size: 11.5px;
			font-weight: 600;
			text-align: center;
		}

		/* 一体式输入条：链接 + 站点 + 清晰度 + 播放 */
		.omnibar {
			display: flex;
			align-items: center;
			padding: 6px;
			background: var(--surface);
			border: 1.5px solid var(--line);
			border-radius: 18px;
			box-shadow: var(--shadow-sm);
			transition: border-color .2s ease, box-shadow .2s ease;
		}

		.omnibar:focus-within {
			border-color: var(--primary);
			box-shadow: var(--ring);
		}

		.field-main {
			flex: 1 1 auto;
			min-width: 0;
			display: flex;
			align-items: center;
			gap: 10px;
			padding-left: 14px;
			color: var(--muted);
		}

		.omnibar:focus-within .field-main {
			color: var(--primary);
		}

		.link-area input.form {
			flex: 1 1 auto;
			min-width: 0;
			width: 100%;
			height: 46px;
			padding: 0;
			border: 0;
			background: transparent;
			color: var(--text);
			font-size: 16px;
			outline: none;
		}

		.link-area input.form::placeholder {
			color: var(--muted);
		}

		.input-clear {
			width: 30px;
			height: 30px;
			flex: none;
			display: inline-grid;
			place-items: center;
			border-radius: 9px;
			color: var(--muted);
			background: var(--surface-2);
			transition: color .18s ease, background .18s ease, transform .18s ease;
			touch-action: manipulation;
		}

		.input-clear[hidden] {
			display: none !important;
		}

		.input-clear svg {
			width: 16px;
			height: 16px;
		}

		.input-clear:hover,
		.input-clear:focus-visible {
			color: var(--primary);
			background: rgba(94, 114, 228, .12);
		}

		.input-clear:active {
			transform: scale(.92);
		}

		.sel {
			position: relative;
			display: flex;
			align-items: center;
			gap: 6px;
			height: 34px;
			margin: 0 2px;
			padding-left: 14px;
			border-left: 1px solid var(--line);
			flex: none;
		}

		.sel>span {
			color: var(--muted);
			font-size: 12px;
			white-space: nowrap;
		}

		.sel select {
			appearance: none;
			-webkit-appearance: none;
			height: 34px;
			padding: 0 24px 0 4px;
			border: 0;
			border-radius: 8px;
			background-color: transparent;
			background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%238898aa' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
			background-repeat: no-repeat;
			background-position: right 6px center;
			color: var(--text);
			font-size: 14px;
			font-weight: 600;
			cursor: pointer;
			outline: none;
		}

		.sel select:focus-visible {
			outline: 2px solid var(--primary);
			outline-offset: 2px;
		}

		.btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 8px;
			font-weight: 700;
			transition: transform .2s ease, box-shadow .2s ease, background .2s ease, border-color .2s ease;
		}

		.btn-play {
			flex: none;
			height: 46px;
			margin-left: 8px;
			padding: 0 24px;
			border-radius: 13px;
			color: #fff;
			font-size: 15px;
			background: linear-gradient(135deg, var(--primary) 0%, var(--violet) 100%);
			box-shadow: 0 10px 22px -8px rgba(94, 114, 228, .75);
			position: relative;
			overflow: hidden;
		}

		.btn-play::after {
			content: '';
			position: absolute;
			inset: 0;
			background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, .28) 50%, transparent 70%);
			transform: translateX(-120%);
			transition: transform .6s ease;
		}

		.btn-play:hover {
			transform: translateY(-1px);
			box-shadow: 0 14px 26px -8px rgba(94, 114, 228, .85);
		}

		.btn-play:hover::after {
			transform: translateX(120%);
		}

		.btn-play:active {
			transform: translateY(1px);
		}

		.btn-play svg {
			width: 15px;
			height: 15px;
		}

		/* 次要操作：磁贴 */
		.tiles {
			display: grid;
			grid-template-columns: repeat(4, 1fr);
			gap: 12px;
			margin-top: 18px;
		}

		.tile {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 14px;
			text-align: left;
			background: var(--surface-2);
			border: 1px solid var(--line);
			border-radius: 16px;
			transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease, background .2s ease;
		}

		.tile:hover {
			transform: translateY(-3px);
			background: var(--surface);
			border-color: rgba(var(--c), .55);
			box-shadow: 0 14px 28px -16px rgba(var(--c), .7);
		}

		.tile:active {
			transform: translateY(0);
		}

		.tile-ico {
			flex: none;
			width: 40px;
			height: 40px;
			border-radius: 12px;
			display: grid;
			place-items: center;
			color: #fff;
			background: linear-gradient(135deg, rgba(var(--c), 1), rgba(var(--c2), 1));
			box-shadow: 0 8px 16px -8px rgba(var(--c), .9);
		}

		.tile-ico svg {
			width: 19px;
			height: 19px;
		}

		.tile-txt {
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 3px;
		}

		.tile-txt b {
			font-size: 14.5px;
			font-weight: 700;
			color: var(--text);
		}

		.tile-txt small {
			font-size: 12px;
			font-weight: 400;
			color: var(--muted);
			line-height: 1.4;
		}

		.tile-hot {
			--c: 251, 99, 64;
			--c2: 251, 176, 64;
		}

		.tile-save {
			--c: 255, 176, 32;
			--c2: 255, 214, 92;
		}

		.tile-share {
			--c: 17, 205, 239;
			--c2: 17, 113, 239;
		}

		.tile-token {
			--c: 130, 94, 228;
			--c2: 243, 81, 156;
		}

		/* 使用小贴士 */
		.tips {
			width: min(920px, calc(100% - 32px));
			margin: 18px auto 0;
			display: grid;
			grid-template-columns: repeat(3, 1fr);
			gap: 12px;
		}

		.tip {
			display: flex;
			gap: 11px;
			padding: 14px 16px;
			border-radius: 16px;
			background: var(--glass);
			border: 1px dashed var(--line);
			color: var(--text-2);
			font-size: 12.5px;
			line-height: 1.65;
		}

		.tip svg {
			width: 18px;
			height: 18px;
			margin-top: 2px;
			color: var(--primary);
		}

		.footer {
			margin-top: auto;
			padding: 34px 20px calc(env(safe-area-inset-bottom, 0px) + 26px);
			text-align: center;
			color: var(--muted);
			font-size: 13px;
		}

		.footer a {
			color: var(--primary);
			text-decoration: none;
			font-weight: 700;
		}

		.footer a:hover {
			text-decoration: underline;
		}

		/* 入场动画（由原脚本给 .wrap 添加 on 类触发） */
		.wrap .reveal {
			opacity: 0;
			transform: translateY(18px);
			transition: opacity .7s cubic-bezier(.22, .8, .3, 1), transform .7s cubic-bezier(.22, .8, .3, 1);
			transition-delay: calc(var(--i, 0) * 90ms);
		}

		.wrap.on .reveal {
			opacity: 1;
			transform: none;
		}

		/* ---------- 播放器遮罩 ---------- */
		#iframeContainer {
			display: none;
			position: fixed;
			inset: 0;
			z-index: 1000;
			flex-direction: column;
			align-items: center;
			justify-content: flex-start;
			gap: 12px;
			padding: calc(env(safe-area-inset-top, 0px) + 14px) 14px calc(env(safe-area-inset-bottom, 0px) + 14px);
			background: radial-gradient(1100px 520px at 50% -10%, rgba(94, 114, 228, .38), transparent 62%), rgba(7, 9, 18, .94);
			-webkit-backdrop-filter: blur(18px);
			backdrop-filter: blur(18px);
			animation: fadeIn .3s ease;
		}

		@keyframes fadeIn {
			from {
				opacity: 0;
			}

			to {
				opacity: 1;
			}
		}

		#playerActions {
			order: -1;
			flex: none;
			position: static;
			display: flex;
			align-items: center;
			gap: 6px;
			max-width: 100%;
			padding: 6px;
			overflow-x: auto;
			scrollbar-width: none;
			border-radius: 999px;
			background: rgba(255, 255, 255, .08);
			border: 1px solid rgba(255, 255, 255, .12);
			-webkit-backdrop-filter: blur(14px);
			backdrop-filter: blur(14px);
			box-shadow: 0 14px 40px -14px rgba(0, 0, 0, .6);
		}

		#playerActions::-webkit-scrollbar {
			display: none;
		}

		#playerActions button {
			position: static;
			flex: none;
			display: inline-flex;
			align-items: center;
			gap: 7px;
			height: 38px;
			padding: 0 15px;
			border-radius: 999px;
			color: #fff;
			font-size: 13px;
			font-weight: 600;
			white-space: nowrap;
			background: rgba(var(--c), .24);
			border: 1px solid rgba(var(--c), .42);
			transition: background .2s ease, transform .2s ease, box-shadow .2s ease;
		}

		#playerActions button:hover {
			background: rgba(var(--c), .42);
			transform: translateY(-1px);
			box-shadow: 0 8px 18px -8px rgba(var(--c), .9);
		}

		#playerActions button svg {
			width: 16px;
			height: 16px;
		}

		#changeButton {
			--c: 130, 94, 228;
		}

		#shareMomentButton {
			--c: 17, 205, 239;
		}

		#saveButton {
			--c: 255, 176, 32;
		}

		#downButton {
			--c: 45, 206, 137;
		}

		#closeButton {
			--c: 245, 54, 92;
		}

		#myVideo {
			flex: 1 1 0;
			min-height: 0;
			width: min(100%, 1440px);
			border: 0;
			border-radius: 16px;
			background: #000;
			object-fit: contain;
			box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .75), 0 0 0 1px rgba(255, 255, 255, .06);
		}

		#ytPlayer {
			flex: 1 1 0 !important;
			min-height: 0;
			width: min(100%, 1440px) !important;
			height: auto !important;
			border-radius: 16px !important;
			background: #000;
			box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .75), 0 0 0 1px rgba(255, 255, 255, .06) !important;
		}

		/* 加载遮罩 */
		.loading-mask {
			position: fixed;
			inset: 0;
			display: none;
			align-items: center;
			justify-content: center;
			background: rgba(14, 18, 40, .42);
			-webkit-backdrop-filter: blur(6px);
			backdrop-filter: blur(6px);
			z-index: 3000;
		}

		.loading-mask.show {
			display: flex;
		}

		.loading-card {
			min-width: 220px;
			max-width: 80vw;
			padding: 22px 26px;
			text-align: center;
			background: var(--surface);
			border: 1px solid var(--line);
			border-radius: 20px;
			box-shadow: var(--shadow);
		}

		.loading-spinner {
			width: 38px;
			height: 38px;
			margin: 0 auto 14px;
			border-radius: 50%;
			border: 3.5px solid rgba(94, 114, 228, .16);
			border-top-color: var(--primary);
			border-right-color: var(--violet);
			animation: spin .8s linear infinite;
		}

		.loading-text {
			font-size: 14px;
			font-weight: 600;
			line-height: 1.5;
			color: var(--text);
		}

		@keyframes spin {
			to {
				transform: rotate(360deg);
			}
		}

		/* 轻提示 */
		.clipboard-soft-tip {
			position: fixed;
			left: 50%;
			bottom: calc(env(safe-area-inset-bottom, 0px) + 28px);
			transform: translate(-50%, 16px);
			max-width: min(92vw, 560px);
			padding: 11px 18px;
			border-radius: 999px;
			background: rgba(23, 28, 46, .94);
			color: #fff;
			border: 1px solid rgba(255, 255, 255, .12);
			font-size: 13px;
			line-height: 1.45;
			text-align: center;
			box-shadow: 0 16px 36px -12px rgba(0, 0, 0, .5);
			opacity: 0;
			pointer-events: none;
			z-index: 3000;
			transition: opacity .2s ease, transform .2s ease;
		}

		.clipboard-soft-tip.show {
			opacity: 1;
			transform: translate(-50%, 0);
		}

		/* ---------- SweetAlert 弹窗皮肤 ---------- */
		.swal-overlay {
			font-family: var(--font);
			background-color: rgba(14, 18, 40, .55);
			-webkit-backdrop-filter: blur(6px);
			backdrop-filter: blur(6px);
		}

		.swal-overlay .swal-modal {
			width: 440px;
			max-width: calc(100% - 24px);
			padding: 8px 6px 4px;
			background: var(--surface);
			border: 1px solid var(--line);
			border-radius: 22px;
			box-shadow: var(--shadow);
			color: var(--text);
		}

		.swal-title {
			color: var(--text);
			font-size: 20px;
			font-weight: 800;
			padding: 0 22px;
			margin-top: 18px;
		}

		.swal-title:not(:last-child) {
			margin-bottom: 10px;
		}

		.swal-text {
			display: block;
			max-width: none;
			margin: 0;
			color: var(--text-2);
			font-size: 14.5px;
			line-height: 1.75;
			padding: 0 22px;
		}

		.swal-content {
			padding: 0 22px;
			color: var(--text-2);
		}

		.swal-content a {
			color: var(--primary);
		}

		.swal-overlay .swal-modal:not(:has(.swal-icon)) .swal-title,
		.swal-overlay .swal-modal:not(:has(.swal-icon)) .swal-text {
			text-align: left;
		}

		.swal-overlay .swal-modal:has(.saveVideos) {
			width: 560px;
		}

		.swal-overlay .swal-modal:has(.swal-icon) .swal-title,
		.swal-overlay .swal-modal:has(.swal-icon) .swal-text {
			text-align: center;
		}

		.swal-footer {
			display: flex;
			flex-wrap: wrap;
			justify-content: flex-end;
			gap: 10px;
			margin-top: 18px;
			padding: 6px 20px 18px;
			text-align: right;
		}

		.swal-modal:has(.swal-icon) .swal-footer {
			justify-content: center;
		}

		.swal-button-container {
			margin: 0;
		}

		.swal-modal .swal-button {
			font-family: inherit;
			padding: 11px 22px;
			border: 1px solid transparent;
			border-radius: 12px;
			font-size: 14px;
			font-weight: 700;
			color: #fff;
			background: linear-gradient(135deg, var(--primary), var(--violet));
			box-shadow: 0 10px 20px -10px rgba(94, 114, 228, .8);
			transition: transform .2s ease, box-shadow .2s ease, background .2s ease;
		}

		.swal-modal .swal-button:not([disabled]):hover {
			background: linear-gradient(135deg, var(--primary-600), #7048d6);
			transform: translateY(-1px);
		}

		.swal-modal .swal-button:active {
			transform: translateY(0);
			background: linear-gradient(135deg, var(--primary-600), #7048d6);
		}

		.swal-modal .swal-button:focus {
			box-shadow: var(--ring);
		}

		.swal-modal .swal-button--cancel,
		.swal-modal .swal-button--disable,
		.swal-modal .swal-button--export,
		.swal-modal .swal-button--import {
			color: var(--text-2);
			background: var(--surface-2);
			border-color: var(--line);
			box-shadow: none;
		}

		.swal-modal .swal-button--cancel:not([disabled]):hover,
		.swal-modal .swal-button--disable:not([disabled]):hover,
		.swal-modal .swal-button--export:not([disabled]):hover,
		.swal-modal .swal-button--import:not([disabled]):hover {
			color: var(--text);
			background: var(--line) !important;
		}

		.swal-modal .swal-button--clear {
			color: var(--red);
			background: rgba(245, 54, 92, .1);
			border-color: rgba(245, 54, 92, .25);
			box-shadow: none;
		}

		.swal-modal .swal-button--clear:not([disabled]):hover {
			color: #fff;
			background: var(--red) !important;
		}

		.swal-modal .swal-button--r18 {
			background: linear-gradient(135deg, #f5365c, #f3519c);
			box-shadow: 0 10px 20px -10px rgba(245, 54, 92, .8);
		}

		.swal-modal .swal-button--r18:not([disabled]):hover {
			background: linear-gradient(135deg, #e02a50, #e04489) !important;
		}

		/* 图标配色统一到 Argon 语义色，并适配暗色卡片背景 */
		.swal-icon--success {
			border-color: var(--green);
		}

		.swal-icon--success:before,
		.swal-icon--success:after,
		.swal-icon--success__hide-corners {
			background: var(--surface);
		}

		.swal-icon--success__ring {
			border-color: rgba(45, 206, 137, .25);
		}

		.swal-icon--success__line {
			background-color: var(--green);
		}

		.swal-icon--error {
			border-color: var(--red);
		}

		.swal-icon--error__line {
			background-color: var(--red);
		}

		.swal-icon--warning {
			border-color: var(--orange);
		}

		.swal-icon--warning__body,
		.swal-icon--warning__dot {
			background-color: var(--orange);
		}

		.swal-icon--info {
			border-color: var(--cyan);
		}

		.swal-icon--info:before,
		.swal-icon--info:after {
			background-color: var(--cyan);
		}

		/* 弹窗内表单控件 */
		.swal-modal .swal-content__input,
		.swal-modal .swal-content>select {
			width: 100%;
			height: 46px;
			padding: 0 14px !important;
			border: 1.5px solid var(--line) !important;
			border-radius: 12px !important;
			background: var(--field) !important;
			color: var(--text);
			font-size: 15px;
			outline: none;
			transition: border-color .2s ease, box-shadow .2s ease;
		}

		.swal-modal .swal-content__input:focus,
		.swal-modal .swal-content>select:focus {
			border-color: var(--primary) !important;
			box-shadow: var(--ring);
		}

		.random-hot-prompt {
			text-align: left;
		}

		.random-hot-prompt-text {
			color: var(--text-2);
			line-height: 1.7;
			margin-bottom: 14px;
		}

		.random-hot-remember {
			display: flex;
			align-items: flex-start;
			gap: 10px;
			padding: 12px 14px;
			border-radius: 14px;
			background: rgba(45, 206, 137, .1);
			border: 1px solid rgba(45, 206, 137, .25);
			color: var(--text-2);
			line-height: 1.5;
			cursor: pointer;
			user-select: none;
		}

		.random-hot-remember input {
			width: 18px;
			height: 18px;
			margin-top: 1px;
			accent-color: var(--green);
			flex: 0 0 auto;
		}

		/* 收藏列表 */
		.saveVideos {
			text-align: left;
		}

		.fav-tip {
			display: flex;
			align-items: flex-start;
			gap: 9px;
			margin: 0 0 12px;
			padding: 10px 14px;
			border-radius: 14px;
			background: var(--surface-2);
			border: 1px solid var(--line);
			color: var(--text-2);
			font-size: 12.5px;
			line-height: 1.55;
		}

		.fav-tip svg {
			width: 16px;
			height: 16px;
			margin-top: 1px;
			color: var(--amber);
		}

		.fav-tag {
			display: inline-block;
			margin-right: 8px;
			padding: 1px 8px;
			border-radius: 7px;
			font-size: 11.5px;
			font-weight: 800;
			letter-spacing: .3px;
			line-height: 1.6;
			vertical-align: 1px;
		}

		.fav-tag-tv {
			color: var(--red);
			background: rgba(245, 54, 92, .12);
		}

		.fav-tag-ai {
			color: var(--violet);
			background: rgba(130, 94, 228, .15);
		}

		.fav-suffix {
			display: none;
		}

		.swal-content table {
			width: 100%;
			border-collapse: separate;
			border-spacing: 0;
			overflow: hidden;
			border: 1px solid var(--line);
			border-radius: 14px;
			box-shadow: none;
		}

		.swal-content th {
			padding: 10px 14px;
			text-align: left;
			font-size: 12px;
			font-weight: 600;
			letter-spacing: .04em;
			color: var(--muted);
			background: var(--surface-2);
			border-bottom: 1px solid var(--line);
		}

		.swal-content td {
			padding: 11px 14px;
			text-align: left;
			vertical-align: middle;
			line-height: 1.5;
			color: var(--text);
			border-bottom: 1px solid var(--line);
		}

		.swal-content tr:last-child td {
			border-bottom: 0;
		}

		#data-table td:first-child {
			cursor: copy;
			overflow-wrap: break-word;
		}

		#data-table td:last-child {
			width: 1%;
			white-space: nowrap;
			text-align: right;
		}

		#data-table tr:hover td {
			background: var(--surface-2);
		}

		#data-table td[colspan] {
			padding: 30px 14px;
			text-align: center !important;
			color: var(--muted) !important;
			cursor: default;
		}

		#data-table td button {
			padding: 6px 12px;
			margin-left: 6px;
			border-radius: 999px;
			font-size: 12.5px;
			font-weight: 700;
			white-space: nowrap;
			transition: background .2s ease, color .2s ease;
		}

		.btn-t-play {
			color: var(--primary);
			background: rgba(94, 114, 228, .12);
		}

		.btn-t-play:hover {
			color: #fff;
			background: var(--primary);
		}

		.btn-t-del {
			color: var(--red);
			background: rgba(245, 54, 92, .1);
		}

		.btn-t-del:hover {
			color: #fff;
			background: var(--red);
		}

		#paginationControls {
			display: none;
			margin: 14px 0 2px;
			text-align: center;
			color: var(--text-2);
		}

		#paginationControls>div:first-child {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			justify-content: center;
			gap: 8px 12px;
			margin-bottom: 12px;
			padding: 12px 14px;
			border: 1px solid var(--line);
			border-radius: 16px;
			background: var(--surface-2);
			font-size: 13px;
		}

		#paginationControls>div:last-child {
			display: flex;
			justify-content: center;
			align-items: center;
			gap: 6px;
			flex-wrap: wrap;
		}

		#pageSizeSelect,
		#viewContentSelect {
			height: 32px;
			padding: 0 10px;
			border: 1px solid var(--line);
			border-radius: 10px;
			background: var(--field);
			color: var(--text);
			font-size: 13px;
		}

		.page-btn {
			padding: 7px 12px;
			border-radius: 10px;
			font-size: 13px;
			font-weight: 600;
			white-space: nowrap;
			color: var(--primary);
			background: rgba(94, 114, 228, .1);
			transition: background .2s ease, color .2s ease;
		}

		.page-btn:hover:not(:disabled) {
			color: #fff;
			background: var(--primary);
		}

		.page-btn:disabled {
			color: var(--muted);
			background: var(--surface-2);
			cursor: not-allowed;
			opacity: .7;
		}

		#pageInfo {
			margin: 0 6px;
			font-weight: 600;
			color: var(--text);
			white-space: nowrap;
		}

		/* ---------- 大屏桌面：提高主内容的视觉占比 ---------- */
		@media (min-width: 1200px) {
			.hero {
				padding: clamp(150px, 20vh, 230px) 24px 46px;
			}

			.meta {
				max-width: 1120px;
			}

			.title {
				font-size: clamp(58px, 4.6vw, 72px);
			}

			.description {
				margin-top: 18px;
				font-size: clamp(19px, 1.5vw, 21px);
			}

			.panel,
			.tips {
				width: min(1380px, 82vw);
			}

			.panel {
				padding: 34px 38px 36px;
				border-radius: 26px;
			}

			.panel-head {
				margin-bottom: 22px;
			}

			.panel-head h2 {
				font-size: 23px;
			}

			.panel-head p {
				font-size: 15px;
			}

			.omnibar {
				padding: 8px;
			}

			.link-area input.form {
				height: 54px;
				font-size: 18px;
			}

			.sel {
				height: 42px;
				padding-left: 18px;
			}

			.sel select {
				height: 42px;
				font-size: 16px;
			}

			.btn-play {
				height: 54px;
				padding: 0 30px;
				font-size: 16px;
			}

			.tiles {
				gap: 16px;
				margin-top: 22px;
			}

			.tile {
				gap: 15px;
				padding: 18px;
				border-radius: 18px;
			}

			.tile-ico {
				width: 48px;
				height: 48px;
				border-radius: 14px;
			}

			.tile-ico svg {
				width: 22px;
				height: 22px;
			}

			.tile-txt b {
				font-size: 16px;
			}

			.tile-txt small {
				font-size: 13.5px;
			}

			.tips {
				gap: 16px;
				margin-top: 22px;
			}

			.tip {
				gap: 13px;
				padding: 18px 20px;
				font-size: 14px;
			}

			.tip svg {
				width: 20px;
				height: 20px;
			}
		}

		/* ---------- 响应式 ---------- */
		@media (max-width: 900px) {
			.tiles {
				grid-template-columns: repeat(2, 1fr);
			}

			.tips {
				grid-template-columns: 1fr;
			}

		}

		@media (max-width: 720px) {
			/* 移动端 APP 的 WebView 通常已经避开原生顶部导航栏，
			   不再叠加 safe-area-inset-top，避免顶栏按钮被二次下移。
			   顶栏改为正常文档流，给标题留出真实空间，不再覆盖标题。 */
			.topbar {
				position: relative;
				top: auto;
				left: auto;
				right: auto;
				padding: 10px max(14px, env(safe-area-inset-right, 0px)) 0 max(14px, env(safe-area-inset-left, 0px));
				min-height: 50px;
			}

			.hero {
				/* 顶栏已占据约 50px 高度，标题区无需再预留 80px。 */
				padding: 26px 18px 28px;
			}

			.panel {
				padding: 20px 16px 18px;
				border-radius: 20px;
			}

			.kbd-hint {
				display: none;
			}

			.omnibar {
				flex-wrap: wrap;
				padding: 4px 4px 6px;
			}

			.field-main {
				flex: 1 1 100%;
				padding-left: 12px;
			}

			.sel {
				flex: 1 1 50%;
				height: 42px;
				margin: 0;
				padding: 0 10px 0 12px;
				border-left: 0;
				border-top: 1px solid var(--line);
			}

			.sel+.sel {
				border-left: 1px solid var(--line);
			}

			.sel select {
				flex: 1;
				font-size: 15px;
			}

			.btn-play {
				flex: 1 1 100%;
				height: 50px;
				margin: 6px 2px 0;
			}

			.title {
				letter-spacing: 0;
			}
		}

		@media (max-width: 520px) {
			.tiles {
				gap: 10px;
			}

			.tile {
				flex-direction: column;
				align-items: flex-start;
				gap: 12px;
				padding: 14px 14px 13px;
			}

			.tile-ico {
				width: 38px;
				height: 38px;
			}

			.tile-txt small {
				font-size: 11.5px;
			}
		}

		@media (max-width: 640px) {
			/* 播放层在 APP WebView 内也已位于原生导航栏下方，
			   顶部只保留少量间距；底部安全区仍单独保留。 */
			#iframeContainer {
				padding-top: 10px;
			}

			#playerActions .lbl {
				display: none;
			}

			#playerActions button {
				width: 42px;
				height: 42px;
				padding: 0;
				justify-content: center;
			}

			#playerActions button svg {
				width: 18px;
				height: 18px;
			}

			#iframeContainer {
				padding-left: 8px;
				padding-right: 8px;
			}

			.swal-footer {
				justify-content: center;
				gap: 8px;
				padding: 6px 14px 16px;
			}

			.swal-modal .swal-button {
				padding: 11px 15px;
			}
		}

		/* 手机端：收藏弹窗压缩间距，分页与底部按钮各保持一行 */
		@media (max-width: 520px) {
			.swal-overlay .swal-modal {
				max-width: calc(100% - 16px);
				padding: 6px 2px 2px;
			}

			.swal-title {
				padding: 0 16px;
				margin-top: 14px;
				font-size: 18px;
			}

			.swal-content {
				padding: 0 14px;
			}

			.swal-footer {
				gap: 8px;
				padding: 4px 12px 14px;
				margin-top: 12px;
			}

			.swal-overlay .swal-modal:has(.saveVideos) .swal-footer {
				flex-wrap: nowrap;
				gap: 6px;
				padding: 4px 10px 14px;
			}

			.swal-overlay .swal-modal:has(.saveVideos) .swal-button {
				padding: 10px 9px;
				font-size: 13px;
				white-space: nowrap;
			}

			.fav-tip {
				padding: 8px 11px;
				margin-bottom: 9px;
				font-size: 12px;
			}

			.swal-content th,
			.swal-content td {
				padding: 8px 11px;
			}

			#data-table td:first-child {
				font-size: 13.5px;
				line-height: 1.45;
			}

			#data-table td button {
				padding: 5px 10px;
				margin-left: 4px;
				font-size: 12px;
			}

			#paginationControls {
				margin: 10px 0 0;
			}

			#paginationControls>div:first-child {
				gap: 6px 8px;
				padding: 8px 10px;
				margin-bottom: 8px;
				font-size: 12.5px;
			}

			#pageSizeSelect,
			#viewContentSelect {
				height: 30px;
				padding: 0 6px;
				font-size: 12.5px;
			}

			#paginationControls>div:last-child {
				flex-wrap: nowrap;
				gap: 4px;
			}

			.page-btn {
				padding: 7px 8px;
				font-size: 12px;
			}

			#pageInfo {
				margin: 0 2px;
				font-size: 12px;
			}
		}

		@media (prefers-reduced-motion: reduce) {

			*,
			*::before,
			*::after {
				animation-duration: .001ms !important;
				animation-iteration-count: 1 !important;
				transition-duration: .001ms !important;
				transition-delay: 0ms !important;
			}

			.wrap .reveal {
				transform: none;
			}
		}
	</style>
</head>

<body>
	<!-- 图标精灵（内联 SVG，无外部请求） -->
	<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
		<symbol id="i-bulb" viewBox="0 0 24 24"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></symbol>
		<symbol id="i-play" viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z"/></symbol>
		<symbol id="i-link" viewBox="0 0 24 24"><path d="M15 7h3a5 5 0 0 1 0 10h-3m-6 0H6A5 5 0 0 1 6 7h3"/><line x1="8" y1="12" x2="16" y2="12"/></symbol>
		<symbol id="i-flame" viewBox="0 0 24 24"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></symbol>
		<symbol id="i-bookmark" viewBox="0 0 24 24"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></symbol>
		<symbol id="i-share" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></symbol>
		<symbol id="i-key" viewBox="0 0 24 24"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></symbol>
		<symbol id="i-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></symbol>
		<symbol id="i-x" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></symbol>
		<symbol id="i-repeat" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></symbol>
		<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></symbol>
		<symbol id="i-star" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></symbol>
		<symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></symbol>
		<symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></symbol>
		<symbol id="i-github" viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></symbol>
	</svg>

	<!-- 渐变网格背景 -->
	<div class="bg-mesh" aria-hidden="true"></div>

	<!-- 顶栏：在线会话数 / GitHub / 明暗主题 -->
	<header class="topbar">
		<div id="onlinePresenceCard" class="presence-panel" data-state="pending" aria-live="polite">
			<span class="presence-dot" aria-hidden="true"></span>
			<span class="presence-label">全站在线</span>
			<strong id="onlineCountValue" class="presence-count">--</strong>
			<span class="presence-unit">会话</span>
		</div>
		<div class="topbar-actions">
			<a id="github" class="icon-btn" href="https://github.com/Iskongkongyo/iwaraVideoProxy" target="_blank" rel="noopener" aria-label="GitHub 项目主页" title="GitHub 项目主页"><svg class="i fill"><use href="#i-github"/></svg></a>
			<button id="themeToggle" class="icon-btn" type="button" aria-label="切换明暗主题" title="切换明暗主题">
				<svg class="i sun"><use href="#i-sun"/></svg>
				<svg class="i moon"><use href="#i-moon"/></svg>
			</button>
		</div>
	</header>

	<div id="loadingMask" class="loading-mask" role="status" aria-live="polite" aria-busy="true">
		<div class="loading-card">
			<div class="loading-spinner"></div>
			<div id="loadingText" class="loading-text">Loading...</div>
		</div>
	</div>

	<!-- 视频播放容器（初始隐藏） -->
	<div id="iframeContainer">
		<div id="playerActions">
			<button id="changeButton" type="button" title="切换播放源" aria-label="切换播放源"><svg class="i"><use href="#i-repeat"/></svg><span class="lbl">切换播放源</span></button>
			<button id="shareMomentButton" type="button" title="分享此刻" aria-label="分享此刻"><svg class="i"><use href="#i-clock"/></svg><span class="lbl">分享此刻</span></button>
			<button id="saveButton" type="button" title="收藏" aria-label="收藏"><svg class="i"><use href="#i-star"/></svg><span class="lbl">收藏</span></button>
			<button id="downButton" type="button" title="下载" aria-label="下载"><svg class="i"><use href="#i-download"/></svg><span class="lbl">下载</span></button>
			<button id="closeButton" type="button" title="关闭" aria-label="关闭"><svg class="i"><use href="#i-x"/></svg><span class="lbl">关闭</span></button>
		</div>
		<video id="myVideo" controls playsinline webkit-playsinline x5-playsinline>
			<source class="videoSource" src="" type="video/mp4" />
			<source class="videoSource" src="" type="video/webm">
			<source class="videoSource" src="" type="video/ogg"> 您的浏览器不支持视频播放。
		</video>
	</div>

	<!-- 收藏列表隐藏容器（用于 SweetAlert 内容；结构与原版一致，脚本依赖其 ID 与层级） -->
	<template id="saveVideosTemplate">
		<div class="saveVideos">
			<div class="fav-tip"><svg class="i"><use href="#i-bulb"/></svg><span>点击列表任意标题行可一键复制原站视频链接</span></div>
			<table id="data-table">
				<thead>
					<tr>
						<th>视频名称</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody></tbody>
			</table>
			<div id="paginationControls" style="display:none;">
				<div>
					<label>每页显示:</label>
					<select id="pageSizeSelect">
						<option value="5">5条</option>
						<option value="10">10条</option>
					</select>
					<label>站点筛选:</label>
					<select id="viewContentSelect">
						<option value="all">全部站点</option>
						<option value="tv">仅TV</option>
						<option value="ai">仅AI</option>
					</select>
				</div>
				<div>
					<button id="firstPage" class="page-btn">首页</button>
					<button id="prevPage" class="page-btn">上一页</button>
					<span id="pageInfo">第 1 页 / 共 1 页</span>
					<button id="nextPage" class="page-btn">下一页</button>
					<button id="lastPage" class="page-btn">末页</button>
				</div>
			</div>
		</div>
	</template>

	<main class="wrap">
		<section class="hero">
			<div class="meta">
				<h1 class="title reveal" style="--i:0">Iwara <span class="grad">视频免梯播放网站</span></h1>
				<h3 class="description reveal" style="--i:1">一款免梯在线 Iwara 视频播放网站</h3>
			</div>
		</section>

		<section class="panel reveal" style="--i:2" aria-label="播放控制">
			<div class="panel-head">
				<div>
					<h2>开始播放</h2>
					<p>粘贴视频链接或 ID，选好站点与清晰度即可。</p>
				</div>
				<span class="kbd-hint"><kbd>Enter</kbd>快速播放</span>
			</div>

			<div class="omnibar link-area">
				<div class="field-main">
					<label class="sr-only" for="video">视频 ID 或链接</label>
					<svg class="i" aria-hidden="true"><use href="#i-link"/></svg>
					<input id="video" class="form" type="text" placeholder="填视频ID或链接" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" />
					<button id="clearVideoInput" class="input-clear" type="button" aria-label="清空视频 ID 或链接" title="清空" hidden><svg class="i"><use href="#i-x"/></svg></button>
				</div>
				<div class="sel">
					<span>站点</span>
					<select id="site" aria-label="站点">
						<option value="tv" selected>TV站</option>
						<option value="ai">AI站</option>
					</select>
				</div>
				<div class="sel">
					<span>清晰度</span>
					<select id="quality" aria-label="清晰度">
						<option value="Source">原视频</option>
						<option value="360">360P</option>
						<option value="540" selected>540P</option>
					</select>
				</div>
				<button id="submit" class="btn btn-play" type="button"><svg class="i"><use href="#i-play"/></svg>播放视频</button>
			</div>

			<div class="tiles">
				<button id="hot" class="btn tile tile-hot" type="button">
					<span class="tile-ico"><svg class="i"><use href="#i-flame"/></svg></span>
					<span class="tile-txt"><b>随机热门</b><small>随机来一个热门视频</small></span>
				</button>
				<button id="save" class="btn tile tile-save" type="button">
					<span class="tile-ico"><svg class="i"><use href="#i-bookmark"/></svg></span>
					<span class="tile-txt"><b>打开收藏</b><small>本机收藏，可导入导出</small></span>
				</button>
				<button id="share" class="btn tile tile-share" type="button">
					<span class="tile-ico"><svg class="i"><use href="#i-share"/></svg></span>
					<span class="tile-txt"><b>分享视频</b><small>复制可直接播放的链接</small></span>
				</button>
				<button id="token" class="btn tile tile-token" type="button">
					<span class="tile-ico"><svg class="i"><use href="#i-key"/></svg></span>
					<span class="tile-txt"><b>填写令牌</b><small>解锁需要登录的视频</small></span>
				</button>
			</div>
		</section>

		<section class="tips reveal" style="--i:4" aria-label="使用小贴士">
			<div class="tip"><svg class="i"><use href="#i-link"/></svg><span>直接粘贴 iwara.tv / iwara.ai 的视频链接，会自动识别站点和视频 ID。</span></div>
			<div class="tip"><svg class="i"><use href="#i-clock"/></svg><span>播放时点「分享此刻」，对方打开链接就会从当前进度开始播放。</span></div>
			<div class="tip"><svg class="i"><use href="#i-bookmark"/></svg><span>收藏只保存在本机浏览器里，换设备前记得先导出 JSON 备份。</span></div>
		</section>
	</main>

	<footer class="footer"> Copyright &copy; <a href="https://github.com/Iskongkongyo"
			target="_blank" rel="noopener">Iskongkongyo</a> All Rights Reserved </footer>
	<script type="text/javascript">
		(() => {
			// 缓存常用元素
			const q = (sel) => document.querySelector(sel);
			const iframeContainer = q('#iframeContainer');
			const videoElement = q('#myVideo');
			const btnChangeOrigin = q('#changeButton');
			const btnShareMoment = q('#shareMomentButton');
			const btnSaveOverlay = q('#saveButton');
			const btnDownload = q('#downButton');
			const btnCloseOverlay = q('#closeButton');
			const inputVideo = q('#video');
			const clearVideoInputButton = q('#clearVideoInput');
			function syncVideoInputClearButton() {
				if (!clearVideoInputButton || !inputVideo) return;
				clearVideoInputButton.hidden = !String(inputVideo.value || '').length;
			}
			function setVideoInputValue(value) {
				inputVideo.value = value == null ? '' : String(value);
				syncVideoInputClearButton();
			}
			const selectQuality = q('#quality');
			const selectSite = q('#site');
			const btnSubmit = q('#submit');
			const btnHot = q('#hot');
			const btnOpenSave = q('#save');
			const btnShare = q('#share');
			const btnToken = q('#token');
			const saveContainer = q('#saveVideos');
			const onlinePresenceCard = q('#onlinePresenceCard');
			const onlineCountValue = q('#onlineCountValue');
			const INITIAL_BACKEND_TOKEN_STATUS = "__BACKEND_TOKEN_STATUS_BOOTSTRAP__";
			const INITIAL_PLAYBACK_MODE = "__PLAYBACK_MODE_BOOTSTRAP__";
			const INITIAL_NOTICE = "__NOTICE_BOOTSTRAP__";
			const BACKEND_TOKEN_STATUS_DEFAULT_RETRY_SECONDS = 86400;

			let currentPlayId = '',
				currentVideoName = '',
				currentVideoUrl = '',
				pendingStartTimeSec = 0;
			let currentYoutubePlayer = null;
			let youtubeIframeApiPromise = null;
			const ONLINE_SESSION_STORAGE_KEY = 'iwara_site_presence_session_v1';
			const ONLINE_WS_PATH = '/online-presence';
			const ONLINE_PRESENCE_ENABLED = '__ONLINE_PRESENCE_ENABLED__' === 'true';
			const ONLINE_RECONNECT_MIN_DELAY_MS = 1500;
			const ONLINE_RECONNECT_MAX_DELAY_MS = 12000;
			const ONLINE_STALE_AFTER_MS = 30000;
			const ONLINE_LAZY_CONNECT_DELAY_MS = 8000;
			const PRESENCE_ACTIVATION_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
			const SENSITIVE_PROMPT_DISABLED_KEY = 'sensitive_prompt_disabled_v1';
			const YOUTUBE_PROMPT_DISABLED_KEY = 'youtube_prompt_disabled_v1';
			const INTRO_PROMPT_DISABLED_KEY = 'intro_prompt_disabled_v1';
			const NOTICE_LAST_DAILY_ID_KEY = 'site_notice_daily_last_id_v1';
			const NOTICE_LAST_DAILY_DAY_KEY = 'site_notice_daily_last_day_v1';
			const NOTICE_LAST_ONCE_ID_KEY = 'site_notice_once_last_id_v1';
			const NOTICE_DISABLED_ID_KEY = 'site_notice_disabled_id_v1';
			const NOTICE_ALLOWED_TAGS = new Set([
				'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
				'a', 'img', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
				'blockquote', 'ul', 'ol', 'li', 'code', 'pre', 'kbd',
				'small', 'mark', 'sub', 'sup', 'q', 'details', 'summary',
				'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
				'div', 'span'
			]);
			const NOTICE_DROP_CONTENT_TAGS = new Set([
				'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math',
				'form', 'input', 'button', 'textarea', 'select', 'option',
				'link', 'meta', 'base', 'template'
			]);
			const NOTICE_ALLOWED_ATTRIBUTES = {
				a: new Set(['href', 'title', 'target']),
				img: new Set(['src', 'alt', 'title', 'width', 'height']),
				ol: new Set(['start', 'reversed']),
				li: new Set(['value']),
				details: new Set(['open']),
				th: new Set(['colspan', 'rowspan']),
				td: new Set(['colspan', 'rowspan'])
			};
			const presenceSessionId = ONLINE_PRESENCE_ENABLED ? getOrCreatePresenceSessionId() : '';
			let presenceSocket = null;
			let presenceReconnectTimer = 0;
			let presenceReconnectAttempts = 0;
			let presenceLastCountAt = 0;
			let presenceClosedByClient = false;
			let presenceActivated = false;
			let presenceActivationTimer = 0;
			let presenceActivationEventsBound = false;

			const swalAlert = (text, icon = 'error', button = '关闭') => swal({ text, icon, button });
			const loadingMask = q('#loadingMask');
			const loadingText = q('#loadingText');

			function showLoading(text) {
				if (loadingText) loadingText.textContent = text || '处理中...';
				if (loadingMask) loadingMask.classList.add('show');
			}

			function hideLoading() {
				if (loadingMask) loadingMask.classList.remove('show');
			}

			function createPresenceSessionId() {
				try {
					if (crypto && typeof crypto.randomUUID === 'function') {
						return crypto.randomUUID().replace(/-/g, '');
					}
				} catch (_) { }
				return (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).replace(/[^a-z0-9]/gi, '').slice(0, 32);
			}

			function getOrCreatePresenceSessionId() {
				try {
					let current = sessionStorage.getItem(ONLINE_SESSION_STORAGE_KEY) || '';
					if (!/^[a-zA-Z0-9_-]{12,120}$/.test(current)) {
						current = createPresenceSessionId();
						sessionStorage.setItem(ONLINE_SESSION_STORAGE_KEY, current);
					}
					return current;
				} catch (_) {
					return createPresenceSessionId();
				}
			}

			function setPresenceStatus(state = 'pending') {
				if (onlinePresenceCard) onlinePresenceCard.dataset.state = state;
			}

			function setPresenceVisibility(visible) {
				if (!onlinePresenceCard) return;
				onlinePresenceCard.style.display = visible && ONLINE_PRESENCE_ENABLED ? 'flex' : 'none';
			}

			function isSensitivePromptDisabled() {
				try {
					return localStorage.getItem(SENSITIVE_PROMPT_DISABLED_KEY) === '1';
				} catch (_) {
					return false;
				}
			}

			function disableSensitivePrompt() {
				try {
					localStorage.setItem(SENSITIVE_PROMPT_DISABLED_KEY, '1');
				} catch (_) { }
			}

			function isYouTubePromptDisabled() {
				try {
					return localStorage.getItem(YOUTUBE_PROMPT_DISABLED_KEY) === '1';
				} catch (_) {
					return false;
				}
			}

			function disableYouTubePrompt() {
				try {
					localStorage.setItem(YOUTUBE_PROMPT_DISABLED_KEY, '1');
				} catch (_) { }
			}

			function isIntroPromptDisabled() {
				try {
					return localStorage.getItem(INTRO_PROMPT_DISABLED_KEY) === '1';
				} catch (_) {
					return false;
				}
			}

			function disableIntroPrompt() {
				try {
					localStorage.setItem(INTRO_PROMPT_DISABLED_KEY, '1');
				} catch (_) { }
			}

			function loadYouTubeIframeApi() {
				if (window.YT && typeof window.YT.Player === 'function') {
					return Promise.resolve(window.YT);
				}
				if (youtubeIframeApiPromise) return youtubeIframeApiPromise;

				youtubeIframeApiPromise = new Promise((resolve, reject) => {
					const previousReady = window.onYouTubeIframeAPIReady;
					window.onYouTubeIframeAPIReady = () => {
						if (typeof previousReady === 'function') {
							try { previousReady(); } catch (_) { }
						}
						if (window.YT && typeof window.YT.Player === 'function') {
							resolve(window.YT);
						} else {
							reject(new Error('YouTube IFrame API 初始化失败'));
						}
					};

					const existingScript = document.getElementById('youtube-iframe-api');
					if (existingScript) return;

					const script = document.createElement('script');
					script.id = 'youtube-iframe-api';
					script.src = 'https://www.youtube.com/iframe_api';
					script.async = true;
					script.onerror = () => reject(new Error('YouTube IFrame API 加载失败'));
					document.head.appendChild(script);
				});

				return youtubeIframeApiPromise;
			}

			function buildYouTubeEmbedSrc(videoId, startSeconds = 0) {
				const params = new URLSearchParams();
				params.set('enablejsapi', '1');
				params.set('playsinline', '1');
				if (location.origin) params.set('origin', location.origin);
				const start = Math.max(0, Math.floor(Number(startSeconds) || 0));
				if (start > 0) params.set('start', String(start));
				return 'https://www.youtube.com/embed/' + encodeURIComponent(videoId) + '?' + params.toString();
			}

			function getOrCreateYouTubeIframe() {
				let ytIframe = document.getElementById('ytPlayer');
				if (ytIframe) return ytIframe;

				ytIframe = document.createElement('iframe');
				ytIframe.id = 'ytPlayer';
				ytIframe.style.width = '90%';
				ytIframe.style.height = '85%';
				ytIframe.style.border = 'none';
				ytIframe.style.borderRadius = '12px';
				ytIframe.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.5)';
				ytIframe.setAttribute('allowfullscreen', '');
				ytIframe.setAttribute('allow', 'encrypted-media; picture-in-picture');
				iframeContainer.insertBefore(ytIframe, iframeContainer.firstChild);
				return ytIframe;
			}

			function destroyYouTubePlayer() {
				if (currentYoutubePlayer && typeof currentYoutubePlayer.destroy === 'function') {
					try {
						currentYoutubePlayer.destroy();
					} catch (_) { }
				}
				currentYoutubePlayer = null;
				const ytIframe = document.getElementById('ytPlayer');
				if (ytIframe) ytIframe.remove();
			}

			async function ensureYouTubePlayer(startSeconds = 0) {
				const ytIframe = document.getElementById('ytPlayer');
				if (!ytIframe) return null;
				const yt = await loadYouTubeIframeApi();

				if (!currentYoutubePlayer) {
					currentYoutubePlayer = new yt.Player('ytPlayer');
				}

				const start = Math.max(0, Math.floor(Number(startSeconds) || 0));
				if (start > 0 && typeof currentYoutubePlayer.cueVideoById === 'function' && window.currentYoutubeId) {
					currentYoutubePlayer.cueVideoById({
						videoId: window.currentYoutubeId,
						startSeconds: start
					});
				}
				return currentYoutubePlayer;
			}

			async function getCurrentPlaybackTimeSec() {
				if (window.currentYoutubeId && currentYoutubePlayer && typeof currentYoutubePlayer.getCurrentTime === 'function') {
					try {
						return Math.max(0, Math.floor(Number(currentYoutubePlayer.getCurrentTime()) || 0));
					} catch (_) { }
				}
				return Math.max(0, Math.floor(Number(videoElement.currentTime) || 0));
			}

			function getPlaybackModeState() {
				if (INITIAL_PLAYBACK_MODE && typeof INITIAL_PLAYBACK_MODE === 'object') {
					return INITIAL_PLAYBACK_MODE;
				}
				return { mode: 'proxy', source: 'bootstrap_missing' };
			}

			function getInitialNoticeState() {
				if (INITIAL_NOTICE && typeof INITIAL_NOTICE === 'object') return INITIAL_NOTICE;
				return {
					hasNotice: false,
					title: '通知',
					content: '',
					showOnce: false,
					noticeId: ''
				};
			}

			function getNoticeIdentity(notice) {
				const noticeId = String(notice && notice.noticeId || '').trim();
				if (noticeId) return noticeId;
				return 'fallback:' + String(notice && notice.title || '') + '|' + String(notice && notice.content || '');
			}

			function getLocalDayKey() {
				const now = new Date();
				const year = now.getFullYear();
				const month = String(now.getMonth() + 1).padStart(2, '0');
				const day = String(now.getDate()).padStart(2, '0');
				return year + '-' + month + '-' + day;
			}

			function hasShownNoticeOnce(identity) {
				if (!identity) return false;
				try {
					return localStorage.getItem(NOTICE_LAST_ONCE_ID_KEY) === identity;
				} catch (_) {
					return false;
				}
			}

			function hasShownNoticeToday(identity) {
				if (!identity) return false;
				try {
					return localStorage.getItem(NOTICE_LAST_DAILY_ID_KEY) === identity
						&& localStorage.getItem(NOTICE_LAST_DAILY_DAY_KEY) === getLocalDayKey();
				} catch (_) {
					return false;
				}
			}

			function isNoticeDisabled(identity) {
				if (!identity) return false;
				try {
					return localStorage.getItem(NOTICE_DISABLED_ID_KEY) === identity;
				} catch (_) {
					return false;
				}
			}

			function markNoticeShown(notice, identity) {
				if (!identity) return;
				try {
					localStorage.setItem(NOTICE_LAST_DAILY_ID_KEY, identity);
					localStorage.setItem(NOTICE_LAST_DAILY_DAY_KEY, getLocalDayKey());
					if (notice && notice.showOnce) localStorage.setItem(NOTICE_LAST_ONCE_ID_KEY, identity);
				} catch (_) { }
			}

			function disableNotice(identity) {
				if (!identity) return;
				try {
					localStorage.setItem(NOTICE_DISABLED_ID_KEY, identity);
				} catch (_) { }
			}

			function isSafeNoticeUrl(value, tagName) {
				const raw = String(value || '').trim();
				if (!raw) return false;
				try {
					const parsed = new URL(raw, location.href);
					if (tagName === 'img') return parsed.protocol === 'https:' || parsed.protocol === 'http:';
					return parsed.protocol === 'https:' || parsed.protocol === 'http:'
						|| parsed.protocol === 'mailto:' || parsed.protocol === 'tel:';
				} catch (_) {
					return false;
				}
			}

			function sanitizeNoticeNumericAttribute(element, attributeName, maxValue = 4096) {
				if (!element.hasAttribute(attributeName)) return;
				const raw = element.getAttribute(attributeName) || '';
				const value = Number.parseInt(raw, 10);
				if (!/^\d+$/.test(raw) || !Number.isFinite(value) || value < 1 || value > maxValue) {
					element.removeAttribute(attributeName);
				}
			}

			function sanitizeNoticeTree(parent) {
				for (const node of Array.from(parent.childNodes || [])) {
					if (node.nodeType === Node.COMMENT_NODE) {
						node.remove();
						continue;
					}
					if (node.nodeType !== Node.ELEMENT_NODE) continue;

					const tagName = String(node.tagName || '').toLowerCase();
					if (NOTICE_DROP_CONTENT_TAGS.has(tagName)) {
						node.remove();
						continue;
					}
					if (!NOTICE_ALLOWED_TAGS.has(tagName)) {
						sanitizeNoticeTree(node);
						node.replaceWith(...Array.from(node.childNodes));
						continue;
					}

					const allowedAttributes = NOTICE_ALLOWED_ATTRIBUTES[tagName] || new Set();
					for (const attribute of Array.from(node.attributes || [])) {
						if (!allowedAttributes.has(attribute.name.toLowerCase())) {
							node.removeAttribute(attribute.name);
						}
					}

					if (tagName === 'a') {
						if (!isSafeNoticeUrl(node.getAttribute('href'), tagName)) node.removeAttribute('href');
						const target = String(node.getAttribute('target') || '').toLowerCase();
						if (target && target !== '_blank' && target !== '_self') node.removeAttribute('target');
						if (node.getAttribute('target') === '_blank') node.setAttribute('rel', 'noopener noreferrer nofollow');
					}
					if (tagName === 'img') {
						if (!isSafeNoticeUrl(node.getAttribute('src'), tagName)) {
							node.remove();
							continue;
						}
						sanitizeNoticeNumericAttribute(node, 'width');
						sanitizeNoticeNumericAttribute(node, 'height');
						node.setAttribute('loading', 'lazy');
						node.setAttribute('decoding', 'async');
						node.setAttribute('referrerpolicy', 'no-referrer');
						node.style.maxWidth = '100%';
						node.style.height = 'auto';
						node.style.borderRadius = '8px';
					}
					if (tagName === 'ol') sanitizeNoticeNumericAttribute(node, 'start', 1000000);
					if (tagName === 'li') sanitizeNoticeNumericAttribute(node, 'value', 1000000);
					if (tagName === 'th' || tagName === 'td') {
						sanitizeNoticeNumericAttribute(node, 'colspan', 100);
						sanitizeNoticeNumericAttribute(node, 'rowspan', 100);
					}
					sanitizeNoticeTree(node);
				}
			}

			function createNoticeContentNode(content) {
				const wrapper = document.createElement('div');
				wrapper.style.textAlign = 'left';
				wrapper.style.lineHeight = '1.7';
				wrapper.style.wordBreak = 'break-word';
				const template = document.createElement('template');
				template.innerHTML = String(content || '');
				sanitizeNoticeTree(template.content);
				wrapper.style.whiteSpace = template.content.querySelector('*') ? 'normal' : 'pre-wrap';
				wrapper.appendChild(template.content);
				return wrapper;
			}

			function showInitialNoticeIfNeeded(retryCount = 0) {
				const notice = getInitialNoticeState();
				if (!notice || !notice.hasNotice) return;

				const identity = getNoticeIdentity(notice);
				if (isNoticeDisabled(identity)) return;
				if (notice.showOnce && hasShownNoticeOnce(identity)) return;
				if (hasShownNoticeToday(identity)) return;

				if (document.querySelector('.swal-overlay--show-modal')) {
					if (retryCount < 20) setTimeout(() => showInitialNoticeIfNeeded(retryCount + 1), 500);
					return;
				}

				swal({
					title: String(notice.title || '通知'),
					content: createNoticeContentNode(notice.content),
					buttons: {
						disable: {
							text: '不再提示',
							value: 'disable'
						},
						confirm: {
							text: '知道了',
							value: 'ok'
						}
					}
				}).then(action => {
					if (action === 'disable') disableNotice(identity);
					markNoticeShown(notice, identity);
				});
			}

			function isDirectPlaybackModeEnabled() {
				return getPlaybackModeState().mode === 'direct';
			}

			function buildPlaybackResourceUrl(videoUrl) {
				return isDirectPlaybackModeEnabled() ? videoUrl : ('/view?url=' + encodeURIComponent(videoUrl));
			}

			function buildDownloadResourceUrl(videoUrl) {
				return videoUrl ? ('/view?url=' + encodeURIComponent(videoUrl)) : '';
			}

			function notifyPlaybackModeIfNeeded(retryCount = 0) {
				const modeState = getPlaybackModeState();
				if (!modeState || modeState.mode !== 'direct' || !modeState.notice) return;
				const noticeKey = 'playbackModeNoticeShown:' + String(modeState.checkedAt || '').slice(0, 10);
				try {
					if (sessionStorage.getItem(noticeKey) === '1') return;
				} catch (_) { }

				setTimeout(() => {
					if (document.querySelector('.swal-overlay--show-modal')) {
						if (retryCount < 20) setTimeout(() => notifyPlaybackModeIfNeeded(retryCount + 1), 500);
						return;
					}
					try {
						sessionStorage.setItem(noticeKey, '1');
					} catch (_) { }
					const hasNewSiteUrl = typeof modeState.newSiteUrl === 'string' && !!modeState.newSiteUrl.trim();
					swal({
						title: '已自动切换播放模式',
						text: modeState.notice,
						icon: 'info',
						buttons: hasNewSiteUrl ? {
							cancel: { text: '留在本页', value: 'stay', visible: true },
							confirm: { text: '访问备用站点', value: 'visit' }
						} : {
							confirm: { text: '知道了', value: 'ok' }
						}
					}).then(action => {
						if (action === 'visit' && hasNewSiteUrl) window.location.href = modeState.newSiteUrl;
					});
				}, retryCount === 0 ? 600 : 0);
			}

			function applyPresenceCount(count) {
				if (!onlineCountValue) return;
				if (Number.isFinite(count) && count >= 0) {
					onlineCountValue.textContent = String(Math.max(0, Math.floor(count)));
					presenceLastCountAt = Date.now();
					setPresenceStatus('online');
					return;
				}
				onlineCountValue.textContent = '--';
			}

			function clearPresenceReconnectTimer() {
				if (!presenceReconnectTimer) return;
				clearTimeout(presenceReconnectTimer);
				presenceReconnectTimer = 0;
			}

			function schedulePresenceReconnect() {
				if (presenceClosedByClient || presenceReconnectTimer) return;
				const delay = Math.min(ONLINE_RECONNECT_MIN_DELAY_MS * Math.pow(1.8, presenceReconnectAttempts), ONLINE_RECONNECT_MAX_DELAY_MS);
				presenceReconnectAttempts += 1;
				presenceReconnectTimer = setTimeout(() => {
					presenceReconnectTimer = 0;
					connectSitePresence();
				}, delay);
			}

			function handlePresenceMessage(rawValue) {
				let data;
				try {
					data = JSON.parse(String(rawValue || ''));
				} catch (_) {
					return;
				}

				if (data && data.type === 'site_online_count') {
					applyPresenceCount(Number(data.online));
				}
			}

			function clearPresenceActivationTimer() {
				if (!presenceActivationTimer) return;
				clearTimeout(presenceActivationTimer);
				presenceActivationTimer = 0;
			}

			function handlePresenceActivationTrigger() {
				activateSitePresence();
			}

			function removePresenceActivationListeners() {
				if (!presenceActivationEventsBound) return;
				presenceActivationEventsBound = false;
				for (const eventName of PRESENCE_ACTIVATION_EVENTS) {
					window.removeEventListener(eventName, handlePresenceActivationTrigger);
				}
			}

			function bindPresenceActivationEvents() {
				if (!ONLINE_PRESENCE_ENABLED || presenceActivationEventsBound || !onlinePresenceCard) return;
				presenceActivationEventsBound = true;
				for (const eventName of PRESENCE_ACTIVATION_EVENTS) {
					window.addEventListener(eventName, handlePresenceActivationTrigger, { passive: true });
				}
			}

			function activateSitePresence() {
				if (!ONLINE_PRESENCE_ENABLED) return;
				clearPresenceActivationTimer();
				if (document.visibilityState === 'hidden') {
					bindPresenceActivationEvents();
					return;
				}
				presenceActivated = true;
				removePresenceActivationListeners();
				connectSitePresence();
			}

			function scheduleLazyPresenceConnect() {
				if (!ONLINE_PRESENCE_ENABLED || !onlinePresenceCard || presenceActivated) return;
				setPresenceVisibility(true);
				bindPresenceActivationEvents();
				if (presenceActivationTimer) return;
				presenceActivationTimer = setTimeout(() => {
					presenceActivationTimer = 0;
					activateSitePresence();
				}, ONLINE_LAZY_CONNECT_DELAY_MS);
			}

			function connectSitePresence() {
				if (!ONLINE_PRESENCE_ENABLED || !onlinePresenceCard) return;
				if (!('WebSocket' in window)) {
					setPresenceStatus('error');
					return;
				}
				if (location.protocol !== 'http:' && location.protocol !== 'https:') {
					setPresenceStatus('error');
					return;
				}
				if (presenceSocket && (presenceSocket.readyState === WebSocket.OPEN || presenceSocket.readyState === WebSocket.CONNECTING)) {
					return;
				}

				clearPresenceReconnectTimer();
				presenceClosedByClient = false;
				setPresenceStatus('pending');

				const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
				const wsUrl = wsScheme + '//' + location.host + ONLINE_WS_PATH + '?sid=' + encodeURIComponent(presenceSessionId);
				const ws = new WebSocket(wsUrl);
				presenceSocket = ws;

				ws.addEventListener('open', () => {
					presenceReconnectAttempts = 0;
					if (Date.now() - presenceLastCountAt > ONLINE_STALE_AFTER_MS) {
						setPresenceStatus('pending');
					} else {
						setPresenceStatus('online');
					}
				});

				ws.addEventListener('message', (event) => {
					handlePresenceMessage(event.data);
				});

				ws.addEventListener('error', () => {
					setPresenceStatus('error');
				});

				ws.addEventListener('close', () => {
					if (presenceSocket === ws) presenceSocket = null;
					if (presenceClosedByClient) return;

					if (Date.now() - presenceLastCountAt <= ONLINE_STALE_AFTER_MS) {
						setPresenceStatus('pending');
					} else {
						applyPresenceCount(NaN);
						setPresenceStatus('error');
					}
					schedulePresenceReconnect();
				});
			}

			function disconnectSitePresence() {
				presenceClosedByClient = true;
				clearPresenceActivationTimer();
				clearPresenceReconnectTimer();
				if (!presenceSocket) return;
				try {
					presenceSocket.close(1000, 'page closing');
				} catch (_) { }
				presenceSocket = null;
			}

			const SENSITIVE_TAG_MAP = {
				qos: '\u5a9a\u9ed1\u5185\u5bb9',
				ntr: '\u725b\u5934\u4eba\u5185\u5bb9',
				netorare: '\u542b NTR \u5185\u5bb9',
				slut: '\u8361\u5987\u5411\u5185\u5bb9',
				asphyxiation: '\u7a92\u606f\u73a9\u6cd5\u5185\u5bb9',
				face_fuck: '\u7c97\u66b4\u53e3\u4ea4\u5185\u5bb9',
				r18g: '\u91cd\u53e3\u5411\u5185\u5bb9',
				monster: '\u602a\u7269\u5185\u5bb9',
				monster_cock: '\u602a\u7269\u9634\u830e',
				hilichurl: '\u4e18\u4e18\u4eba/\u602a\u7269\u5185\u5bb9',
				huge_penis: '\u5de8\u5927\u9634\u830e\u5185\u5bb9',
				bbc: '\u5f3a\u8c03\u9ed1\u4eba\u5927\u9634\u830e\u7684\u6027\u5185\u5bb9',
				big_balls: '\u5de8\u5927\u776a\u4e38\u5185\u5bb9',
				'3p': '\u591a\u4eba\u6027\u884c\u4e3a\u5185\u5bb9'
			};
			const SENSITIVE_TAG_IDS = new Set(Object.keys(SENSITIVE_TAG_MAP));

			function formatSensitiveTagLabel(tagId) {
				const desc = SENSITIVE_TAG_MAP[tagId];
				return desc ? (tagId + '（' + desc + '）') : tagId;
			}

			function detectSensitiveContent(data) {
				const title = String(data && data.title || '');
				const titleLower = title.toLowerCase();
				const titleHits = [];
				for (const tagId of SENSITIVE_TAG_IDS) {
					if (titleLower.includes(tagId)) titleHits.push(tagId);
				}

				const tagHits = [];
				if (Array.isArray(data && data.tags)) {
					for (const tag of data.tags) {
						const tagId = String(tag && tag.id || '').toLowerCase();
						if (tagId && SENSITIVE_TAG_IDS.has(tagId) && !tagHits.includes(tagId)) {
							tagHits.push(tagId);
						}
					}
				}

				return {
					matched: titleHits.length > 0 || tagHits.length > 0,
					titleHits,
					tagHits
				};
			}
			function normalizeSiteType(rawType) {
				return String(rawType || '').toLowerCase() === 'ai' ? 'ai' : 'tv';
			}

			function getCurrentSiteType() {
				return normalizeSiteType(selectSite && selectSite.value);
			}

			function getCurrentSiteHost() {
				return getCurrentSiteType() === 'ai' ? 'www.iwara.ai' : 'www.iwara.tv';
			}

			function applySiteType(siteType) {
				if (!selectSite) return;
				selectSite.value = normalizeSiteType(siteType);
			}

			function getSiteStoragePrefix() {
				return getCurrentSiteType() === 'ai' ? 'ai_' : 'tv_';
			}

			function getSiteHostByType(siteType) {
				return normalizeSiteType(siteType) === 'ai' ? 'www.iwara.ai' : 'www.iwara.tv';
			}

			function normalizeFavoriteEntry(entry) {
				if (typeof entry === 'string') {
					return { name: entry, type: 'tv' };
				}
				if (Array.isArray(entry)) {
					return {
						name: String(entry[0] || ''),
						type: normalizeSiteType(entry[1])
					};
				}
				if (entry && typeof entry === 'object') {
					return {
						name: String(entry.name || ''),
						type: normalizeSiteType(entry.type)
					};
				}
				return null;
			}

			function normalizeFavoritesData(raw) {
				const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
				const out = {};
				for (const [id, entry] of Object.entries(source)) {
					const normalized = normalizeFavoriteEntry(entry);
					if (!normalized) continue;
					if (!normalized.name) continue;
					out[id] = normalized;
				}
				return out;
			}

			function loadAndUpgradeFavorites() {
				const raw = localStorage.getItem('save');
				if (!raw) return {};
				try {
					const parsed = JSON.parse(raw);
					const normalized = normalizeFavoritesData(parsed);
					if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
						localStorage.setItem('save', JSON.stringify(normalized));
					}
					return normalized;
				} catch {
					localStorage.setItem('save', JSON.stringify({}));
					return {};
				}
			}
			const fetchJson = async (url, options = {}) => {
				const res = await fetch(url, options);
				const data = await res.json();
				if (!res.ok) {
					const errorsInfo = {
						"errors.notFound": "该视频未找到或者该视频需填写令牌才能观看!",
						"errors.privateVideo": "该视频被作者设置为私人视频，无法播放!"
					};
					throw errorsInfo[data.message] || '获取视频信息失败';
				}
				return data;
			};
			loadAndUpgradeFavorites();

			// 弹窗提示用户遵守法规
			// 判断是否应该显示提示（24小时内不重复提示）
			const promptLastDismissed = localStorage.getItem('promptLastDismissed');
			const shouldShowPrompt = !isIntroPromptDisabled() && (!promptLastDismissed || (Date.now() - parseInt(promptLastDismissed, 10) > 24 * 60 * 60 * 1000));

			if (shouldShowPrompt) {
				// 弹窗提示用户遵守法规
				swal({
					title: '温馨提示',
					text: '本网站免费提供 I站 (Iwara) 视频播放和下载服务！请遵守当地法律法规。若您能访问 I站，请到官网观看更多精彩内容！是否跳转 I站官网？',
					buttons: {
						cancel: {
							text: "暂不跳转",
							value: false,
							visible: true
						},
						disable: {
							text: "不再提示",
							value: 'disable'
						},
						confirm: {
							text: "跳转 I站",
							value: true
						}
					}
				}).then(goToIwara => {
					videoElement.pause();
					if (goToIwara === 'disable') {
						disableIntroPrompt();
						localStorage.setItem('promptLastDismissed', Date.now().toString());
					} else if (goToIwara) {
						const shareId = new URL(location.href).searchParams.get('id');
						const siteHost = getCurrentSiteHost();
						location.replace(shareId ? ('https://' + siteHost + '/video/' + shareId) : ('https://' + siteHost));
					} else {
						// 用户选择暂不跳转，记录当前时间戳
						localStorage.setItem('promptLastDismissed', Date.now().toString());
					}
				});
			}

			// 页面载入后激活动画效果，若 URL 带有 id 参数则自动播放

			let clipboardAutoAttempted = false;
			let clipboardGestureAttempted = false;
			let clipboardPromptHandled = false;
			let clipboardReadInFlight = false;
			let clipboardFocusRetryUsed = false;
			let clipboardAutoHintShown = false;
			let clipboardGestureHintShown = false;
			let lastClipboardPromptedId = '';
			let lastClipboardPromptedAt = 0;
			const CLIPBOARD_PROMPT_DEDUPE_MS = 3500;
			const CLIPBOARD_DEBUG_ENABLED = new URLSearchParams(location.search).get('clipdebug') === '1' || localStorage.getItem('clipboard_debug_v1') === '1';
			function clipboardLog(){
				if (!CLIPBOARD_DEBUG_ENABLED) return;
				try { console.log.apply(console, ['[clipboard]'].concat(Array.from(arguments))); } catch (_) {}
			}

			function showClipboardRestrictionHintOnce(message, kind = 'auto') {
				if (kind === 'gesture') {
					if (clipboardGestureHintShown) return;
					clipboardGestureHintShown = true;
				} else {
					if (clipboardAutoHintShown) return;
					clipboardAutoHintShown = true;
				}
				showClipboardSoftTip(message || '浏览器限制自动读取剪切板，请点击页面任意位置后重试；也可以手动粘贴视频链接。');
			}

			async function getClipboardReadPermissionState() {
				// clipboard-read 权限查询只在部分 Chromium 浏览器可用；Safari / Firefox 通常不支持。
				// Permissions API 没有通用的 permissions.request()，实际授权由 readText() 触发。
				if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return 'unsupported';
				try {
					const status = await navigator.permissions.query({ name: 'clipboard-read' });
					return status && status.state ? status.state : 'unknown';
				} catch (_) {
					return 'unsupported';
				}
			}

			function showClipboardSoftTip(message) {
				if (!message) return;
				let tip = document.getElementById('clipboardSoftTip');
				if (!tip) {
					tip = document.createElement('div');
					tip.id = 'clipboardSoftTip';
					tip.className = 'clipboard-soft-tip';
					document.body.appendChild(tip);
				}
				tip.textContent = message;
				tip.classList.remove('show');
				void tip.offsetWidth;
				tip.classList.add('show');
				clearTimeout(showClipboardSoftTip._timer);
				showClipboardSoftTip._timer = setTimeout(() => {
					tip.classList.remove('show');
				}, 2600);
			}

			function isClipboardAutoplaySuppressed() {
				return !!(iframeContainer && iframeContainer.style.display === 'flex');
			}

			function extractIwaraVideoInfoFromText(text) {
				const raw = String(text || '').trim();
				if (!raw) return null;
				let parsedUrl;
				try {
					parsedUrl = new URL(raw);
				} catch {
					return null;
				}
				const protocol = String(parsedUrl.protocol || '').toLowerCase();
				if (protocol !== 'http:' && protocol !== 'https:') return null;
				const hostname = String(parsedUrl.hostname || '').toLowerCase();
				let siteType = null;
				if (hostname === 'www.iwara.tv') siteType = 'tv';
				if (hostname === 'www.iwara.ai') siteType = 'ai';
				if (!siteType) return null;
				const parts = String(parsedUrl.pathname || '').split('/').filter(Boolean);
				if (parts.length < 2 || parts[0].toLowerCase() !== 'video') return null;
				const id = parts[1];
				if (!/^[0-9A-Za-z]{9,}$/.test(id)) return null;
				return { id, url: parsedUrl.toString(), type: siteType };
			}

			function getCurrentInputVideoId() {
				const raw = String(inputVideo && inputVideo.value || '').trim();
				if (!raw) return '';
				const info = extractIwaraVideoInfoFromText(raw);
				if (info && info.id) return info.id;
				return /^[0-9A-Za-z]{9,}$/.test(raw) ? raw : '';
			}


			async function promptQualityBeforePlay() {
				const qualitySelect = document.createElement('select');
				qualitySelect.style.width = '100%';
				qualitySelect.style.padding = '8px';
				qualitySelect.style.borderRadius = '8px';
				qualitySelect.style.border = '1px solid #ccc';
				qualitySelect.style.background = '#fff';

				[
					{ value: '360', label: '360P' },
					{ value: '540', label: '540P' },
					{ value: 'Source', label: '原视频' }
				].forEach(item => {
					const opt = document.createElement('option');
					opt.value = item.value;
					opt.textContent = item.label;
					qualitySelect.appendChild(opt);
				});

				qualitySelect.value = selectQuality.value || '540';

				const confirmed = await swal({
					title: '选择清晰度',
					text: '请选择视频播放清晰度',
					content: qualitySelect,
					buttons: {
						cancel: { text: '取消', value: false, visible: true },
						confirm: { text: '确认播放', value: true }
					}
				});

				if (!confirmed) return null;
				return qualitySelect.value || selectQuality.value || '540';
			}

			function getQualityLabel(quality) {
				const normalized = String(quality || '');
				if (normalized === 'Source') return '原视频';
				if (normalized === '540') return '540P';
				if (normalized === '360') return '360P';
				return normalized || '当前选择';
			}

			function getAvailableQualityValues(list) {
				const values = [];
				for (const item of Array.isArray(list) ? list : []) {
					const value = String(item && item.name || '').trim();
					const viewUrl = item && item.src && item.src.view;
					if (!value || !viewUrl || values.includes(value)) continue;
					values.push(value);
				}
				return values;
			}

			function getPreferredQualityFallbacks(requestedQuality) {
				if (requestedQuality === 'Source') return ['540', '360'];
				if (requestedQuality === '540') return ['360', 'Source'];
				if (requestedQuality === '360') return ['540', 'Source'];
				return ['540', '360', 'Source'];
			}

			function pickBestAvailableQuality(requestedQuality, availableValues) {
				const values = Array.isArray(availableValues) ? availableValues : [];
				if (values.includes(requestedQuality)) return requestedQuality;
				for (const candidate of getPreferredQualityFallbacks(requestedQuality)) {
					if (values.includes(candidate)) return candidate;
				}
				return values[0] || '';
			}

			async function promptQualityForUnavailableSelection(requestedQuality, availableValues) {
				const values = Array.isArray(availableValues) ? availableValues : [];
				if (!values.length) return null;

				const qualitySelect = document.createElement('select');
				qualitySelect.style.width = '100%';
				qualitySelect.style.padding = '8px';
				qualitySelect.style.borderRadius = '8px';
				qualitySelect.style.border = '1px solid #ccc';
				qualitySelect.style.background = '#fff';

				values.forEach(value => {
					const opt = document.createElement('option');
					opt.value = value;
					opt.textContent = getQualityLabel(value);
					qualitySelect.appendChild(opt);
				});

				qualitySelect.value = pickBestAvailableQuality(requestedQuality, values) || values[0];

				const confirmed = await swal({
					title: '清晰度提示',
					text: '当前视频清晰度没有' + getQualityLabel(requestedQuality) + '，请选择视频播放的清晰度！',
					content: qualitySelect,
					buttons: {
						cancel: { text: '取消', value: false, visible: true },
						confirm: { text: '确认播放', value: true }
					}
				});

				if (!confirmed) return null;
				return qualitySelect.value || null;
			}
			async function promptPlayDetectedIwaraLink(info) {
				if (!info || clipboardPromptHandled) return;
				const now = Date.now();
				if (info.id === lastClipboardPromptedId && now - lastClipboardPromptedAt < CLIPBOARD_PROMPT_DEDUPE_MS) {
					clipboardLog('同一剪切板链接短时间内已提示，跳过重复弹窗！', info.id);
					clipboardPromptHandled = true;
					return;
				}
				lastClipboardPromptedId = info.id;
				lastClipboardPromptedAt = now;
				clipboardPromptHandled = true;
				const shouldPlay = await swal({
					title: '播放提示',
					text: '检测到剪切板中存在 Iwara 网站视频链接：' + info.url + '。是否需要播放？',
					buttons: {
						cancel: { text: "不播放", value: false, visible: true },
						confirm: { text: "播放", value: true }
					}
				});
				if (!shouldPlay) return;
				const selectedQuality = await promptQualityBeforePlay();
				if (!selectedQuality) return;
				selectQuality.value = selectedQuality;
				applySiteType(info.type);
				setVideoInputValue(info.id);
				playVideoById();
			}

			function isClipboardReadAvailable() {
				return !!(window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.readText === 'function');
			}

			async function autoPlayClipboardIwaraLink(fromUserGesture = false, forceAutoRetry = false) {
				clipboardLog('剪切板读取开始', 'fromUserGesture=', fromUserGesture, 'force=', forceAutoRetry, 'handled=', clipboardPromptHandled);
				if (isClipboardAutoplaySuppressed()) {
					clipboardLog('当前播放器活跃，跳过剪切板检测！');
					return;
				}
				if (clipboardPromptHandled || clipboardReadInFlight) return;
				if (!isClipboardReadAvailable()) {
					clipboardLog('剪切板读取 API 不可用！', 'secure=', window.isSecureContext, 'hasClipboard=', !!navigator.clipboard);
					if (fromUserGesture) showClipboardRestrictionHintOnce('当前浏览器或 APP 未开放剪切板读取能力，请手动粘贴 Iwara 视频链接。', 'gesture');
					return;
				}
				if (fromUserGesture) {
					if (clipboardGestureAttempted) return;
					clipboardGestureAttempted = true;
				} else {
					if (clipboardAutoAttempted && !forceAutoRetry) return;
					clipboardAutoAttempted = true;
				}

				clipboardReadInFlight = true;
				try {
					// 必须在真实用户手势事件的同步调用栈中直接调用 readText，
					// 不要先 await 权限查询，否则 Firefox / Safari 可能丢失 transient activation。
					const readPromise = navigator.clipboard.readText();
					const clipboardText = String(await readPromise || '').trim();
					clipboardLog('剪切板读取成功，文本长度：', clipboardText.length);
					const info = extractIwaraVideoInfoFromText(clipboardText);
					if (!info) {
						clipboardLog('剪切板中没有可识别的 Iwara 视频链接！');
						return;
					}
					const currentInputVideoId = getCurrentInputVideoId();
					if (currentInputVideoId && currentInputVideoId === info.id) {
						clipboardLog('剪切板视频 ID 与输入框一致，跳过提示！', info.id);
						return;
					}
					await promptPlayDetectedIwaraLink(info);
				} catch (err) {
					clipboardLog('剪切板读取失败！', err && (err.name + ': ' + err.message));
					const errName = String(err && err.name || '').toLowerCase();
					const errMsg = String(err && err.message || '').toLowerCase();
					const denied = errName === 'notallowederror' || errMsg.indexOf('not focused') >= 0 || errMsg.indexOf('permission') >= 0 || errMsg.indexOf('denied') >= 0;
					if (!fromUserGesture && errMsg.indexOf('not focused') >= 0) {
						clipboardAutoAttempted = false;
						clipboardLog('页面可见但尚未获得焦点，等待 window.focus 补充重试！');
						if (!clipboardFocusRetryUsed) {
							clipboardFocusRetryUsed = true;
							setTimeout(() => {
								if (document.visibilityState === 'visible' && !isClipboardAutoplaySuppressed() && !clipboardReadInFlight && !clipboardPromptHandled && !clipboardAutoAttempted) {
									void autoPlayClipboardIwaraLink(false, true);
								}
							}, 160);
						}
					}
					if (denied && !clipboardPromptHandled) {
						// 权限状态仅用于诊断/提示；异步查询不阻塞 finally，也不放在 readText() 之前，
						// 避免错过随后到达的 window.focus 自动补读，以及丢失用户激活状态。
						void getClipboardReadPermissionState().then(permissionState => {
							clipboardLog('clipboard-read 权限状态：', permissionState);
							if (clipboardReadInFlight || clipboardPromptHandled) return;
							if (permissionState === 'denied') {
								showClipboardRestrictionHintOnce('剪切板权限当前处于拒绝状态。请在浏览器/APP的网站设置中将“剪切板”改为允许，或手动粘贴视频链接。', fromUserGesture ? 'gesture' : 'auto');
							} else if (fromUserGesture) {
								showClipboardRestrictionHintOnce('浏览器未允许读取剪切板。请按浏览器提示选择“粘贴/允许”，或检查网站剪切板权限；也可以手动粘贴链接。', 'gesture');
							} else {
								showClipboardRestrictionHintOnce('浏览器可能限制后台自动读取剪切板；请点击页面任意位置后重试，或手动粘贴视频链接。', 'auto');
							}
						});
					}
				} finally {
					clipboardReadInFlight = false;
				}
			}

			let clipboardGestureProbeActive = false;
			let clipboardEntryCycleActive = false;

			function triggerClipboardCheckOnEntry(_reason = 'entry') {
				clipboardLog('页面重新进入前台', _reason, 'visibility=', document.visibilityState);
				if (document.visibilityState === 'hidden' || isClipboardAutoplaySuppressed()) return;
				if (!clipboardEntryCycleActive) {
					clipboardEntryCycleActive = true;
					clipboardAutoAttempted = false;
					clipboardGestureAttempted = false;
					clipboardFocusRetryUsed = false;
					clipboardPromptHandled = false;
					bindClipboardGestureProbe();
				} else {
					clipboardLog('同一次前台切换事件已处理，检查是否需要补一次焦点重试！');
				}
				// visibilitychange 有时先于 window.focus；若首次读取因页面尚未真正获得焦点而失败，
				// catch 会复位 clipboardAutoAttempted，让后续 focus 事件补做一次自动读取。
				if (!clipboardAutoAttempted && !clipboardReadInFlight && !clipboardPromptHandled) {
					void autoPlayClipboardIwaraLink(false, true);
				}
			}

			function bindClipboardGestureProbe() {
				if (clipboardGestureProbeActive) return;
				clipboardGestureProbeActive = true;
				const cleanup = () => {
					document.removeEventListener('pointerdown', onPointerDown, true);
					document.removeEventListener('pointerup', onPointerUp, true);
					document.removeEventListener('click', onClick, true);
					clipboardGestureProbeActive = false;
				};
				const tryFromGesture = (event) => {
					const target = event && event.target;
					if (target && typeof target.closest === 'function' && target.closest('#clearVideoInput')) return;
					if (event && event.type === 'pointerdown' && event.pointerType !== 'mouse') return;
					if (event && event.type === 'pointerup' && event.pointerType === 'mouse') return;
					// 自动读取尚未结束时不消费本次手势，保留监听，等待下一次真实手势重试。
					if (clipboardReadInFlight) return;
					cleanup();
					clipboardLog('真实用户手势触发剪切板重试！', event && event.type);
					void autoPlayClipboardIwaraLink(true);
				};
				function onPointerDown(event) { tryFromGesture(event); }
				function onPointerUp(event) { tryFromGesture(event); }
				function onClick(event) { tryFromGesture(event); }
				document.addEventListener('pointerdown', onPointerDown, true);
				document.addEventListener('pointerup', onPointerUp, true);
				document.addEventListener('click', onClick, true);
			}

			function bindClipboardFallbackEvents() {
				// 只在输入框的真实点击事件中兜底；不在 focus 事件读取，
				// 避免移动端 touchstart 阶段先触发 focus、消耗掉 touchend 的用户激活。
				inputVideo.addEventListener('click', () => void autoPlayClipboardIwaraLink(true), { passive: true });
			}

			document.addEventListener('DOMContentLoaded', () => {
				setTimeout(() => document.querySelector('.wrap').classList.add('on'), 100);
				scheduleLazyPresenceConnect();
				notifyPlaybackModeIfNeeded();
				setTimeout(() => {
					showInitialNoticeIfNeeded();
				}, 900);
				setTimeout(() => {
					const hasValidLocalToken = checkStoredTokenStatusOnLoad();
					void checkBackendTokenStatusOnLoad(hasValidLocalToken, INITIAL_BACKEND_TOKEN_STATUS);
				}, 1200);

				const idParam = new URLSearchParams(location.search).get('id');
				const qualityParam = new URLSearchParams(location.search).get('quality');
				const typeParam = new URLSearchParams(location.search).get('type');
				const tParam = new URLSearchParams(location.search).get('t');
				applySiteType(typeParam);
				if (idParam) {
					setVideoInputValue(idParam);
					selectQuality.value = qualityParam || selectQuality.value;
					pendingStartTimeSec = parseStartTimeSec(tParam);
					playVideoById();
				} else {
					setTimeout(() => {
						triggerClipboardCheckOnEntry('initial-load');
						bindClipboardFallbackEvents();
					}, 300);
				}
			});

			window.addEventListener('pageshow', (evt) => {
				if (ONLINE_PRESENCE_ENABLED && presenceClosedByClient) {
					if (presenceActivated) connectSitePresence();
					else scheduleLazyPresenceConnect();
				}
				if (evt && evt.persisted) {
					triggerClipboardCheckOnEntry('pageshow-bfcache');
				}
			});

			window.addEventListener('pagehide', () => {
				disconnectSitePresence();
				clipboardEntryCycleActive = false;
			});

			window.addEventListener('blur', () => {
				// 浏览器标签页切换或切到其他桌面应用时，允许下一次回到页面触发检测。
				clipboardEntryCycleActive = false;
			});

			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'hidden') {
					clipboardEntryCycleActive = false;
					return;
				}
				if (document.visibilityState === 'visible') {
					triggerClipboardCheckOnEntry('visibilitychange-visible');
					if (ONLINE_PRESENCE_ENABLED && presenceActivated && presenceClosedByClient) {
						connectSitePresence();
					} else if (ONLINE_PRESENCE_ENABLED && !presenceActivated) {
						scheduleLazyPresenceConnect();
					}
				}
			});

			window.addEventListener('focus', () => {
				triggerClipboardCheckOnEntry('window-focus');
			});			function parseStartTimeSec(rawValue) {
				const sec = Number.parseInt(rawValue, 10);
				return Number.isFinite(sec) && sec > 0 ? sec : 0;
			}

			function getStartTimeForPlayback() {
				const sec = pendingStartTimeSec > 0 ? pendingStartTimeSec : 0;
				pendingStartTimeSec = 0;
				return sec;
			}
			let winHeight = window.innerHeight;
			window.addEventListener('orientationchange', () => {
				setTimeout(() => {
					winHeight = window.innerHeight;
				}, 300);
			});

			document.addEventListener('fullscreenchange', () => {
				if (!document.fullscreenElement) {
					setTimeout(() => {
						winHeight = window.innerHeight;
					}, 200);
				}
			});

			document.addEventListener('webkitfullscreenchange', () => {
				if (!document.webkitFullscreenElement) {
					setTimeout(() => {
						winHeight = window.innerHeight;
					}, 200);
				}
			});

			// 监听窗口大小变化
			
			let needsInputRecoveryAfterFullscreen = false;

			function markInputRecoveryAfterFullscreenExit() {
				needsInputRecoveryAfterFullscreen = true;
				setTimeout(() => {
					winHeight = window.innerHeight;
				}, 120);
			}

			function recoverInputIfNeededByUserGesture() {
				if (!needsInputRecoveryAfterFullscreen) return;
				needsInputRecoveryAfterFullscreen = false;
				try {
					if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) {
						document.activeElement.blur();
					}
				} catch (_) { }
				inputVideo.readOnly = true;
				inputVideo.readOnly = false;
				// Focus only on explicit user tap after fullscreen exit.
				inputVideo.focus({ preventScroll: true });
			}

			document.addEventListener('fullscreenchange', () => {
				if (!document.fullscreenElement) markInputRecoveryAfterFullscreenExit();
			});

			document.addEventListener('webkitfullscreenchange', () => {
				if (!document.webkitFullscreenElement) markInputRecoveryAfterFullscreenExit();
			});

			videoElement.addEventListener('webkitendfullscreen', markInputRecoveryAfterFullscreenExit);
			inputVideo.addEventListener('pointerup', recoverInputIfNeededByUserGesture, { passive: true });
			inputVideo.addEventListener('touchend', recoverInputIfNeededByUserGesture, { passive: true });
			window.addEventListener('resize', function () {
				var thisHeight = window.innerHeight;

				if (winHeight - thisHeight > 40) {
					// 键盘弹出
					document.querySelector('.footer').style.display = 'none';
				} else {
					// 键盘收起
					document.querySelector('.footer').style.display = 'block';
				}
			});

			// 仅在视频 ID 输入框中按回车时播放，避免 Token 等其他输入框误触发。
			document.addEventListener('keypress', event => {
				if (event.key === 'Enter' && event.target === inputVideo && !event.isComposing) {
					playVideoById();
				}
			});

			// 绑定按钮事件
			btnSubmit.addEventListener('click', playVideoById);
			btnHot.addEventListener('click', showRandomHotPrompt);
			btnOpenSave.addEventListener('click', () => openFavorites());
			btnShare.addEventListener('click', () => copyLinkToClipboard());
			btnShareMoment.addEventListener('click', () => copyMomentLinkToClipboard());
			btnToken.addEventListener('click', () => saveToken());
			btnCloseOverlay.addEventListener('click', () => {
				videoElement.pause();
				videoElement.currentTime = 0;
				iframeContainer.style.display = 'none';
				setPresenceVisibility(true);
				hideLoading();
				// 清除旧监听器（避免重复绑定）
				videoElement.onerror = null;
				document.querySelectorAll('.videoSource').forEach(src => src.onerror = null);

				// 清理 YouTube iframe并恢复界面状态
				destroyYouTubePlayer();
				window.currentYoutubeId = null;
				videoElement.style.display = '';
				btnDownload.style.display = '';
				btnChangeOrigin.style.display = '';
			});

			
			videoElement.addEventListener('loadeddata', hideLoading);
			videoElement.addEventListener('canplay', hideLoading);
			videoElement.addEventListener('error', hideLoading);

			// 输入框清空按钮：只清空输入内容，不触发剪切板读取或播放。
			syncVideoInputClearButton();
			clearVideoInputButton.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				setVideoInputValue('');
				inputVideo.focus({ preventScroll: true });
			});

			// 输入框 URL 转 ID 解析
			inputVideo.addEventListener('input', () => {
				syncVideoInputClearButton();
				const url = inputVideo.value;
				if (url.startsWith('https://www.iwara.tv/video/') || url.startsWith('https://www.iwara.ai/video/')) {
					const info = extractIwaraVideoInfoFromText(url);
					if (!info) return;
					const newId = info.id;
					setTimeout(() => {
						applySiteType(info.type);
						setVideoInputValue(newId);
					}, 200);
				}
			});

			// 切换视频播放源
			btnChangeOrigin.addEventListener('click', () => {
				// 如果是 YouTube 视频，已经隐藏了这个按钮，但为了安全起见保留判断逻辑可以直接 return
				if (window.currentYoutubeId) {
					return;
				}

				if (!currentVideoUrl || currentVideoUrl === 'undefined') {
					return swalAlert('暂未获取到视频播放链接!', 'error', false);
				}

				const obj = new URL(currentVideoUrl);
				const hostParts = obj.hostname.split('.');
				const currentPrefix = hostParts[0];

				const group1 = ['mikoto', 'hime'];
				const group2 = ['asta', 'acheron', 'firefly', 'hook', 'hanya', 'camellya', 'welt', 'bailu', 'topaz', 'sparkle', 'pela'];

				let availableOptions = [];
				if (group1.includes(currentPrefix)) {
					availableOptions = group1.filter(p => p !== currentPrefix);
				} else if (group2.includes(currentPrefix)) {
					availableOptions = group2.filter(p => p !== currentPrefix);
				} else {
					// Fallback if the prefix doesn't match known groups but follows the same pattern
					availableOptions = group2; // arbitrary default fallback
				}

				if (availableOptions.length === 0) {
					return swalAlert('没有可用的其他源！', 'error', false);
				}

				const selectBox = document.createElement("select");
				selectBox.className = "swal-content__input";
				selectBox.style.width = "100%";
				selectBox.style.padding = "10px";
				selectBox.style.marginTop = "15px";
				selectBox.style.borderRadius = "8px";

				availableOptions.forEach(opt => {
					const option = document.createElement("option");
					option.value = opt;
					option.text = opt;
					selectBox.appendChild(option);
				});

				swal({
					title: "切换播放源",
					text: "当前源: " + currentPrefix + "。请选择新的播放源：",
					content: selectBox,
					buttons: {
						cancel: {
							text: "取消",
							value: false,
							visible: true
						},
						confirm: {
							text: "确认",
							value: true
						}
					}
				}).then((isConfirm) => {
					if (!isConfirm) return;

					const selectedValue = selectBox.value;
					if (!selectedValue) return;

					hostParts[0] = selectedValue;
					obj.hostname = hostParts.join('.');
					currentVideoUrl = obj.toString();

					swalAlert('已切换到 ' + selectedValue + ' 服务器播放视频!', 'success', false);

					if (!isAllowedViewSourceUrl(currentVideoUrl)) {
						return swalAlert('播放链接不符合安全规则，已拦截！');
					}
					const finalUrl = buildPlaybackResourceUrl(currentVideoUrl);

					showLoading('正在准备播放器...');

					// 播放视频
					videoElement.pause();
					videoElement.currentTime = 0;
					iframeContainer.style.display = 'none';
					setPresenceVisibility(false);
					iframeContainer.style.display = 'flex';
					const videoSource = document.querySelector('.videoSource');
					videoSource.src = finalUrl + '#t=' + getStartTimeForPlayback(); // 设置 video 源链接
					videoElement.load(); // 加载视频
				});
			});

			// 收藏按钮（覆盖当前视频）
			btnSaveOverlay.addEventListener('click', () => {
				let data = loadAndUpgradeFavorites();
				data[currentPlayId] = { name: currentVideoName, type: getCurrentSiteType() };
				localStorage.setItem('save', JSON.stringify(data));
				swalAlert('收藏成功！', 'success', false);
			});

			// 下载当前视频
			btnDownload.addEventListener('click', () => {
				const downloadUrl = buildDownloadResourceUrl(currentVideoUrl);
				if (!downloadUrl) return;
				const a = document.createElement('a');
				a.href = downloadUrl;
				a.download = currentVideoName || 'video.mp4';
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
			});

			// 获取油管视频ID
			function getYouTubeId(embedUrl) {
				if (!embedUrl) return null;
				const s = embedUrl.replaceAll("&amp;", "&");

				let u;
				try { u = new URL(s); } catch { return null; }

				const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");

				if (host === "youtu.be") return u.pathname.split("/").filter(Boolean)[0] || null;

				if (host === "youtube.com") {
					if (u.pathname === "/watch") return u.searchParams.get("v");
					const parts = u.pathname.split("/").filter(Boolean);
					if (parts[0] === "embed" || parts[0] === "shorts") return parts[1] || null;
				}
				return null;
			}

			// 播放视频逻辑
			async function playVideoById() {
				const id = inputVideo.value.trim() || 'Hvfo6PVnB9mnsD';
				const validId = /^[0-9a-zA-Z]{9,}$/;
				if (!id) {
					setVideoInputValue('');
					return;
				}
				if (!validId.test(id)) {
					swalAlert('视频 ID 格式不正确！');
					setVideoInputValue('');
					return;
				}
				const quality = selectQuality.value;
				currentPlayId = id;

				showLoading('正在获取视频信息...');

				// 获取视频信息
				try {
					const data = await fetchJson('/video/' + id, {
						headers: {
							CustomizedToken: localStorage.getItem('token') ? 'Bearer ' + localStorage.getItem('token') : '',
							'X-Site': getCurrentSiteHost()
						}
					});

					showLoading('正在解析视频信息...');

					// 检查 data.file 是否存在
					if (!data.file) {
						// data.file 为 null，尝试解析 embedUrl
						if (data.embedUrl) {
							const ytVideoId = getYouTubeId(data.embedUrl);
							if (ytVideoId) {
								currentVideoName = data.title || 'YouTube Video';

								// 记录当前是 YouTube 视频
								window.currentYoutubeId = ytVideoId;
								const startSeconds = getStartTimeForPlayback();

								// 使用 iframe 播放 YouTube 视频
								videoElement.pause();
								videoElement.style.display = 'none';
								// 隐藏下载按钮 (YouTube无法直接下载)
								btnDownload.style.display = 'none';
								btnChangeOrigin.style.display = 'none'; // 隐藏切换源按钮

								destroyYouTubePlayer();
						const ytIframe = getOrCreateYouTubeIframe();
						ytIframe.src = buildYouTubeEmbedSrc(ytVideoId, startSeconds);
						setPresenceVisibility(false);
						ytIframe.style.display = 'block';
						iframeContainer.style.display = 'flex';
						loadYouTubeIframeApi()
							.then(() => ensureYouTubePlayer(startSeconds))
							.catch(() => { });

						// 提示用户需要网络支持
						if (!isYouTubePromptDisabled()) {
							swal({
								title: "播放提示",
								text: "当前视频为 YouTube 视频，请确保你的网络可以访问 YouTube，否则视频将无法正常加载和播放。此外，要修改视频清晰度请在右下角设置（齿轮图标）里自行选择！",
								icon: "info",
								buttons: {
									disable: {
										text: "不再提示",
										value: 'disable'
									},
									confirm: {
										text: "我知道了",
										value: 'ok'
									}
								}
							}).then(action => {
								if (action === 'disable') {
									disableYouTubePrompt();
									swal({
										text: '已关闭 YouTube 播放提示，后续将不再弹出！',
										icon: 'success',
										buttons: false,
										timer: 2500
									});
								}
							});
						}
						return;
					}
				}
						// 既没有 file 也没有有效的 embedUrl
						throw '该视频暂无可用播放资源（file 为空且无有效的 embedUrl）';
					}

					// 清除 YouTube 状态
					destroyYouTubePlayer();
					window.currentYoutubeId = null;

					currentVideoName = data.title + '.' + data.file.mime.replace('video/', '');
					// Sensitive content prompt (title + tags, case-insensitive)
					const sensitiveCheck = isSensitivePromptDisabled() ? { matched: false, titleHits: [], tagHits: [] } : detectSensitiveContent(data);
					if (sensitiveCheck.matched) {
						const mergedSensitiveTags = Array.from(new Set([
							...(Array.isArray(sensitiveCheck.titleHits) ? sensitiveCheck.titleHits : []),
							...(Array.isArray(sensitiveCheck.tagHits) ? sensitiveCheck.tagHits : [])
						]));
						let pauseIntv = setInterval(() => videoElement.pause(), 300);
						const proceed = await swal({
							title: '温馨提示',
							text: '检测到视频含有高敏感内容：' + mergedSensitiveTags.map(formatSensitiveTagLabel).join('、') + '，是否继续观看？',
							buttons: {
								disable: {
									text: "不再提示",
									value: 'disable'
								},
								confirm: {
									text: "播放",
									value: true
								},
								cancel: {
									text: "不播放",
									value: false,
									visible: true
								}
							}
						});
						clearInterval(pauseIntv);
						if (proceed === 'disable') {
							disableSensitivePrompt();
							swal({
								text: '已关闭高敏感内容提示，后续将不再检测！',
								icon: 'success',
								buttons: false,
								timer: 2500
							});
						}
						else if (!proceed) {
							btnCloseOverlay.click();
							return;
						}
					}
					const fileUrl = new URL(data.fileUrl);
					const filehash = fileUrl.searchParams.get('hash');
					const fileExpires = fileUrl.searchParams.get('expires');
					const inputString = data.file.id + '_' + fileExpires + '_mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN';

					// 生成 SHA-1
					showLoading('正在生成播放签名...');

					const hashHex = await (async function (str) {
						if (window.crypto && crypto.subtle) {
							const hashBuf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
							return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
						}
						function encodeUTF8(s) {
							let r = [];
							for (let i = 0; i < s.length; i++) {
								let c = s.charCodeAt(i);
								if (c < 0x80) r.push(c);
								else if (c < 0x800) r.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
								else if (c < 0xd800 || c >= 0xe000) r.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
								else {
									i++;
									c = 0x10000 + (((c & 0x3ff) << 10) | (s.charCodeAt(i) & 0x3ff));
									r.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
								}
							}
							return r;
						}
						function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
						let data = encodeUTF8(str);
						let l = ((data.length + 8) >>> 6 << 4) + 16, s = new Uint32Array(l);
						for (let i = 0; i < data.length; i++) s[i >> 2] |= data[i] << (24 - (i & 3) * 8);
						s[data.length >> 2] |= 0x80 << (24 - (data.length & 3) * 8);
						s[l - 1] = data.length * 8;
						let w = new Uint32Array(80), h = [1732584193, -271733879, -1732584194, 271733878, -1009589776];
						for (let i = 0; i < l; i += 16) {
							let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
							for (let j = 0; j < 80; j++) {
								w[j] = j < 16 ? s[i + j] : rol(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
								let f = j < 20 ? (b & c) | (~b & d) : j < 40 ? b ^ c ^ d : j < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
								let k = j < 20 ? 1518500249 : j < 40 ? 1859775393 : j < 60 ? -1894007588 : -899497514;
								let temp = (rol(a, 5) + f + e + k + w[j]) | 0;
								e = d; d = c; c = rol(b, 30); b = a; a = temp;
							}
							h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
						}
						return h.map(x => ('00000000' + (x >>> 0).toString(16)).slice(-8)).join('');
					})(inputString);

					// 获取实际播放链接
					showLoading('正在获取实际播放链接...');

					const res2 = await fetch(fileUrl.pathname + '?expires=' + fileExpires + '&hash=' + filehash +
						'&download=' + encodeURIComponent('Iwara - ' + data.title + ' [' + data.id + '].' + data
							.file.mime.replace('video/', '')), {
						headers: {
							'X-Version': hashHex
						}
					});
					if (!res2.ok) {
						throw '获取播放资源失败！';
					}
					const data2 = await res2.json();
					const availableQualityValues = getAvailableQualityValues(data2);
					let resolvedQuality = quality;
					let resolvedVideoPath = getVideoUrlByQuality(data2, resolvedQuality);
					if (!resolvedVideoPath) {
						resolvedQuality = await promptQualityForUnavailableSelection(quality, availableQualityValues);
						if (!resolvedQuality) {
							hideLoading();
							return;
						}
						selectQuality.value = resolvedQuality;
						resolvedVideoPath = getVideoUrlByQuality(data2, resolvedQuality);
					}
					if (!resolvedVideoPath) {
						throw '当前视频暂无可用清晰度播放资源！';
					}
					currentVideoUrl = 'https:' + resolvedVideoPath;
					showLoading('正在准备播放器...');
					if (!isAllowedViewSourceUrl(currentVideoUrl)) {
						return swalAlert('播放链接不符合安全规则，已拦截！');
					}
					const finalUrl = buildPlaybackResourceUrl(currentVideoUrl);

					// 播放视频
					videoElement.pause();
					videoElement.currentTime = 0;
					iframeContainer.style.display = 'none';
					setPresenceVisibility(false);
					iframeContainer.style.display = 'flex';
					const videoSource = document.querySelector('.videoSource');
					videoSource.src = finalUrl + '#t=' + getStartTimeForPlayback(); // 设置 video 源链接
					// 清除旧监听器（避免重复绑定）
					videoElement.onerror = null;
					document.querySelectorAll('.videoSource').forEach(src => src.onerror = null);
					// 绑定监听器
					bindVideoErrorHandlers();
					videoElement.load(); // 加载视频

				} catch (err) {
					swalAlert('出现错误：' + err);
				} finally {
					hideLoading();
				}
			}

			// 监听视频播放失败事件
			function bindVideoErrorHandlers() {
				const handleVideoError = () => {
					swal({
						title: '播放失败',
						text: '媒体无法加载，可能是服务器或网络故障，或者格式不被支持！是否重新请求视频？',
						buttons: {
							cancel: {
								text: "关闭",
								value: false,
								visible: true
							},
							confirm: {
								text: "重新请求",
								value: true
							}
						}
					}).then(req => {
						videoElement.pause();
						if (req) playVideoById();
					});
				};

				videoElement.addEventListener('error', handleVideoError);
				document.querySelectorAll('.videoSource').forEach(src => {
					src.addEventListener('error', handleVideoError);
				});
			}

			// 根据清晰度从播放列表中选取链接
			function getVideoUrlByQuality(list, quality) {
				const found = (Array.isArray(list) ? list : []).find(item => item && item.name === quality && item.src && item.src.view);
				return found ? found.src.view : '';
			}

			// 显示随机热门选择
			const RANDOM_HOT_CHOICE_COOKIE = 'iwara_random_hot_choice';

			function getCookieValue(name) {
				const prefix = encodeURIComponent(name) + '=';
				const item = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
				if (!item) return '';
				try {
					return decodeURIComponent(item.slice(prefix.length));
				} catch {
					return '';
				}
			}

			function rememberRandomHotChoice(choice) {
				const secure = location.protocol === 'https:' ? '; Secure' : '';
				document.cookie = encodeURIComponent(RANDOM_HOT_CHOICE_COOKIE) + '=' + encodeURIComponent(choice) + '; Path=/; SameSite=Lax' + secure;
			}

			function getRememberedRandomHotChoice() {
				const choice = getCookieValue(RANDOM_HOT_CHOICE_COOKIE);
				return choice === 'R18' || choice === 'General' ? choice : '';
			}

						function isAllowedViewSourceUrl(rawUrl) {
				try {
					const u = new URL(rawUrl);
					const protocol = String(u.protocol || '').toLowerCase();
					const host = String(u.hostname || '').toLowerCase();
					const pathname = String(u.pathname || '');
					const query = String(u.search || '');
					const protocolOk = protocol === 'http:' || protocol === 'https:';
					const hostOk = /^[a-z0-9-]+\.iwara\.tv$/i.test(host);
					const pathOk = pathname === '/view';
					const queryOk = query.length > 1;
					return protocolOk && hostOk && pathOk && queryOk;
				} catch {
					return false;
				}
			}

			function playRandomHot(choice) {
				const sitePrefix = getSiteStoragePrefix();
				let keyInfo = choice === 'R18' ? (sitePrefix + 'hots') : (sitePrefix + 'generalHots');
				let keyTs = choice === 'R18' ? (sitePrefix + 'ts') : (sitePrefix + 'generalTs');
				let rating = choice === 'R18' ? 'ecchi' : 'general';
				const cache = localStorage.getItem(keyInfo);
				const timestamp = parseInt(localStorage.getItem(keyTs) || '0');
				if (cache && !isExpired(timestamp)) {
					const list = JSON.parse(cache);
					setVideoInputValue(list[getRandomInt(0, list.length - 1)].id);
					playVideoById();
				} else {
					showLoading('正在获取热门视频列表...');
					fetchJson("/videos?rating=" + rating + "&sort=trending&limit=30", {
						headers: {
							'X-Site': getCurrentSiteHost()
						}
					})
						.then(data => {
							const results = data.results || [];
							localStorage.setItem(keyInfo, JSON.stringify(results));
							localStorage.setItem(keyTs, Date.now().toString());
							if (results.length) {
								setVideoInputValue(results[getRandomInt(0, results.length - 1)].id);
								playVideoById();
							}
						})
						.catch(err => swalAlert('出现错误：' + err))
						.finally(() => hideLoading());
				}
			}

			function showRandomHotPrompt() {
				const rememberedChoice = getRememberedRandomHotChoice();
				if (rememberedChoice) {
					playRandomHot(rememberedChoice);
					return;
				}

				const promptContent = document.createElement('div');
				promptContent.className = 'random-hot-prompt';

				const promptText = document.createElement('p');
				promptText.className = 'random-hot-prompt-text';
				promptText.textContent = '随机热门视频分为普通和 R18 内容，您要随机播放哪种内容？';
				promptContent.appendChild(promptText);

				const rememberLabel = document.createElement('label');
				rememberLabel.className = 'random-hot-remember';
				const rememberCheckbox = document.createElement('input');
				rememberCheckbox.type = 'checkbox';
				rememberCheckbox.checked = false;
				const rememberText = document.createElement('span');
				rememberText.textContent = '这次打开期间记住选择（下次点“随机热门”不再询问）';
				rememberLabel.append(rememberCheckbox, rememberText);
				promptContent.appendChild(rememberLabel);

				swal({
					content: promptContent,
					icon: 'info',
					buttons: {
						cancel: {
							text: "关闭",
							value: false,
							visible: true
						},
						r18: {
							text: "R18",
							value: 'R18'
						},
						general: {
							text: "普通",
							value: 'General'
						}
					}
				}).then(choice => {
					if (!choice) return;
					if (rememberCheckbox.checked) rememberRandomHotChoice(choice);
					playRandomHot(choice);
				});
			}

			// 打开收藏列表（使用 template 克隆，不再移除原 DOM）
			function openFavorites() {
				const data = loadAndUpgradeFavorites();
				const entries = Object.entries(data);
				const reversedEntries = entries.reverse();
				const reversedData = Object.fromEntries(reversedEntries);

				// 克隆模板内容
				const template = document.getElementById('saveVideosTemplate');
				const saveContainer = template.content.firstElementChild.cloneNode(true);

				const saveTableBody = saveContainer.querySelector('tbody');
				const pageSizeSelect = saveContainer.querySelector('#pageSizeSelect');
				const viewContentSelect = saveContainer.querySelector('#viewContentSelect');
				const firstPageBtn = saveContainer.querySelector('#firstPage');
				const prevPageBtn = saveContainer.querySelector('#prevPage');
				const nextPageBtn = saveContainer.querySelector('#nextPage');
				const lastPageBtn = saveContainer.querySelector('#lastPage');
				const pageInfo = saveContainer.querySelector('#pageInfo');
				const paginationControls = saveContainer.querySelector('#paginationControls');

				let currentPage = 1;
				let pageSize = 5;
				let totalPages = 1;
				let filteredDataArray = [];

				function getFilteredData() {
					const dataArray = Object.entries(reversedData);
					const filterValue = viewContentSelect ? viewContentSelect.value : 'all';
					if (filterValue === 'tv') {
						return dataArray.filter(([, item]) => normalizeSiteType(item && item.type) !== 'ai');
					} else if (filterValue === 'ai') {
						return dataArray.filter(([, item]) => normalizeSiteType(item && item.type) === 'ai');
					}
					return dataArray;
				}

				// 计算总页数
				function calculateTotalPages() {
					filteredDataArray = getFilteredData();
					const totalItems = filteredDataArray.length;
					totalPages = Math.ceil(totalItems / pageSize);
					if (totalPages === 0) totalPages = 1;
				}

				// 渲染当前页
				function renderCurrentPage() {
					saveTableBody.innerHTML = '';

					const startIndex = (currentPage - 1) * pageSize;
					const endIndex = Math.min(startIndex + pageSize, filteredDataArray.length);
					const cur = filteredDataArray.slice(startIndex, endIndex);

					cur.forEach(([id, item]) => {
						const tr = document.createElement('tr');
						const itemName = String(item && item.name || '');
						const itemType = normalizeSiteType(item && item.type);

						const td1 = document.createElement('td');
						td1.textContent = itemName + (itemType === 'ai' ? ' [AI]' : ' [TV]');
						td1.dataset.id = id;
						td1.dataset.type = itemType;

						const td2 = document.createElement('td');

						const btnPlay = document.createElement('button');
						btnPlay.textContent = '播放';
						btnPlay.className = 'btn-t-play';

						const btnDel = document.createElement('button');
						btnDel.textContent = '删除';
						btnDel.className = 'btn-t-del';

						td2.appendChild(btnPlay);
						td2.appendChild(btnDel);

						tr.appendChild(td1);
						tr.appendChild(td2);
						saveTableBody.appendChild(tr);

						// 点击播放
						btnPlay.onclick = () => {
							applySiteType(itemType);
							setVideoInputValue(id);
							swal.close();
							playVideoById();
						};

						// 点击删除
						btnDel.onclick = () => {
							if (confirm('确认删除 ' + itemName + ' 吗？')) {
								delete reversedData[id];
								const entries = Object.entries(reversedData);
								const reversedEntries = entries.reverse();
								const data = Object.fromEntries(reversedEntries);
								localStorage.setItem('save', JSON.stringify(data));
								calculateTotalPages();
								if (currentPage > totalPages) currentPage = totalPages;
								renderCurrentPage();
								updateControls();
							}
						};
					});

					// 空提示
					if (cur.length === 0) {
						const tr = document.createElement('tr');
						const td = document.createElement('td');
						td.colSpan = 2;
						td.textContent = '暂无收藏视频';
						td.style.textAlign = 'center';
						td.style.color = '#999';
						tr.appendChild(td);
						saveTableBody.appendChild(tr);
					}
				}

				// 更新分页控件
				function updateControls() {
					pageInfo.textContent = '第 ' + currentPage + ' 页 / 共 ' + totalPages + ' 页';

					firstPageBtn.disabled = currentPage === 1;
					prevPageBtn.disabled = currentPage === 1;
					nextPageBtn.disabled = currentPage === totalPages;
					lastPageBtn.disabled = currentPage === totalPages;

					const hasAnyData = Object.keys(reversedData).length > 0;
					paginationControls.style.display = hasAnyData ? 'block' : 'none';
					
					const pageNavPanel = paginationControls.querySelector('div:last-child');
					if (pageNavPanel) {
						pageNavPanel.style.display = totalPages > 1 ? 'flex' : 'none';
					}
				}

				// 分页按钮
				firstPageBtn.onclick = () => {
					currentPage = 1;
					renderCurrentPage();
					updateControls();
				};

				prevPageBtn.onclick = () => {
					if (currentPage > 1) currentPage--;
					renderCurrentPage();
					updateControls();
				};

				nextPageBtn.onclick = () => {
					if (currentPage < totalPages) currentPage++;
					renderCurrentPage();
					updateControls();
				};

				lastPageBtn.onclick = () => {
					currentPage = totalPages;
					renderCurrentPage();
					updateControls();
				};

				// 每页数量改变
				pageSizeSelect.onchange = () => {
					pageSize = parseInt(pageSizeSelect.value);
					currentPage = 1;
					calculateTotalPages();
					renderCurrentPage();
					updateControls();
				};

				// 点击行复制链接
				saveTableBody.addEventListener('click', e => {
					const tr = e.target.closest('tr');
					if (tr && !e.target.matches('button')) {
						const td = tr.querySelector('td');
						if (td && td.dataset.id) {
							const host = getSiteHostByType(td.dataset.type);
							copyLinkToClipboard('https://' + host + '/video/' + td.dataset.id);
						}
					}
				});

				if (viewContentSelect) {
					viewContentSelect.onchange = () => {
						currentPage = 1;
						calculateTotalPages();
						renderCurrentPage();
						updateControls();
						
						const titleMap = {
							all: '我的收藏（全部）',
							tv: '我的收藏（仅TV）',
							ai: '我的收藏（仅AI）'
						};
						const titleText = titleMap[viewContentSelect.value] || '我的收藏（全部）';
						const titleEl = document.querySelector('.swal-title');
						if (titleEl) titleEl.textContent = titleText;
					};
				}

				// 初始化
				calculateTotalPages();
				renderCurrentPage();
				updateControls();

				// SweetAlert 弹窗
				swal({
					title: '我的收藏（全部）',
					content: saveContainer,
					buttons: {
						clear: {
							text: "清空收藏",
							value: 'clear'
						},
						export: {
							text: "导出收藏",
							value: 'export'
						},
						import: {
							text: "导入收藏",
							value: 'import'
						},
						close: {
							text: "关闭",
							value: null
						}
					}
				}).then(act => {
					if (act === 'clear') {
						swal({
							title: '提示',
							text: '清空收藏不可恢复，是否确认？',
							icon: 'warning',
							buttons: ['取消', '清空']
						}).then(ok => {
							if (ok) {
								localStorage.removeItem('save');
								openFavorites();
							}
						});
					} else if (act === 'export') {
						exportFavorites();
					} else if (act === 'import') {
						importFavorites().then(() => openFavorites());
					}
				});
			}

			// 检查 JWT Token 是否有效（仅本地解析，不验证签名）
			function isJwtValid(token) {
				try {
					if (typeof token !== 'string' || token.trim() === '') {
						return false; // 空或非字符串
					}

					const parts = token.split('.');
					if (parts.length !== 3) {
						return false; // JWT 必须由三部分组成
					}

					// 解码 payload（Base64URL 转换）
					const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

					// 检查 exp（过期时间，单位秒）
					if (!payload.exp || typeof payload.exp !== 'number') {
						return false; // 没有过期时间
					}

					const now = Math.floor(Date.now() / 1000); // 当前时间（秒）
					return payload.exp > now; // true 表示未过期
				} catch (err) {
					console.error('Token 解析失败:', err);
					return false;
				}
			}

			// 页面访问时自动检查本地 Token 是否过期
			function checkStoredTokenStatusOnLoad() {
				const token = localStorage.getItem('token');
				if (!token) return false;

				if (!isJwtValid(token)) {
					localStorage.removeItem('token');
					swal({
						title: '令牌已失效',
						text: '检测到你之前保存的 Iwara 令牌已过期或无效，已自动清除，请重新填写令牌！',
						icon: 'warning',
						button: '知道了'
					});
					return false;
				}

				return true;
			}

			// 页面访问时检查后端 Token 状态（优先使用首页内嵌结果，避免额外请求）
			async function checkBackendTokenStatusOnLoad(hasValidLocalToken = false, initialStatus = null) {
				const nextCheckKey = 'backendTokenStatusNextCheckAt';
				if (initialStatus && initialStatus.status === 'valid') {
					localStorage.removeItem(nextCheckKey);
					return;
				}
				const now = Date.now();
				const nextCheckAt = parseInt(localStorage.getItem(nextCheckKey) || '0', 10);
				if (nextCheckAt && now < nextCheckAt) return;

				const applyRetryAfter = retryAfterSeconds => {
					const retryAfter = parseInt(retryAfterSeconds || '0', 10);
					if (retryAfter > 0) {
						localStorage.setItem(nextCheckKey, (Date.now() + retryAfter * 1000).toString());
					} else {
						localStorage.removeItem(nextCheckKey);
					}
				};

				const shouldWarnForLoginFailure = failureReason => {
					return failureReason === 'credentials_rejected' || failureReason === 'invalid_response';
				};

				const showStatusWarning = (status, message, failureReason = '', retryCount = 0) => {
					if (hasValidLocalToken) return;
					if (document.querySelector('.swal-overlay--show-modal')) {
						if (retryCount < 20) setTimeout(() => showStatusWarning(status, message, failureReason, retryCount + 1), 500);
						return;
					}
					const loginIssue = status === 'login_failed' || status === 'login_misconfigured';
					const loginTitle = status === 'login_misconfigured'
						? '自动登录配置不完整'
						: (failureReason === 'credentials_rejected' ? '自动登录凭据被拒绝' : '自动登录接口异常');
					swal({
						title: loginIssue ? loginTitle : '令牌已失效',
						text: message || (loginIssue ? '请站点管理员检查 Iwara 自动登录状态！' : '后端设置的token已过期！'),
						icon: 'warning',
						button: '知道了'
					});
				};

				const handleStatus = (status, retryAfterSeconds = 0, message = '', failureReason = '') => {
					if (status === 'not_configured') {
						applyRetryAfter(retryAfterSeconds || BACKEND_TOKEN_STATUS_DEFAULT_RETRY_SECONDS);
						return true;
					}
					if (status === 'valid') {
						localStorage.removeItem(nextCheckKey);
						return true;
					}
					if (status === 'login_failed') {
						applyRetryAfter(retryAfterSeconds || 60);
						if (shouldWarnForLoginFailure(failureReason)) {
							showStatusWarning(status, message, failureReason);
						} else {
							console.info('[backend-token-status] 自动登录暂时不可用，已静默等待后续重试：', failureReason || 'unknown');
						}
						return true;
					}
					if (status === 'expired' || status === 'login_misconfigured') {
						applyRetryAfter(retryAfterSeconds);
						showStatusWarning(status, message, failureReason);
						return true;
					}
					return false;
				};

				if (initialStatus && typeof initialStatus === 'object'
					&& handleStatus(initialStatus.status, initialStatus.retryAfterSeconds, initialStatus.message, initialStatus.failureReason)) {
					return;
				}

				try {
					const res = await fetch('/token-status', { headers: { Accept: 'application/json' } });
					const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
					if (res.status === 204) {
						handleStatus(retryAfter > 0 ? 'not_configured' : 'valid', retryAfter);
						return;
					}
					if (!res.ok) return;
					const data = await res.json().catch(() => ({}));
					const statusMap = {
						backend_token_expired: 'expired',
						backend_login_failed: 'login_failed',
						backend_login_credentials_rejected: 'login_failed',
						backend_login_invalid_response: 'login_failed',
						backend_login_rate_limited: 'login_failed',
						backend_login_upstream_blocked: 'login_failed',
						backend_login_temporarily_unavailable: 'login_failed',
						backend_login_misconfigured: 'login_misconfigured'
					};
					handleStatus(statusMap[data && data.code] || '', retryAfter, data && data.message, data && data.reason);
				} catch (err) {
					// 后端状态检测失败时静默处理，避免影响正常使用
				}
			}

			// 保存Token
			function saveToken() {
				swal({
					"title": "令牌获取方法",
					"text": "有些视频需要登录令牌才能观看！在PC端访问Iwara官网，再按键盘上面的“F12”，在弹出的窗口中选择“控制台”，然后输入“localStorage.getItem('token')”（去掉双引号）后按回车，把输出的内容复制到下方点击确定即可！",
					content: "input",
					button: "确定"
				})
					.then((value) => {

						if (isJwtValid(value)) {
							localStorage.setItem('token', value);
							swal({
								text: "令牌填写成功！",
								icon: "success",
								button: "确定"
							});
						} else {
							swal({
								text: "令牌格式有误或已过期！",
								icon: "error",
								button: "确定"
							});
						}

					});
			}

			// 导出收藏
			function exportFavorites() {
				const data = JSON.stringify(loadAndUpgradeFavorites());
				if (data && data !== '{}') {
					const blob = new Blob([data], {
						type: 'application/json'
					});
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = 'Iwara收藏视频.json';
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
					URL.revokeObjectURL(url);
				}
			}

			// 导入收藏（返回Promise）
			function importFavorites() {
				return new Promise((resolve) => {
					const input = document.createElement('input');
					input.type = 'file';
					input.accept = 'application/json';
					input.style.display = 'none';
					document.body.appendChild(input);

					input.addEventListener('change', () => {
						if (!input.files[0]) {
							resolve();
							return;
						}

						const reader = new FileReader();
						reader.readAsText(input.files[0]);
						reader.onload = () => {
							let parsedImported;
							try {
								parsedImported = JSON.parse(String(reader.result || '{}'));
							} catch {
								swal({
									text: 'JSON 格式错误，导入失败！',
									icon: 'error'
								});
								resolve();
								return;
							}
							const imported = JSON.stringify(normalizeFavoritesData(parsedImported));
							if (localStorage.getItem('save')) {
								swal({
									text: '已有收藏内容，导入将覆盖旧数据，是否继续？',
									icon: 'warning',
									buttons: {
										cancel: '取消',
										ok: '确定'
									}
								}).then(ok => {
									if (ok) {
										localStorage.setItem('save', imported);
										loadAndUpgradeFavorites();
									}
									resolve();
								});
							} else {
								localStorage.setItem('save', imported);
								loadAndUpgradeFavorites();
								resolve();
							}
						};

						reader.onerror = () => {
							swal({
								text: '文件读取失败！',
								icon: 'error'
							});
							resolve();
						};
					}, {
						once: true
					});

					input.click();
					// 如果用户取消选择文件，也需要resolve
					input.addEventListener('cancel', () => {
						setTimeout(resolve, 100);
					}, {
						once: true
					});
				});
			}

			// 复制链接到剪切板
			async function copyLinkToClipboard(url = null) {
				try {
					const link = url || (() => {
						const u = new URL(location.origin);
						u.searchParams.set('id', inputVideo.value.trim() || 'Hvfo6PVnB9mnsD');
						u.searchParams.set('quality', selectQuality.value);
						u.searchParams.set('type', getCurrentSiteType());
						return u.href;
					})();
					await navigator.clipboard.writeText(link);
					swal("链接已复制到剪切板！", {
						icon: "success",
						buttons: false,
						timer: 2000
					});
				} catch (err) {
					swal({
						text: '复制失败：' + err,
						icon: 'error',
						button: '关闭'
					});
				}
			}

			// 判断时间是否超过一天
			async function copyMomentLinkToClipboard() {
				const id = (currentPlayId || inputVideo.value.trim() || 'Hvfo6PVnB9mnsD').trim();
				const t = await getCurrentPlaybackTimeSec();
				const u = new URL(location.origin + location.pathname);
				u.searchParams.set('id', id);
				u.searchParams.set('quality', selectQuality.value);
				u.searchParams.set('type', getCurrentSiteType());
				u.searchParams.set('t', String(t));
				return copyLinkToClipboard(u.href);
			}

			function isExpired(timestamp) {
				return Date.now() - timestamp > 24 * 60 * 60 * 1000;
			}

			// 获取 [min, max] 区间随机整数
			const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

		})();
	</script>
	<script>
		/* 界面增强：明暗主题切换（独立于业务脚本，仅操作 <html data-theme>） */
		(() => {
			const root = document.documentElement;
			const KEY = 'ui_theme_v1';
			const btn = document.getElementById('themeToggle');
			const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
			const effective = () => root.getAttribute('data-theme') || (mq && mq.matches ? 'dark' : 'light');
			const syncMeta = () => {
				const m = document.querySelector('meta[name="theme-color"]');
				if (m) m.setAttribute('content', effective() === 'dark' ? '#0e1220' : '#f1f3f9');
			};
			if (btn) {
				btn.addEventListener('click', () => {
					const next = effective() === 'dark' ? 'light' : 'dark';
					root.setAttribute('data-theme', next);
					try { localStorage.setItem(KEY, next); } catch (_) { }
					syncMeta();
				});
				// 业务脚本里有全局 Enter 监听（会触发播放），键盘操作主题按钮时不让事件冒泡过去
				btn.addEventListener('keypress', e => e.stopPropagation());
			}
			if (mq && mq.addEventListener) mq.addEventListener('change', syncMeta);
			syncMeta();
			// 兜底：万一入场动画类没被加上，1.2 秒后确保内容可见
			setTimeout(() => { const w = document.querySelector('.wrap'); if (w) w.classList.add('on'); }, 1200);
		})();
	</script>
	<script>
		/* 界面增强：收藏列表在视频名前加 TV / AI 标签（只读取行上已有的 data-type，不改业务脚本） */
		(() => {
			const decorate = () => {
				document.querySelectorAll('#data-table td[data-type]').forEach(td => {
					if (td.querySelector('.fav-tag')) return;
					const type = td.getAttribute('data-type') === 'ai' ? 'ai' : 'tv';
					const tag = document.createElement('span');
					tag.className = 'fav-tag fav-tag-' + type;
					tag.textContent = type === 'ai' ? 'AI' : 'TV';
					td.insertBefore(tag, td.firstChild);
					// 名称末尾的 " [TV]" / " [AI]" 与标签重复：包进 span 并默认隐藏（不用正则，避免模板字符串转义问题）
					const txt = td.lastChild;
					if (txt && txt.nodeType === 3) {
						const v = txt.nodeValue;
						const i = Math.max(v.lastIndexOf(' [TV]'), v.lastIndexOf(' [AI]'));
						if (i > 0 && i === v.length - 5) {
							txt.nodeValue = v.slice(0, i);
							const sfx = document.createElement('span');
							sfx.className = 'fav-suffix';
							sfx.textContent = v.slice(i);
							td.appendChild(sfx);
						}
					}
				});
			};
			new MutationObserver(decorate).observe(document.body, { childList: true, subtree: true });
		})();
	</script>
</body>

</html>`
