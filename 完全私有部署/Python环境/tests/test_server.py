"""本地模拟上游的集成测试，不访问 Iwara 或 FlareSolverr 公网服务。"""

import asyncio
import base64
import gzip
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote

import aiohttp
from aiohttp import WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer
from yarl import URL

import worker
from flaresolverr import UpstreamClient
from server import WORKER_KEY, create_app, load_env


def token(exp):
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return "header." + payload + ".signature"


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hits = []
        self.login_count = 0
        self.login_status = 200
        self.login_token = token(time.time() + 3600)
        self.notice_count = self.analytics_count = 0
        self.proxy_handler = None

        async def upstream(request):
            self.hits.append((request.raw_path, dict(request.headers)))
            if request.path == "/user/login":
                self.login_count += 1
                await asyncio.sleep(0.03)
                data = await request.json()
                self.assertEqual(data, {"email": "mail@example.com", "password": "password"})
                if self.login_status != 200:
                    return web.Response(status=self.login_status, text="denied")
                return web.json_response({"token": self.login_token})
            if request.path == "/notice":
                self.notice_count += 1
                return web.json_response({"hasNotice": True, "title": "公告", "content": "</script><b>hello</b>", "noticeId": "1"})
            if request.path == "/graphql":
                self.analytics_count += 1
                return web.json_response({"data": {"viewer": {"accounts": [{"workersInvocationsAdaptive": [{"sum": {"requests": 99950}}]}]}}})
            if self.proxy_handler:
                return await self.proxy_handler(request)
            return web.json_response({"path": request.raw_path})

        app = web.Application()
        app.router.add_route("*", "/{path:.*}", upstream)
        self.upstream = TestServer(app)
        await self.upstream.start_server()
        self.origin = str(self.upstream.make_url("/")).rstrip("/")
        self.clients = []
        self.patches = [patch.object(worker, "API_ORIGIN", self.origin), patch.object(worker, "FILE_ORIGIN", self.origin),
                        patch.object(worker, "IWARA_LOGIN_URL", self.origin + "/user/login"),
                        patch.object(worker, "ANALYTICS_URL", self.origin + "/graphql")]
        for item in self.patches:
            item.start()

    async def asyncTearDown(self):
        for client in self.clients:
            await client.close()
        await self.upstream.close()
        for item in reversed(self.patches):
            item.stop()

    async def client(self, env=None, **kwargs):
        client = TestClient(TestServer(create_app(env or {}, **kwargs)))
        await client.start_server()
        self.clients.append(client)
        return client

    async def test_home_bootstrap_and_empty_status(self):
        client = await self.client()
        response = await client.get("/")
        text = await response.text()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        for marker in ("__ONLINE_PRESENCE_ENABLED__", "__BACKEND_TOKEN_STATUS_BOOTSTRAP__", "__PLAYBACK_MODE_BOOTSTRAP__", "__NOTICE_BOOTSTRAP__"):
            self.assertNotIn(marker, text)
        self.assertIn('"status":"not_configured"', text)
        self.assertIn('"source":"analytics_not_configured"', text)
        response = await client.get("/token-status")
        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers["Retry-After"], "86400")
        self.assertEqual((await client.head("/")).status, 200)

    async def test_basic_auth_http_and_websocket(self):
        client = await self.client({"BASIC_AUTH_USER": "user", "BASIC_AUTH_PASS": "pass"})
        for path in ("/", "/online-count", "/token-status", "/file/id", "/online-presence"):
            response = await client.get(path)
            self.assertEqual(response.status, 401)
            self.assertIn("IwaraProxy", response.headers["WWW-Authenticate"])
        auth_headers = {"Authorization": "Basic " + base64.b64encode(b"user:pass").decode()}
        response = await client.get("/video/id", headers=auth_headers)
        self.assertEqual(response.status, 200)
        self.assertNotIn("Authorization", self.hits[-1][1])
        with self.assertRaises(aiohttp.WSServerHandshakeError) as failure:
            await client.ws_connect("/online-presence?sid=abcdefghijkl")
        self.assertEqual(failure.exception.status, 401)
        ws = await client.ws_connect("/online-presence?sid=abcdefghijkl", headers=auth_headers)
        self.assertEqual((await ws.receive_json())["online"], 1)
        await ws.close()

    async def test_methods_and_view_validation(self):
        client = await self.client()
        for path in ("/video/id", "/videos", "/file/id", "/view"):
            for method in ("POST", "PUT", "DELETE", "HEAD"):
                self.assertEqual((await client.request(method, path)).status, 403)
            response = await client.options(path)
            self.assertEqual(response.status, 204)
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual((await client.get("/view")).status, 400)
        for value, status in (("%ZZ", 400), ("not a url", 400),
                              ("https://evil.example/view?x=1", 403),
                              ("https://a.b.iwara.tv/view?x=1", 403),
                              ("https://a.iwara.tv/view", 403),
                              ("https://a.iwara.tv/other?x=1", 403)):
            self.assertEqual((await client.get("/view", params={"url": value})).status, status)
        # 只替换发送函数，验证双重解码后实际交给代理的 URL；不连接公网。
        target = "https://a.iwara.tv/view?expires=123&hash=ab%2Fcd"
        called = []

        async def proxy(url, request):
            called.append(url)
            return web.Response(text="ok")

        with patch.object(client.app[WORKER_KEY], "proxy", proxy):
            response = await client.get("/view", params={"url": quote(target, safe="")})
        self.assertEqual(response.status, 200)
        self.assertEqual(called, [target])
        self.assertEqual(self.hits, [])

    async def test_proxy_range_headers_query_and_compression(self):
        seen = []

        async def proxy(request):
            seen.append(request)
            if request.path == "/file/compressed":
                return web.Response(body=gzip.compress(b"decoded data"), headers={"Content-Encoding": "gzip"})
            response = web.Response(body=b"01234567", status=206,
                headers={"Content-Range": "bytes 0-7/100", "Accept-Ranges": "bytes", "Content-Type": "video/mp4"})
            response.headers.add("Set-Cookie", "first=1; Path=/")
            response.headers.add("Set-Cookie", "second=2; Path=/")
            return response

        self.proxy_handler = proxy
        client = await self.client({"IWARA_AUTHORIZATION": "backend"})
        response = await client.get(URL("/file/id?hash=a%2Fb&expires=123", encoded=True), headers={
            "Range": "bytes=0-7", "CustomizedToken": "custom", "Authorization": "Basic secret", "X-Site": "www.iwara.tv"})
        self.assertEqual(response.status, 206)
        self.assertEqual(await response.read(), b"01234567")
        self.assertEqual(response.headers["Content-Range"], "bytes 0-7/100")
        self.assertEqual(len(response.headers.getall("Set-Cookie")), 2)
        self.assertEqual(seen[-1].raw_path, "/file/id?hash=a%2Fb&expires=123")
        self.assertEqual(seen[-1].headers["Authorization"], "Bearer custom")
        self.assertNotIn("CustomizedToken", seen[-1].headers)
        self.assertEqual(seen[-1].headers["Range"], "bytes=0-7")
        self.assertNotEqual(seen[-1].headers["Host"], client.host)
        response = await client.get("/file/compressed")
        self.assertEqual(await response.read(), b"decoded data")
        self.assertNotIn("Content-Encoding", response.headers)
        self.assertNotIn("Content-Length", response.headers)

    async def test_proxy_starts_streaming_before_upstream_finishes(self):
        release = asyncio.Event()

        async def proxy(request):
            response = web.StreamResponse(headers={"Content-Type": "video/mp4"})
            await response.prepare(request)
            await response.write(b"first")
            await release.wait()
            await response.write(b"second")
            return response

        self.proxy_handler = proxy
        client = await self.client()
        response = await client.get("/file/stream")
        try:
            self.assertEqual(await asyncio.wait_for(response.content.readexactly(5), 2), b"first")
        finally:
            release.set()
        self.assertEqual(await response.read(), b"second")

    async def test_login_concurrency_refresh_and_custom_token(self):
        credentials = {"IWARA_USERNAME": "mail@example.com", "IWARA_PASSWORD": "password"}
        client = await self.client(credentials)
        responses = await asyncio.gather(*(client.get("/token-status") for _ in range(8)))
        self.assertTrue(all(r.status == 204 for r in responses))
        self.assertEqual(self.login_count, 1)
        await client.get("/video/id")
        self.assertEqual(self.hits[-1][1]["Authorization"], "Bearer " + self.login_token)
        attempts = []

        async def unauthorized_once(request):
            attempts.append(request.headers.get("Authorization"))
            return web.Response(status=401 if len(attempts) == 1 else 200)

        self.proxy_handler = unauthorized_once
        self.assertEqual((await client.get("/video/id")).status, 200)
        self.assertEqual(self.login_count, 2)
        self.assertEqual(len(attempts), 2)
        attempts.clear()
        self.assertEqual((await client.get("/video/id", headers={"CustomizedToken": "own"})).status, 401)
        self.assertEqual(attempts, ["Bearer own"])
        self.assertEqual(self.login_count, 2)
        diagnostic = await (await client.get("/token-status?debug=1")).json()
        self.assertEqual(diagnostic["authorizationSource"], "auto_login_cache")
        serialized = json.dumps(diagnostic)
        self.assertNotIn(self.login_token, serialized)
        self.assertNotIn("mail@example.com", serialized)
        self.assertNotIn('"password": "password"', serialized)

    async def test_login_failure_cooldown_and_token_states(self):
        self.login_status = 401
        client = await self.client({"IWARA_USERNAME": "mail@example.com", "IWARA_PASSWORD": "password"})
        for _ in range(2):
            response = await client.get("/token-status")
            data = await response.json()
            self.assertEqual(data["reason"], "credentials_rejected")
            self.assertTrue(data["shouldWarnUser"])
            self.assertGreater(int(response.headers["Retry-After"]), 0)
        self.assertEqual(self.login_count, 1)
        # 登录失败仍允许匿名公开内容。
        self.assertEqual((await client.get("/video/public")).status, 200)
        self.assertNotIn("Authorization", self.hits[-1][1])
        expired = await self.client({"IWARA_AUTHORIZATION": token(time.time() - 1)})
        self.assertEqual((await (await expired.get("/token-status")).json())["code"], "backend_token_expired")
        partial = await self.client({"IWARA_USERNAME": "mail@example.com"})
        self.assertEqual((await (await partial.get("/token-status")).json())["code"], "backend_login_misconfigured")
        manual = await self.client({"IWARA_AUTHORIZATION": "opaque", "IWARA_USERNAME": "partial"})
        self.assertEqual((await manual.get("/token-status")).status, 204)

    async def test_notice_and_analytics_cache_and_safe_injection(self):
        client = await self.client({"NOTICE_API_URL": self.origin + "/notice", "CF_ACCOUNT_TAG": "account",
            "CF_ANALYTICS_API_TOKEN": "secret", "CF_WORKER_SCRIPT_NAME": "script", "NEW_SITE_URL": "https://backup.example/"})
        for _ in range(2):
            text = await (await client.get("/")).text()
            self.assertIn('"mode":"direct"', text)
            self.assertIn("\\u003c/script\\u003e", text)
            self.assertNotIn("</script><b>hello", text)
        self.assertEqual(self.notice_count, 1)
        self.assertEqual(self.analytics_count, 1)
        data = await (await client.get("/playback-mode-debug?refresh=1")).json()
        self.assertTrue(data["cacheHit"])
        self.assertFalse(data["bypassCache"])
        self.assertEqual(data["estimatedRemainingRequests"], 50)
        self.assertNotIn("secret", json.dumps(data))
        authenticated = await self.client(dict(client.app[WORKER_KEY].env, BASIC_AUTH_USER="u", BASIC_AUTH_PASS="p"))
        auth_headers = {"Authorization": "Basic " + base64.b64encode(b"u:p").decode()}
        await authenticated.get("/playback-mode-debug", headers=auth_headers)
        data = await (await authenticated.get("/playback-mode-debug?refresh=1", headers=auth_headers)).json()
        self.assertTrue(data["bypassCache"])
        self.assertEqual(self.analytics_count, 3)

    async def test_websocket_count_replacement_ping_and_disconnect(self):
        client = await self.client()
        self.assertEqual((await client.get("/online-presence")).status, 426)
        with self.assertRaises(aiohttp.WSServerHandshakeError) as failure:
            await client.ws_connect("/online-presence?sid=short")
        self.assertEqual(failure.exception.status, 400)
        first = await client.ws_connect("/online-presence?sid=abcdefghijkl")
        self.assertEqual((await first.receive_json())["online"], 1)
        second = await client.ws_connect("/online-presence?sid=mnopqrstuvwx")
        self.assertEqual((await second.receive_json())["online"], 2)
        self.assertEqual((await first.receive_json())["online"], 2)
        replacement = await client.ws_connect("/online-presence?sid=abcdefghijkl")
        self.assertEqual((await replacement.receive_json())["online"], 2)
        closed = await asyncio.wait_for(first.receive(), 2)
        self.assertEqual(closed.type, WSMsgType.CLOSE)
        self.assertEqual(closed.data, 1000)
        self.assertEqual(closed.extra, "session replaced")
        await replacement.send_str(" PiNg ")
        self.assertEqual((await asyncio.wait_for(replacement.receive_json(), 2))["type"], "pong")
        self.assertEqual((await (await client.get("/online-count")).json())["online"], 2)
        await replacement.close()
        # second 先读到替换连接时的广播，再读到断开后的广播。
        self.assertEqual((await second.receive_json())["online"], 2)
        self.assertEqual((await second.receive_json())["online"], 1)
        await second.close()
        self.assertEqual((await (await client.get("/online-count")).json())["online"], 0)

    async def test_static_root_containment_and_env_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.html").write_text("__ONLINE_PRESENCE_ENABLED__", encoding="utf-8")
            (root / "public").mkdir()
            (root / "public" / "asset.txt").write_text("asset", encoding="utf-8")
            (root / "secret.txt").write_text("secret", encoding="utf-8")
            client = await self.client(base_dir=root)
            self.assertEqual(await (await client.get("/asset.txt")).text(), "asset")
            response = await client.get("/%2e%2e/secret.txt")
            self.assertIn(response.status, {403, 404})
            self.assertNotIn("secret", await response.text())
            self.assertEqual((await client.get("/missing")).status, 404)
            env_file = root / ".env"
            env_file.write_text('# comment\nPORT=1234\nIWARA_PASSWORD=" with spaces "\n', encoding="utf-8-sig")
            with patch.dict(os.environ, {"PORT": "5678"}, clear=True):
                load_env(env_file)
                self.assertEqual(os.environ["PORT"], "5678")
                self.assertEqual(os.environ["IWARA_PASSWORD"], " with spaces ")


class FlareSolverrTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.solves = 0
        self.hits = []
        self.mode = "cookie"

        async def handle(request):
            if request.path == "/v1":
                self.solves += 1
                payload = await request.json()
                self.assertEqual(payload["cmd"], "request.get")
                await asyncio.sleep(0.04)
                if self.mode == "failure":
                    return web.json_response({"status": "error", "message": "failed"})
                solution = {"status": 200, "userAgent": "SolverBrowser", "cookies": [],
                            "response": '<html><pre>{"url":"https://example/?x=1&amp;y=2","name":"&#x732b;"}</pre></html>'}
                if self.mode in {"cookie", "still_challenged"}:
                    solution["cookies"] = [{"name": "cf_clearance", "value": "good", "domain": "127.0.0.1", "expiry": time.time() + 300}]
                return web.json_response({"status": "ok", "solution": solution})
            self.hits.append(dict(request.headers))
            if self.mode == "cookie" and "cf_clearance=good" in request.headers.get("Cookie", ""):
                return web.json_response({"ok": True})
            return web.Response(status=403, text="<html>Just a moment challenge-platform</html>", content_type="text/html")

        app = web.Application()
        app.router.add_route("*", "/{path:.*}", handle)
        self.target = TestServer(app)
        self.solver = TestServer(app)
        await self.target.start_server()
        await self.solver.start_server()
        self.session = aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar())
        self.clients = []

    async def asyncTearDown(self):
        for client in self.clients:
            await client.close()
        await self.session.close()
        await self.target.close()
        await self.solver.close()

    def client(self, **env):
        config = {"FLARESOLVERR_URL": str(self.solver.make_url("/")).rstrip("/"), "FLARESOLVERR_USE_CURL_CFFI": "off"}
        config.update(env)
        client = UpstreamClient(self.session, config)
        self.clients.append(client)
        return client

    async def test_clearance_cache_concurrency_and_user_agent(self):
        client = self.client()
        responses = await asyncio.gather(*(client.fetch(str(self.target.make_url("/data")), headers={"Cookie": "existing=1"}) for _ in range(6)))
        for response in responses:
            self.assertEqual(await response.json(), {"ok": True})
            response.close()
        self.assertEqual(self.solves, 1)
        self.assertIn("existing=1; cf_clearance=good", self.hits[-1]["Cookie"])
        self.assertEqual(self.hits[-1]["User-Agent"], "SolverBrowser")
        response = await client.fetch(str(self.target.make_url("/data")))
        self.assertEqual(response.status, 200)
        response.close()
        self.assertEqual(self.solves, 1)

    async def test_browser_fallback_json_entities_and_remembered_origin(self):
        self.mode = "browser"
        client = self.client()
        for _ in range(2):
            response = await client.fetch(str(self.target.make_url("/data")))
            self.assertEqual(response.headers["X-FlareSolverr"], "browser-fetch")
            self.assertEqual(await response.json(), {"url": "https://example/?x=1&y=2", "name": "猫"})
        self.assertEqual(len(self.hits), 1)
        self.assertEqual(self.solves, 2)

    async def test_solver_failure_preserves_readable_body(self):
        self.mode = "failure"
        response = await self.client().fetch(str(self.target.make_url("/data")))
        self.assertEqual(response.status, 403)
        self.assertIn(b"Just a moment", await response.read())
        response.close()

    async def test_range_does_not_use_browser_body_or_fingerprint(self):
        self.mode = "still_challenged"
        client = self.client(FLARESOLVERR_USE_CURL_CFFI="on")
        response = await client.fetch(str(self.target.make_url("/data")), headers={"Range": "bytes=0-7"})
        self.assertEqual(response.status, 403)
        self.assertNotIn("X-FlareSolverr", response.headers)
        self.assertFalse(client.fingerprint_checked)
        self.assertIn(b"Just a moment", await response.read())
        response.close()

    async def test_host_filter_and_disabled_browser_fetch(self):
        client = self.client(FLARESOLVERR_HOSTS="iwara.tv")
        response = await client.fetch(str(self.target.make_url("/data")))
        self.assertEqual(response.status, 403)
        response.close()
        self.assertEqual(self.solves, 0)
        self.mode = "browser"
        response = await self.client(FLARESOLVERR_BROWSER_FETCH="off").fetch(str(self.target.make_url("/data")))
        self.assertEqual(response.status, 403)
        self.assertIn(b"Just a moment", await response.read())
        response.close()

    async def test_optional_fingerprint_replay(self):
        try:
            import curl_cffi  # noqa: F401
        except ImportError:
            self.skipTest("未安装可选 curl_cffi")
        client = self.client(FLARESOLVERR_USE_CURL_CFFI="on")
        response = await client.fetch(str(self.target.make_url("/data")))
        self.assertEqual(await response.json(), {"ok": True})
        self.assertIsNotNone(client.fingerprint)
        response.close()


if __name__ == "__main__":
    unittest.main()
