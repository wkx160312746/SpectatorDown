const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = __dirname;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const content = fs.readFileSync(filePath, "utf8");
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] != null) {
      return;
    }
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
}

loadEnvFile(path.join(ROOT, ".env"));

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const REMOTE_BASE_URL = process.env.REMOTE_BASE_URL || "";
const API_SUGGEST_PATH = process.env.API_SUGGEST_PATH || "";
const API_SEARCH_PATH = process.env.API_SEARCH_PATH || "";
const API_DETAIL_PATH = process.env.API_DETAIL_PATH || "";
const API_EPISODES_PATH = process.env.API_EPISODES_PATH || "";
const CLIENT_INFO = process.env.CLIENT_INFO || "codex-probe-device";
const CHANNEL = process.env.CHANNEL || "codex";
const VERSION_CODE = process.env.VERSION_CODE || "0";
const VERSION_NAME = process.env.VERSION_NAME || "0";
const DEVICE_TYPE = process.env.DEVICE_TYPE || "android";
const OS_TYPE = process.env.OS_TYPE || "1";
const DETAIL_USER_ID = process.env.DETAIL_USER_ID || "";
const DETAIL_PLAY_ORDER = process.env.DETAIL_PLAY_ORDER || "1";
const EPISODE_USER_ID = process.env.EPISODE_USER_ID || "0";
const EPISODE_QUERY_ALL = process.env.EPISODE_QUERY_ALL || "false";
const EPISODE_PAGE_SIZE = process.env.EPISODE_PAGE_SIZE || "120";
const DOWNLOAD_HOST_ALLOWLIST = ["tv-video.cdn.drama.9ddm.com", "video.cdn.drama.9ddm.com"];
const ACCESS_KEY = process.env.ACCESS_KEY || "";
const AUTH_ENABLED = ACCESS_KEY.length > 0;
const SESSION_SECRET = process.env.SESSION_SECRET || "codex-demo-session-secret";
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "drama_demo_session";
const COOKIE_SECURE =
  process.env.COOKIE_SECURE === "true" || (process.env.NODE_ENV === "production" && HOST !== "127.0.0.1");
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 12);
const AUTH_TOKEN = crypto.createHash("sha256").update(`${ACCESS_KEY}:${SESSION_SECRET}`).digest("hex");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function getConfiguredUrlOrThrow(relativePath) {
  if (!REMOTE_BASE_URL) {
    throw new Error("REMOTE_BASE_URL is not configured");
  }
  if (!relativePath) {
    throw new Error("upstream API path is not configured");
  }
  return new URL(relativePath, REMOTE_BASE_URL);
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").reduce((acc, item) => {
    const trimmed = item.trim();
    if (!trimmed) {
      return acc;
    }
    const index = trimmed.indexOf("=");
    const key = index >= 0 ? trimmed.slice(0, index) : trimmed;
    const value = index >= 0 ? trimmed.slice(index + 1) : "";
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function buildCookie(value, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, maxAgeSeconds)}`,
  ];
  if (COOKIE_SECURE) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function setSessionCookie(res) {
  res.setHeader("Set-Cookie", buildCookie(AUTH_TOKEN, SESSION_TTL_SECONDS));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", buildCookie("", 0));
}

function isAuthorized(req) {
  if (!AUTH_ENABLED) {
    return true;
  }
  const cookies = parseCookies(req);
  return cookies[SESSION_COOKIE_NAME] === AUTH_TOKEN;
}

function ensureAuthorized(req, res) {
  if (isAuthorized(req)) {
    return true;
  }
  clearSessionCookie(res);
  sendJson(res, 401, { code: 401, msg: "unauthorized" });
  return false;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function buildCommonQuery() {
  return {
    clientInfo: CLIENT_INFO,
    channel: CHANNEL,
    version_code: VERSION_CODE,
    version_name: VERSION_NAME,
    device_type: DEVICE_TYPE,
    os_type: OS_TYPE,
  };
}

async function proxyJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    payload = { code: response.status, msg: "invalid json", raw: text };
  }
  return { response, payload };
}

async function proxyDownload(res, remoteUrl, filename) {
  const response = await fetch(remoteUrl);
  if (!response.ok || !response.body) {
    sendText(res, response.status || 502, `download failed: HTTP ${response.status}`);
    return;
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const safeName = filename.replace(/[^\w.-]+/g, "_");
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${safeName}"`,
    "Cache-Control": "no-store",
  });

  for await (const chunk of response.body) {
    res.write(chunk);
  }
  res.end();
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || "text/plain; charset=utf-8";
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      code: 200,
      data: {
        ok: true,
        authEnabled: AUTH_ENABLED,
      },
    });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    return sendJson(res, 200, {
      code: 200,
      data: {
        authEnabled: AUTH_ENABLED,
        authorized: isAuthorized(req),
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (!AUTH_ENABLED) {
      return sendJson(res, 200, {
        code: 200,
        data: {
          authEnabled: false,
          authorized: true,
        },
      });
    }
    const body = await readJsonBody(req);
    if ((body.key || "") !== ACCESS_KEY) {
      clearSessionCookie(res);
      return sendJson(res, 401, { code: 401, msg: "invalid access key" });
    }
    setSessionCookie(res);
    return sendJson(res, 200, {
      code: 200,
      data: {
        authEnabled: true,
        authorized: true,
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    clearSessionCookie(res);
    return sendJson(res, 200, {
      code: 200,
      data: {
        authEnabled: AUTH_ENABLED,
        authorized: false,
      },
    });
  }

  if (!ensureAuthorized(req, res)) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/suggest") {
    const remoteUrl = getConfiguredUrlOrThrow(API_SUGGEST_PATH);
    const commonQuery = buildCommonQuery();
    Object.entries(commonQuery).forEach(([key, value]) => {
      remoteUrl.searchParams.set(key, value);
    });
    const { response, payload } = await proxyJson(remoteUrl);
    return sendJson(res, response.status, payload);
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    const keyword = (url.searchParams.get("keyword") || "").trim();
    const remoteUrl = getConfiguredUrlOrThrow(API_SEARCH_PATH);
    const commonQuery = buildCommonQuery();
    Object.entries(commonQuery).forEach(([key, value]) => {
      remoteUrl.searchParams.set(key, value);
    });
    const body = {
      searchWord: keyword,
      audience: "",
      subject: "",
      shortPlayType: "",
      page: Number(url.searchParams.get("page") || 1),
      pageSize: Number(url.searchParams.get("pageSize") || 20),
      order: "",
      sessionHistory: null,
    };
    const { response, payload } = await proxyJson(remoteUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return sendJson(res, response.status, payload);
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/detail/")) {
    const oneId = url.pathname.split("/").pop();
    const remoteUrl = getConfiguredUrlOrThrow(API_DETAIL_PATH);
    remoteUrl.searchParams.set("userId", DETAIL_USER_ID);
    remoteUrl.searchParams.set("deviceId", CLIENT_INFO);
    remoteUrl.searchParams.set("oneId", oneId);
    remoteUrl.searchParams.set("playOrder", DETAIL_PLAY_ORDER);
    const { response, payload } = await proxyJson(remoteUrl);
    return sendJson(res, response.status, payload);
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/episodes/")) {
    const oneId = url.pathname.split("/").pop();
    const remoteUrl = getConfiguredUrlOrThrow(API_EPISODES_PATH);
    const commonQuery = buildCommonQuery();
    Object.entries(commonQuery).forEach(([key, value]) => {
      remoteUrl.searchParams.set(key, value);
    });
    remoteUrl.searchParams.set("oneId", oneId);
    remoteUrl.searchParams.set("page", String(Number(url.searchParams.get("page") || 1)));
    remoteUrl.searchParams.set(
      "pageSize",
      String(Number(url.searchParams.get("pageSize") || EPISODE_PAGE_SIZE))
    );
    remoteUrl.searchParams.set("userId", url.searchParams.get("userId") || EPISODE_USER_ID);
    remoteUrl.searchParams.set("queryAll", url.searchParams.get("queryAll") || EPISODE_QUERY_ALL);
    const { response, payload } = await proxyJson(remoteUrl);
    return sendJson(res, response.status, payload);
  }

  if (req.method === "GET" && url.pathname === "/api/download") {
    const rawUrl = url.searchParams.get("url") || "";
    const filename = url.searchParams.get("filename") || "video.mp4";
    let remoteUrl;
    try {
      remoteUrl = new URL(rawUrl);
    } catch (error) {
      return sendText(res, 400, "invalid url");
    }

    if (!["http:", "https:"].includes(remoteUrl.protocol)) {
      return sendText(res, 400, "unsupported protocol");
    }

    if (!DOWNLOAD_HOST_ALLOWLIST.includes(remoteUrl.hostname)) {
      return sendText(res, 403, "host not allowed");
    }

    await proxyDownload(res, remoteUrl, filename);
    return;
  }

  return sendJson(res, 404, { code: 404, msg: "unknown api" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error) => {
      sendJson(res, 500, { code: 500, msg: error.message || "proxy failed" });
    });
    return;
  }

  const relativePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(ROOT, relativePath);
  return serveFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`minimal_search_demo listening on http://${HOST}:${PORT}`);
});
