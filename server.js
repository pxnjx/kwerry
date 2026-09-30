const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// Load .env BEFORE db.js so seedApiKeyFromEnv can read SERPAPI_API_KEY.
(function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^["'].*["']$/.test(value)) value = value.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
})();

const db = require("./db");

const PORT = process.env.PORT || 8765;
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || "";
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type.includes("json") ? JSON.stringify(body) : body);
}
function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
  });
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(res, token) {
  const maxAge = 60 * 60 * 24 * 14;
  res.setHeader("Set-Cookie", `kwerry_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "kwerry_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}
function currentUser(req) {
  const token = parseCookies(req).kwerry_session;
  return db.getSessionUser(token);
}

// --- simple in-memory login rate limit (per IP) ---
const loginAttempts = new Map(); // ip -> { count, resetAt }
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
function checkLoginRate(req) {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return { ok: true, ip };
  }
  if (rec.count >= LOGIN_MAX_FAILS) {
    const waitSec = Math.ceil((rec.resetAt - now) / 1000);
    return { ok: false, ip, waitSec };
  }
  return { ok: true, ip };
}
function recordLoginFail(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
  rec.count += 1;
  loginAttempts.set(ip, rec);
}
function clearLoginFails(ip) {
  loginAttempts.delete(ip);
}

// Run async jobs with limited concurrency (used by bulk research).
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function runner() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, runner));
  return results;
}

const commercialWords = [
  "harga","beli","jual","jasa","promo","diskon","murah","terbaik","review","vs",
  "order","booking","sewa","paket","vendor","supplier","download","software"
];

function detectIntent(q) {
  const x = q.toLowerCase();
  if (/\b(beli|jual|order|booking|sewa|daftar|download|harga)\b/.test(x)) return "transactional";
  if (/\b(terbaik|best|review|vs|versus|rekomendasi|alternatif|perbandingan|jasa|vendor)\b/.test(x)) return "commercial";
  if (/\b(cara|apa|kenapa|mengapa|bagaimana|tutorial|panduan|tips|pengertian|arti)\b/.test(x)) return "informational";
  return "mixed";
}

async function serpSearch({ engine, q, location, hl = "id", gl = "id", num = 10 }) {
  const keys = db.getActiveApiKeys();
  if (!keys.length) throw new Error("No SerpAPI key configured. Add one in Settings.");
  let lastErr = null;
  // Try keys with remaining quota first, then the rest (rotation).
  const ordered = keys.slice();
  for (const row of ordered) {
    try {
      const u = new URL("https://serpapi.com/search.json");
      u.searchParams.set("api_key", row.api_key);
      u.searchParams.set("engine", engine);
      u.searchParams.set("q", q);
      u.searchParams.set("hl", hl);
      if (engine === "google") u.searchParams.set("gl", gl);
      if (location) u.searchParams.set("location", location);
      u.searchParams.set("num", String(num));
      const r = await fetch(u);
      if (r.status === 429 || r.status === 401 || r.status === 403) {
        lastErr = new Error(`SerpAPI key "${row.label || maskKey(row.api_key)}" rejected (${r.status}). Trying next…`);
        continue;
      }
      if (!r.ok) throw new Error(`SERP API error ${r.status}`);
      const data = await r.json();
      if (data.error) {
        // quota exhausted / plan limit — try next key
        if (/limit|quota|account/i.test(String(data.error))) {
          lastErr = new Error(data.error);
          continue;
        }
        throw new Error(data.error);
      }
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All SerpAPI keys failed.");
}

function maskKey(key) {
  const k = String(key || "");
  if (k.length <= 8) return k;
  return k.slice(0, 4) + "…" + k.slice(-4);
}

async function autocomplete(q, gl = "id", hl = "id") {
  const keys = db.getActiveApiKeys();
  if (!keys.length) return [];
  for (const row of keys) {
    try {
      const u = new URL("https://serpapi.com/search.json");
      u.searchParams.set("api_key", row.api_key);
      u.searchParams.set("engine", "google_autocomplete");
      u.searchParams.set("q", q);
      u.searchParams.set("gl", gl);
      u.searchParams.set("hl", hl);
      const r = await fetch(u);
      if (!r.ok) continue;
      const data = await r.json();
      return (data.suggestions || []).map(x => x.value || x.suggestion || x).filter(Boolean);
    } catch { /* try next */ }
  }
  return [];
}

// SerpAPI quota for every configured key — cached briefly.
let usageCache = { at: 0, data: null };
async function fetchSerpUsage() {
  const keys = db.getActiveApiKeys();
  if (!keys.length) return { configured: false, keys: [], totals: null };
  const now = Date.now();
  if (usageCache.data && now - usageCache.at < 60_000) return usageCache.data;

  const results = [];
  for (const row of keys) {
    try {
      const u = new URL("https://serpapi.com/account");
      u.searchParams.set("api_key", row.api_key);
      const r = await fetch(u);
      if (!r.ok) throw new Error(`account API ${r.status}`);
      const a = await r.json();
      results.push({
        id: row.id,
        label: row.label,
        masked: maskKey(row.api_key),
        plan: a.plan_name || null,
        limit: a.searches_per_month ?? null,
        left: a.total_searches_left ?? a.plan_searches_left ?? null,
        used: a.this_month_usage ?? null,
        hourLimit: a.account_rate_limit_per_hour ?? null,
        hourLeft: a.account_rate_limit_per_hour != null && a.this_hour_searches != null
          ? a.account_rate_limit_per_hour - a.this_hour_searches
          : null,
        renewsAt: a.plan_renewal_date || null
      });
    } catch (e) {
      results.push({
        id: row.id,
        label: row.label,
        masked: maskKey(row.api_key),
        error: e.message
      });
    }
  }

  const totals = results.reduce((acc, k) => {
    if (k.limit != null) acc.limit = (acc.limit || 0) + k.limit;
    if (k.left != null) acc.left = (acc.left || 0) + k.left;
    if (k.used != null) acc.used = (acc.used || 0) + k.used;
    return acc;
  }, {});

  const data = {
    configured: results.length > 0,
    keys: results,
    totals: {
      limit: totals.limit ?? null,
      left: totals.left ?? null,
      used: totals.used ?? null
    }
  };
  usageCache = { at: now, data };
  return data;
}

function normalizeSerp(data) {
  const organic = (data.organic_results || []).slice(0, 10).map(x => ({
    position: x.position,
    title: x.title,
    link: x.link,
    displayed_link: x.displayed_link,
    snippet: x.snippet || ""
  }));
  const paa = (data.related_questions || []).map(x => x.question).filter(Boolean);
  const related = (data.related_searches || []).map(x => x.query).filter(Boolean);
  const ads = (data.ads || data.inline_ads || []).length;
  const shopping = (data.shopping_results || []).length;
  const local = Boolean(data.local_results || data.local_map);
  const totalResults = data.search_information?.total_results || null;
  return { organic, paa, related, ads, shopping, local, totalResults };
}

function domainOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function scoreKeyword(keyword, normalized, suggestions) {
  let score = 50;
  const reasons = [];
  const intent = detectIntent(keyword);
  const words = keyword.trim().split(/\s+/).filter(Boolean);

  if (words.length >= 2 && words.length <= 6) { score += 8; reasons.push("Keyword cukup spesifik dan masih natural."); }
  if (words.length === 1) { score -= 10; reasons.push("Keyword satu kata cenderung terlalu broad."); }
  if (words.length > 8) { score -= 6; reasons.push("Keyword sangat panjang; demand perlu divalidasi."); }

  const domains = new Set(normalized.organic.map(x => domainOf(x.link)).filter(Boolean));
  if (domains.size >= 7) { score += 7; reasons.push("SERP punya keragaman domain yang baik."); }
  else if (domains.size <= 4) { score -= 6; reasons.push("SERP terkonsentrasi pada sedikit domain kuat."); }

  const exactTitleHits = normalized.organic.filter(x => (x.title || "").toLowerCase().includes(keyword.toLowerCase())).length;
  if (exactTitleHits >= 7) { score -= 12; reasons.push("Banyak top result memakai exact keyword di title: kompetisi relevansi tinggi."); }
  else if (exactTitleHits <= 3) { score += 8; reasons.push("Exact-title saturation relatif rendah: ada ruang diferensiasi."); }

  if (normalized.paa.length) { score += 5; reasons.push(`Ada ${normalized.paa.length} People Also Ask: bagus untuk cluster konten/FAQ.`); }
  if (normalized.related.length) { score += 5; reasons.push(`Ada ${normalized.related.length} related searches untuk ekspansi keyword.`); }
  if (suggestions.length >= 5) { score += 6; reasons.push("Autocomplete menghasilkan banyak variasi query nyata."); }

  if (normalized.ads > 0 || normalized.shopping > 0) {
    score += 4; reasons.push("Ada ads/shopping: sinyal intent komersial.");
  }
  if (normalized.local) {
    reasons.push("SERP memiliki local pack: optimasi local SEO mungkin penting.");
  }
  if (commercialWords.some(w => keyword.toLowerCase().includes(w))) {
    score += 4; reasons.push("Keyword mengandung modifier komersial.");
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const verdict = score >= 75 ? "OK" : score >= 55 ? "TEST" : "AVOID";
  return { score, verdict, intent, reasons };
}

function buildRecommendations(keyword, normalized, suggestions, goal = "seo") {
  const pool = [];
  const add = (text, source, type) => {
    if (!text) return;
    const clean = String(text).replace(/\s+/g, " ").trim();
    if (!clean || clean.toLowerCase() === keyword.toLowerCase()) return;
    if (!pool.some(x => x.text.toLowerCase() === clean.toLowerCase()))
      pool.push({ text: clean, source, type });
  };
  suggestions.forEach(x => add(x, "Google Autocomplete", "keyword"));
  normalized.related.forEach(x => add(x, "Related Searches", "keyword"));
  normalized.paa.forEach(x => add(x, "People Also Ask", "question"));

  const bases = pool.slice(0, 8).map(x => x.text);
  if (goal === "landing") {
    bases.slice(0, 5).forEach(x => add(`${titleCase(x)} — Solusi untuk Kebutuhan Anda`, "Generated from SERP candidate", "wording"));
  } else if (goal === "article") {
    bases.slice(0, 5).forEach(x => add(`Panduan ${titleCase(x)}: Cara Memilih dan Hal yang Perlu Diperhatikan`, "Generated from SERP candidate", "wording"));
  } else if (goal === "product") {
    bases.slice(0, 5).forEach(x => add(`${titleCase(x)}: Pilihan, Harga, dan Rekomendasi`, "Generated from SERP candidate", "wording"));
  }
  return pool.slice(0, 30);
}
function titleCase(s) {
  return s.replace(/\b\w/g, m => m.toUpperCase());
}

async function research(body, userId) {
  const keyword = String(body.keyword || "").trim();
  const engine = ["google","bing"].includes(body.engine) ? body.engine : "google";
  const location = String(body.location || "Indonesia");
  const hl = String(body.hl || "id");
  const gl = String(body.gl || "id");
  const goal = String(body.goal || "seo");
  if (!keyword) throw new Error("Keyword wajib diisi.");

  const [raw, suggestions] = await Promise.all([
    serpSearch({ engine, q: keyword, location, hl, gl }),
    engine === "google" ? autocomplete(keyword, gl, hl) : Promise.resolve([])
  ]);
  const normalized = normalizeSerp(raw);
  const evaluation = scoreKeyword(keyword, normalized, suggestions);
  const recommendations = buildRecommendations(keyword, normalized, suggestions, goal);

  const result = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
    keyword, engine, location, goal,
    projectId: body.projectId || null,
    evaluation, serp: normalized, suggestions, recommendations
  };
  db.saveSearch(result, userId);
  return result;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "keyword";
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(items) {
  const header = [
    "id", "createdAt", "keyword", "engine", "location", "goal",
    "score", "verdict", "intent", "project_id", "tags", "notes",
    "paa", "related", "recommendations", "serp_urls"
  ];
  const lines = [header.join(",")];
  for (const x of items || []) {
    const urls = (x.serp?.organic || []).map(o => o.link).filter(Boolean).join(" | ");
    lines.push([
      x.id,
      x.createdAt,
      x.keyword,
      x.engine,
      x.location,
      x.goal,
      x.evaluation?.score ?? "",
      x.evaluation?.verdict ?? "",
      x.evaluation?.intent ?? "",
      x.projectId || "",
      (x.tags || []).join(" | "),
      (x.notes || "").replace(/\r?\n/g, " "),
      (x.serp?.paa || []).join(" | "),
      (x.serp?.related || []).join(" | "),
      (x.recommendations || []).map(r => r.text).join(" | "),
      urls
    ].map(csvEscape).join(","));
  }
  return lines.join("\r\n");
}

function mdEscapeCell(s) {
  return String(s || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function buildReport(result) {
  const { keyword, engine, location, goal, evaluation, serp, suggestions, recommendations } = result || {};
  const md = [];
  md.push(`# Kwerry — Keyword Research Report`);
  md.push("");
  md.push(`- **Keyword**: ${keyword || "-"}`);
  md.push(`- **Search engine**: ${engine || "-"}`);
  md.push(`- **Lokasi**: ${location || "-"}`);
  md.push(`- **Tujuan wording**: ${goal || "-"}`);
  md.push(`- **Dibuat**: ${result?.createdAt ? new Date(result.createdAt).toLocaleString("id-ID") : "-"}`);
  md.push("");
  md.push("## Evaluasi");
  md.push("");
  md.push(`- **Verdict**: ${evaluation?.verdict || "-"}`);
  md.push(`- **Opportunity score**: ${evaluation?.score ?? "-"}/100`);
  md.push(`- **Intent**: ${evaluation?.intent || "-"}`);
  if (evaluation?.reasons && evaluation.reasons.length) {
    md.push("");
    md.push("**Alasan:**");
    evaluation.reasons.forEach(r => md.push(`- ${r}`));
  }
  md.push("");
  md.push("## Rekomendasi Keyword & Wording");
  md.push("");
  const recs = recommendations || [];
  if (recs.length) {
    recs.slice(0, 30).forEach(x => md.push(`- **${x.text}** — ${x.source} · ${x.type}`));
  } else {
    md.push("- Tidak ada rekomendasi.");
  }
  md.push("");
  md.push("## Top SERP (Organic)");
  md.push("");
  md.push("| # | Title | Domain | URL |");
  md.push("|---|---|---|---|");
  const organic = serp?.organic || [];
  if (organic.length) {
    organic.forEach(x => {
      const title = mdEscapeCell(x.title);
      const domain = mdEscapeCell(domainOf(x.link));
      const url = x.link ? String(x.link) : "";
      const titleCell = url ? `[${title}](${url})` : title;
      md.push(`| ${x.position || ""} | ${titleCell} | ${domain} | ${url ? `<${url}>` : "-"} |`);
    });
  } else {
    md.push("| - | Tidak ada data | - | - |");
  }
  md.push("");
  md.push("### Daftar URL Halaman SERP");
  md.push("");
  if (organic.length) {
    organic.forEach(x => {
      const url = x.link || "";
      const pos = x.position || "";
      const title = mdEscapeCell(x.title);
      if (url) md.push(`- [${pos}. ${title}](${url})`);
      else md.push(`- ${pos}. ${title}`);
    });
  } else {
    md.push("- Tidak ada URL.");
  }
  md.push("");
  md.push("## People Also Ask");
  md.push("");
  const paa = serp?.paa || [];
  if (paa.length) paa.forEach(x => md.push(`- ${x}`)); else md.push("- Tidak ditemukan.");
  md.push("");
  md.push("## Related Searches");
  md.push("");
  const related = serp?.related || [];
  if (related.length) related.forEach(x => md.push(`- ${x}`)); else md.push("- Tidak ditemukan.");
  md.push("");
  md.push("## Google Autocomplete");
  md.push("");
  const sugg = suggestions || [];
  if (sugg.length) sugg.forEach(x => md.push(`- ${x}`)); else md.push("- Tidak ditemukan.");
  md.push("");
  md.push("---");
  md.push("*Generated automatically by Kwerry.*");
  return md.join("\n");
}

function serveStatic(req, res, overridePath) {
  // Strip query string first so "/?load=abc" resolves to a file, not a directory.
  const pathname = overridePath || (req.url || "/").split("?")[0];
  const requestPath = pathname === "/" || pathname === "" ? "/index.html" : pathname;
  const file = path.normalize(path.join(PUBLIC, requestPath));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden", "text/plain");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "Not found", "text/plain");
  const ext = path.extname(file);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
  };
  send(res, 200, fs.readFileSync(file), types[ext] || "application/octet-stream");
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || "localhost"}`);
}

// Pages that are public (no session required)
const PUBLIC_PAGES = new Set([
  "/",
  "/index.html",
  "/login.html",
  "/styles.css",
  "/icon.svg",
  "/favicon-32.png",
  "/icon-180.png",
  "/icon-1024.png"
]);

const server = http.createServer(async (req, res) => {
  try {
    const u = parseUrl(req);
    const pathname = u.pathname;
    const user = currentUser(req);

    // ---- Auth API ----
    if (pathname === "/api/auth/login" && req.method === "POST") {
      const rate = checkLoginRate(req);
      if (!rate.ok) {
        return send(res, 429, {
          error: `Too many failed attempts. Try again in ${rate.waitSec}s.`,
          retryAfter: rate.waitSec
        });
      }
      const body = await readJson(req);
      const uname = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      const found = db.getUserByUsername(uname);
      if (!found || !db.verifyPassword(password, found.password_hash)) {
        recordLoginFail(rate.ip);
        return send(res, 401, { error: "Invalid username or password." });
      }
      clearLoginFails(rate.ip);
      const token = db.createSession(found.id);
      setSessionCookie(res, token);
      return send(res, 200, { ok: true, user: { id: found.id, username: found.username } });
    }

    if (pathname === "/api/auth/register" && req.method === "POST") {
      const rate = checkLoginRate(req);
      if (!rate.ok) {
        return send(res, 429, {
          error: `Too many attempts. Try again in ${rate.waitSec}s.`,
          retryAfter: rate.waitSec
        });
      }
      const body = await readJson(req);
      try {
        const created = db.createUser(body.username, body.password);
        clearLoginFails(rate.ip);
        const token = db.createSession(created.id);
        setSessionCookie(res, token);
        return send(res, 200, { ok: true, user: created });
      } catch (e) {
        recordLoginFail(rate.ip);
        return send(res, 400, { error: e.message });
      }
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const token = parseCookies(req).kwerry_session;
      db.destroySession(token);
      clearSessionCookie(res);
      return send(res, 200, { ok: true });
    }

    if (pathname === "/api/auth/me" && req.method === "GET") {
      if (!user) return send(res, 401, { error: "Not logged in." });
      return send(res, 200, { user });
    }

    if (pathname === "/api/auth/password" && req.method === "POST") {
      if (!user) return send(res, 401, { error: "Not logged in." });
      const body = await readJson(req);
      try {
        db.changePassword(user.id, body.currentPassword, body.newPassword);
        const token = db.createSession(user.id);
        setSessionCookie(res, token);
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // ---- SerpAPI key management (authenticated) ----
    if (pathname === "/api/keys" && req.method === "GET") {
      if (!user) return send(res, 401, { error: "Not logged in." });
      // Never return full keys to the client — masked only.
      const items = db.listApiKeys().map(k => ({
        id: k.id,
        label: k.label,
        apiKeyMasked: k.apiKeyMasked,
        isActive: k.isActive,
        createdAt: k.createdAt
      }));
      return send(res, 200, { items });
    }

    if (pathname === "/api/keys" && req.method === "POST") {
      if (!user) return send(res, 401, { error: "Not logged in." });
      const body = await readJson(req);
      try {
        db.addApiKey(body.label, body.apiKey);
        usageCache = { at: 0, data: null };
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    if (pathname.startsWith("/api/keys/") && req.method === "DELETE") {
      if (!user) return send(res, 401, { error: "Not logged in." });
      const id = pathname.slice("/api/keys/".length);
      const ok = db.removeApiKey(id);
      usageCache = { at: 0, data: null };
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Key not found." });
    }

    if (pathname.startsWith("/api/keys/") && req.method === "POST") {
      if (!user) return send(res, 401, { error: "Not logged in." });
      const id = pathname.slice("/api/keys/".length);
      const body = await readJson(req);
      const ok = db.setApiKeyActive(id, body.active !== false);
      usageCache = { at: 0, data: null };
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Key not found." });
    }

    // ---- Protected API (requires session) ----
    const isApi = pathname.startsWith("/api/");
    const isPublicApi = pathname === "/api/health" || pathname === "/api/usage" ||
      pathname.startsWith("/api/auth/");

    if (isApi && !isPublicApi && !user) {
      return send(res, 401, { error: "Authentication required." });
    }

    // ---- Projects ----
    if (pathname === "/api/projects" && req.method === "GET") {
      return send(res, 200, { items: db.listProjects(user.id) });
    }
    if (pathname === "/api/projects" && req.method === "POST") {
      try {
        const body = await readJson(req);
        return send(res, 200, { ok: true, project: db.createProject(body.name, user.id) });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (pathname.startsWith("/api/projects/") && req.method === "PUT") {
      const id = pathname.slice("/api/projects/".length);
      const body = await readJson(req);
      try {
        const ok = db.renameProject(id, body.name, user.id);
        return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Project not found." });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (pathname.startsWith("/api/projects/") && req.method === "DELETE") {
      const id = pathname.slice("/api/projects/".length);
      const ok = db.deleteProject(id, user.id);
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Project not found." });
    }

    // ---- Search meta (notes / tags / project) ----
    if (pathname.startsWith("/api/searches/") && req.method === "PATCH") {
      const id = pathname.slice("/api/searches/".length);
      const body = await readJson(req);
      const ok = db.updateSearchMeta(id, body, user.id);
      if (!ok) return send(res, 404, { error: "Search not found." });
      return send(res, 200, { ok: true, search: db.getSearch(id, user.id) });
    }

    // ---- Bulk research (parallel, limited concurrency) ----
    if (pathname === "/api/research/bulk" && req.method === "POST") {
      const body = await readJson(req);
      const rawList = Array.isArray(body.keywords)
        ? body.keywords
        : String(body.keywords || "").split(/[\n,]+/);
      const keywords = [...new Set(rawList.map(x => String(x || "").trim()).filter(Boolean))].slice(0, 25);
      if (!keywords.length) throw new Error("Add at least one keyword.");
      const outcomes = await mapPool(keywords, 4, async (kw) => {
        try {
          const r = await research({
            keyword: kw,
            engine: body.engine,
            location: body.location,
            goal: body.goal,
            projectId: body.projectId
          }, user.id);
          return { ok: true, result: r };
        } catch (e) {
          return { ok: false, keyword: kw, error: e.message };
        }
      });
      const results = outcomes.filter(x => x.ok).map(x => x.result);
      const errors = outcomes.filter(x => !x.ok).map(x => ({ keyword: x.keyword, error: x.error }));
      return send(res, 200, { ok: true, results, errors, total: keywords.length });
    }

    // ---- CSV export ----
    if (pathname === "/api/export/csv" && req.method === "GET") {
      const q = u.searchParams.get("q") || "";
      const projectId = u.searchParams.get("project") || null;
      const id = u.searchParams.get("id") || null;
      let items;
      if (id) {
        const one = db.getSearch(id, user.id);
        items = one ? [one] : [];
      } else if (q) {
        items = db.searchHistory(q, 500, user.id, projectId);
      } else {
        items = db.listSearches(500, 0, user.id, projectId);
      }
      const csv = buildCsv(items);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="kwerry-export-${Date.now().toString(36)}.csv"`,
        "Content-Length": Buffer.byteLength(csv),
        "Cache-Control": "no-store"
      });
      return res.end(csv);
    }

    // ---- Compare two searches ----
    if (pathname === "/api/compare" && req.method === "GET") {
      const a = u.searchParams.get("a");
      const b = u.searchParams.get("b");
      const sa = a ? db.getSearch(a, user.id) : null;
      const sb = b ? db.getSearch(b, user.id) : null;
      return send(res, 200, { a: sa, b: sb });
    }

    // ---- Backup / restore ----
    if (pathname === "/api/backup" && req.method === "GET") {
      const pathMod = require("path");
      const fsMod = require("fs");
      const backupsDir = pathMod.join(ROOT, "data", "backups");
      if (!fsMod.existsSync(backupsDir)) fsMod.mkdirSync(backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = pathMod.join(backupsDir, `kwerry-backup-${stamp}.db`);
      db.backupDatabase(dest);
      const buf = fsMod.readFileSync(dest);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="kwerry-backup-${stamp}.db"`,
        "Content-Length": buf.length,
        "Cache-Control": "no-store"
      });
      return res.end(buf);
    }

    if (pathname === "/api/backup/restore" && req.method === "POST") {
      const body = await readJson(req);
      const b64 = body.data || body.base64;
      if (!b64) throw new Error("Backup file data is required (base64).");
      const buf = Buffer.from(String(b64), "base64");
      if (buf.length < 100) throw new Error("Backup file looks empty or invalid.");
      const pathMod = require("path");
      const fsMod = require("fs");
      const tmp = pathMod.join(ROOT, "data", `restore-upload-${Date.now()}.db`);
      fsMod.writeFileSync(tmp, buf);
      try {
        const { safetyPath } = db.restoreDatabase(tmp);
        return send(res, 200, {
          ok: true,
          requiresRestart: true,
          message: "Database restored. Restart the Kwerry server to load the restored data.",
          safetyPath
        });
      } finally {
        try { fsMod.rmSync(tmp, { force: true }); } catch { /* ok */ }
      }
    }

    if (pathname === "/api/research" && req.method === "POST") {
      return send(res, 200, await research(await readJson(req), user.id));
    }

    if (pathname === "/api/report" && req.method === "POST") {
      const result = await readJson(req);
      if (!result || !result.keyword) throw new Error("Data report tidak ditemukan.");
      let reportSource = result;
      if (result.id) {
        const stored = db.getSearch(result.id, user.id);
        if (stored) reportSource = stored;
      }
      const report = buildReport(reportSource);
      const filename = `keyword-report-${slugify(reportSource.keyword)}-${Date.now().toString(36)}.md`;
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": Buffer.byteLength(report),
        "Cache-Control": "no-store"
      });
      return res.end(report);
    }

    if (pathname === "/api/searches" && req.method === "GET") {
      const limit = Math.min(Number(u.searchParams.get("limit")) || 10, 250);
      const offset = Math.max(Number(u.searchParams.get("offset")) || 0, 0);
      const q = u.searchParams.get("q") || "";
      const project = u.searchParams.get("project") || null;
      const items = q
        ? db.searchHistory(q, limit, user.id, project, offset)
        : db.listSearches(limit, offset, user.id, project);
      const total = db.countSearches(user.id, project, q);
      return send(res, 200, { items, total, limit, offset });
    }

    if (pathname.startsWith("/api/searches/") && req.method === "GET") {
      const id = pathname.slice("/api/searches/".length);
      const item = db.getSearch(id, user.id);
      if (!item) return send(res, 404, { error: "Search tidak ditemukan." });
      return send(res, 200, item);
    }

    if (pathname.startsWith("/api/searches/") && req.method === "DELETE") {
      const id = pathname.slice("/api/searches/".length);
      const ok = db.deleteSearch(id, user.id);
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Search tidak ditemukan." });
    }

    if (pathname === "/api/keywords" && req.method === "GET") {
      const limit = u.searchParams.get("limit") || 100;
      return send(res, 200, { items: db.listKeywords(limit, user.id) });
    }

    if (pathname.startsWith("/api/keywords/") && req.method === "GET") {
      const kw = decodeURIComponent(pathname.slice("/api/keywords/".length));
      const item = db.getKeyword(kw, user.id);
      if (!item) return send(res, 404, { error: "Keyword tidak ditemukan." });
      return send(res, 200, item);
    }

    if (pathname === "/api/analytics" && req.method === "GET") {
      return send(res, 200, db.analytics(user.id));
    }

    if (pathname === "/api/history" && req.method === "GET") {
      return send(res, 200, db.listSearches(30, 0, user.id));
    }

    if (pathname === "/api/health" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        serpApiConfigured: db.getActiveApiKeys().length > 0,
        port: PORT,
        db: db.DB_PATH,
        authRequired: true
      });
    }

    if (pathname === "/api/usage" && req.method === "GET") {
      return send(res, 200, await fetchSerpUsage());
    }

    // ---- Pages ----
    // Root always shows landing. Authenticated users get a CTA into the app.
    if (pathname === "/" || pathname === "/index.html") {
      return serveStatic(req, res, "/index.html");
    }

    // Protected pages redirect to login when no session
    const protectedPages = new Set(["/research.html", "/analytics.html", "/history.html", "/settings.html", "/compare.html", "/app.html"]);
    if (protectedPages.has(pathname) && !user) {
      return redirect(res, "/login.html");
    }

    // Logged-in users skip login page
    if (pathname === "/login.html" && user) {
      return redirect(res, "/research.html");
    }

    return serveStatic(req, res);
  } catch (e) {
    return send(res, 400, { error: e.message || "Unknown error" });
  }
});

server.listen(PORT, () => {
  console.log(`Keyword Research Tool running on http://localhost:${PORT}`);
  console.log(`SQLite DB: ${db.DB_PATH}`);
  if (!SERPAPI_API_KEY) console.log("WARNING: SERPAPI_API_KEY belum diset.");
});
