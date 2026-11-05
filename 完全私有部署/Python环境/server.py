"""启动方式：python server.py（Python 3.10+，仅必需 aiohttp）。"""

import logging
import os
import re
from pathlib import Path

import aiohttp
from aiohttp import web

from flaresolverr import UpstreamClient
from worker import BASE_DIR, IwaraWorker, integer, json_response

WORKER_KEY = web.AppKey("iwara_worker", IwaraWorker)


def load_env(path: Path):
    """读取同目录 .env，现有系统环境变量优先；规则与 Node 版一致。"""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        match = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if not match:
            continue
        key, value = match.groups()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


@web.middleware
async def errors(request, handler):
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except (ConnectionError, aiohttp.ClientConnectionError):
        if request.transport is None or request.transport.is_closing():
            raise
        logging.getLogger("iwara-python").warning("上游连接失败")
        return json_response({"error": "Internal Server Error"}, 500)
    except Exception as error:
        logging.getLogger("iwara-python").warning("请求处理失败：%s", type(error).__name__)
        return json_response({"error": "Internal Server Error"}, 500)


def create_app(env=None, base_dir=BASE_DIR):
    config = dict(os.environ if env is None else env)
    app = web.Application(middlewares=[errors])

    async def lifecycle(application):
        async with aiohttp.ClientSession(
            cookie_jar=aiohttp.DummyCookieJar(),
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=300),
            skip_auto_headers={"User-Agent"},
        ) as session:
            upstream = UpstreamClient(session, config)
            application[WORKER_KEY] = IwaraWorker(config, upstream, base_dir)
            if upstream.solver_url:
                logging.getLogger("iwara-python").info("FlareSolverr 过盾已启用")
            try:
                yield
            finally:
                await application[WORKER_KEY].close()
                await upstream.close()

    async def shutdown(application):
        await application[WORKER_KEY].close()

    async def handle(request):
        return await request.app[WORKER_KEY].handle(request)

    app.cleanup_ctx.append(lifecycle)
    app.on_shutdown.append(shutdown)
    app.router.add_route("*", "/{path:.*}", handle)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")
    load_env(BASE_DIR / ".env")
    web.run_app(create_app(), host=os.environ.get("HOST") or "0.0.0.0",
                port=integer(os.environ.get("PORT"), 3000), access_log=None)
