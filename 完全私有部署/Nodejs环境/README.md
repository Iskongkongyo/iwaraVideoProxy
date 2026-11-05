# Iwara 播放站 —— Node.js 部署版

由 Cloudflare Worker 版 `worker.js` 转换而来。业务逻辑一行未改，仍在
`worker.mjs` 里（就是原 worker.js 加了个说明头）；`server.mjs` 是 Node
运行时适配层，负责把 Cloudflare 专属的四样东西补齐：

| Cloudflare 能力 | Node 版实现 |
| --- | --- |
| `export default fetch` | Node http 服务器把请求翻译成标准 Request 调用它 |
| Cache API（`caches.default`） | 进程内内存缓存，按响应 max-age 过期 |
| Durable Object 在线人数 | 用 `ws` 实现：sid 去重计数、重复 sid 踢旧连接（1000 / session replaced）、连接与断开广播 `site_online_count`、`ping` 回 `pong` |
| `env.ASSETS` 静态资源 | `./public` 目录，未命中返回 404 |

## 运行要求

- Node.js >= 18（建议 20+）
- 必需依赖：`ws`（WebSocket）；可选依赖 `impit` 用于 Chrome 指纹回放

## 快速开始

```bash
npm install
cp .env.example .env   # 按注释填入配置（从 CF 迁移就把原变量/Secret 原样搬过来）
npm start              # 默认监听 0.0.0.0:3000，PORT 可在 .env 里改
```

配置项与 CF 版完全一致：`BASIC_AUTH_USER`、`BASIC_AUTH_PASS`、
`IWARA_AUTHORIZATION`、`IWARA_USERNAME`、`IWARA_PASSWORD`、
`NOTICE_API_URL`、`NEW_SITE_URL`、`FORCE_PLAYBACK_MODE` 等，
也可以直接改 `worker.mjs` 顶部的常量默认值（与原 worker.js 相同位置）。

## 放到公网（推荐：反代 + 进程守护）

1. 进程守护二选一：
   - pm2：`pm2 start server.mjs --name iwara-node && pm2 save`
   - systemd：写一个简单的 service，`ExecStart=/usr/bin/node /path/to/server.mjs`，
     `WorkingDirectory=/path/to`，`Restart=always`。
2. 前面套 nginx/Caddy 反代到 `127.0.0.1:3000`，**务必透传 WebSocket 升级**
   （在线人数要用），并透传 `X-Forwarded-Proto` / `X-Forwarded-Host`。
   nginx 示例：

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header X-Forwarded-Host $host;
       proxy_buffering off;          # 视频流不要缓冲
       proxy_read_timeout 3600s;
   }
   ```

3. 可选：在 `.env` 里把 `PUBLIC_ORIGIN` 填成公开地址（如
   `https://ss.example.com`），让服务端内部构造的请求地址与公开地址严格一致。

## 可选：Cloudflare 挑战自动过盾（FlareSolverr）

Node 直连上游时，指纹和机房 IP 容易被 Cloudflare 弹人机挑战
（`Just a moment…` / 403）。本包内置了可选的过盾模块
（`flaresolverr.mjs`，由 `server.mjs` 包裹全局 `fetch` 实现，
业务代码无感）：

1. 先同机部署 FlareSolverr（它用真实 Chromium 解挑战）：

   ```bash
   docker run -d --name flaresolverr --restart unless-stopped \
     -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
   ```

2. 在 `.env` 里填 `FLARESOLVERR_URL=http://127.0.0.1:8191` 后重启本服务，
   启动日志会出现 `FlareSolverr 过盾已启用`。

工作方式：正常请求完全不受影响；一旦某个上游响应被识别为挑战
（响应头 `cf-mitigated: challenge`，或 403/503 的挑战页 HTML），
模块按三级策略处理：

1. **常规取盾回放**：调用 FlareSolverr 取得该源的 `cf_clearance` 等
   cookie 与 User-Agent，注入后把原请求重试一次，并按源缓存复用
   （过期或再次被挑战才重新取）；同一源并发被挑战只触发一次解盾。
2. **指纹回放**：有些站点把 clearance 与客户端 TLS 指纹绑定校验，
   Node 原生指纹即使带着有效 clearance 回放也会被拒（实测
   apiq.iwara.tv 即是，curl 回放却可以）。若装有可选依赖 `impit`
   （`npm install` 会自动装，平台不支持时自动跳过），回放重试改走
   impit 冒充 Chrome 指纹。可用 `FLARESOLVERR_USE_IMPIT=off` 关掉。
3. **内容直取**：有些主机对真实浏览器是「静默放行」的——根本不签发
   cookie，无盾可回放。此时直接采用 FlareSolverr 浏览器取回的正文
   合成响应返回（仅限无 body、无 Range 的 GET，如视频信息 JSON），
   并记住该源、后续同类请求直接直取。可用
   `FLARESOLVERR_BROWSER_FETCH=off` 关掉。

取盾失败时原样返回挑战响应（响应体完整可读），不会掩盖问题，
也不会把异常抛给业务代码。

注意两点硬约束：

- **必须同机/同出口**：`cf_clearance` 绑定「UA + 出口 IP」，FlareSolverr
  部署在别的机器上取的盾拿回来不能用。
- **IP 信誉无解时软件也没办法**：若出口是信誉很差的机房 IP，可能连
  FlareSolverr 都解不开（2026 年 7 月后这类报告变多），日志会提示
  「带 clearance 重试后仍被挑战」，此时只能换出口（住宅 IP/代理）。

可选细调：`FLARESOLVERR_HOSTS=iwara.tv` 只对指定域名后缀过盾；
`FLARESOLVERR_SESSION` 复用 FlareSolverr 浏览器会话；
`FLARESOLVERR_MAX_TIMEOUT` 调解盾超时（默认 60000 毫秒）。

## 与 CF 版的行为差异（已知，仅两点）

1. **Node 服务自身不受 Workers 免费请求额度限制**：未配置 Cloudflare Analytics
   时，`playback-mode-debug` 会显示 `analytics_not_configured`，默认使用 `proxy`。
   原业务逻辑仍保留 Analytics 查询：完整设置 `CF_ACCOUNT_TAG`、
   `CF_ANALYTICS_API_TOKEN`、`CF_WORKER_SCRIPT_NAME` 后，可依据指定 Worker 的用量
   自动切换，统计对象不是 Node 服务自身。需要固定直连时，在 `.env` 设
   `FORCE_PLAYBACK_MODE=direct`；设为 `proxy` 则固定代理模式。
2. **内存缓存不跨进程/不持久**：CF 的 Cache API 是边缘共享缓存；
   Node 版是单进程内存，重启即清零。播放模式决策和通知接口默认各缓存 300 秒。
   自动登录 Token、FlareSolverr 状态与在线人数也保存在当前进程中，部署时运行单进程。

其余行为与 CF 版一致：Basic Auth、Iwara Token/自动登录续期、
`/view`、`/video`、`/file` 代理（含 Range 透传）、`/token-status`、
`/playback-mode-debug`、`/online-count`、`/online-presence`、
静态页与全部前端逻辑都原样保留。

## 部署自检（对着运行中的服务跑）

```bash
curl -I http://127.0.0.1:3000/                 # 200，站点首页
curl http://127.0.0.1:3000/online-count        # {"online":0}
curl http://127.0.0.1:3000/token-status        # 未配置 Token 时 204
curl http://127.0.0.1:3000/video/<视频ID> -H "X-Site: www.iwara.tv"   # 视频信息 JSON
curl http://127.0.0.1:3000/view?url=<双重编码的官方 /view 地址> -H "Range: bytes=0-7" -i   # 206 + Content-Range
```
