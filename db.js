const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "keyword-research.db");
const LEGACY_HISTORY = path.join(DATA_DIR, "history.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS searches (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    keyword TEXT NOT NULL,
    keyword_lower TEXT NOT NULL,
    engine TEXT NOT NULL DEFAULT 'google',
    location TEXT NOT NULL DEFAULT 'Indonesia',
    goal TEXT NOT NULL DEFAULT 'seo',
    score INTEGER,
    verdict TEXT,
    intent TEXT,
    serp_json TEXT NOT NULL,
    suggestions_json TEXT NOT NULL DEFAULT '[]',
    recommendations_json TEXT NOT NULL DEFAULT '[]',
    reasons_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS keywords (
    keyword_lower TEXT PRIMARY KEY,
    user_id TEXT,
    keyword TEXT NOT NULL,
    first_searched_at TEXT NOT NULL,
    last_searched_at TEXT NOT NULL,
    search_count INTEGER NOT NULL DEFAULT 1,
    best_score INTEGER,
    last_verdict TEXT,
    last_intent TEXT
  );
`);

// --- schema migrations for DBs created before auth ---
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("searches", "user_id", "user_id TEXT");
ensureColumn("keywords", "user_id", "user_id TEXT");
ensureColumn("searches", "project_id", "project_id TEXT");
ensureColumn("searches", "notes", "notes TEXT DEFAULT ''");
ensureColumn("searches", "tags", "tags TEXT DEFAULT '[]'");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_searches_keyword ON searches(keyword_lower);
  CREATE INDEX IF NOT EXISTS idx_searches_created ON searches(created_at);
  CREATE INDEX IF NOT EXISTS idx_searches_verdict ON searches(verdict);
  CREATE INDEX IF NOT EXISTS idx_searches_intent ON searches(intent);
  CREATE INDEX IF NOT EXISTS idx_searches_user ON searches(user_id);
`);

// --- password helpers ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(":");
    if (!salt || !hash) return false;
    const check = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
  } catch {
    return false;
  }
}

// --- users ---
// First-run admin: set SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD in .env
// (recommended), or a random password is generated and printed once.
function seedDefaultUser() {
  const anyUser = db.prepare("SELECT id FROM users LIMIT 1").get();
  if (anyUser) return anyUser.id;

  const username = String(process.env.SEED_ADMIN_USERNAME || "admin").trim().toLowerCase();
  let password = String(process.env.SEED_ADMIN_PASSWORD || "");
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(9).toString("base64url");
    generated = true;
  }
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, username, hashPassword(password), new Date().toISOString());

  console.log("────────────────────────────────────────");
  console.log("First-run admin account created");
  console.log(`  username: ${username}`);
  if (generated) {
    console.log(`  password: ${password}`);
    console.log("  (generated — change it in Settings after sign-in)");
  } else {
    console.log("  password: (from SEED_ADMIN_PASSWORD)");
  }
  console.log("────────────────────────────────────────");
  return id;
}
const DEFAULT_USER_ID = seedDefaultUser();

// Bind any legacy / unowned rows to the default user so history stays visible.
db.prepare(`UPDATE searches SET user_id = ? WHERE user_id IS NULL OR user_id = ''`).run(DEFAULT_USER_ID);
db.prepare(`UPDATE keywords SET user_id = ? WHERE user_id IS NULL OR user_id = ''`).run(DEFAULT_USER_ID);

function getUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || "").toLowerCase());
}
function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(String(id || ""));
}
function createUser(username, password) {
  const uname = String(username || "").trim().toLowerCase();
  if (!uname || !password) throw new Error("Username and password are required.");
  if (!/^[a-z0-9_.-]{3,32}$/.test(uname)) {
    throw new Error("Username must be 3-32 chars (a-z, 0-9, _ . -).");
  }
  if (String(password).length < 6) throw new Error("Password must be at least 6 characters.");
  if (getUserByUsername(uname)) throw new Error("Username already taken.");
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, uname, hashPassword(password), new Date().toISOString());
  return { id, username: uname };
}
function changePassword(userId, currentPassword, newPassword) {
  const user = getUserById(userId);
  if (!user) throw new Error("User not found.");
  if (!verifyPassword(currentPassword, user.password_hash)) {
    throw new Error("Current password is incorrect.");
  }
  if (String(newPassword).length < 6) throw new Error("New password must be at least 6 characters.");
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), userId);
  // invalidate other sessions for safety
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return true;
}

// --- sessions ---
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(token, userId, now.toISOString(), exp.toISOString());
  return token;
}
function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE token = ?").get(String(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(row.token);
    return null;
  }
  const user = getUserById(row.user_id);
  if (!user) return null;
  return { id: user.id, username: user.username };
}
function destroySession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token = ?").run(String(token));
}

// --- SerpAPI keys (multi-account pool) ---
function seedApiKeyFromEnv() {
  const envKey = process.env.SERPAPI_API_KEY || "";
  if (!envKey) return;
  const existing = db.prepare("SELECT id FROM api_keys WHERE api_key = ?").get(envKey);
  if (existing) return;
  db.prepare(
    "INSERT OR IGNORE INTO api_keys (id, label, api_key, is_active, created_at) VALUES (?, ?, ?, 1, ?)"
  ).run(crypto.randomUUID(), "Default (from .env)", envKey, new Date().toISOString());
}
seedApiKeyFromEnv();

function listApiKeys() {
  return db.prepare(
    "SELECT id, label, api_key, is_active, created_at FROM api_keys ORDER BY created_at ASC"
  ).all().map(r => ({
    id: r.id,
    label: r.label,
    // mask key in UI lists
    apiKeyMasked: maskKey(r.api_key),
    apiKeyFull: r.api_key,
    isActive: !!r.is_active,
    createdAt: r.created_at
  }));
}
function maskKey(key) {
  const k = String(key || "");
  if (k.length <= 8) return k;
  return k.slice(0, 4) + "…" + k.slice(-4);
}
function addApiKey(label, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("API key is required.");
  if (key.length < 16) throw new Error("API key looks too short.");
  const existing = db.prepare("SELECT id FROM api_keys WHERE api_key = ?").get(key);
  if (existing) throw new Error("This API key is already saved.");
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO api_keys (id, label, api_key, is_active, created_at) VALUES (?, ?, ?, 1, ?)"
  ).run(id, String(label || "").trim() || "Untitled", key, new Date().toISOString());
  return id;
}
function removeApiKey(id) {
  const info = db.prepare("DELETE FROM api_keys WHERE id = ?").run(String(id));
  return info.changes > 0;
}
function setApiKeyActive(id, active) {
  const info = db.prepare("UPDATE api_keys SET is_active = ? WHERE id = ?").run(active ? 1 : 0, String(id));
  return info.changes > 0;
}
function getActiveApiKeys() {
  return db.prepare(
    "SELECT * FROM api_keys WHERE is_active = 1 ORDER BY created_at ASC"
  ).all();
}

// One-time migration from legacy history.json (if present and DB is empty).
function migrateLegacyHistory() {
  if (!fs.existsSync(LEGACY_HISTORY)) return;
  const count = db.prepare("SELECT COUNT(*) AS c FROM searches").get().c;
  if (count > 0) return;
  let items = [];
  try { items = JSON.parse(fs.readFileSync(LEGACY_HISTORY, "utf8")); } catch { return; }
  if (!Array.isArray(items) || !items.length) return;

  const insertSearch = db.prepare(`
    INSERT OR IGNORE INTO searches
      (id, user_id, keyword, keyword_lower, engine, location, goal, score, verdict, intent,
       serp_json, suggestions_json, recommendations_json, reasons_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertKeyword = db.prepare(`
    INSERT INTO keywords (keyword_lower, user_id, keyword, first_searched_at, last_searched_at, search_count, best_score, last_verdict, last_intent)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(keyword_lower) DO UPDATE SET
      last_searched_at = MAX(keywords.last_searched_at, excluded.last_searched_at),
      first_searched_at = MIN(keywords.first_searched_at, excluded.first_searched_at),
      search_count = keywords.search_count + 1,
      best_score = MAX(COALESCE(keywords.best_score, -1), COALESCE(excluded.best_score, -1)),
      last_verdict = excluded.last_verdict,
      last_intent = excluded.last_intent
  `);

  db.exec("BEGIN");
  try {
    for (const item of items) {
      if (!item?.keyword) continue;
      const createdAt = item.createdAt || new Date().toISOString();
      const keywordLower = String(item.keyword).toLowerCase();
      insertSearch.run(
        item.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        DEFAULT_USER_ID,
        String(item.keyword),
        keywordLower,
        item.engine || "google",
        item.location || "Indonesia",
        item.goal || "seo",
        item.evaluation?.score ?? null,
        item.evaluation?.verdict ?? null,
        item.evaluation?.intent ?? null,
        JSON.stringify(item.serp || {}),
        JSON.stringify(item.suggestions || []),
        JSON.stringify(item.recommendations || []),
        JSON.stringify(item.evaluation?.reasons || []),
        createdAt
      );
      upsertKeyword.run(
        keywordLower,
        DEFAULT_USER_ID,
        String(item.keyword),
        createdAt,
        createdAt,
        item.evaluation?.score ?? null,
        item.evaluation?.verdict ?? null,
        item.evaluation?.intent ?? null
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("Legacy history migration failed:", e.message);
  }
}
migrateLegacyHistory();

const insertSearchStmt = db.prepare(`
  INSERT INTO searches
    (id, user_id, keyword, keyword_lower, engine, location, goal, score, verdict, intent,
     serp_json, suggestions_json, recommendations_json, reasons_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const upsertKeywordStmt = db.prepare(`
  INSERT INTO keywords (keyword_lower, user_id, keyword, first_searched_at, last_searched_at, search_count, best_score, last_verdict, last_intent)
  VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  ON CONFLICT(keyword_lower) DO UPDATE SET
    user_id = excluded.user_id,
    last_searched_at = excluded.last_searched_at,
    first_searched_at = MIN(keywords.first_searched_at, excluded.first_searched_at),
    search_count = keywords.search_count + 1,
    best_score = MAX(COALESCE(keywords.best_score, -1), COALESCE(excluded.best_score, -1)),
    last_verdict = excluded.last_verdict,
    last_intent = excluded.last_intent
`);

function saveSearch(result, userId) {
  const createdAt = result.createdAt || new Date().toISOString();
  const keywordLower = String(result.keyword || "").toLowerCase();
  const score = result.evaluation?.score ?? null;
  const uid = userId || DEFAULT_USER_ID;
  insertSearchStmt.run(
    result.id,
    uid,
    result.keyword,
    keywordLower,
    result.engine || "google",
    result.location || "Indonesia",
    result.goal || "seo",
    score,
    result.evaluation?.verdict ?? null,
    result.evaluation?.intent ?? null,
    JSON.stringify(result.serp || {}),
    JSON.stringify(result.suggestions || []),
    JSON.stringify(result.recommendations || []),
    JSON.stringify(result.evaluation?.reasons || []),
    createdAt
  );
  upsertKeywordStmt.run(
    keywordLower,
    uid,
    result.keyword,
    createdAt,
    createdAt,
    score,
    result.evaluation?.verdict ?? null,
    result.evaluation?.intent ?? null
  );
  if (result.projectId) {
    db.prepare("UPDATE searches SET project_id = ? WHERE id = ?").run(result.projectId, result.id);
  }
}

function rowToSearch(row) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags || "[]"); } catch { tags = []; }
  return {
    id: row.id,
    createdAt: row.created_at,
    keyword: row.keyword,
    engine: row.engine,
    location: row.location,
    goal: row.goal,
    projectId: row.project_id || null,
    notes: row.notes || "",
    tags,
    evaluation: {
      score: row.score,
      verdict: row.verdict,
      intent: row.intent,
      reasons: JSON.parse(row.reasons_json || "[]")
    },
    serp: JSON.parse(row.serp_json || "{}"),
    suggestions: JSON.parse(row.suggestions_json || "[]"),
    recommendations: JSON.parse(row.recommendations_json || "[]")
  };
}

function listSearches(limit = 50, offset = 0, userId, projectId) {
  const filters = [];
  const params = [];
  if (userId) { filters.push("user_id = ?"); params.push(userId); }
  if (projectId) { filters.push("project_id = ?"); params.push(projectId); }
  params.push(Math.min(Number(limit) || 50, 500));
  params.push(Math.max(Number(offset) || 0, 0));
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT * FROM searches ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params);
  return rows.map(rowToSearch);
}

function getSearch(id, userId) {
  const row = userId
    ? db.prepare("SELECT * FROM searches WHERE id = ? AND user_id = ?").get(String(id), userId)
    : db.prepare("SELECT * FROM searches WHERE id = ?").get(String(id));
  return rowToSearch(row);
}

function deleteSearch(id, userId) {
  const info = userId
    ? db.prepare("DELETE FROM searches WHERE id = ? AND user_id = ?").run(String(id), userId)
    : db.prepare("DELETE FROM searches WHERE id = ?").run(String(id));
  return info.changes > 0;
}

function listKeywords(limit = 100, userId) {
  const rows = userId
    ? db.prepare(
        "SELECT * FROM keywords WHERE user_id = ? ORDER BY search_count DESC, last_searched_at DESC LIMIT ?"
      ).all(userId, Math.min(Number(limit) || 100, 1000))
    : db.prepare(
        "SELECT * FROM keywords ORDER BY search_count DESC, last_searched_at DESC LIMIT ?"
      ).all(Math.min(Number(limit) || 100, 1000));
  return rows.map(r => ({
    keyword: r.keyword,
    firstSearchedAt: r.first_searched_at,
    lastSearchedAt: r.last_searched_at,
    searchCount: r.search_count,
    bestScore: r.best_score,
    lastVerdict: r.last_verdict,
    lastIntent: r.last_intent
  }));
}

function getKeyword(keyword, userId) {
  const r = userId
    ? db.prepare("SELECT * FROM keywords WHERE keyword_lower = ? AND user_id = ?").get(String(keyword).toLowerCase(), userId)
    : db.prepare("SELECT * FROM keywords WHERE keyword_lower = ?").get(String(keyword).toLowerCase());
  if (!r) return null;
  return {
    keyword: r.keyword,
    firstSearchedAt: r.first_searched_at,
    lastSearchedAt: r.last_searched_at,
    searchCount: r.search_count,
    bestScore: r.best_score,
    lastVerdict: r.last_verdict,
    lastIntent: r.last_intent
  };
}

function analytics(userId) {
  const where = userId ? "WHERE user_id = ?" : "";
  const params = userId ? [userId] : [];

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS totalSearches,
      COUNT(DISTINCT keyword_lower) AS uniqueKeywords,
      AVG(score) AS avgScore,
      MIN(created_at) AS firstSearchAt,
      MAX(created_at) AS lastSearchAt
    FROM searches ${where}
  `).get(...params);

  const verdicts = db.prepare(
    `SELECT verdict, COUNT(*) AS count FROM searches ${where} GROUP BY verdict ORDER BY count DESC`
  ).all(...params);

  const intents = db.prepare(
    `SELECT intent, COUNT(*) AS count FROM searches ${where} GROUP BY intent ORDER BY count DESC`
  ).all(...params);

  const byDay = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count, AVG(score) AS avgScore
    FROM searches ${where}
    GROUP BY day
    ORDER BY day ASC
  `).all(...params);

  const byEngine = db.prepare(
    `SELECT engine, COUNT(*) AS count FROM searches ${where} GROUP BY engine ORDER BY count DESC`
  ).all(...params);

  const byGoal = db.prepare(
    `SELECT goal, COUNT(*) AS count FROM searches ${where} GROUP BY goal ORDER BY count DESC`
  ).all(...params);

  const topKeywords = db.prepare(`
    SELECT keyword, keyword_lower, COUNT(*) AS searchCount,
           AVG(score) AS avgScore, MAX(created_at) AS lastSearchedAt
    FROM searches ${where}
    GROUP BY keyword_lower
    ORDER BY searchCount DESC, lastSearchedAt DESC
    LIMIT 15
  `).all(...params);

  const scoreBuckets = db.prepare(`
    SELECT
      CASE
        WHEN score >= 75 THEN '75-100 (OK)'
        WHEN score >= 55 THEN '55-74 (TEST)'
        WHEN score IS NULL THEN 'N/A'
        ELSE '0-54 (AVOID)'
      END AS bucket,
      COUNT(*) AS count
    FROM searches ${where}
    GROUP BY bucket
    ORDER BY bucket
  `).all(...params);

  const allSerps = db.prepare(`SELECT serp_json FROM searches ${where}`).all(...params);
  const domainCounts = {};
  for (const row of allSerps) {
    let serp;
    try { serp = JSON.parse(row.serp_json || "{}"); } catch { continue; }
    for (const item of (serp.organic || [])) {
      if (!item?.link) continue;
      try {
        const host = new URL(item.link).hostname.replace(/^www\./, "");
        if (host) domainCounts[host] = (domainCounts[host] || 0) + 1;
      } catch { /* ignore */ }
    }
  }
  const topDomains = Object.entries(domainCounts)
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return {
    totals: {
      totalSearches: totals.totalSearches || 0,
      uniqueKeywords: totals.uniqueKeywords || 0,
      avgScore: totals.avgScore != null ? Math.round(totals.avgScore * 10) / 10 : null,
      firstSearchAt: totals.firstSearchAt,
      lastSearchAt: totals.lastSearchAt
    },
    verdicts,
    intents,
    byDay,
    byEngine,
    byGoal,
    topKeywords,
    scoreBuckets,
    topDomains
  };
}

function searchHistory(query, limit = 50, userId, projectId, offset = 0) {
  const q = `%${String(query || "").toLowerCase()}%`;
  const filters = [];
  const params = [];
  if (userId) { filters.push("user_id = ?"); params.push(userId); }
  if (projectId) { filters.push("project_id = ?"); params.push(projectId); }
  filters.push("keyword_lower LIKE ?");
  params.push(q);
  params.push(Math.min(Number(limit) || 50, 200));
  params.push(Math.max(Number(offset) || 0, 0));
  const where = filters.join(" AND ");
  const rows = db.prepare(
    `SELECT * FROM searches WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params);
  return rows.map(rowToSearch);
}

function countSearches(userId, projectId, query) {
  const filters = [];
  const params = [];
  if (userId) { filters.push("user_id = ?"); params.push(userId); }
  if (projectId) { filters.push("project_id = ?"); params.push(projectId); }
  if (query) {
    filters.push("keyword_lower LIKE ?");
    params.push(`%${String(query).toLowerCase()}%`);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  return db.prepare(`SELECT COUNT(*) AS c FROM searches ${where}`).get(...params).c;
}

function updateSearchMeta(id, { notes, tags, projectId }, userId) {
  const row = userId
    ? db.prepare("SELECT id FROM searches WHERE id = ? AND user_id = ?").get(String(id), userId)
    : db.prepare("SELECT id FROM searches WHERE id = ?").get(String(id));
  if (!row) return false;
  if (notes !== undefined) {
    db.prepare("UPDATE searches SET notes = ? WHERE id = ?").run(String(notes || ""), String(id));
  }
  if (tags !== undefined) {
    const arr = Array.isArray(tags) ? tags.map(String) : [];
    db.prepare("UPDATE searches SET tags = ? WHERE id = ?").run(JSON.stringify(arr.slice(0, 20)), String(id));
  }
  if (projectId !== undefined) {
    db.prepare("UPDATE searches SET project_id = ? WHERE id = ?").run(projectId || null, String(id));
  }
  return true;
}

// --- projects ---
function listProjects(userId) {
  const rows = userId
    ? db.prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC").all(userId)
    : db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    searchCount: db.prepare("SELECT COUNT(*) AS c FROM searches WHERE project_id = ?").get(r.id).c
  }));
}
function createProject(name, userId) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Project name is required.");
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, userId || DEFAULT_USER_ID, n, new Date().toISOString());
  return { id, name: n };
}
function renameProject(id, name, userId) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Project name is required.");
  const info = userId
    ? db.prepare("UPDATE projects SET name = ? WHERE id = ? AND user_id = ?").run(n, String(id), userId)
    : db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(n, String(id));
  return info.changes > 0;
}
function deleteProject(id, userId) {
  db.prepare("UPDATE searches SET project_id = NULL WHERE project_id = ?").run(String(id));
  const info = userId
    ? db.prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").run(String(id), userId)
    : db.prepare("DELETE FROM projects WHERE id = ?").run(String(id));
  return info.changes > 0;
}

// --- backup ---
function backupDatabase(destPath) {
  // checkpoint WAL so the main .db file is complete, then copy
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* ok */ }
  fs.copyFileSync(DB_PATH, destPath);
  return destPath;
}
function restoreDatabase(srcPath) {
  if (!fs.existsSync(srcPath)) throw new Error("Backup file not found.");
  // basic sanity: file must be a SQLite DB
  const fd = fs.openSync(srcPath, "r");
  try {
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    if (header.toString("utf8", 0, 15) !== "SQLite format 3") {
      throw new Error("File is not a valid SQLite database.");
    }
  } finally {
    fs.closeSync(fd);
  }
  // checkpoint current DB, swap files
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* ok */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safety = DB_PATH + `.before-restore-${stamp}`;
  fs.copyFileSync(DB_PATH, safety);
  // close is not available on DatabaseSync cleanly mid-request; copy over after flush
  fs.copyFileSync(srcPath, DB_PATH);
  // remove stale wal/shm so next open is clean
  try { fs.rmSync(DB_PATH + "-wal", { force: true }); } catch {}
  try { fs.rmSync(DB_PATH + "-shm", { force: true }); } catch {}
  return { safetyPath: safety };
}

module.exports = {
  saveSearch,
  listSearches,
  getSearch,
  deleteSearch,
  listKeywords,
  getKeyword,
  analytics,
  searchHistory,
  countSearches,
  DB_PATH,
  DEFAULT_USER_ID,
  hashPassword,
  verifyPassword,
  getUserByUsername,
  getUserById,
  createUser,
  changePassword,
  createSession,
  getSessionUser,
  destroySession,
  listApiKeys,
  addApiKey,
  removeApiKey,
  setApiKeyActive,
  getActiveApiKeys,
  seedApiKeyFromEnv,
  updateSearchMeta,
  listProjects,
  createProject,
  renameProject,
  deleteProject,
  backupDatabase,
  restoreDatabase
};
