// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import fs from "fs";

const app = express();

// ---------- 中间件 ----------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- 异步加载 index.html ----------
let indexHTML = "";
fs.readFile("./index.html", "utf8", (err, data) => {
  if (!err) indexHTML = data;
});

// 首页
app.get("/", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(indexHTML || "<h1>Loading...</h1>");
});

// ------------------------------------------------------
// 通用 JSON 反代函数（api.iwara.tv / allOrigins 都复用）
// ------------------------------------------------------
async function proxyJSON(req, res, targetUrl) {
  try {
    console.log("反代请求：", targetUrl);

    const resp = await fetch(targetUrl, {
      method: req.method,
      headers: filterHeaders(req),
    });

    // 自动判断 JSON / TEXT
    const contentType = resp.headers.get("content-type");
    let body;
    if (contentType && contentType.includes("application/json")) {
      body = await resp.json();
    } else {
      body = await resp.text();
    }

    console.log("反代响应长度：", typeof body === "string" ? body.length : JSON.stringify(body).length);

    res.status(resp.status).send(body);

  } catch (err) {
    console.error("反代出错：", err);
    res.status(500).json({ error: err.toString() });
  }
}

// ------------------------------
// 1) /video → 反代 api.iwara.tv，（需要使用第三方反代过Cloudflare的人机挑战），“https://api.allorigins.win/raw?url=”反代接口可访问“https://github.com/gnuns/allOrigins/tree/main”自行部署
// ------------------------------
app.use(/^\/video(.*)/, async (req, res) => {
  const target = `https://api.allorigins.win/raw?url=${
    encodeURIComponent("https://api.iwara.tv" + req.originalUrl)
  }`;

  proxyJSON(req, res, target);
});

// ---------------------------------------
// 2) /file/... → 反代 files.iwara.tv
// ---------------------------------------
app.use("/file", async (req, res) => {
  const remote = "https://files.iwara.tv" + req.originalUrl;

  proxyJSON(req, res, remote);
});

// --------------------------------------------------------------
// 3) /view?url=... → 视频文件流式反代（支持 Range）
// --------------------------------------------------------------
app.get("/view", async (req, res) => {
  try {
    const finUrl = req.query.url;
    if (!finUrl) return res.status(400).json({ error: "Missing ?url=" });

    // 透传 Range 头
    const headers = {};
    if (req.headers.range) {
      headers["Range"] = req.headers.range;
    }

    // 设置超时（15 秒）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const upstream = await fetch(finUrl, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    clearTimeout(timeout);

    // 透传远程响应头
    upstream.headers.forEach((v, k) => res.setHeader(k, v));

    res.status(upstream.status);

    // 视频流管道
    const stream = upstream.body;

    // 错误监听：防止 Node 崩溃
    stream.on("error", err => {
      console.error("视频流传输错误：", err);
      res.destroy(err);
    });

    stream.pipe(res);

  } catch (err) {
    console.error("视频代理出错：", err);
    res.status(500).json({ error: err.toString() });
  }
});

// -------------------------------
// 请求头过滤（删除可能导致错误的头）
// -------------------------------
function filterHeaders(req) {
  const headers = {
    "User-Agent": req.headers["user-agent"] ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": req.headers["accept"] || "*/*",
  };

  // 透传 Range（视频用）
  if (req.headers.range) headers.range = req.headers.range;

  // 若客户端带 Origin/Referer，则透传（更真实）
  if (req.headers.referer) headers.Referer = req.headers.referer;
  if (req.headers.origin) headers.Origin = req.headers.origin;

  // 透传授权头
  if (req.headers.authorization) {
    headers.Authorization = req.headers.authorization;
  }

  // 避免产生 encoding 错误
  delete headers.host;
  delete headers["accept-encoding"];

  return headers;
}

// ------------------ 启动 ------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`反代服务器已启动：http://localhost:${PORT}`);
});
