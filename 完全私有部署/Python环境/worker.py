"""Iwara 业务逻辑的 Python 实现；前端模板来自 Node 版 worker.mjs。"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import json
import logging
import math
import mimetypes
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

from aiohttp import WSMsgType, web
from multidict import CIMultiDict
from yarl import URL

from flaresolverr import UpstreamClient

BASE_DIR = Path(__file__).resolve().parent
IWARA_LOGIN_URL = "https://api.iwara.tv/user/login"
API_ORIGIN = "https://apiq.iwara.tv"
FILE_ORIGIN = "https://filesq.iwara.tv"
ANALYTICS_URL = "https://api.cloudflare.com/client/v4/graphql"
log = logging.getLogger("iwara-python")
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailer", "transfer-encoding", "upgrade"}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def utc_range():
    now = datetime.now(timezone.utc)
    return {"dayKey": now.date().isoformat(),
            "startIso": now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "nowIso": now.isoformat(timespec="milliseconds").replace("+00:00", "Z")}


def integer(value, default, minimum=1):
    try:
        result = int(value)
        return result if result >= minimum else default
    except (ValueError, TypeError):
        return default


def http_url(value):
    try:
        url = URL(str(value or "").strip())
        return str(url) if url.scheme in {"http", "https"} and url.host else ""
    except ValueError:
        return ""


def bearer(value):
    value = str(value or "").strip()
    return value if not value or re.match(r"Bearer\s+", value, re.I) else "Bearer " + value


def jwt_payload(value):
    try:
        parts = re.sub(r"^Bearer\s+", "", value.strip(), flags=re.I).split(".")
        if len(parts) != 3:
            return {}
        data = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        return data if isinstance(data, dict) else {}
    except (ValueError, UnicodeError, binascii.Error):
        return {}


def fresh(value, skew=60):
    if not value:
        return False
    exp = jwt_payload(value).get("exp")
    return not isinstance(exp, (int, float)) or exp > int(time.time()) + skew


def expiry(value):
    exp = jwt_payload(value).get("exp")
    try:
        return datetime.fromtimestamp(exp, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def json_response(data, status=200, headers=None):
    return web.Response(text=json.dumps(data, ensure_ascii=False, separators=(",", ":")), status=status,
                        content_type="application/json", charset="UTF-8", headers=headers)


def public_failure(reason):
    code, message, warn = {
        "credentials_rejected": ("backend_login_credentials_rejected", "Iwara登录凭据被拒绝，请站点管理员检查登录邮箱和密码。", True),
        "invalid_response": ("backend_login_invalid_response", "Iwara登录接口响应中没有可用Token，请站点管理员检查接口是否发生变化。", True),
        "rate_limited": ("backend_login_rate_limited", "Iwara登录接口暂时限流，Worker会在冷却结束后自动重试。", False),
        "upstream_blocked": ("backend_login_upstream_blocked", "Iwara登录接口暂时受到上游访问限制，Worker稍后会自动重试。", False),
    }.get(reason, ("backend_login_temporarily_unavailable", "Iwara登录接口暂时不可用，Worker稍后会自动重试。", False))
    return {"code": code, "message": message, "shouldWarnUser": warn}


def inline_json(data):
    result = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    for char in "<>&\u2028\u2029":
        result = result.replace(char, "\\u%04x" % ord(char))
    return result


class MemoryCache:
    def __init__(self):
        self.entries = {}

    def get(self, key):
        entry = self.entries.get(key)
        if entry and entry[0] > time.monotonic():
            return dict(entry[1])
        self.entries.pop(key, None)
        return None

    def put(self, key, data, ttl):
        # 清理过期项，避免按 UTC 日期生成的键无限累积。
        now = time.monotonic()
        self.entries = {k: v for k, v in self.entries.items() if v[0] > now}
        self.entries[key] = (now + ttl, dict(data))


class IwaraWorker:
    def __init__(self, env: dict, upstream: UpstreamClient, base_dir=BASE_DIR):
        self.env, self.upstream = dict(env), upstream
        self.base_dir = Path(base_dir)
        self.template = (self.base_dir / "index.html").read_text(encoding="utf-8")
        self.cache = MemoryCache()
        self.sockets: dict[web.WebSocketResponse, str] = {}
        self.presence_lock = asyncio.Lock()
        self.login_task = None
        self.auto_token = ""
        self.retry_at = 0
        self.last_attempt = self.last_success = self.last_error = self.failure_reason = ""
        self.last_response_status = None
        self.last_content_type = ""

    def config(self, key):
        return self.env.get(key, "").strip()

    def has_credentials(self):
        return bool(self.config("IWARA_USERNAME") and self.env.get("IWARA_PASSWORD", ""))

    def authorized(self, request):
        user, password = self.config("BASIC_AUTH_USER"), self.config("BASIC_AUTH_PASS")
        if not (user or password):
            return True
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(auth[6:], validate=True).decode("utf-8")
            supplied_user, _, supplied_pass = decoded.partition(":")
            return (hmac.compare_digest(supplied_user.encode(), user.encode())
                    and hmac.compare_digest(supplied_pass.encode(), password.encode()))
        except (ValueError, UnicodeError, binascii.Error):
            return False

    def retry_seconds(self):
        return max(0, math.ceil(self.retry_at - time.time()))

    def classify_failure(self):
        status = self.last_response_status or 0
        if status == 429:
            return "rate_limited"
        if status in {400, 401}:
            return "credentials_rejected"
        if status == 403:
            return "upstream_blocked"
        if status >= 500:
            return "upstream_unavailable"
        if 200 <= status < 300:
            return "invalid_response"
        return "network_error" if status <= 0 else "unknown"

    async def login(self, force=False):
        if not self.has_credentials():
            raise RuntimeError("Iwara自动登录账号或密码未完整配置")
        if not force and fresh(self.auto_token):
            return self.auto_token
        if self.login_task:
            return await asyncio.shield(self.login_task)
        if time.time() < self.retry_at:
            raise RuntimeError(self.last_error or "Iwara自动登录暂时处于重试冷却中")
        if force:
            self.auto_token = ""

        async def run():
            self.last_attempt = now_iso()
            self.last_response_status, self.last_content_type = None, ""
            response = None
            try:
                headers = {
                    "Accept": "application/json", "Accept-Language": "zh-CN,zh;q=0.9",
                    "Content-Type": "application/json", "Origin": "https://www.iwara.tv",
                    "Referer": "https://www.iwara.tv/", "Priority": "u=1, i",
                    "Sec-CH-UA": '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
                    "Sec-CH-UA-Mobile": "?0", "Sec-CH-UA-Platform": '"Windows"',
                    "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-site",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
                    "X-Site": "www.iwara.tv",
                }
                response = await self.upstream.fetch(IWARA_LOGIN_URL, "POST", headers, json.dumps({
                    "email": self.config("IWARA_USERNAME"), "password": self.env["IWARA_PASSWORD"],
                }).encode())
                self.last_response_status = response.status
                self.last_content_type = response.headers.get("Content-Type", "")[:200]
                if not 200 <= response.status < 300:
                    raise RuntimeError("Iwara登录接口返回HTTP " + str(response.status))
                try:
                    data = await response.json()
                except (ValueError, UnicodeError):
                    data = None
                token = bearer(data.get("token")) if isinstance(data, dict) else ""
                if not token:
                    raise RuntimeError("Iwara登录响应中缺少Token")
                self.auto_token = token
                self.retry_at = 0
                self.last_error = self.failure_reason = ""
                self.last_success = now_iso()
                log.info("Iwara 自动登录成功")
                return token
            except Exception as error:
                self.auto_token = ""
                self.retry_at = time.time() + 60
                # 不将异常中的请求 URL、凭据或响应正文放入诊断结果。
                self.last_error = str(error) if isinstance(error, RuntimeError) else "Iwara登录请求失败（" + type(error).__name__ + "）"
                self.failure_reason = self.classify_failure()
                log.warning("Iwara 自动登录失败：%s；60 秒后可重试", self.failure_reason)
                raise RuntimeError(self.last_error) from None
            finally:
                if response is not None:
                    response.close()

        task = asyncio.create_task(run())
        self.login_task = task

        def cleanup(done):
            if self.login_task is done:
                self.login_task = None
            if not done.cancelled():
                done.exception()

        task.add_done_callback(cleanup)
        return await asyncio.shield(task)

    async def backend_authorization(self):
        token = bearer(self.config("IWARA_AUTHORIZATION"))
        if fresh(token):
            return token
        if self.has_credentials():
            try:
                return await self.login()
            except RuntimeError:
                pass
        return token

    async def token_status(self):
        token = bearer(self.config("IWARA_AUTHORIZATION"))
        if fresh(token, 0):
            return {"status": "valid"}
        if bool(self.config("IWARA_USERNAME") or self.env.get("IWARA_PASSWORD", "")) and not self.has_credentials():
            return {"status": "login_misconfigured"}
        if self.has_credentials():
            try:
                await self.login()
                return {"status": "valid"}
            except RuntimeError:
                return {"status": "login_failed", "failureReason": self.failure_reason,
                        "retryAfterSeconds": self.retry_seconds() or 60}
        return {"status": "expired" if token else "not_configured"}

    def diagnostics(self, status):
        manual_fresh = fresh(bearer(self.config("IWARA_AUTHORIZATION")), 0)
        auto_fresh = fresh(self.auto_token, 0)
        return {
            "status": status["status"],
            "configured": {"manualToken": bool(self.config("IWARA_AUTHORIZATION")),
                           "username": bool(self.config("IWARA_USERNAME")), "password": bool(self.env.get("IWARA_PASSWORD", ""))},
            "authorizationSource": "configured_token" if manual_fresh else ("auto_login_cache" if auto_fresh else "none"),
            "autoLogin": {"endpoint": IWARA_LOGIN_URL, "attempted": bool(self.last_attempt),
                          "lastAttemptAt": self.last_attempt or None, "lastResponseStatus": self.last_response_status,
                          "lastResponseContentType": self.last_content_type or None, "lastSucceededAt": self.last_success or None,
                          "cachedTokenAvailable": auto_fresh, "cachedTokenExpiresAt": expiry(self.auto_token),
                          "loginInFlight": self.login_task is not None, "retryAfterSeconds": self.retry_seconds(),
                          "failureReason": self.failure_reason or None, "lastError": self.last_error or None},
        }

    def playback_config(self):
        raw_mode = self.config("FORCE_PLAYBACK_MODE")
        tag, api_token, script = (self.config(k) for k in ("CF_ACCOUNT_TAG", "CF_ANALYTICS_API_TOKEN", "CF_WORKER_SCRIPT_NAME"))
        return {"manualModeRaw": raw_mode, "manualMode": "direct" if raw_mode.lower() == "direct" else "proxy",
                "hasAccountTag": bool(tag), "hasApiToken": bool(api_token), "scriptName": script,
                "newSiteUrl": http_url(self.config("NEW_SITE_URL")),
                "dailyLimit": integer(self.config("WORKERS_DAILY_REQUEST_LIMIT"), 100000),
                "remainingThreshold": integer(self.config("DIRECT_MODE_REMAINING_REQUESTS_THRESHOLD"), 100, 0),
                "cacheTtlSeconds": integer(self.config("PLAYBACK_MODE_CACHE_TTL_SECONDS"), 300),
                "missingConfig": [k for k in ("CF_ACCOUNT_TAG", "CF_ANALYTICS_API_TOKEN", "CF_WORKER_SCRIPT_NAME") if not self.config(k)]}

    @staticmethod
    def direct_notice(site):
        notice = "今日 Worker 请求量已接近配置上限，新打开的页面已切换为视频直连模式。若当前网络无法直接访问 Iwara 视频源，请稍后重试；免费额度将在北京时间早上 8 点（UTC 0 点）重置。"
        return notice + (" 也可以前往备用站点 " + URL(site).authority + " 继续观看。" if site else "")

    async def playback(self, bypass=False):
        cfg = self.playback_config()
        result = {"mode": "proxy", "source": "analytics_not_configured", "requestLimit": cfg["dailyLimit"],
                  "remainingThreshold": cfg["remainingThreshold"], "estimatedUsedRequests": None,
                  "estimatedRemainingRequests": None, "checkedAt": now_iso(), "notice": "", "newSiteUrl": ""}
        if cfg["manualModeRaw"]:
            result.update(mode=cfg["manualMode"], source="manual_override")
        elif not cfg["missingConfig"]:
            day = utc_range()
            key = ("playback", cfg["scriptName"], day["dayKey"])
            cached = None if bypass else self.cache.get(key)
            if cached:
                result = dict(cached, cacheHit=True)
            else:
                response = None
                try:
                    query = """query GetWorkersAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
                      viewer { accounts(filter: { accountTag: $accountTag }) {
                        workersInvocationsAdaptive(limit: 100, filter: { scriptName: $scriptName,
                          datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }) { sum { requests } }
                      } }
                    }"""
                    response = await self.upstream.fetch(ANALYTICS_URL, "POST", {
                        "Authorization": "Bearer " + self.config("CF_ANALYTICS_API_TOKEN"), "Content-Type": "application/json", "Accept": "application/json",
                    }, json.dumps({"query": query, "variables": {"accountTag": self.config("CF_ACCOUNT_TAG"),
                        "datetimeStart": day["startIso"], "datetimeEnd": day["nowIso"], "scriptName": cfg["scriptName"]}}).encode())
                    if not 200 <= response.status < 300:
                        raise RuntimeError("Cloudflare Analytics API 返回状态异常：" + str(response.status))
                    data = await response.json()
                    if data.get("errors"):
                        raise RuntimeError("Cloudflare Analytics API 返回错误")
                    rows = data["data"]["viewer"]["accounts"][0]["workersInvocationsAdaptive"]
                    if not isinstance(rows, list):
                        raise ValueError("invalid analytics rows")
                    used = sum(float(row.get("sum", {}).get("requests", 0)) for row in rows)
                    if not math.isfinite(used) or used < 0:
                        raise ValueError("invalid request count")
                    remaining = max(0, cfg["dailyLimit"] - used)
                    result.update(mode="direct" if remaining <= cfg["remainingThreshold"] else "proxy",
                                  source="cloudflare_graphql_analytics", estimatedUsedRequests=used,
                                  estimatedRemainingRequests=remaining, checkedAt=day["nowIso"], cacheHit=False)
                    self.cache.put(key, result, cfg["cacheTtlSeconds"])
                except Exception as error:
                    result.update(source="analytics_error", cacheHit=False,
                                  error=str(error) if isinstance(error, RuntimeError) else "Cloudflare Analytics API 未返回有效的请求数据")
                finally:
                    if response is not None:
                        response.close()
        if result["mode"] == "direct":
            result.update(notice=self.direct_notice(cfg["newSiteUrl"]), newSiteUrl=cfg["newSiteUrl"])
        return result

    @staticmethod
    def normalize_notice(data):
        data = data if isinstance(data, dict) else {}
        return {"hasNotice": bool(data.get("hasNotice")), "title": str(data.get("title") or "通知")[:200],
                "content": str(data.get("content") or "")[:20000], "showOnce": bool(data.get("showOnce")),
                "noticeId": str(data.get("noticeId") or "")[:200], "checkedAt": now_iso()}

    async def notice(self):
        url = http_url(self.config("NOTICE_API_URL"))
        if not url:
            return self.normalize_notice(None)
        cached = self.cache.get(("notice", url))
        if cached:
            return self.normalize_notice(cached)
        response = None
        try:
            response = await self.upstream.fetch(url, headers={"Accept": "application/json"})
            if not 200 <= response.status < 300:
                raise ValueError("notice status")
            try:
                data = await response.json()
            except (ValueError, UnicodeError):
                data = None
            result = self.normalize_notice(data)
            self.cache.put(("notice", url), result, integer(self.config("NOTICE_API_CACHE_TTL_SECONDS"), 300))
            return result
        except Exception:
            return self.normalize_notice(None)
        finally:
            if response is not None:
                response.close()

    async def render_html(self):
        status, mode, notice = await asyncio.gather(self.token_status(), self.playback(), self.notice())
        retry = {"not_configured": 86400, "login_misconfigured": 60}.get(status["status"], status.get("retryAfterSeconds", 0))
        bootstrap = {"status": status["status"], "retryAfterSeconds": retry,
                     "failureReason": status.get("failureReason", ""),
                     "message": public_failure(status.get("failureReason"))["message"] if status["status"] == "login_failed" else ""}
        result = self.template.replace("__ONLINE_PRESENCE_ENABLED__", "true", 1)
        for name, payload in (("BACKEND_TOKEN_STATUS_BOOTSTRAP", bootstrap), ("PLAYBACK_MODE_BOOTSTRAP", mode), ("NOTICE_BOOTSTRAP", notice)):
            result = result.replace('"__' + name + '__"', inline_json(payload), 1)
        return result

    def count(self):
        return len(set(self.sockets.values()))

    async def broadcast(self):
        payload = {"type": "site_online_count", "online": self.count(), "ts": int(time.time() * 1000)}
        await asyncio.gather(*(ws.send_json(payload) for ws in list(self.sockets) if not ws.closed), return_exceptions=True)

    async def presence(self, request):
        ws = web.WebSocketResponse(autoping=True)
        if not ws.can_prepare(request).ok:
            return json_response({"error": "预期 WebSocket 升级请求！"}, 426, {"Upgrade": "websocket"})
        sid = request.query.get("sid", "").strip()
        if not re.fullmatch(r"[a-zA-Z0-9_-]{12,120}", sid):
            return json_response({"error": "缺少有效的会话标识！"}, 400)
        await ws.prepare(request)
        # 锁仅覆盖连接替换和广播，旧连接在锁外关闭，避免等待 close 握手阻塞新连接。
        async with self.presence_lock:
            old = [other for other, other_sid in self.sockets.items() if other_sid == sid]
            for other in old:
                self.sockets.pop(other, None)
            self.sockets[ws] = sid
            await self.broadcast()
        for other in old:
            await other.close(code=1000, message=b"session replaced")
        try:
            async for message in ws:
                if message.type in {WSMsgType.TEXT, WSMsgType.BINARY}:
                    value = message.data.decode("utf-8", "replace") if isinstance(message.data, bytes) else message.data
                    if value.strip().lower() == "ping":
                        await ws.send_json({"type": "pong", "ts": int(time.time() * 1000)})
                elif message.type == WSMsgType.ERROR:
                    break
        finally:
            async with self.presence_lock:
                if self.sockets.pop(ws, None) is not None:
                    await self.broadcast()
        return ws

    async def proxy(self, target, request):
        connection_tokens = {v.strip().lower() for v in request.headers.get("Connection", "").split(",")}
        excluded = HOP_HEADERS | connection_tokens | {"host", "authorization", "customizedtoken", "content-length"}
        headers = CIMultiDict((k, v) for k, v in request.headers.items() if k.lower() not in excluded)
        custom = request.headers.get("CustomizedToken", "").strip()
        authorization = bearer(custom) if custom else await self.backend_authorization()
        if authorization:
            headers["Authorization"] = authorization
        upstream = await self.upstream.fetch(target, headers=headers)
        if upstream.status == 401 and not custom and self.has_credentials():
            try:
                headers["Authorization"] = await self.login(force=True)
                retry = await self.upstream.fetch(target, headers=headers)
                upstream.close()
                upstream = retry
            except Exception:
                pass
        connection_tokens = {v.strip().lower() for v in upstream.headers.get("Connection", "").split(",")}
        excluded = HOP_HEADERS | connection_tokens
        if upstream.headers.get("Content-Encoding", "").lower() in {"gzip", "deflate", "br"}:
            excluded |= {"content-encoding", "content-length"}
        response = web.StreamResponse(status=upstream.status,
            headers=CIMultiDict((k, v) for k, v in upstream.headers.items() if k.lower() not in excluded))
        try:
            await response.prepare(request)
            async for chunk in upstream.chunks():
                await response.write(chunk)
            await response.write_eof()
        except Exception:
            if not response.prepared:
                raise
            # 响应头已经发送，流中断时关闭连接，避免拼接一个 500 响应损坏视频。
            if request.transport is not None:
                request.transport.close()
            log.warning("代理响应流已中断")
        finally:
            upstream.close()
        return response

    async def static(self, request):
        root = (self.base_dir / "public").resolve()
        try:
            target = (root / request.path.lstrip("/")).resolve()
            if not target.is_relative_to(root):
                return web.Response(text="Forbidden", status=403)
            if target.is_file():
                mime = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
                if target.suffix.lower() in {".js", ".mjs"}:
                    mime = "text/javascript"
                return web.FileResponse(target, headers={"Content-Type": mime})
        except (OSError, ValueError):
            pass
        return web.Response(text="Not Found", status=404)

    async def handle(self, request):
        if not self.authorized(request):
            return web.Response(text="Authentication required", status=401,
                headers={"WWW-Authenticate": 'Basic realm="IwaraProxy", charset="UTF-8"'})
        path = request.path
        is_proxy = path.startswith(("/video/", "/videos", "/file/", "/view"))
        if is_proxy:
            if request.method not in {"GET", "OPTIONS"}:
                return json_response({"error": "仅允许代理GET和OPTIONS请求！"}, 403, {"Allow": "GET, OPTIONS"})
            if request.method == "OPTIONS":
                return web.Response(status=204, headers={"Allow": "GET, OPTIONS", "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, CustomizedToken, X-Version, Range"})
        if path == "/":
            return web.Response(text=await self.render_html(), content_type="text/html", charset="UTF-8", headers={"Cache-Control": "no-store"})
        if path == "/token-status":
            status = await self.token_status()
            if request.query.get("debug") == "1":
                return json_response(self.diagnostics(status), headers={"Cache-Control": "no-store"})
            state = status["status"]
            if state in {"valid", "not_configured"}:
                return web.Response(status=204, headers={"Retry-After": "86400"} if state == "not_configured" else {})
            if state == "login_misconfigured":
                return json_response({"code": "backend_login_misconfigured", "message": "Iwara自动登录配置不完整，请同时设置IWARA_USERNAME和IWARA_PASSWORD！"}, headers={"Retry-After": "60"})
            if state == "login_failed":
                return json_response(dict(public_failure(status["failureReason"]), reason=status["failureReason"] or "unknown"),
                                     headers={"Retry-After": str(status["retryAfterSeconds"])})
            return json_response({"code": "backend_token_expired", "message": "后端设置的token已过期！"})
        if path == "/online-count":
            return json_response({"online": self.count()}, headers={"Cache-Control": "no-store"})
        if path == "/online-presence":
            return await self.presence(request)
        if path == "/playback-mode-debug":
            bypass = bool(self.config("BASIC_AUTH_USER") or self.config("BASIC_AUTH_PASS")) and request.query.get("refresh") == "1"
            state = await self.playback(bypass)
            state.pop("newSiteUrl", None)
            return json_response(dict(state, cacheHit=bool(state.get("cacheHit")), bypassCache=bypass,
                error=state.get("error", ""), config=self.playback_config(), utcDayRange=utc_range()))
        if path.startswith(("/video/", "/videos", "/file/")):
            # 固定 HTTPS 源，避免把本地监听协议/端口错误地带到上游。
            origin = FILE_ORIGIN if path.startswith("/file/") else API_ORIGIN
            return await self.proxy(origin + request.raw_path, request)
        if path.startswith("/view"):
            value = request.query.get("url")
            if not value:
                return json_response({"error": "缺少url参数值！"}, 400)
            try:
                if re.search(r"%(?![0-9a-fA-F]{2})", value):
                    raise ValueError("bad escape")
                decoded = unquote(value, errors="strict")
                url = URL(decoded)
                if not url.is_absolute() or not url.host:
                    raise ValueError("absolute URL required")
                _ = url.port
            except (ValueError, UnicodeError):
                return json_response({"error": "url参数格式错误！"}, 400)
            if not (url.scheme in {"http", "https"} and re.fullmatch(r"[a-z0-9-]+\.iwara\.tv", url.host, re.I)
                    and url.path == "/view" and url.query_string):
                return json_response({"error": "请勿滥用接口！"}, 403)
            return await self.proxy(decoded, request)
        return await self.static(request)

    async def close(self):
        await asyncio.gather(*(ws.close(code=1001, message=b"server shutdown") for ws in list(self.sockets)), return_exceptions=True)
        if self.login_task:
            self.login_task.cancel()
            await asyncio.gather(self.login_task, return_exceptions=True)
