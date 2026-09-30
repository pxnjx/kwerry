const $ = id => document.getElementById(id);

function esc(s = "") {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}

function show(el, msg) {
  el.textContent = msg;
  el.classList.remove("hidden");
}
function hide(el) {
  el.classList.add("hidden");
  el.textContent = "";
}

async function loadKeys() {
  hide($("keysError"));
  try {
    const [keysRes, usageRes] = await Promise.all([
      fetch("/api/keys").then(r => r.json()),
      fetch("/api/usage").then(r => r.json())
    ]);
    const usageById = {};
    (usageRes.keys || []).forEach(k => { usageById[k.id] = k; });

    const items = keysRes.items || [];
    $("keysTable").innerHTML = items.map(k => {
      const u = usageById[k.id] || {};
      const quota = u.error
        ? `<span class="muted">error</span>`
        : (u.left != null && u.limit != null
            ? `${u.left}/${u.limit}`
            : "<span class='muted'>—</span>");
      return `
        <tr>
          <td>${esc(k.label)}</td>
          <td class="mono-cell">${esc(k.apiKeyMasked)}</td>
          <td>
            <button class="btn-mini" data-toggle="${esc(k.id)}" data-active="${k.isActive ? 1 : 0}">
              ${k.isActive ? "Active" : "Disabled"}
            </button>
          </td>
          <td class="mono-cell">${quota}</td>
          <td class="actions-cell">
            <button class="btn-mini icon-action" data-del="${esc(k.id)}" title="Remove">
              <svg class="icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.5 4.5h9"/><path d="M5 4.5l.5 8h5l.5-8"/><path d="M6.5 4.5V3h3v1.5"/></svg>
              Remove
            </button>
          </td>
        </tr>`;
    }).join("") || `<tr><td colspan="5" class="muted">No API keys yet.</td></tr>`;

    $("keysTable").querySelectorAll("[data-del]").forEach(btn => {
      btn.onclick = async () => {
        if (!confirm("Remove this API key?")) return;
        await fetch(`/api/keys/${encodeURIComponent(btn.getAttribute("data-del"))}`, { method: "DELETE" });
        loadKeys();
      };
    });
    $("keysTable").querySelectorAll("[data-toggle]").forEach(btn => {
      btn.onclick = async () => {
        const id = btn.getAttribute("data-toggle");
        const active = btn.getAttribute("data-active") === "1";
        await fetch(`/api/keys/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ active: !active })
        });
        loadKeys();
      };
    });
  } catch (e) {
    show($("keysError"), e.message || "Failed to load keys.");
  }
}

$("addKeyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hide($("keysError"));
  try {
    const r = await fetch("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: $("keyLabel").value,
        apiKey: $("keyValue").value
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed to add key.");
    $("keyLabel").value = "";
    $("keyValue").value = "";
    loadKeys();
  } catch (err) {
    show($("keysError"), err.message);
  }
});

$("passwordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hide($("passwordMsg"));
  const newPass = $("newPass").value;
  if (newPass !== $("newPass2").value) {
    show($("passwordMsg"), "New passwords do not match.");
    return;
  }
  try {
    const r = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: $("curPass").value,
        newPassword: newPass
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed to change password.");
    $("passwordForm").reset();
    alert("Password updated.");
  } catch (err) {
    show($("passwordMsg"), err.message);
  }
});

loadKeys();

/* ---- Backup / restore ---- */
function showBackup(msg, isErr) {
  const el = $("backupMsg");
  el.textContent = msg;
  el.classList.remove("hidden");
  el.classList.toggle("error", !!isErr);
}

$("downloadBackup").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/backup");
    if (!r.ok) throw new Error("Backup failed.");
    const blob = await r.blob();
    const match = /filename="?([^";]+)"?/i.exec(r.headers.get("content-disposition") || "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = match?.[1] || "kwerry-backup.db";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    showBackup("Backup downloaded.", false);
  } catch (e) {
    showBackup(e.message, true);
  }
});

$("restoreFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!confirm("Restore this backup? The current database will be replaced.")) {
    e.target.value = "";
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const r = await fetch("/api/backup/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: b64 })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Restore failed.");
    showBackup(d.message || "Restored. Restart the server.", false);
    alert(d.message || "Database restored. Restart the Kwerry server to load the restored data.");
  } catch (err) {
    showBackup(err.message, true);
  } finally {
    e.target.value = "";
  }
});
