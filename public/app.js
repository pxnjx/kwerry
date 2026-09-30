const $ = id => document.getElementById(id);
let lastResult = null;

const ICON_OK = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M5.2 8.2l2 2 3.6-3.8"/></svg>`;
const ICON_WARN = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5L14 13H2L8 2.5z"/><path d="M8 6.5v3"/><circle cx="8" cy="11.2" r="0.6" fill="currentColor" stroke="none"/></svg>`;

/* ---- Research mode tabs (single / bulk) ---- */
document.querySelectorAll(".form-modes .tab").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    document.querySelectorAll(".form-modes .tab").forEach(b => b.classList.toggle("active", b === btn));
    $("singleForm").classList.toggle("hidden", mode !== "single");
    $("bulkForm").classList.toggle("hidden", mode !== "bulk");
  });
});

/* ---- Projects ---- */
async function loadProjects() {
  try {
    const r = await fetch("/api/projects");
    const d = await r.json();
    const items = d.items || [];
    for (const sel of [$("project"), $("bulkProject")]) {
      if (!sel) continue;
      const current = sel.value;
      sel.innerHTML = `<option value="">No project</option>` +
        items.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.searchCount})</option>`).join("");
      sel.value = current;
    }
  } catch { /* ignore */ }
}
loadProjects();

function initApiStatus() {
  fetch("/api/health").then(r => r.json()).then(async h => {
    const badge = $("apiState");
    const label = $("apiStateLabel");
    const bar = $("apiLimitBar");
    const fill = $("apiLimitFill");
    const text = $("apiLimitText");
    const icon = badge.querySelector(".badge-icon");

    if (!h.serpApiConfigured) {
      badge.className = "badge badge-usage warn";
      icon.innerHTML = ICON_WARN;
      label.textContent = "API key required";
      bar.hidden = true;
      text.textContent = "";
      return;
    }

    badge.className = "badge badge-usage ok";
    icon.innerHTML = ICON_OK;
    label.textContent = "SerpAPI connected";

    try {
      const u = await fetch("/api/usage").then(r => r.json());
      const limit = u.totals?.limit ?? u.limit ?? null;
      const left = u.totals?.left ?? u.left ?? null;
      const keyCount = (u.keys || []).length;
      if (limit != null && left != null) {
        const pctLeft = Math.max(0, Math.min(100, Math.round((left / limit) * 100)));
        bar.hidden = false;
        fill.style.width = pctLeft + "%";
        fill.classList.toggle("is-low", pctLeft <= 20);
        text.textContent = `${left}/${limit} searches left`;
        if (keyCount > 1) text.textContent += ` · ${keyCount} keys`;
      } else {
        text.textContent = u.error ? "quota unavailable" : (keyCount ? `${keyCount} key(s)` : "");
      }
    } catch {
      text.textContent = "";
    }
  });
}
initApiStatus();

function domain(link) {
  try { return new URL(link).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function esc(s = "") {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "short", year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  } catch { return iso; }
}

function showHistoryBanner(createdAt, keyword) {
  const banner = $("historyBanner");
  const text = $("historyBannerText");
  text.innerHTML = `Showing saved search of <strong>${esc(keyword || "keyword")}</strong> — searched on <strong>${esc(fmtDate(createdAt))}</strong>`;
  banner.classList.remove("hidden");
}
function hideHistoryBanner() {
  $("historyBanner").classList.add("hidden");
}

function renderRecItem(x) {
  return `<div class="rec"><b>${esc(x.text)}</b><small>${esc(x.source)} · ${esc(x.type)}</small></div>`;
}

function renderResult(d, opts = {}) {
  lastResult = d;
  $("verdict").textContent = d.evaluation.verdict;
  $("score").textContent = d.evaluation.score + "/100";
  $("intent").textContent = d.evaluation.intent;
  $("domains").textContent = new Set(d.serp.organic.map(x => domain(x.link))).size;

  $("reasons").innerHTML = d.evaluation.reasons.map(x => `<li>${esc(x)}</li>`).join("");

  const recs = d.recommendations || [];
  $("topRecs").innerHTML = recs.slice(0, 5).map(renderRecItem).join("") || '<p class="muted">No recommendations.</p>';
  $("recommendations").innerHTML = recs.map(renderRecItem).join("") || '<p class="muted">No recommendations.</p>';

  $("serp").innerHTML = d.serp.organic.map(x => `
    <tr>
      <td class="pos-cell">${x.position || ""}</td>
      <td>
        <a class="serp-title" target="_blank" rel="noopener" href="${esc(x.link)}">${esc(x.title)}</a>
        <div class="serp-snippet">${esc(x.snippet || "")}</div>
        <div class="serp-url"><a target="_blank" rel="noopener" href="${esc(x.link)}">${esc(x.link || "")}</a></div>
      </td>
      <td class="dom-cell">${esc(domain(x.link))}</td>
    </tr>`).join("");

  $("paa").innerHTML = d.serp.paa.map(x => `<span class="chip">${esc(x)}</span>`).join("") || '<span class="muted">Not found.</span>';
  $("related").innerHTML = d.serp.related.map(x => `<span class="chip">${esc(x)}</span>`).join("") || '<span class="muted">Not found.</span>';

  if (opts.fromHistory && d.createdAt) {
    showHistoryBanner(d.createdAt, d.keyword);
  } else {
    hideHistoryBanner();
  }

  activateTab("overview");
  $("result").classList.remove("hidden");
}

function activateTab(name) {
  document.querySelectorAll(".result-tabs .tab").forEach(btn => {
    const on = btn.dataset.tab === name;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach(p => {
    p.classList.toggle("active", p.id === `tab-${name}`);
  });
}
document.querySelectorAll(".result-tabs .tab").forEach(btn => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

$("gotoIdeas").onclick = (e) => {
  e.preventDefault();
  activateTab("ideas");
};

$("clearHistoryView").onclick = () => {
  hideHistoryBanner();
  $("result").classList.add("hidden");
  $("keyword").focus();
};

/* ---- Single research ---- */
$("run").onclick = async () => {
  $("loading").classList.remove("hidden");
  $("error").classList.add("hidden");
  $("result").classList.add("hidden");
  hideHistoryBanner();
  try {
    const r = await fetch("/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keyword: $("keyword").value,
        engine: $("engine").value,
        location: $("location").value,
        goal: $("goal").value,
        projectId: $("project").value || null
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Research failed");
    renderResult(d, { fromHistory: false });
    loadProjects();
  } catch (e) {
    $("error").textContent = e.message;
    $("error").classList.remove("hidden");
  } finally {
    $("loading").classList.add("hidden");
  }
};

$("keyword").addEventListener("keydown", e => {
  if (e.key === "Enter") $("run").click();
});

/* ---- Bulk research ---- */
$("runBulk").onclick = async () => {
  const list = $("bulkKeywords").value
    .split(/[\n,]+/)
    .map(x => x.trim())
    .filter(Boolean);
  if (!list.length) {
    $("error").textContent = "Add at least one keyword.";
    $("error").classList.remove("hidden");
    return;
  }
  $("bulkProgress").classList.remove("hidden");
  $("bulkProgress").textContent = `Running ${list.length} keyword(s)…`;
  $("error").classList.add("hidden");
  $("result").classList.add("hidden");
  hideHistoryBanner();
  try {
    const r = await fetch("/api/research/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keywords: list,
        engine: $("bulkEngine").value,
        location: $("bulkLocation").value,
        goal: $("bulkGoal").value,
        projectId: $("bulkProject").value || null
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Bulk research failed");
    renderBulkResults(d);
    loadProjects();
  } catch (e) {
    $("error").textContent = e.message;
    $("error").classList.remove("hidden");
  } finally {
    $("bulkProgress").classList.add("hidden");
  }
};

function renderBulkResults(d) {
  $("verdict").textContent = `${d.results.length}/${d.total}`;
  $("score").textContent = "bulk";
  $("intent").textContent = "—";
  $("domains").textContent = "—";
  $("reasons").innerHTML = (d.errors || []).length
    ? d.errors.map(x => `<li>${esc(x.keyword)}: ${esc(x.error)}</li>`).join("")
    : "<li>All keywords completed.</li>";
  $("topRecs").innerHTML = d.results.map(r =>
    `<div class="rec"><b>${esc(r.keyword)}</b><small>${esc(r.evaluation?.verdict || "")} · ${r.evaluation?.score ?? "—"} · ${esc(fmtDate(r.createdAt))}</small></div>`
  ).join("");
  $("recommendations").innerHTML = d.results.map(r =>
    `<div class="rec"><b>${esc(r.keyword)}</b><small>${esc(r.evaluation?.verdict || "")} · ${r.evaluation?.score ?? "—"} · <a href="/research.html?load=${encodeURIComponent(r.id)}">Open</a></small></div>`
  ).join("");
  $("serp").innerHTML = d.results.map(r =>
    `<tr>
      <td class="pos-cell">—</td>
      <td><a class="serp-title" href="/research.html?load=${encodeURIComponent(r.id)}">${esc(r.keyword)}</a>
        <div class="serp-snippet">${esc(r.evaluation?.reasons?.[0] || "")}</div></td>
      <td class="dom-cell">${esc(r.evaluation?.verdict || "")}</td>
    </tr>`
  ).join("");
  $("paa").innerHTML = "";
  $("related").innerHTML = "";
  activateTab("overview");
  $("result").classList.remove("hidden");
}

/* ---- Download MD ---- */
$("download").onclick = async () => {
  if (!lastResult) {
    $("error").textContent = "No result to download.";
    $("error").classList.remove("hidden");
    return;
  }
  const btn = $("download");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Downloading…";
  try {
    const r = await fetch("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lastResult)
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || "Failed to download report.");
    }
    const blob = await r.blob();
    const match = /filename="?([^";]+)"?/i.exec(r.headers.get("content-disposition") || "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = match?.[1] || "keyword-report.md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    $("error").textContent = e.message;
    $("error").classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
};

/* ---- ?load=<id> ---- */
(function loadFromQuery() {
  const params = new URLSearchParams(location.search);
  const id = params.get("load");
  if (!id) return;
  fetch(`/api/searches/${encodeURIComponent(id)}`)
    .then(r => r.json())
    .then(d => {
      if (d.error) throw new Error(d.error);
      $("keyword").value = d.keyword || "";
      if (d.engine) $("engine").value = d.engine;
      if (d.location) $("location").value = d.location;
      if (d.goal) $("goal").value = d.goal;
      if (d.projectId) $("project").value = d.projectId;
      renderResult(d, { fromHistory: true });
    })
    .catch(e => {
      $("error").textContent = e.message;
      $("error").classList.remove("hidden");
    });
})();
