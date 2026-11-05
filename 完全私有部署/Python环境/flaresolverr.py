"""异步上游请求、FlareSolverr 挑战重试及可选的 Chrome 指纹回放。"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any

import aiohttp
from multidict import CIMultiDict
from yarl import URL

log = logging.getLogger("flaresolverr")
CHALLENGE_RE = re.compile(
    r"just a moment|challenge-platform|_cf_chl|cf-challenge|"
    r"attention required!?\s*\||enable javascript and cookies to continue", re.I
)


@dataclass
class UpstreamResponse:
    status: int
    headers: CIMultiDict
    source: aiohttp.ClientResponse | None = None
    body: bytes | None = None

    async def read(self) -> bytes:
        if self.body is None:
            self.body = await self.source.read()
        return self.body

    async def json(self) -> Any:
        return json.loads(await self.read())

    def close(self) -> None:
        if self.source is not None:
            self.source.close()

    async def chunks(self):
        if self.body is not None:
            yield self.body
        elif self.source is not None:
            async for chunk in self.source.content.iter_chunked(64 * 1024):
                yield chunk


class UpstreamClient:
    def __init__(self, session: aiohttp.ClientSession, env: dict):
        self.session = session
        self.solver_url = env.get("FLARESOLVERR_URL", "").strip().rstrip("/")
        try:
            timeout_value = int(env.get("FLARESOLVERR_MAX_TIMEOUT") or 60000)
            self.max_timeout = timeout_value if timeout_value > 0 else 60000
        except ValueError:
            self.max_timeout = 60000
        self.solver_session = env.get("FLARESOLVERR_SESSION", "").strip()
        self.hosts = [h.strip().lower() for h in env.get("FLARESOLVERR_HOSTS", "").split(",") if h.strip()]
        self.browser_fetch = env.get("FLARESOLVERR_BROWSER_FETCH", "").lower() not in {"off", "0", "false"}
        # 保留 Node 配置名作为兼容别名；Python 使用 curl_cffi 实现指纹回放。
        self.fingerprint_mode = (env.get("FLARESOLVERR_USE_CURL_CFFI") or env.get("FLARESOLVERR_USE_IMPIT") or "auto").lower()
        self.clearances: dict[str, dict] = {}
        self.browser_origins: set[str] = set()
        self.pending: dict[str, asyncio.Task] = {}
        self.fingerprint = None
        self.fingerprint_checked = False

    async def close(self):
        tasks = list(self.pending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.fingerprint is not None:
            await self.fingerprint.close()

    def applicable(self, url: str) -> bool:
        if not self.solver_url:
            return False
        try:
            target, solver = URL(url), URL(self.solver_url)
            host = (target.host or "").lower()
            return (target.scheme in {"http", "https"} and target.authority != solver.authority
                    and (not self.hosts or any(host == h or host.endswith("." + h) for h in self.hosts)))
        except ValueError:
            return False

    async def native(self, url, method="GET", headers=None, body=None, timeout=None):
        outgoing = CIMultiDict(headers or {})
        # aiohttp 解压后向下游去掉编码头；限定为无需可选解码器的格式。
        outgoing["Accept-Encoding"] = "gzip, deflate"
        response = await self.session.request(
            method, URL(str(url), encoded=True), headers=outgoing, data=body,
            allow_redirects=True, timeout=timeout or self.session.timeout,
        )
        return UpstreamResponse(response.status, CIMultiDict(response.headers), source=response)

    async def challenged(self, response):
        if "challenge" in response.headers.get("cf-mitigated", "").lower():
            return True
        if response.status not in {403, 503} or "text/html" not in response.headers.get("content-type", "").lower():
            return False
        return bool(CHALLENGE_RE.search((await response.read()).decode("utf-8", "replace")))

    async def call_solver(self, target):
        payload = {"cmd": "request.get", "url": target, "maxTimeout": self.max_timeout}
        if self.solver_session:
            payload["session"] = self.solver_session
        response = await self.native(
            self.solver_url + "/v1", "POST", {"Content-Type": "application/json"},
            json.dumps(payload).encode(), aiohttp.ClientTimeout(total=self.max_timeout / 1000 + 30),
        )
        try:
            data = await response.json()
            if data.get("status") != "ok" or not isinstance(data.get("solution"), dict):
                raise RuntimeError("FlareSolverr 未返回有效 solution")
            return data["solution"]
        finally:
            response.close()

    async def solve(self, origin, target):
        async def run():
            log.info("请求 FlareSolverr 处理源：%s", origin)
            solution = await self.call_solver(target)
            host = (URL(target).host or "").lower()
            cookies = []
            for cookie in solution.get("cookies", []):
                domain = str(cookie.get("domain", "")).lstrip(".").lower()
                if cookie.get("name") and (not domain or host == domain or host.endswith("." + domain)):
                    cookies.append(cookie)
            entry = None
            if cookies:
                expiry = time.time() + 1200
                for cookie in cookies:
                    if cookie["name"] == "cf_clearance" and float(cookie.get("expiry", 0)) > 0:
                        expiry = float(cookie["expiry"])
                entry = {"cookie": "; ".join(str(c["name"]) + "=" + str(c.get("value", "")) for c in cookies),
                         "userAgent": str(solution.get("userAgent", "")), "expiresAt": expiry}
                self.clearances[origin] = entry
            return entry, solution, target

        if origin not in self.pending:
            task = asyncio.create_task(run())
            self.pending[origin] = task

            def cleanup(done):
                if self.pending.get(origin) is done:
                    self.pending.pop(origin, None)
                if not done.cancelled():
                    done.exception()  # 即使发起请求的客户端已断开，也回收任务异常。

            task.add_done_callback(cleanup)
        return await asyncio.shield(self.pending[origin])

    @staticmethod
    def merge_headers(headers, entry):
        result = CIMultiDict(headers or {})
        if entry:
            if entry["userAgent"]:
                result["User-Agent"] = entry["userAgent"]
            if entry["cookie"]:
                existing = result.get("Cookie", "")
                result["Cookie"] = (existing + "; " if existing else "") + entry["cookie"]
        return result

    async def replay(self, url, method, headers, body, entry):
        outgoing = self.merge_headers(headers, entry)
        if self.fingerprint_mode != "off" and "Range" not in outgoing:
            if not self.fingerprint_checked:
                self.fingerprint_checked = True
                try:
                    from curl_cffi.requests import AsyncSession
                    self.fingerprint = AsyncSession(impersonate="chrome", discard_cookies=True)
                except ImportError:
                    if self.fingerprint_mode == "on":
                        log.warning("未安装 curl_cffi，指纹回放退回 aiohttp")
            if self.fingerprint is not None:
                try:
                    response = await self.fingerprint.request(method, url, headers=dict(outgoing), data=body, timeout=120)
                    # curl_cffi 已解压正文。
                    result_headers = CIMultiDict(response.headers.multi_items())
                    result_headers.popall("Content-Encoding", None)
                    result_headers.popall("Content-Length", None)
                    return UpstreamResponse(response.status_code, result_headers, body=response.content)
                except Exception as error:
                    log.warning("指纹回放失败，退回 aiohttp：%s", type(error).__name__)
        return await self.native(url, method, outgoing, body)

    @staticmethod
    def synthesize(solution):
        body = solution.get("response", "")
        if not isinstance(body, str) or not body or CHALLENGE_RE.search(body):
            return None
        content_type = "text/html; charset=utf-8"
        pre = re.search(r"<pre\b[^>]*>([\s\S]*?)</pre\s*>", body, re.I)
        for candidate in ([html.unescape(pre[1])] if pre else []) + [body]:
            candidate = candidate.strip()
            if not candidate.startswith(("{", "[")):
                continue
            try:
                json.loads(candidate)
                body, content_type = candidate, "application/json; charset=utf-8"
                break
            except ValueError:
                pass
        try:
            status = int(solution.get("status", 200))
        except (TypeError, ValueError):
            status = 200
        if not 200 <= status <= 599:
            status = 200
        return UpstreamResponse(status, CIMultiDict({"Content-Type": content_type, "X-FlareSolverr": "browser-fetch"}),
                                body=body.encode() if status not in {204, 205, 304} else b"")

    async def fetch(self, url, method="GET", headers=None, body=None):
        url = str(url)
        if not self.applicable(url):
            return await self.native(url, method, headers, body)
        origin = str(URL(url).origin())
        plain_get = method == "GET" and body is None and "Range" not in CIMultiDict(headers or {})
        if self.browser_fetch and plain_get and origin in self.browser_origins:
            try:
                result = self.synthesize(await self.call_solver(url))
                if result:
                    return result
            except Exception as error:
                log.warning("内容直取失败，退回常规请求：%s", type(error).__name__)
        entry = self.clearances.get(origin)
        if entry and entry["expiresAt"] < time.time():
            self.clearances.pop(origin, None)
            entry = None
        response = await self.native(url, method, self.merge_headers(headers, entry), body)
        if not await self.challenged(response):
            return response
        try:
            entry, solution, solved_url = await self.solve(origin, url)
            if entry:
                retry = await self.replay(url, method, headers, body, entry)
                if not await self.challenged(retry):
                    response.close()
                    return retry
                response.close()
                response = retry
                self.clearances.pop(origin, None)
            if self.browser_fetch and plain_get:
                if solved_url != url:
                    solution = await self.call_solver(url)
                result = self.synthesize(solution)
                if result:
                    response.close()
                    self.browser_origins.add(origin)
                    return result
        except Exception as error:
            log.warning("解盾失败，返回原挑战响应：%s", type(error).__name__)
        return response
