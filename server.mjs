import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
const COOKIE_FILE = join(__dirname, ".weibo_cookie");
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "yuzhou2024";

// 优先用环境变量，其次读本地文件
let weiboCookie = (process.env.WEIBO_COOKIE || "").replace(/[\r\n\s]+/g, " ").trim();
if (!weiboCookie) {
  try {
    weiboCookie = (await readFile(COOKIE_FILE, "utf8")).replace(/[\r\n]+/g, " ").trim();
    if (weiboCookie) console.log(`[startup] 从 .weibo_cookie 文件读取 Cookie（长度 ${weiboCookie.length}）`);
  } catch { /* 文件不存在时忽略 */ }
}

console.log(`[startup] WEIBO_COOKIE 已配置: ${weiboCookie ? "是（长度 " + weiboCookie.length + "）" : "否（未设置）"}`);
console.log(`[startup] ACCESS_PASSWORD 已配置: ${ACCESS_PASSWORD ? "是" : "否"}`);

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
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache"
  });
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
  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Referer: "https://weibo.com/hot/search",
    Accept: "application/json, text/plain, */*"
  };
  // 全国热搜不需要 Cookie，加了反而会导致微博返回不同结构
  const resp = await fetch("https://weibo.com/ajax/side/hotSearch", { headers });
  console.log(`[weibo realtime] status=${resp.status} url=${resp.url}`);
  if (!resp.ok) throw new Error(`微博接口异常: ${resp.status}`);
  const data = await resp.json();
  console.log(`[weibo realtime] data keys=${Object.keys(data||{}).join(",")} data.data keys=${Object.keys(data?.data||{}).join(",")}`);
  const list = data?.data?.realtime || data?.data?.band_list || [];
  console.log(`[weibo realtime] list length=${list.length}`);
  if (!Array.isArray(list) || list.length === 0) throw new Error("微博接口返回为空或结构变化");
  return list.map((item, idx) => normalizeHotItem(item, idx)).filter(Boolean).slice(0, 50);
}

async function fetchWeiboCategoryHot(cate, refPath) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": `https://weibo.com/hot/${refPath}`,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-Requested-With": "XMLHttpRequest",
    "Client-Version": "v2.47.42",
    "Server-Version": "v2025.10.30.1"
  };
  if (weiboCookie) headers.Cookie = weiboCookie;
  const url = `https://weibo.com/ajax/statuses/${cate}`;
  const resp = await fetch(url, { headers });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const list = data?.data?.band_list || data?.data?.realtime || [];
  // 微博登录态失效的典型响应：{"ok":-100,"url":"https://weibo.com/login.php?..."}
  const cookieExpired = data?.ok === -100 || /login\.php/i.test(data?.url || "");
  console.log(`[weibo ${cate}] status=${resp.status} hasCookie=${!!weiboCookie} ok=${data?.ok} expired=${cookieExpired} bodyLen=${text.length} listLen=${list.length} snippet=${text.slice(0, 200).replace(/\s+/g, " ")}`);
  if (cookieExpired) {
    const err = new Error("WEIBO_COOKIE_EXPIRED");
    err.cookieExpired = true;
    throw err;
  }
  if (!resp.ok || !Array.isArray(list)) return [];
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

function getKeywordStatus(keywords, realtime, entertainment, life, society) {
  return parseKeywordGroups(keywords).map((aliases) => ({
    keyword: aliases[0],
    aliases,
    realtimeRank: findBestRankByAliases(realtime, aliases),
    entertainmentRank: findBestRankByAliases(entertainment, aliases),
    lifeRank: findBestRankByAliases(life, aliases),
    societyRank: findBestRankByAliases(society, aliases)
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
      // 微信内置浏览器（公众号菜单/分享卡片打开）自动免密，签发会话 cookie
      const ua = String(req.headers["user-agent"] || "");
      const isWeChat = /MicroMessenger/i.test(ua);
      if (isWeChat) {
        const newToken = createSession();
        const setCookie = `wb_session=${newToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`;
        if (url.pathname.startsWith("/api/")) {
          res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": setCookie });
          return res.end(JSON.stringify({ error: "请重试", wechatAutoLogin: true }));
        }
        // 给页面种 cookie 并重定向到自身，让后续请求带上 session
        res.writeHead(302, { "Set-Cookie": setCookie, Location: url.pathname + url.search });
        return res.end();
      }
      if (url.pathname.startsWith("/api/")) return sendJson(res, 401, { error: "未登录" });
      // Serve login page for browser requests
      const loginHtml = await readFile(join(__dirname, "login.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(loginHtml);
    }

    // Debug: see raw Weibo category response structure
    if (url.pathname === "/api/debug/category") {
      if (!weiboCookie) return sendJson(res, 200, { error: "no cookie" });
      const resp = await fetch("https://weibo.com/ajax/side/hotSearch?cate=entertainment", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Referer: "https://weibo.com/hot/entertainment",
          Accept: "application/json, text/plain, */*",
          Cookie: weiboCookie
        }
      });
      const text = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      return sendJson(res, 200, {
        status: resp.status,
        finalUrl: resp.url,
        topLevelKeys: parsed ? Object.keys(parsed) : null,
        dataKeys: parsed?.data ? Object.keys(parsed.data) : null,
        realtimeCount: parsed?.data?.realtime?.length ?? null,
        rawSnippet: text.slice(0, 300)
      });
    }

    // Cookie config — set/clear Weibo cookie at runtime
    if (url.pathname === "/api/config/cookie" && req.method === "POST") {
      const body = await readBody(req);
      let cookie = "";
      try { cookie = JSON.parse(body).cookie || ""; } catch { cookie = ""; }
      weiboCookie = cookie.replace(/[\r\n]+/g, " ").trim();
      // 持久化到文件，重启后自动读取
      try {
        await writeFile(COOKIE_FILE, weiboCookie, "utf8");
      } catch (e) {
        console.error("[config] 写入 .weibo_cookie 失败:", e.message);
      }
      console.log(`[config] weiboCookie updated, length=${weiboCookie.length}`);
      return sendJson(res, 200, { ok: true, hasCookie: !!weiboCookie });
    }

    // Cookie status
    if (url.pathname === "/api/config/cookie" && req.method === "GET") {
      return sendJson(res, 200, { hasCookie: !!weiboCookie, cookieLength: weiboCookie.length });
    }

    // Hot search API
    if (url.pathname === "/api/weibo/hot") {
      const keywordsRaw = url.searchParams.get("keywords") || "";
      const keywords = keywordsRaw.split(",").map((k) => k.trim()).filter(Boolean);

      const safe = (fn) => fn.catch((e) => { console.error("[fetch error]", e.message); return { __error: e }; });
      const [realtime, entRaw, lifeRaw, socRaw] = await Promise.all([
        fetchWeiboRealtimeHot().catch((e) => { console.error("[fetch error]", e.message); return []; }),
        safe(fetchWeiboCategoryHot("entertainment", "entertainment")),
        safe(fetchWeiboCategoryHot("life", "life")),
        safe(fetchWeiboCategoryHot("social", "social"))
      ]);

      const unwrap = (v) => Array.isArray(v) ? v : [];
      const entertainment = unwrap(entRaw);
      const life = unwrap(lifeRaw);
      const society = unwrap(socRaw);
      const cookieExpired = [entRaw, lifeRaw, socRaw].some((v) => v && v.__error && v.__error.cookieExpired);

      return sendJson(res, 200, {
        fetchedAt: new Date().toISOString(),
        hasCookie: !!weiboCookie,
        cookieExpired,
        realtime,
        entertainment,
        life,
        society,
        keywordStatus: getKeywordStatus(keywords, realtime, entertainment, life, society)
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
