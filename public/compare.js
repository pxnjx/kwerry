const $ = id => document.getElementById(id);
function esc(s = "") {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}

function showLoading(on) {
  $("compareLoading").classList.toggle("hidden", !on);
}
function showError(msg) {
  const el = $("compareError");
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function loadOptions() {
  $("compareEmpty").classList.remove("hidden");
  $("compareResult").classList.add("hidden");
  showError("");
  try {
    const r = await fetch("/api/searches?limit=200");
    const d = await r.json();
    const items = d.items || [];
    if (!items.length) {
      $("pickA").innerHTML = `<option value="">— no searches yet —</option>`;
      $("pickB").innerHTML = `<option value="">— no searches yet —</option>`;
      $("compareEmpty").innerHTML = `<p class="muted">No saved searches yet. Run a research first on the Research page.</p>`;
      return;
    }
    const opts = items.map(x =>
      `<option value="${esc(x.id)}">${esc(x.keyword)} · ${x.evaluation?.score ?? "—"} · ${esc((x.createdAt || "").slice(0, 10))}</option>`
    ).join("");
    $("pickA").innerHTML = `<option value="">— select —</option>` + opts;
    $("pickB").innerHTML = `<option value="">— select —</option>` + opts;
    $("compareEmpty").innerHTML = `<p class="muted">Pick two saved searches above, then click <strong>Compare</strong>.</p>`;
  } catch (e) {
    showError(e.message || "Failed to load searches.");
    $("pickA").innerHTML = `<option value="">— select —</option>`;
    $("pickB").innerHTML = `<option value="">— select —</option>`;
  }
}

function metricsBlock(title, s) {
  if (!s) return `<article class="panel panel-compact"><h2>${esc(title)}</h2><p class="muted">Not selected.</p></article>`;
  const domains = new Set((s.serp?.organic || []).map(x => {
    try { return new URL(x.link).hostname.replace(/^www\./, ""); } catch { return ""; }
  }).filter(Boolean)).size;
  return `
    <article class="panel panel-compact">
      <h2>${esc(s.keyword)}</h2>
      <div class="metrics metrics-inline">
        <div class="metric-mini"><span>Verdict</span><b>${esc(s.evaluation?.verdict || "—")}</b></div>
        <div class="metric-mini"><span>Score</span><b>${s.evaluation?.score ?? "—"}/100</b></div>
        <div class="metric-mini"><span>Intent</span><b>${esc(s.evaluation?.intent || "—")}</b></div>
        <div class="metric-mini"><span>Domains</span><b>${domains}</b></div>
      </div>
      <ul class="tight-list">${(s.evaluation?.reasons || []).map(r => `<li>${esc(r)}</li>`).join("")}</ul>
      <p class="muted" style="margin:8px 0 0">Searched ${esc(s.createdAt || "")}</p>
    </article>`;
}

$("runCompare").onclick = async () => {
  const a = $("pickA").value;
  const b = $("pickB").value;
  showError("");
  $("compareResult").classList.add("hidden");
  if (!a || !b) {
    showError("Select two keywords to compare.");
    $("compareEmpty").classList.remove("hidden");
    return;
  }
  if (a === b) {
    showError("Pick two different searches.");
    $("compareEmpty").classList.remove("hidden");
    return;
  }
  $("compareEmpty").classList.add("hidden");
  showLoading(true);
  try {
    const r = await fetch(`/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Compare failed.");
    $("compareResult").innerHTML =
      metricsBlock("Keyword A", d.a) + metricsBlock("Keyword B", d.b);
    $("compareResult").classList.remove("hidden");
    if (!d.a && !d.b) {
      showError("Could not load those searches.");
      $("compareEmpty").classList.remove("hidden");
    }
  } catch (e) {
    showError(e.message);
    $("compareEmpty").classList.remove("hidden");
  } finally {
    showLoading(false);
  }
};

loadOptions();
