const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// .env is loaded by the start script via `node --env-file=.env`.
const db = require("./db");

const PORT = Number(process.env.PORT) || 8765;
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || "";

// This is a local, single-user tool: every account lives in ONE local SQLite
// file and there is no way to invite people (no email, no admin UI for it).
// Accounts are therefore provisioned from .env on first run, not through a
// sign-up screen.
//
// ENABLE_SIGNUP is OPT-IN (`=== "true"` opens it). It is off by default, which
// also means the "Create account" tab is hidden and POST /api/auth/register
// answers 403 — the server stays the single authority and the client just asks
// /api/auth/config rather than reading its own build-time flag.
const SIGNUP_OK = process.env.ENABLE_SIGNUP === "true";
const ROOT = __dirname;

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type.includes("json") ? JSON.stringify(body) : body);
}
function sendFile(res, body, filename, type) {
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
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
function setSessionCookie(req, res, token) {
  const maxAge = 60 * 60 * 24 * 14;
  // ponytail: Secure only behind TLS — offline/local runs are plain HTTP, where
  // the flag would make the browser drop the cookie and login would silently
  // fail. reqIsTls reads the REQUEST header, not the response's.
  const secure = reqIsTls(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `kwerry_session=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`);
}
function clearSessionCookie(req, res) {
  const secure = reqIsTls(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `kwerry_session=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
}
// No socket-level TLS flag on a plain http server; the explicit port
// (PORT=8443 convention) or X-Forwarded-Proto from a reverse proxy is the only
// signal available. The header is attacker-controlled when no proxy fronts this
// server, but the worst case is a dropped cookie (login fails, no data exposed);
// TRUST_PROXY lets you disable the header path entirely.
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
function reqIsTls(req) {
  const addr = req.socket?.address?.();
  if (addr && addr.port === 443) return true;
  return Boolean(TRUST_PROXY && req.headers?.["x-forwarded-proto"] === "https");
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

async function serpSearch({ engine, q, location, hl = "id", gl = "id", num = 10, userId }) {
  const cacheKey = `serp|${userId || ""}|${engine}|${String(q).toLowerCase()}|${location || ""}|${hl}|${gl}|${num}`;
  const hit = db.cacheGet(cacheKey, "serp");
  if (hit) return hit;

  const keys = db.getActiveApiKeys();
  if (!keys.length) throw new Error("No SerpAPI key configured. Add one in Settings.");
  let lastErr = null;
  for (const row of keys) {
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
        lastErr = new Error(`SerpAPI key "${row.label || db.maskKey(row.api_key)}" rejected (${r.status}). Trying next…`);
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
      db.cacheSet(cacheKey, "serp", data);
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All SerpAPI keys failed.");
}

async function autocomplete(q, gl = "id", hl = "id", userId) {
  const cacheKey = `ac|${userId || ""}|${String(q).toLowerCase()}|${gl}|${hl}`;
  const hit = db.cacheGet(cacheKey, "ac");
  if (hit && hit.length) return hit;

  // Free Google Suggest first — no SerpAPI quota.
  try {
    const u = new URL("https://suggestqueries.google.com/complete/search");
    u.searchParams.set("client", "firefox");
    u.searchParams.set("q", q);
    if (gl) u.searchParams.set("gl", gl);
    if (hl) u.searchParams.set("hl", hl);
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (r.ok) {
      const data = await r.json();
      const list = Array.isArray(data?.[1]) ? data[1] : [];
      const cleaned = list.map(x => (typeof x === "string" ? x : x?.value || "")).filter(Boolean);
      if (cleaned.length) {
        const out = cleaned.slice(0, 12);
        db.cacheSet(cacheKey, "ac", out);
        return out;
      }
    }
  } catch { /* fall back */ }

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
        masked: db.maskKey(row.api_key),
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
        masked: db.maskKey(row.api_key),
        error: e.message
      });
    }
  }

  const totals = results.reduce((acc, k) => {
    if (k.limit != null) acc.limit = (acc.limit || 0) + k.limit;
    if (k.left != null) acc.left = (acc.left || 0) + k.left;
    if (k.used != null) acc.used = (acc.used || 0) + k.used;
    // Rate limits are per-key and keys are used in rotation, so the pool's real
    // ceiling is the sum.
    if (k.hourLimit != null) acc.hourLimit = (acc.hourLimit || 0) + k.hourLimit;
    if (k.hourLeft != null) acc.hourLeft = (acc.hourLeft || 0) + k.hourLeft;
    // The client wants to count down to the refill, so keep the EARLIEST
    // renewal rather than the last — that is the first moment quota comes back.
    if (k.renewsAt) {
      const t = Date.parse(k.renewsAt);
      if (!Number.isNaN(t) && (acc.renewsAt == null || t < acc.renewsAt)) acc.renewsAt = t;
    }
    return acc;
  }, {});

  const data = {
    configured: results.length > 0,
    keys: results,
    totals: {
      limit: totals.limit ?? null,
      left: totals.left ?? null,
      used: totals.used ?? null,
      hourLimit: totals.hourLimit ?? null,
      hourLeft: totals.hourLeft ?? null,
      renewsAt: totals.renewsAt != null ? new Date(totals.renewsAt).toISOString() : null
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
    snippet: x.snippet || "",
    date: x.date || null,
    source: x.source || null,
    highlights: x.snippet_highlighted_words || []
  }));
  const paa = (data.related_questions || []).map(x => x.question || "").filter(Boolean);
  const related = (data.related_searches || []).map(x => x.query || x || "").filter(Boolean);
  const ads = (data.ads || data.inline_ads || []).length;
  const shopping = (data.shopping_results || []).length;
  const local = Boolean(data.local_results || data.local_map);
  const si = data.search_information || {};
  const totalResults = si.total_results ?? null;
  const timeTaken = si.time_taken_displayed ?? null;
  const organicState = si.organic_results_state || null;

  const aiSrc = data.ai_overview;
  const aiBlocks = (aiSrc?.text_blocks || []).map(b => b.snippet || "").filter(Boolean);
  const aiOutline = (aiSrc?.text_blocks || []).map(b => {
    if (b.type === "list") {
      return {
        type: "list",
        items: (b.list || []).map(li => String(li.snippet || li.title || "").trim()).filter(Boolean)
      };
    }
    return {
      type: b.type === "heading" ? "heading" : b.type === "paragraph" ? "paragraph" : (b.type || "text"),
      text: String(b.snippet || "").trim()
    };
  }).filter(x => (x.type === "list" && x.items.length) || x.text);

  const aiMentions = [];
  const pushMention = (m) => {
    if (!m) return;
    const text = String(m.text || m.snippet || "").trim();
    const link = m.link || m.url || "";
    if (!text && !link) return;
    aiMentions.push({ text, link, domain: db.domainOf(link) || m.source || "" });
  };
  const pushEntityFromSnippet = (snippet, link) => {
    const st = String(snippet || "").trim();
    if (!st || st.endsWith("?")) return;
    const m = st.match(/^([^:]{2,80}):\s+\S/);
    if (m) {
      const t = m[1].trim();
      if (!t.endsWith("?")) pushMention({ text: t, link: link || "" });
      return;
    }
    if (st.length <= 60 && !st.endsWith(".") && !st.endsWith("?")) {
      pushMention({ text: st, link: link || "" });
    }
  };
  for (const b of aiSrc?.text_blocks || []) {
    (b.snippet_links || []).forEach(pushMention);
    for (const li of b.list || []) {
      (li.snippet_links || []).forEach(pushMention);
      if (!(li.snippet_links || []).length) pushEntityFromSnippet(li.snippet, null);
    }
  }

  const normCiteLink = (link) => {
    if (!link) return "";
    try {
      const u = new URL(link);
      u.hash = "";
      u.searchParams.delete("t");
      u.searchParams.delete("si");
      u.searchParams.delete("feature");
      return u.toString().replace(/\/$/, "");
    } catch { return String(link); }
  };
  const rawCitations = (aiSrc?.references || []).map(r => {
    const link = r.link || r.url || "";
    const domain = db.domainOf(link);
    return {
      source: r.source || domain || "",
      domain: domain || r.source || "",
      title: r.title || "",
      link,
      index: r.index ?? null
    };
  }).filter(r => r.source || r.link);
  const seenCite = new Map();
  const aiCitations = [];
  for (const c of rawCitations) {
    const key = normCiteLink(c.link) || (c.domain + "|" + String(c.source).toLowerCase());
    const prev = seenCite.get(key);
    if (prev) {
      if (!prev.title && c.title) prev.title = c.title;
      if (c.source && !String(c.source).includes(".") && String(prev.source || "").includes(".")) prev.source = c.source;
      continue;
    }
    const row = { ...c, index: aiCitations.length, mentions: [] };
    seenCite.set(key, row);
    aiCitations.push(row);
  }
  const citeByLink = new Map(aiCitations.map(c => [normCiteLink(c.link), c]));
  const seenMention = new Set();
  const uniqueMentions = [];
  for (const m of aiMentions) {
    const key = (m.text.toLowerCase() + "|" + normCiteLink(m.link));
    if (seenMention.has(key)) continue;
    seenMention.add(key);
    const cite = citeByLink.get(normCiteLink(m.link));
    uniqueMentions.push({ ...m, citationIndex: cite ? cite.index : null });
    if (cite) cite.mentions.push(m.text);
  }
  const byDomain = {};
  for (const c of aiCitations) {
    const d = c.domain || "unknown";
    if (!byDomain[d]) byDomain[d] = { domain: d, pages: 0, titles: [], mentionCount: 0 };
    byDomain[d].pages += 1;
    if (c.title) byDomain[d].titles.push(c.title);
    byDomain[d].mentionCount += c.mentions.length;
  }
  const citationBreakdown = Object.values(byDomain).sort((a, b) => b.pages - a.pages || b.mentionCount - a.mentionCount);

  const aiOverview = aiSrc
    ? {
        present: true,
        snippets: aiBlocks,
        outline: aiOutline,
        referenceCount: aiCitations.length,
        referenceDomains: [...new Set(aiCitations.map(r => r.domain).filter(Boolean))],
        citations: aiCitations,
        mentions: uniqueMentions,
        citationBreakdown
      }
    : { present: false, snippets: [], outline: [], referenceCount: 0, referenceDomains: [], citations: [], mentions: [], citationBreakdown: [] };

  const features = {
    aiOverview: aiOverview.present,
    paa: paa.length > 0,
    related: related.length > 0,
    shopping: shopping > 0,
    local,
    ads: ads > 0,
    images: (data.inline_images || []).length > 0 || (data.images_results || []).length > 0,
    videos: (data.video_results || data.videos_results || data.videos || []).length > 0,
    news: (data.top_stories || []).length > 0,
    knowledgeGraph: Boolean(data.knowledge_graph),
    featuredSnippet: Boolean(data.answer_box || data.featured_snippet)
  };
  return {
    organic, paa, related,
    ads, shopping, local, totalResults, timeTaken, organicState,
    aiOverview, features,
    inlineImages: (data.inline_images || []).length
  };
}

function summarizeTrends(timeline) {
  const series = (timeline || [])
    .map(p => ({
      date: p.date || "",
      value: Number(p.values?.[0]?.extracted_value ?? p.values?.[0]?.value ?? NaN)
    }))
    .filter(p => Number.isFinite(p.value));
  if (!series.length) return null;
  const values = series.map(p => p.value);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const last = values[values.length - 1];
  const prev = values.length >= 2 ? values[values.length - 2] : last;
  const recent = values.slice(-4);
  const prior = values.slice(-8, -4);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const priorAvg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : recentAvg;
  let direction = "stable";
  if (priorAvg > 0) {
    const delta = (recentAvg - priorAvg) / priorAvg;
    if (delta >= 0.12) direction = "rising";
    else if (delta <= -0.12) direction = "falling";
  }
  return {
    avg: Math.round(avg * 10) / 10,
    min, max, last, prev,
    direction,
    points: series.length,
    series: series.slice(-12)
  };
}

async function fetchTrends(q, gl = "id", userId) {
  const cacheKey = `trends|${userId || ""}|${String(q).toLowerCase()}|${gl}`;
  const hit = db.cacheGet(cacheKey, "trends");
  if (hit !== null) return hit;

  const keys = db.getActiveApiKeys();
  if (!keys.length) return null;
  const geo = String(gl || "id").toUpperCase().slice(0, 2);
  for (const row of keys) {
    try {
      const u = new URL("https://serpapi.com/search.json");
      u.searchParams.set("api_key", row.api_key);
      u.searchParams.set("engine", "google_trends");
      u.searchParams.set("q", q);
      u.searchParams.set("geo", geo);
      u.searchParams.set("data_type", "TIMESERIES");
      const r = await fetch(u);
      if (!r.ok) continue;
      const data = await r.json();
      if (data.error) continue;
      const summary = summarizeTrends(data.interest_over_time?.timeline_data);
      if (summary) db.cacheSet(cacheKey, "trends", summary);
      return summary;
    } catch { /* try next key */ }
  }
  return null;
}

async function fetchAiOverview(pageToken, userId) {
  if (!pageToken) return null;
  // This follow-up is billed like any other SerpAPI search, and it used to be
  // the ONLY call in the research chain with no cache: serpSearch,
  // autocomplete and fetchTrends all hit the 24h cache, but this one re-bought
  // the same AI Overview on every repeat of the same keyword. Cache by token so
  // a re-run costs nothing. The token is itself stable — it comes out of the
  // cached SERP payload, so it only changes when the SERP does.
  const cacheKey = `aio|${userId || ""}|${String(pageToken)}`;
  const hit = db.cacheGet(cacheKey, "aio");
  if (hit) return hit;

  const keys = db.getActiveApiKeys();
  if (!keys.length) return null;
  for (const row of keys) {
    try {
      const u = new URL("https://serpapi.com/search.json");
      u.searchParams.set("api_key", row.api_key);
      u.searchParams.set("engine", "google_ai_overview");
      u.searchParams.set("page_token", pageToken);
      const r = await fetch(u);
      if (!r.ok) continue;
      const data = await r.json();
      if (data.error) continue;
      const out = data.ai_overview || data;
      // Only cache a real payload. Caching a null/empty result would pin the
      // failure for 24h even though SerpAPI may serve it a second later.
      if (out && typeof out === "object" && Object.keys(out).length) {
        db.cacheSet(cacheKey, "aio", out);
      }
      return out;
    } catch { /* try next key */ }
  }
  return null;
}

async function resolveAiOverview(raw, userId) {
  const ai = raw?.ai_overview;
  if (!ai) return raw;
  const hasBody = (ai.text_blocks || []).length || (ai.references || []).length;
  if (hasBody) return raw;
  const token = ai.page_token;
  if (!token) return raw;
  const full = await fetchAiOverview(token, userId).catch(() => null);
  if (!full) return raw;
  return { ...raw, ai_overview: { ...ai, ...full } };
}

function scoreKeyword(keyword, normalized, suggestions, trends = null) {
  let score = 50;
  const reasons = [];
  const intent = detectIntent(keyword);
  const words = keyword.trim().split(/\s+/).filter(Boolean);

  if (words.length >= 2 && words.length <= 6) { score += 8; reasons.push("Keyword cukup spesifik dan masih natural."); }
  if (words.length === 1) { score -= 10; reasons.push("Keyword satu kata cenderung terlalu broad."); }
  if (words.length > 8) { score -= 6; reasons.push("Keyword sangat panjang; demand perlu divalidasi."); }

  const domains = new Set(normalized.organic.map(x => db.domainOf(x.link)).filter(Boolean));
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

  const dated = normalized.organic.filter(x => x.date).length;
  if (dated >= 5) {
    score += 5;
    reasons.push(`Mayoritas top result (${dated}/10) punya tanggal publikasi: pasar aktif, konten segar dihargai.`);
  } else if (dated > 0 && dated <= 2) {
    score += 2;
    reasons.push("Sebagian kecil hasil ber-tanggal: ada peluang konten yang lebih fresh.");
  }

  if (normalized.features?.featuredSnippet) {
    score += 4;
    reasons.push("SERP memuat featured snippet: peluang posisi-0 untuk konten terstruktur.");
  }
  if (normalized.features?.knowledgeGraph) {
    reasons.push("Knowledge graph muncul: perhatikan entitas/brand yang dikenali Google.");
  }
  if (normalized.features?.videos) {
    score += 3;
    reasons.push("Hasil video muncul di SERP: pertimbangkan distribusi video untuk keyword ini.");
  }
  if (normalized.features?.news) {
    score += 2;
    reasons.push("Top stories muncul: ada sisi newsiness/jangka pendek.");
  }

  if (normalized.aiOverview?.present) {
    score -= 3;
    reasons.push("AI Overview hadir: traffic organik bisa tergerak, fokus pada konten yang sulit diringkas mesin.");
    if (normalized.aiOverview.referenceCount >= 3) {
      reasons.push(`AI Overview mereferensikan ${normalized.aiOverview.referenceCount} sumber — peluang masuk daftar rujukan.`);
    }
  }

  if (normalized.totalResults != null) {
    if (normalized.totalResults >= 10_000_000) {
      score -= 3;
      reasons.push(`Indeks sangat luas (~${formatCompact(normalized.totalResults)} hasil): keyword broad, butuh angle tajam.`);
    } else if (normalized.totalResults > 0 && normalized.totalResults < 500_000) {
      score += 3;
      reasons.push(`Indeks relatif sempit (~${formatCompact(normalized.totalResults)} hasil): kompetisi halaman lebih realistis.`);
    }
  }

  if (trends) {
    const avg = trends.avg ?? 0;
    if (trends.direction === "rising") {
      score += 8;
      reasons.push(`Google Trends naik (avg interest ${avg}/100, peak ${trends.max}): momentum demand.`);
    } else if (trends.direction === "falling") {
      score -= 6;
      reasons.push(`Google Trends turun (avg interest ${avg}/100): demand melemah belakangan.`);
    } else if (avg >= 50) {
      score += 5;
      reasons.push(`Google Trends stabil-tinggi (avg interest ${avg}/100): demand konsisten.`);
    } else if (avg > 0) {
      reasons.push(`Google Trends avg interest ${avg}/100 (relatif 0-100, bukan volume absolut).`);
    }
    if (trends.max >= 80 && trends.direction !== "falling") {
      score += 2;
      reasons.push(`Peak interest ${trends.max}/100: ada momen pencarian tinggi.`);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 75 ? "OK" : score >= 55 ? "TEST" : "AVOID";
  return { score, verdict, intent, reasons };
}

function formatCompact(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n ?? "");
  if (x >= 1e9) return (x / 1e9).toFixed(1) + "B";
  if (x >= 1e6) return (x / 1e6).toFixed(1) + "M";
  if (x >= 1e3) return (x / 1e3).toFixed(1) + "K";
  return String(x);
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

  const wantTrends = body.trends !== false;
  const [raw, suggestions, trends] = await Promise.all([
    serpSearch({ engine, q: keyword, location, hl, gl, userId }),
    engine === "google" ? autocomplete(keyword, gl, hl, userId) : Promise.resolve([]),
    (engine === "google" && wantTrends) ? fetchTrends(keyword, gl, userId).catch(() => null) : Promise.resolve(null)
  ]);
  const rawResolved = await resolveAiOverview(raw, userId).catch(() => raw);
  const normalized = normalizeSerp(rawResolved);
  const evaluation = scoreKeyword(keyword, normalized, suggestions, trends);
  const recommendations = buildRecommendations(keyword, normalized, suggestions, goal);
  const contentBrief = buildContentBrief(keyword, normalized, suggestions);
  const clusters = buildClusters(keyword, normalized, suggestions);

  const serpOut = { ...normalized, trends: trends || null, contentBrief, clusters };
  const result = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
    keyword, engine, location, goal,
    evaluation, serp: serpOut, trends: trends || serpOut.trends || null, suggestions, recommendations,
    contentBrief: contentBrief || serpOut.contentBrief || null,
    clusters: clusters || serpOut.clusters || []
  };
  db.saveSearch(result, userId);
  return result;
}


function buildContentBrief(keyword, normalized, suggestions = []) {
  const kw = String(keyword || "").trim();
  const titleIdeas = [];
  const pushTitle = (t) => {
    const v = String(t || "").replace(/\s+/g, " ").trim();
    if (!v) return;
    if (!titleIdeas.some(x => x.toLowerCase() === v.toLowerCase())) titleIdeas.push(v);
  };
  pushTitle(kw.charAt(0).toUpperCase() + kw.slice(1));
  pushTitle(`Panduan ${kw}: Tips, Pilihan, dan Hal yang Perlu Diketahui`);
  pushTitle(`${kw} — Rekomendasi dan Cara Memilih`);

  const outline = [];
  const add = (level, text) => {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (t) outline.push({ level, text: t });
  };
  add(2, `Apa itu ${kw}?`);
  add(2, "Poin utama yang perlu diketahui");

  const aiOutline = normalized?.aiOverview?.outline || [];
  for (const b of aiOutline) {
    if (b.type === "heading") add(3, b.text);
    else if (b.type === "list" && b.items?.length) {
      b.items.forEach(it => add(3, it));
    }
  }

  const paa = normalized?.paa || [];
  paa.forEach(q => add(3, q));

  add(2, "Perbandingan / rekomendasi utama");
  add(2, "Tips memilih atau menggunakannya");
  add(2, "FAQ");
  add(2, "Kesimpulan");

  const entities = (normalized?.aiOverview?.mentions || []).map(m => m.text).filter(Boolean).slice(0, 12);
  const secondary = [];
  const pushSec = (t) => {
    const v = String(t || "").replace(/\s+/g, " ").trim();
    if (!v || v.toLowerCase() === kw.toLowerCase()) return;
    if (!secondary.some(x => x.toLowerCase() === v.toLowerCase())) secondary.push(v);
  };
  (suggestions || []).forEach(pushSec);
  (normalized?.related || []).forEach(pushSec);

  return {
    keyword: kw,
    titleSuggestions: titleIdeas.slice(0, 5),
    outline,
    faq: paa.slice(0, 8),
    entities,
    secondaryKeywords: secondary.slice(0, 40),
    wordCountTarget: "800–1.400 kata",
    notes: [
      "Gunakan PAA sebagai heading FAQ / H2-H3.",
      "Masukkan entity/brand dari AI Overview bila relevan.",
      "Bandingkan minimal 3–5 opsi bila intent komersial."
    ]
  };
}

const CLUSTER_HINTS = [
  { key: "how", label: "How-to / guide", re: /^(cara|tips|langkah|panduan|tutorial|how)/i },
  { key: "best", label: "Best / rekomendasi", re: /^(rekomendasi|best|terbaik|top|pilihan)/i },
  { key: "price", label: "Price / buy", re: /(harga|price|murah|diskon|beli|promo|sale)/i },
  { key: "vs", label: "Compare", re: /(vs|versus|perbandingan|dibanding|lebih baik)/i },
  { key: "review", label: "Review", re: /(review|ulasan|testimoni|kelebihan|kekurangan)/i },
  { key: "brand", label: "Brand / product", re: /(brand|merek|model|series|seri)/i }
];

function buildClusters(keyword, normalized, suggestions = []) {
  const kw = String(keyword || "").toLowerCase();
  const all = [];
  const push = (text, source) => {
    const v = String(text || "").replace(/\s+/g, " ").trim();
    if (!v || v.toLowerCase() === kw) return;
    if (!all.some(x => x.text.toLowerCase() === v.toLowerCase())) all.push({ text: v, source });
  };
  (suggestions || []).forEach(x => push(x, "autocomplete"));
  (normalized?.related || []).forEach(x => push(x, "related"));
  (normalized?.paa || []).forEach(x => push(x, "paa"));

  const buckets = new Map();
  for (const h of CLUSTER_HINTS) buckets.set(h.key, { key: h.key, label: h.label, items: [] });
  buckets.set("other", { key: "other", label: "Other ideas", items: [] });

  for (const item of all) {
    const t = item.text.toLowerCase();
    let placed = false;
    for (const h of CLUSTER_HINTS) {
      if (h.re.test(t)) {
        buckets.get(h.key).items.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // shared token with main keyword → related cluster
      const mainTokens = new Set(kw.split(/\s+/).filter(x => x.length > 3));
      const its = t.split(/\s+/);
      const overlap = its.some(x => mainTokens.has(x));
      if (overlap) buckets.get("other").items.push({ ...item, theme: "similar" });
      else buckets.get("other").items.push(item);
    }
  }

  return [...buckets.values()].filter(b => b.items.length).map(b => ({
    ...b,
    items: b.items.slice(0, 12)
  }));
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
    "score", "verdict", "intent", "tags", "notes",
    "trends_avg", "trends_direction", "trends_max", "total_results",
    "ai_overview", "dated_results", "serp_features",
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
      (x.tags || []).join(" | "),
      (x.notes || "").replace(/\r?\n/g, " "),
      (x.trends || x.serp?.trends)?.avg ?? "",
      (x.trends || x.serp?.trends)?.direction ?? "",
      (x.trends || x.serp?.trends)?.max ?? "",
      x.serp?.totalResults ?? "",
      x.serp?.aiOverview?.present ? "yes" : "no",
      (x.serp?.organic || []).filter(o => o.date).length,
      Object.entries(x.serp?.features || {}).filter(([, v]) => v).map(([k]) => k).join(" | "),
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
    const trends = result.trends || serp?.trends || null;
    if (trends) {
      const dirLabel = trends.direction === "rising" ? "naik" : trends.direction === "falling" ? "turun" : "stabil";
      md.push(`- **Google Trends interest** (relatif 0-100): avg ${trends.avg} · min ${trends.min} · max ${trends.max} · arah ${dirLabel}`);
    }
    if (serp?.totalResults != null) {
      md.push(`- **Total hasil Google**: ~${serp.totalResults}`);
    }
    if (serp?.aiOverview?.present) {
      md.push(`- **AI Overview**: ya (${serp.aiOverview.referenceCount || 0} referensi)`);
    }
    const featList = Object.entries(serp?.features || {}).filter(([, v]) => v).map(([k]) => k);
    if (featList.length) md.push(`- **SERP features**: ${featList.join(", ")}`);
  if (evaluation?.reasons && evaluation.reasons.length) {
    md.push("");
    md.push("**Alasan:**");
    evaluation.reasons.forEach(r => md.push(`- ${r}`));
  }
  md.push("");
  if (serp?.aiOverview?.present) {
      const outline = serp.aiOverview.outline || [];
      if (outline.length) {
        md.push("");
        md.push("### Isi AI Overview (lengkap)");
        outline.forEach(b => {
          if (b.type === "list") {
            (b.items || []).forEach(i => md.push(`- ${i}`));
            md.push("");
          } else if (b.type === "heading") {
            md.push("");
            md.push(`**${b.text}**`);
          } else if (b.text) {
            md.push(b.text);
            md.push("");
          }
        });
      } else if (serp.aiOverview.snippets?.length) {
        md.push("");
        md.push("### Cuplikan AI Overview");
        serp.aiOverview.snippets.forEach(x => md.push(`- ${x}`));
      }
      const bd = serp.aiOverview.citationBreakdown || [];
      if (bd.length) {
        md.push("");
        md.push("### Citation breakdown (AI Overview)");
        md.push("");
        md.push("| Domain | Pages | Mentions |");
        md.push("|--------|------:|---------:|");
        bd.forEach(d => md.push(`| ${mdEscapeCell(d.domain)} | ${d.pages} | ${d.mentionCount || 0} |`));
      }
      const ments = serp.aiOverview.mentions || [];
      if (ments.length) {
        md.push("");
        md.push(`### Mentions (${ments.length})`);
        ments.forEach(m => {
          const t = mdEscapeCell(m.text || m.domain || "-");
          md.push(m.link ? `- **${t}** — <${m.link}>` : `- **${t}**`);
        });
      }
      const cites = serp.aiOverview.citations || [];
      if (cites.length) {
        md.push("");
        md.push(`### Citations (${cites.length})`);
        md.push("");
        md.push("| # | Source | Title | Mentions | URL |");
        md.push("|---|--------|-------|----------|-----|");
        cites.forEach((c, i) => {
          const src = mdEscapeCell(c.source || c.domain || "-");
          const title = mdEscapeCell(c.title || "-");
          const mcount = (c.mentions || []).length;
          const url = c.link || "";
          md.push(`| ${i + 1} | ${src} | ${title} | ${mcount} | ${url ? `<${url}>` : "-"} |`);
        });
      }
    }
    if (trends?.series?.length) {
      md.push("");
      md.push("### Google Trends (12 titik terakhir)");
      md.push("");
      md.push("| Period | Interest |");
      md.push("|--------|----------|");
      trends.series.forEach(p => md.push(`| ${mdEscapeCell(p.date)} | ${p.value} |`));
    }
    md.push("");
    const brief = result.contentBrief || serp?.contentBrief || null;
    const clusters = result.clusters || serp?.clusters || [];
    if (brief) {
      md.push("");
      md.push("## Content brief");
      md.push("");
      (brief.titleSuggestions || []).forEach(t => md.push("- **" + t + "**"));
      md.push("");
      md.push("### Outline");
      (brief.outline || []).forEach(o => md.push((o.level === 2 ? "## " : "### ") + o.text));
      if (brief.faq && brief.faq.length) {
        md.push("");
        md.push("### FAQ");
        brief.faq.forEach(q => md.push("- " + q));
      }
      if (brief.entities && brief.entities.length) {
        md.push("");
        md.push("### Entities");
        md.push(brief.entities.join(", "));
      }
      if (brief.secondaryKeywords && brief.secondaryKeywords.length) {
        md.push("");
        md.push("### Secondary keywords");
        brief.secondaryKeywords.forEach(k => md.push("- " + k));
      }
      if (brief.wordCountTarget) md.push("- **Target panjang**: " + brief.wordCountTarget);
    }
    if (clusters.length) {
      md.push("");
      md.push("## Keyword clusters");
      clusters.forEach(c => {
        md.push("");
        md.push("### " + c.label + " (" + c.items.length + ")");
        c.items.forEach(it => md.push("- " + it.text));
      });
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
  md.push("| # | Title | Domain | Date | URL |");
  md.push("|---|---|---|---|---|");
  const organic = serp?.organic || [];
  if (organic.length) {
    organic.forEach(x => {
      const title = mdEscapeCell(x.title);
      const domain = mdEscapeCell(db.domainOf(x.link));
      const url = x.link ? String(x.link) : "";
      const titleCell = url ? `[${title}](${url})` : title;
      md.push(`| ${x.position || ""} | ${titleCell} | ${domain} | ${mdEscapeCell(x.date || "-")} | ${url ? `<${url}>` : "-"} |`);
    });
  } else {
    md.push("| - | Tidak ada data | - | - | - |");
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
  const pathname = overridePath || (req.url || "/").split("?")[0];
  const requestPath = pathname === "/" || pathname === "" ? "/index.html" : pathname;
  const DIST = path.join(ROOT, "dist");
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
  };

  // Built hashed assets from dist
  const distFile = path.normalize(path.join(DIST, requestPath));
  if (distFile.startsWith(DIST) && fs.existsSync(distFile) && fs.statSync(distFile).isFile()) {
    const ext = path.extname(distFile);
    if (ext !== ".html") {
      return send(res, 200, fs.readFileSync(distFile), types[ext] || "application/octet-stream");
    }
    // dist/index.html handled below for app routes
  }

  const spaIndex = path.join(DIST, "index.html");
  if (fs.existsSync(spaIndex) && !pathname.startsWith("/api/")) {
    return send(res, 200, fs.readFileSync(spaIndex), "text/html; charset=utf-8");
  }
  return send(res, 404, "Not found", "text/plain");
}
function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || "localhost"}`);
}


const server = http.createServer(async (req, res) => {
  try {
    const u = parseUrl(req);
    const pathname = u.pathname;
    const user = currentUser(req);

    // ---- Auth API ----
    // Public (no session required): tells the login screen whether to show the
    // "Create account" tab. Accounts normally come from .env on first run, so
    // this is false out of the box and the tab stays hidden. The server is the
    // single authority — the client used to read a build-time VITE_ENABLE_SIGNUP
    // baked in by Vite, which could silently disagree with the register route.
    if (pathname === "/api/auth/config" && req.method === "GET") {
      return send(res, 200, { signupEnabled: SIGNUP_OK });
    }

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
      setSessionCookie(req, res, token);
      return send(res, 200, { ok: true, user: { id: found.id, username: found.username } });
    }

    if (pathname === "/api/auth/register" && req.method === "POST") {
      // Closed by default — accounts come from .env on first run. Set
      // ENABLE_SIGNUP=true to reopen. Rate limiting still applies either way:
      // a stranger cannot burn more than LOGIN_MAX_FAILS attempts per IP per
      // 15 minutes.
      if (!SIGNUP_OK) {
        return send(res, 403, { error: "Account creation is disabled on this server." });
      }
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
        setSessionCookie(req, res, token);
        return send(res, 200, { ok: true, user: created });
      } catch (e) {
        recordLoginFail(rate.ip);
        return send(res, 400, { error: e.message });
      }
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const token = parseCookies(req).kwerry_session;
      db.destroySession(token);
      clearSessionCookie(req, res);
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
        setSessionCookie(req, res, token);
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // ---- SerpAPI key management (admin only) ----
    // ponytail: no admin column on users, so gate on a single env secret.
    // Set ADMIN_USERNAME=<your username> in .env; unset = every authenticated
    // user can manage keys, which is wrong once this app is on a public URL.
    // Add a `role TEXT` column + db check if you need multiple admins.
    const isAdmin = !!user && (
      !process.env.ADMIN_USERNAME ||
      user.username === process.env.ADMIN_USERNAME.trim().toLowerCase()
    );
    if (pathname === "/api/keys" && req.method === "GET") {
      if (!user) return send(res, 401, { error: "Not logged in." });
      if (!isAdmin) return send(res, 403, { error: "Admin only." });
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
      if (!isAdmin) return send(res, 403, { error: "Admin only." });
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
      if (!isAdmin) return send(res, 403, { error: "Admin only." });
      const id = pathname.slice("/api/keys/".length);
      const ok = db.removeApiKey(id);
      usageCache = { at: 0, data: null };
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Key not found." });
    }

    if (pathname.startsWith("/api/keys/") && req.method === "POST") {
      if (!user) return send(res, 401, { error: "Not logged in." });
      if (!isAdmin) return send(res, 403, { error: "Admin only." });
      const id = pathname.slice("/api/keys/".length);
      const body = await readJson(req);
      const ok = db.setApiKeyActive(id, body.active !== false);
      usageCache = { at: 0, data: null };
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Key not found." });
    }

    // ---- Protected API (requires session) ----
    const isApi = pathname.startsWith("/api/");
    const isPublicApi = pathname === "/api/health" ||
      pathname.startsWith("/api/auth/");

    if (isApi && !isPublicApi && !user) {
      return send(res, 401, { error: "Authentication required." });
    }

    // ---- Search meta (notes / tags) ----
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
          }, user.id);
          return { ok: true, result: r };
        } catch (e) {
          return { ok: false, keyword: kw, error: e.message };
        }
      });
      const results = outcomes.filter(x => x.ok).map(x => x.result);
      const errors = outcomes.filter(x => !x.ok).map(x => ({ keyword: x.keyword, error: x.error }));
      // One invalidate for the whole batch. mapPool can run up to 25 keywords,
      // so clearing per keyword would mean a /account round-trip each time.
      usageCache = { at: 0, data: null };
      return send(res, 200, { ok: true, results, errors, total: keywords.length });
    }

    // ---- CSV export ----
    if (pathname === "/api/export/csv" && req.method === "GET") {
      const q = u.searchParams.get("q") || "";
      const id = u.searchParams.get("id") || null;
      let items;
      if (id) {
        const one = db.getSearch(id, user.id);
        items = one ? [one] : [];
      } else if (q) {
        items = db.searchHistory(q, 500, user.id);
      } else {
        items = db.listSearches(500, 0, user.id);
      }
      const csv = buildCsv(items);
      return sendFile(res, csv, `kwerry-export-${Date.now().toString(36)}.csv`, "text/csv; charset=utf-8");
    }

    // ---- Compare two searches ----
    if (pathname === "/api/compare" && req.method === "GET") {
      const a = u.searchParams.get("a");
      const b = u.searchParams.get("b");
      const sa = a ? db.getSearch(a, user.id) : null;
      const sb = b ? db.getSearch(b, user.id) : null;
      return send(res, 200, { a: sa, b: sb });
    }

    // ---- Backup / restore (admin only — these hand out or overwrite the whole DB) ----
    if (pathname === "/api/cache/clear" && req.method === "POST") {
      if (!isAdmin) return send(res, 403, { error: "Admin only." });
      const n = db.cacheClear();
      return send(res, 200, { ok: true, cleared: n });
    }

    if (pathname === "/api/backup" && req.method === "GET") {
      if (!isAdmin) return send(res, 403, { error: "Admin only." });
      const backupsDir = path.join(ROOT, "data", "backups");
      if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = path.join(backupsDir, `kwerry-backup-${stamp}.db`);
      db.backupDatabase(dest);
      const buf = fs.readFileSync(dest);
      return sendFile(res, buf, `kwerry-backup-${stamp}.db`, "application/octet-stream");
    }

    if (pathname === "/api/backup/restore" && req.method === "POST") {
      if (!isAdmin) return send(res, 403, { error: "Admin only." });
      const body = await readJson(req);
      const b64 = body.data || body.base64;
      if (!b64) throw new Error("Backup file data is required (base64).");
      const buf = Buffer.from(String(b64), "base64");
      if (buf.length < 100) throw new Error("Backup file looks empty or invalid.");
      const tmp = path.join(ROOT, "data", `restore-upload-${Date.now()}.db`);
      fs.writeFileSync(tmp, buf);
      try {
        const { safetyPath, stagedPath } = db.restoreDatabase(tmp);
        pendingRestore = stagedPath;
        return send(res, 200, {
          ok: true,
          requiresRestart: true,
          message: "Database staged. Restart the Kwerry server to load the restored data.",
          safetyPath
        });
      } finally {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ok */ }
      }
    }

    if (pathname === "/api/research" && req.method === "POST") {
      let out;
      try {
        out = await research(await readJson(req), user.id);
      } finally {
        // The run just spent SerpAPI quota, so the 60s usage snapshot the
        // QuotaBadge refetches is now wrong — it would show the pre-search
        // numbers. Invalidated in finally on purpose: a run that failed BECAUSE
        // quota ran out is exactly when the badge most needs fresh figures.
        usageCache = { at: 0, data: null };
      }
      return send(res, 200, out);
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
      return sendFile(res, report, `keyword-report-${slugify(reportSource.keyword)}-${Date.now().toString(36)}.md`, "text/markdown; charset=utf-8");
    }

    if (pathname === "/api/searches" && req.method === "GET") {
      const limit = Math.min(Number(u.searchParams.get("limit")) || 10, 250);
      const offset = Math.max(Number(u.searchParams.get("offset")) || 0, 0);
      const q = u.searchParams.get("q") || "";
      
      const items = q
        ? db.searchHistory(q, limit, user.id, offset)
        : db.listSearches(limit, offset, user.id);
      const total = db.countSearches(user.id, q);
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

    if (pathname === "/api/analytics" && req.method === "GET") {
      return send(res, 200, db.analytics(user.id));
    }

    if (pathname === "/api/health" && req.method === "GET") {
      // ponytail: public endpoint leaks nothing but liveness — no DB path or
      // key count. Add those behind auth if you need them for monitoring.
      return send(res, 200, { ok: true, authRequired: true });
    }

    if (pathname === "/api/usage" && req.method === "GET") {
      if (!isAdmin) return send(res, 403, { error: "Admin only." });
      return send(res, 200, await fetchSerpUsage());
    }

    // ---- Pages ----
    // Root always shows landing. Authenticated users get a CTA into the app.
    if (pathname === "/" || pathname === "/index.html") {
      return serveStatic(req, res, "/index.html");
    }

    // Protected pages redirect to login when no session
    if (pathname.endsWith(".html") && pathname !== "/index.html") { return redirect(res, pathname.replace(/\.html$/, "")); }

    const protectedPages = new Set(["/research", "/analytics", "/history", "/settings", "/compare"]);
    if (protectedPages.has(pathname) && !user) {
      return redirect(res, "/login");
    }

    // Logged-in users skip login page
    if (pathname === "/login" && user) {
      return redirect(res, "/research");
    }

    return serveStatic(req, res);
  } catch (e) {
    // Never echo internals to the client. The request stays logged server-side.
    console.error("request failed:", e);
    return send(res, 400, { error: "Bad request." });
  }
});

// No host argument: Node binds to every interface (0.0.0.0), not just
// loopback — so "local" is a promise this app cannot keep on its own. Signup
// being off is what makes that promise hold; see .env for ADMIN_USERNAME.
server.listen(PORT, () => {
  console.log(`Keyword Research Tool running on http://localhost:${PORT}`);
  console.log(`SQLite DB: ${db.DB_PATH}`);
  if (!SERPAPI_API_KEY) console.log("WARNING: SERPAPI_API_KEY belum diset.");
  // Keep this terse — first-run credentials are already printed by db.js.
  console.log(SIGNUP_OK
    ? "  Signup: OPEN (ENABLE_SIGNUP=true) — anyone who can reach this port can make an account."
    : "  Signup: closed (default for local use).");
  if (!process.env.ADMIN_USERNAME) {
    console.log("  WARNING: ADMIN_USERNAME unset — every account can manage keys/billing/backup.");
  }
});

// /api/backup/restore stages the upload here; swapping while the server holds
// open prepared statements on the live file would corrupt the read path. The
// swap happens at shutdown, so a restart opens the restored DB cleanly.
let pendingRestore = null;
function applyPendingRestore() {
  if (!pendingRestore) return;
  const staged = pendingRestore;
  pendingRestore = null;
  try {
    fs.rmSync(db.DB_PATH + "-wal", { force: true });
    fs.rmSync(db.DB_PATH + "-shm", { force: true });
    fs.copyFileSync(staged, db.DB_PATH);
    fs.rmSync(staged, { force: true });
    console.log(`Restore applied: ${db.DB_PATH} replaced with the staged backup.`);
  } catch (e) {
    console.error("Restore failed — the live DB is untouched:", e.message);
  }
}
process.on("SIGINT", () => { applyPendingRestore(); process.exit(0); });
process.on("SIGTERM", () => { applyPendingRestore(); process.exit(0); });
