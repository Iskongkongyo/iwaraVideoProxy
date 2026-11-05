# Iwara 播放站：Python 部署版

将相邻 `Nodejs环境` 的服务端逻辑移植为 Python，保留相同的前端页面、接口与配置名。运行时只需要 Python，不依赖 Node.js，也不读取相邻目录。

## 快速开始

需要 Python 3.10 或更新版本。在本目录执行：

```bash
python -m venv .venv
# Windows PowerShell：.\.venv\Scripts\Activate.ps1
# Linux / macOS：source .venv/bin/activate
python -m pip install -r requirements.txt
```

将 `.env.example` 复制为 `.env`，按注释填写，再运行：

```bash
python server.py
```

默认监听 `0.0.0.0:3000`，可通过 `HOST`、`PORT` 修改。脚本始终读取自身目录的 `.env`、`index.html` 和 `public/`；可从其他工作目录启动。已有系统环境变量优先于 `.env`。修改配置后重启生效。

## 文件与功能

| 文件 | 用途 |
| --- | --- |
| `server.py` | 启动 aiohttp 服务、加载 `.env`、管理异步 HTTP 客户端与关闭流程 |
| `worker.py` | 代理、认证、自动登录、页面引导数据、通知缓存及在线人数 |
| `flaresolverr.py` | 挑战检测、clearance 缓存与重试、可选指纹回放、浏览器内容直取 |
| `index.html` | 从 Node 版实际 HTML 模板提取的完整前端，启动时注入引导数据 |
| `requirements.txt` | 必需依赖 aiohttp |
| `requirements-optional.txt` | 额外安装 curl_cffi，用于 Chrome TLS/HTTP2 指纹回放 |

- `/video/…`、`/videos…` 转发至 `https://apiq.iwara.tv`，`/file/…` 转发至 `https://filesq.iwara.tv`，保留路径和查询参数。
- `/view?url=…` 接受前端使用的双重 URL 编码，仅允许单层 `*.iwara.tv` 域名下、含查询参数的 `/view` 地址。与 Node 版一致，代理仅允许 GET 和 OPTIONS。
- 视频按块转发，保留 Range、206、Content-Range 等语义；客户端断开时关闭上游流。压缩响应解压后清理失配的编码与长度头。
- Basic Auth 保护 HTTP 与 WebSocket；站点认证不会传给 Iwara。上游 Token 顺序为：请求的 `CustomizedToken`、有效的手动 Token、自动登录 Token。后端收到 401 时可自动登录并重试一次，自定义 Token 不触发后端续期。
- 自动登录合并并发请求，提前 60 秒更新即将过期的 JWT，失败后冷却 60 秒；账号密码、原始 Token 不出现在诊断响应中。
- `/token-status` 与 `/token-status?debug=1` 提供与 Node 版相同的 Token 状态及诊断字段。
- `/online-count` 返回 `{"online":0}`；`/online-presence?sid=…` 提供 WebSocket。sid 为 12–120 位字母、数字、下划线或连字符，同 sid 替换旧连接（1000 / `session replaced`），人数变化广播 `site_online_count`，文本 `ping` 返回 JSON `pong`。
- 首页注入 Token 状态、播放模式、通知；通知与播放模式使用进程内 TTL 缓存。通知接口 JSON 字段为 `hasNotice`、`title`、`content`、`showOnce`、`noticeId`。
- 其他路径从本目录的 `public/` 提供静态文件，未命中返回 404；首页始终通过模板渲染。

## 配置与 Node 版的对应关系

直接复制 Node 版的业务环境变量即可。建议通过 `.env` 配置，完整选项见 `.env.example`。

`FORCE_PLAYBACK_MODE=direct` 强制视频直连，`proxy` 强制走本站代理；留空且未配置 Cloudflare Analytics 时为 `proxy`，诊断来源为 `analytics_not_configured`。如果完整配置 `CF_ACCOUNT_TAG`、`CF_ANALYTICS_API_TOKEN`、`CF_WORKER_SCRIPT_NAME`，也保留原脚本查询指定 Worker 用量并按阈值切换的能力；这不是 Python 服务自身的请求统计。

`/playback-mode-debug` 返回模式与配置诊断。启用 Basic Auth 后可带 `?refresh=1` 绕过播放模式缓存。

Python 版将 API/文件上游固定为 HTTPS，独立于本站监听端口与反向代理请求头，不需要 Node 适配器的 `PUBLIC_ORIGIN`。外部访问地址由浏览器当前地址决定。

内存缓存、Token 缓存、在线人数均为单进程状态，重启清空。运行一个进程；多进程部署需要另行实现共享状态。

## 可选：FlareSolverr

先将 FlareSolverr 部署在同机或同出口 IP，例如：

```bash
docker run -d --name flaresolverr --restart unless-stopped -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
```

设置 `FLARESOLVERR_URL=http://127.0.0.1:8191` 后重启。未设置时不启用。

检测到 `cf-mitigated: challenge` 或 403/503 挑战 HTML 后，按源合并并发解盾，缓存 cookie 与 User-Agent，再重试请求。可选安装：

```bash
python -m pip install -r requirements-optional.txt
```

Python 使用 `curl_cffi` 替代 Node 的 `impit`，通过 `FLARESOLVERR_USE_CURL_CFFI=auto|on|off` 控制；也兼容旧变量 `FLARESOLVERR_USE_IMPIT`。`auto` 为安装后自动使用，`on` 在缺少依赖时告警并回退。Range 请求始终使用 aiohttp 流式回放。

无 cookie 或回放仍被挑战时，仅对无 body、无 Range 的 GET 尝试使用浏览器正文，并从 Chrome 的 `<pre>` 包装中还原 JSON 和 HTML 实体。成功后同源的同类请求优先内容直取。`FLARESOLVERR_BROWSER_FETCH=off` 可关闭。解盾失败时保留可读的挑战响应。其他选项为 `FLARESOLVERR_HOSTS`、`FLARESOLVERR_SESSION`、`FLARESOLVERR_MAX_TIMEOUT`（毫秒）。clearance 受出口 IP、UA 与指纹约束，无法保证所有上游挑战均可解决。

## 反向代理与守护

可通过 systemd、容器或其他进程管理器运行 `python /绝对路径/server.py`。nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

WebSocket 升级头用于在线人数；关闭代理缓冲可及时转发视频流。

## 验证

本地测试不依赖真实 Iwara 账号或公网服务：

```bash
python -m unittest discover -s tests -v
```

启动服务后可再检查（启用 Basic Auth 时为 curl 增加 `-u 用户名:密码`）：

```bash
curl -I http://127.0.0.1:3000/
curl http://127.0.0.1:3000/online-count
curl -i http://127.0.0.1:3000/token-status
curl http://127.0.0.1:3000/playback-mode-debug
curl -H "X-Site: www.iwara.tv" http://127.0.0.1:3000/video/实际视频ID
```
