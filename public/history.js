const $ = id => document.getElementById(id);
function esc(s = "") {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}
function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return iso; }
}

const PAGE_SIZE = 10;
let histPage = 1;
let histTotal = 0;

async function loadHistory(q) {
  const project = $("projectFilter")?.value || "";
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String((histPage - 1) * PAGE_SIZE)
  });
  if (q) params.set("q", q);
  if (project) params.set("project", project);
  const r = await fetch(`/api/searches?${params}`);
  const d = await r.json().catch(() => ({ items: [], total: 0 }));
  const items = d.items || [];
  histTotal = d.total ?? items.length;
  const totalPages = Math.max(1, Math.ceil(histTotal / PAGE_SIZE));
  if (histPage > totalPages) {
    histPage = totalPages;
    return loadHistory(q);
  }

  $("historyCount").textContent = histTotal
    ? `Showing ${items.length ? (histPage - 1) * PAGE_SIZE + 1 : 0}–${(histPage - 1) * PAGE_SIZE + items.length} of ${histTotal}`
    : "No search history yet.";

  $("historyTable").innerHTML = items.map((x, i) => {
    const tags = (x.tags || []).join(", ");
    const n = (histPage - 1) * PAGE_SIZE + i + 1;
    return `
    <tr data-id="${esc(x.id)}">
      <td>${n}</td>
      <td class="kw-cell"><a href="/research.html?load=${encodeURIComponent(x.id)}">${esc(x.keyword)}</a></td>
      <td>${x.evaluation?.score ?? "—"}</td>
      <td>${esc(x.evaluation?.verdict || "—")}</td>
      <td><input class="cell-input tags-input" data-id="${esc(x.id)}" value="${esc(tags)}" placeholder="tag1, tag2"></td>
      <td><input class="cell-input notes-input" data-id="${esc(x.id)}" value="${esc(x.notes || "")}" placeholder="Add note…"></td>
      <td class="mono-cell">${fmtDate(x.createdAt)}</td>
      <td class="actions-cell">
        <a class="icon-action" href="/research.html?load=${encodeURIComponent(x.id)}" title="Open">
          <svg class="icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 3.5h6.5V10"/><path d="M12.5 3.5L7 9"/><path d="M10 9.5v3h-7v-7h3"/>
          </svg>
          Open
        </a>
        <button class="btn-mini icon-action" data-del="${esc(x.id)}" title="Delete">
          <svg class="icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.5 4.5h9"/><path d="M5 4.5l.5 8h5l.5-8"/><path d="M6.5 4.5V3h3v1.5"/></svg>
          Delete
        </button>
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="muted">No search history yet.</td></tr>`;

  renderPagination(totalPages);

  $("historyTable").querySelectorAll(".tags-input, .notes-input").forEach(input => {
    input.addEventListener("change", async () => {
      const id = input.getAttribute("data-id");
      const body = input.classList.contains("tags-input")
        ? { tags: input.value.split(",").map(s => s.trim()).filter(Boolean) }
        : { notes: input.value };
      await fetch(`/api/searches/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    });
  });

  $("historyTable").querySelectorAll("[data-del]").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("Delete this search record?")) return;
      const id = btn.getAttribute("data-del");
      const del = await fetch(`/api/searches/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (del.ok) loadHistory($("searchFilter").value.trim());
    };
  });
}

function renderPagination(totalPages) {
  const el = $("historyPagination");
  if (totalPages <= 1) {
    el.innerHTML = "";
    return;
  }
  const btn = (label, page, disabled, active) =>
    `<button class="page-btn${active ? " active" : ""}" data-page="${page}" ${disabled ? "disabled" : ""}>${label}</button>`;

  let html = btn("‹", histPage - 1, histPage <= 1, false);
  const start = Math.max(1, histPage - 2);
  const end = Math.min(totalPages, histPage + 2);
  if (start > 1) html += btn("1", 1, false, false) + (start > 2 ? `<span class="page-dots">…</span>` : "");
  for (let p = start; p <= end; p++) html += btn(String(p), p, false, p === histPage);
  if (end < totalPages) html += (end < totalPages - 1 ? `<span class="page-dots">…</span>` : "") + btn(String(totalPages), totalPages, false, false);
  html += btn("›", histPage + 1, histPage >= totalPages, false);
  el.innerHTML = html;

  el.querySelectorAll(".page-btn").forEach(b => {
    b.addEventListener("click", () => {
      const p = Number(b.getAttribute("data-page"));
      if (!p || p === histPage) return;
      histPage = p;
      loadHistory($("searchFilter").value.trim());
    });
  });
}

async function loadProjectFilter() {
  try {
    const r = await fetch("/api/projects");
    const d = await r.json();
    const sel = $("projectFilter");
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `<option value="">All projects</option>` +
      (d.items || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    sel.value = current;
  } catch { /* ignore */ }
}

$("searchFilter").addEventListener("input", e => {
  histPage = 1;
  loadHistory(e.target.value.trim());
});
$("projectFilter")?.addEventListener("change", () => {
  histPage = 1;
  loadHistory($("searchFilter").value.trim());
});
$("exportCsv").addEventListener("click", () => {
  const q = $("searchFilter").value.trim();
  const project = $("projectFilter").value || "";
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (project) params.set("project", project);
  location.href = `/api/export/csv?${params}`;
});

loadProjectFilter();
loadHistory("");
