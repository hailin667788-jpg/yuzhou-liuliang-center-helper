import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "yuzhou2024";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

// Simple in-memory session store
const sessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function createSession() {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function isValidSession(token) {
  if (!token || !sessions.has(token)) return false;
  const session = sessions.get(token);
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)wb_session=([^;]+)/);
  return match ? match[1] : null;
}

function parseCookies(req) {
  return getSessionToken(req);
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function normalizeHotItem(item, index) {
  const rank = index + 1;
  const keyword = String(item?.word || item?.note || item?.title || "").trim();
  if (!keyword) return null;
  return {
    rank,
    keyword,
    hot: String(item?.num || item?.raw_hot || item?.hot || ""),
    label: item?.label_name || item?.icon_desc || "",
    url: item?.scheme ? `https://s.weibo.com${item.scheme}` : ""
  };
}

async function fetchWeiboRealtimeHot() {
  const resp = await fetch("https://weibo.com/ajax/side/hotSearch", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: "https://weibo.com/hot/search",
      Accept: "application/json, text/plain, */*"
    }
  });
  if (!resp.ok) throw new Error(`微博接口异常: ${resp.status}`);
  const data = await resp.json();
  const list = data?.data?.realtime || data?.data?.band_list || [];
  if (!Array.isArray(list) || list.length === 0) throw new Error("微博接口返回为空或结构变化");
  return list.map((item, idx) => normalizeHotItem(item, idx)).filter(Boolean).slice(0, 50);
}

function normalizeText(input) {
  return String(input || "").toLowerCase().replace(/[＃#\s]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function parseKeywordGroups(rawKeywords) {
  return rawKeywords.map((k) => k.trim()).filter(Boolean).map((item) => {
    const aliases = item.split("|").map((s) => s.trim()).filter(Boolean);
    return aliases.length ? aliases : [item];
  });
}

const CITY_ALIAS_MAP = {
  北京: ["北京", "京城", "帝都"], 上海: ["上海", "魔都"], 广州: ["广州", "羊城"],
  深圳: ["深圳", "鹏城"], 杭州: ["杭州"], 南京: ["南京", "金陵"],
  成都: ["成都", "蓉城"], 重庆: ["重庆", "山城"], 武汉: ["武汉", "江城"],
  西安: ["西安", "长安"], 青岛: ["青岛", "胶澳"], 济南: ["济南", "泉城"],
  苏州: ["苏州"], 天津: ["天津", "津门"], 厦门: ["厦门", "鹭岛"],
  长沙: ["长沙"], 郑州: ["郑州"], 宁波: ["宁波"], 福州: ["福州"], 东莞: ["东莞"]
};

const CITY_CONTEXT_HINTS = ["同城", "本地", "地铁", "交通", "天气", "演唱会", "音乐节", "展览", "开业", "招聘", "学校", "医院", "停电", "停水"];

function getCityAliases(cityName) {
  const trimmed = String(cityName || "").trim();
  if (!trimmed) return [];
  return CITY_ALIAS_MAP[trimmed] ? [trimmed, ...CITY_ALIAS_MAP[trimmed]] : [trimmed];
}

function scoreTopicForCity(keyword, aliases) {
  const normalizedKeyword = normalizeText(keyword);
  let score = 0;
  for (const alias of aliases) {
    const nAlias = normalizeText(alias);
    if (!nAlias) continue;
    if (normalizedKeyword.includes(nAlias)) score += 120;
  }
  if (CITY_CONTEXT_HINTS.some((hint) => keyword.includes(hint))) score += 15;
  return score;
}

function buildCityBoardFromRealtime(realtime, cityName) {
  const aliases = getCityAliases(cityName);
  if (!aliases.length) return { city: [], meta: { mode: "disabled", city: "" } };
  const scored = realtime.map((item) => ({ ...item, cityScore: scoreTopicForCity(item.keyword, aliases) }));
  const hasStrongMatch = scored.some((item) => item.cityScore >= 100);
  const ordered = scored.filter((item) => item.cityScore > 0).sort((a, b) => b.cityScore !== a.cityScore ? b.cityScore - a.cityScore : a.rank - b.rank);
  const ranked = ordered.slice(0, 50).map((item, idx) => ({ rank: idx + 1, keyword: item.keyword, hot: item.hot, label: item.label, url: item.url }));
  return { city: ranked, meta: { mode: hasStrongMatch ? "related" : ranked.length ? "weak-related" : "no-city-data", city: String(cityName) } };
}

function findBestRankByAliases(rows, aliases) {
  const normalizedAliases = aliases.map((a) => normalizeText(a)).filter(Boolean);
  if (!normalizedAliases.length) return null;
  let best = null;
  for (const row of rows) {
    const normalizedWord = normalizeText(row.keyword);
    const matched = normalizedAliases.some((alias) => normalizedWord.includes(alias) || alias.includes(normalizedWord));
    if (!matched) continue;
    if (best === null || row.rank < best) best = row.rank;
  }
  return best;
}

function getKeywordStatus(keywords, realtime, city) {
  return parseKeywordGroups(keywords).map((aliases) => ({
    keyword: aliases[0],
    aliases,
    realtimeRank: findBestRankByAliases(realtime, aliases),
    cityRank: findBestRankByAliases(city, aliases)
  }));
}

async function serveStatic(pathname, res) {
  const filePath = pathname === "/" ? join(__dirname, "index.html") : join(__dirname, pathname);
  const file = await readFile(filePath);
  res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
  res.end(file);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const token = getSessionToken(req);

    // Login endpoint — no auth required
    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      let password = "";
      try { password = JSON.parse(body).password || ""; } catch { password = new URLSearchParams(body).get("password") || ""; }
      const expected = Buffer.from(ACCESS_PASSWORD);
      const provided = Buffer.from(String(password));
      const match = expected.length === provided.length && timingSafeEqual(expected, provided);
      if (!match) return sendJson(res, 401, { error: "密码错误" });
      const newToken = createSession();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `wb_session=${newToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // Logout endpoint
    if (url.pathname === "/api/logout" && req.method === "POST") {
      if (token) sessions.delete(token);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": "wb_session=; Path=/; HttpOnly; Max-Age=0" });
      return res.end(JSON.stringify({ ok: true }));
    }

    // Auth check for all other routes
    if (!isValidSession(token)) {
      if (url.pathname.startsWith("/api/")) return sendJson(res, 401, { error: "未登录" });
      // Serve login page for browser requests
      const loginHtml = await readFile(join(__dirname, "login.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(loginHtml);
    }

    // Hot search API
    if (url.pathname === "/api/weibo/hot") {
      const keywordsRaw = url.searchParams.get("keywords") || "";
      const cityName = (url.searchParams.get("city") || "").trim();
      const keywords = keywordsRaw.split(",").map((k) => k.trim()).filter(Boolean);
      const realtime = await fetchWeiboRealtimeHot();
      const cityBuilt = buildCityBoardFromRealtime(realtime, cityName);
      return sendJson(res, 200, {
        source: "https://weibo.com/ajax/side/hotSearch",
        fetchedAt: new Date().toISOString(),
        realtime,
        city: cityBuilt.city,
        cityMeta: cityBuilt.meta,
        keywordStatus: getKeywordStatus(keywords, realtime, cityBuilt.city)
      });
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    if (String(error.message || "").includes("ENOENT")) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not Found");
    }
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

function getLanIPv4List() {
  const nets = networkInterfaces();
  const results = [];
  for (const values of Object.values(nets)) {
    for (const info of values || []) {
      if (info.family === "IPv4" && !info.internal) results.push(info.address);
    }
  }
  return [...new Set(results)];
}

server.listen(PORT, HOST, () => {
  console.log(`\n🚀 宇宙流量中心小助手已启动`);
  console.log(`   本机访问: http://localhost:${PORT}`);
  const lanIps = getLanIPv4List();
  if (lanIps.length) lanIps.forEach((ip) => console.log(`   局域网访问: http://${ip}:${PORT}`));
  console.log(`   访问密码: ${ACCESS_PASSWORD}`);
  console.log(`   (可通过环境变量 ACCESS_PASSWORD 修改密码)\n`);
});
