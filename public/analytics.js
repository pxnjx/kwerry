const $ = id => document.getElementById(id);
function esc(s = "") {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}
function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return iso; }
}
function pct(n, total) {
  if (!total) return 0;
  return Math.round((n / total) * 1000) / 10;
}

function renderBars(el, rows, total, colorFn) {
  if (!rows.length) {
    el.innerHTML = '<p class="muted">No data yet.</p>';
    return;
  }
  el.innerHTML = rows.map((r, i) => {
    const width = total ? Math.max(4, Math.round((r.count / total) * 100)) : 4;
    const color = colorFn ? colorFn(r, i) : "#1f1f1f";
    return `
      <div class="bar-row">
        <div class="bar-label">${esc(r.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${color}"></div></div>
        <div class="bar-value">${r.count} <small>${pct(r.count, total)}%</small></div>
      </div>`;
  }).join("");
}

function renderDayChart(el, rows) {
  if (!rows.length) {
    el.innerHTML = '<p class="muted">No data yet.</p>';
    return;
  }
  const max = Math.max(...rows.map(r => r.count), 1);
  el.innerHTML = `<div class="day-bars">` + rows.map(r => {
    const h = Math.max(6, Math.round((r.count / max) * 120));
    return `
      <div class="day-col" title="${esc(r.day)} · ${r.count} searches">
        <div class="day-bar" style="height:${h}px"></div>
        <div class="day-label">${esc(r.day.slice(5))}</div>
      </div>`;
  }).join("") + `</div>`;
}

async function load() {
  $("loading").classList.remove("hidden");
  $("error").classList.add("hidden");
  $("dash").classList.add("hidden");
  try {
    const r = await fetch("/api/analytics");
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed to load analytics");

    const t = d.totals || {};
    $("kpiTotal").textContent = t.totalSearches ?? 0;
    $("kpiUnique").textContent = t.uniqueKeywords ?? 0;
    $("kpiAvg").textContent = t.avgScore != null ? t.avgScore + "/100" : "—";
    $("kpiLast").textContent = t.lastSearchAt ? fmtDate(t.lastSearchAt) : "—";

    const totalSearches = t.totalSearches || 0;

    renderBars($("verdictChart"),
      (d.verdicts || []).map(v => ({ label: v.verdict || "—", count: v.count })),
      totalSearches,
      (r) => r.label === "OK" ? "#1f1f1f" : r.label === "TEST" ? "#6f6f6f" : "#a9a9a9"
    );

    renderBars($("intentChart"),
      (d.intents || []).map(v => ({ label: v.intent || "—", count: v.count })),
      totalSearches
    );

    renderBars($("scoreChart"),
      (d.scoreBuckets || []).map(v => ({ label: v.bucket, count: v.count })),
      totalSearches
    );

    renderDayChart($("dayChart"), d.byDay || []);

    $("topKeywords").innerHTML = (d.topKeywords || []).map(k => `
      <tr>
        <td class="kw-cell">${esc(k.keyword)}</td>
        <td>${k.searchCount}</td>
        <td>${k.avgScore != null ? Math.round(k.avgScore * 10) / 10 : "—"}</td>
        <td class="mono-cell">${fmtDate(k.lastSearchedAt)}</td>
      </tr>`).join("") || `<tr><td colspan="4" class="muted">No data yet.</td></tr>`;

    renderBars($("topDomains"),
      (d.topDomains || []).map(v => ({ label: v.domain, count: v.count })),
      (d.topDomains || []).reduce((s, x) => s + x.count, 0) || 1
    );

    $("dash").classList.remove("hidden");
  } catch (e) {
    $("error").textContent = e.message;
    $("error").classList.remove("hidden");
  } finally {
    $("loading").classList.add("hidden");
  }
}

load();
