import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function normalizeHotItem(item, index) {
  // Weibo rank fields are not always stable; keep deterministic top-50 index rank.
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
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: "https://weibo.com/hot/search",
      Accept: "application/json, text/plain, */*"
    }
  });

  if (!resp.ok) {
    throw new Error(`微博接口异常: ${resp.status}`);
  }

  const data = await resp.json();
  const list = data?.data?.realtime || data?.data?.band_list || [];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("微博接口返回为空或结构变化");
  }

  return list
    .map((item, idx) => normalizeHotItem(item, idx))
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 50);
}

function guessCityRankFromRealtime(realtime) {
  // 微博同城榜官方接口存在风控与区域差异，先返回空数组占位，前端会提示同城源未配置。
  return realtime.filter((item) => /同城|本地|城市/.test(item.keyword)).slice(0, 50);
}

function normalizeText(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[＃#\s]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function parseKeywordGroups(rawKeywords) {
  return rawKeywords
    .map((k) => k.trim())
    .filter(Boolean)
    .map((item) => {
      const aliases = item
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      return aliases.length ? aliases : [item];
    });
}

function findBestRankByAliases(rows, aliases) {
  const normalizedAliases = aliases.map((a) => normalizeText(a)).filter(Boolean);
  if (!normalizedAliases.length) return null;
  let best = null;
  for (const row of rows) {
    const normalizedWord = normalizeText(row.keyword);
    const matched = normalizedAliases.some(
      (alias) => normalizedWord.includes(alias) || alias.includes(normalizedWord)
    );
    if (!matched) continue;
    if (best === null || row.rank < best) best = row.rank;
  }
  return best;
}

function getKeywordStatus(keywords, realtime, city) {
  const groups = parseKeywordGroups(keywords);
  return groups.map((aliases) => {
    const displayKeyword = aliases[0];
    return {
      keyword: displayKeyword,
      aliases,
      realtimeRank: findBestRankByAliases(realtime, aliases),
      cityRank: findBestRankByAliases(city, aliases)
    };
  });
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

    if (url.pathname === "/api/weibo/hot") {
      const keywordsRaw = url.searchParams.get("keywords") || "";
      const keywords = keywordsRaw
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);

      const realtime = await fetchWeiboRealtimeHot();
      const city = guessCityRankFromRealtime(realtime);
      const status = getKeywordStatus(keywords, realtime, city);

      return sendJson(res, 200, {
        source: "https://weibo.com/ajax/side/hotSearch",
        fetchedAt: new Date().toISOString(),
        realtime,
        city,
        keywordStatus: status
      });
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    if (String(error.message || "").includes("ENOENT")) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

function getLanIPv4List() {
  const nets = networkInterfaces();
  const results = [];
  for (const values of Object.values(nets)) {
    for (const info of values || []) {
      if (info.family === "IPv4" && !info.internal) {
        results.push(info.address);
      }
    }
  }
  return [...new Set(results)];
}

server.listen(PORT, HOST, () => {
  console.log(`Weibo monitor server running at http://localhost:${PORT}`);
  const lanIps = getLanIPv4List();
  if (lanIps.length) {
    console.log("Team access URLs:");
    lanIps.forEach((ip) => {
      console.log(`  http://${ip}:${PORT}`);
    });
  }
});
