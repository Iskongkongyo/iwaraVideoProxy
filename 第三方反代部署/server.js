// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import fs from "fs";
import { pipeline } from "stream";
import { promisify } from "util";

const pipe = promisify(pipeline);
const app = express();

const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || ""; // 设置访问的用户名
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || ""; // 设置访问的密码
const IWARA_AUTHORIZATION = process.env.IWARA_AUTHORIZATION || ""; // 设置默认使用Iwara账号的Token
const BACKEND_TOKEN_STATUS_RETRY_AFTER_SECONDS = 86400; // 前端请求检测后端Token有效期间隔(单位秒，默认1天，后端未设置token生效)

// ---------------------------------------------------
// 中间件
// ---------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requireBasicAuth);


function safeEquals(a = "", b = "") {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

function requireBasicAuth(req, res, next) {
  const enabled = !!(BASIC_AUTH_USER || BASIC_AUTH_PASS);
  if (!enabled) return next();

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="IwaraProxy", charset="UTF-8"');
    return res.status(401).send("Authentication required");
  }

  let decoded = "";
  try {
    decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  } catch {
    res.setHeader("WWW-Authenticate", 'Basic realm="IwaraProxy", charset="UTF-8"');
    return res.status(401).send("Authentication required");
  }

  const idx = decoded.indexOf(":");
  const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const pass = idx >= 0 ? decoded.slice(idx + 1) : "";

  if (!safeEquals(user, BASIC_AUTH_USER) || !safeEquals(pass, BASIC_AUTH_PASS)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="IwaraProxy", charset="UTF-8"');
    return res.status(401).send("Authentication required");
  }

  next();
}

function normalizeIwaraAuthorization(value) {
  const v = (value || "").trim();
  if (!v) return "";
  return /^Bearer\s+/i.test(v) ? v : ("Bearer " + v);
}

function resolveUpstreamAuthorization(req) {
  const customized = (req.headers["customizedtoken"] || "").trim();
  if (customized) return normalizeIwaraAuthorization(customized);
  return normalizeIwaraAuthorization(IWARA_AUTHORIZATION || "");
}
function decodeJwtPayload(token) {
  try {
    const raw = (token || "").trim().replace(/^Bearer\s+/i, "");
    if (!raw) return null;
    const parts = raw.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function getBackendTokenStatus() {
  const token = normalizeIwaraAuthorization(IWARA_AUTHORIZATION || "");
  if (!token) return { status: "not_configured" };
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return { status: "expired" };
  const now = Math.floor(Date.now() / 1000);
  return payload.exp > now ? { status: "valid" } : { status: "expired" };
}

// ---------------------------------------------------
// 安全加载 index.html
// ---------------------------------------------------
let indexHTML = "<h1>Loading...</h1>";
try {
  indexHTML = fs.readFileSync("./index.html", "utf8");
} catch (err) {
  console.error("index.html 读取失败：, err);
}

// 后端默认 token 状态检测（给前端访问时提示用）
app.get("/token-status", (req, res) => {
  const status = getBackendTokenStatus();
  if (status.status === "not_configured") {
    return res.status(204).setHeader("Retry-After", String(BACKEND_TOKEN_STATUS_RETRY_AFTER_SECONDS)).end();
  }
  if (status.status === "valid") {
    return res.status(204).end();
  }
  return res.status(200).json({ code: "backend_token_expired", message: "后端设置的token已过期！" });
});

// 首页
app.get("/", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(indexHTML);
});

// ---------------------------------------------------
// 请求头过滤
// ---------------------------------------------------
function filterHeaders(req) {
  const headers = {
    "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
    "Accept": req.headers["accept"] || "*/*",
  };

  if (req.headers.range) headers.range = req.headers.range;
  if (req.headers.referer) headers.Referer = req.headers.referer;
  if (req.headers.origin) headers.Origin = req.headers.origin;
  const upstreamAuthorization = resolveUpstreamAuthorization(req);
  if (upstreamAuthorization) headers.Authorization = upstreamAuthorization;
  if (req.headers["x-version"]) headers["X-Version"] = req.headers["x-version"];

  delete headers.host;
  delete headers["accept-encoding"];

  return headers;
}

// ---------------------------------------------------
// 判断反代域名是否为iwara
// ---------------------------------------------------
function isIwaraUrl(encodedUrl) {
  try {
    const decoded = decodeURIComponent(encodedUrl); // 解码
    const urlObj = new URL(decoded);// 解析 URL
    return (
      (urlObj.protocol === "http:" || urlObj.protocol === "https:") &&
      urlObj.hostname.endsWith(".iwara.tv")
    );
  } catch (e) {
    return false; // 如果不是合法 URL
  }
}

// ---------------------------------------------------
// 通用 JSON 代理
// ---------------------------------------------------
async function proxyJSON(req, res, targetUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(targetUrl, {
      method: req.method,
      headers: filterHeaders(req),
      signal: controller.signal
    });

    clearTimeout(timeout);

    const contentType = resp.headers.get("content-type") || "";
    const data = contentType.includes("json") ? await resp.json() : await resp.text();

    res.status(resp.status).send(data);
  } catch (err) {
    console.error("proxyJSON 发生错误：, err);
    res.status(500).json({ error: err.message || String(err) });
  }
}

// ---------------------------------------------------
// /video → 反代 apiq.iwara.tv
// ---------------------------------------------------
app.use(/^\/video(.*)/, async (req, res) => {
  const target =
    "https://api.allorigins.win/raw?url=" +
    encodeURIComponent("https://apiq.iwara.tv" + req.originalUrl);

  await proxyJSON(req, res, target);
});

// ---------------------------------------------------
// /file/... → 反代 filesq.iwara.tv
// ---------------------------------------------------
app.use("/file", async (req, res) => {
  const remote = "https://filesq.iwara.tv" + req.originalUrl;
  await proxyJSON(req, res, remote);
});

// ---------------------------------------------------
// /view → 流媒体代理（支持 Range）
// ---------------------------------------------------
app.get("/view", async (req, res) => {
  try {
    const finUrl = req.query.url;
    if (!finUrl) return res.status(400).json({ error: "缺少url参数值" });

    if (!isIwaraUrl(finUrl)) return res.status(403).json({ error: "禁止滥用反代其他域名！"  });

    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(finUrl, {
      method: "GET",
      headers,
      signal: controller.signal
    });

    clearTimeout(timeout);

    resp.headers.forEach((v, k) => res.setHeader(k, v));
    res.status(resp.status);

    // 使用 pipeline 代替 pipe（官方推荐，自动捕获异常）
    await pipe(resp.body, res);

  } catch (err) {
    console.error("视频流代理出错：", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || String(err) });
    } else {
      res.destroy(err);
    }
  }
});

// ---------------------------------------------------
// 全局错误兜底（防止 Node 崩溃）
// ---------------------------------------------------
process.on("uncaughtException", err => {
  console.error("未捕获异常：", err);
});
process.on("unhandledRejection", err => {
  console.error("未处理 Promise 异常：", err);
});

// ---------------------------------------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`服务器已启动：http://localhost:${PORT}`);
});





