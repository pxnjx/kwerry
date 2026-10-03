import React, { useCallback, useEffect, useState } from "react";
import { api, fmtCompact, fmtDay, fmtUntil } from "../api.js";
import { DownloadIcon, EyeIcon, EyeSlashIcon, TrashIcon, UploadIcon } from "../components/icons.jsx";

function PanelHead({ eyebrow, title, desc, meta }) {
  return (
    <div className="settings-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        <p className="muted settings-desc">{desc}</p>
      </div>
      {meta}
    </div>
  );
}

export default function Settings() {
  const [keys, setKeys] = useState([]);
  const [keysError, setKeysError] = useState("");
  const [keysLoading, setKeysLoading] = useState(true);
  const [backupMsg, setBackupMsg] = useState("");
  const [backupErr, setBackupErr] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState("");
  const [passwordOk, setPasswordOk] = useState(false);
  const [showPw, setShowPw] = useState({ cur: false, next: false, again: false });
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  // Which key the delete dialog is currently holding. Null means the dialog is
  // closed. Replaces the old window.confirm() -- a native dialog cannot name the
  // key, cannot be styled, and blocks the whole page.
  const [pendingDelete, setPendingDelete] = useState(null);

  const loadKeys = useCallback(async () => {
    setKeysError("");
    setKeysLoading(true);
    try {
      const [keysRes, usageRes] = await Promise.all([
        api("/api/keys"),
        api("/api/usage").catch(() => ({ keys: [] }))
      ]);
      const usageById = {};
      (usageRes.keys || []).forEach((k) => {
        usageById[k.id] = k;
      });
      const items = (keysRes.items || []).map((k) => ({
        ...k,
        usage: usageById[k.id] || {}
      }));
      setKeys(items);
    } catch (e) {
      setKeysError(e.message || "Failed to load keys.");
    } finally {
      setKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  async function addKey(e) {
    e.preventDefault();
    setKeysError("");
    try {
      await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ label, apiKey })
      });
      setLabel("");
      setApiKey("");
      loadKeys();
    } catch (err) {
      setKeysError(err.message);
    }
  }

  async function toggleKey(k) {
    await api(`/api/keys/${encodeURIComponent(k.id)}`, {
      method: "POST",
      body: JSON.stringify({ active: !k.isActive })
    }).catch((e) => setKeysError(e.message));
    loadKeys();
  }

  // Actually deletes. Kept separate from the row's onClick so the dialog is the
  // only thing that can trigger it -- no stray confirm() left behind.
  async function removeKey(k) {
    await api(`/api/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" }).catch((e) =>
      setKeysError(e.message)
    );
    setPendingDelete(null);
    loadKeys();
  }

  async function changePassword(e) {
    e.preventDefault();
    setPasswordMsg("");
    setPasswordOk(false);
    const form = new FormData(e.target);
    const newPassword = form.get("newPass");
    const newPass2 = form.get("newPass2");
    if (newPassword !== newPass2) {
      setPasswordMsg("New passwords do not match.");
      return;
    }
    if (String(newPassword || "").length < 6) {
      setPasswordMsg("New password must be at least 6 characters.");
      return;
    }
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: form.get("curPass"),
          newPassword
        })
      });
      e.target.reset();
      setShowPw({ cur: false, next: false, again: false });
      setPasswordOk(true);
      setPasswordMsg("Password updated.");
    } catch (err) {
      setPasswordMsg(err.message);
    }
  }

  const activeKeys = keys.filter((k) => k.isActive).length;

  async function downloadBackup() {
    setBackupMsg("");
    setBackupErr(false);
    try {
      const r = await fetch("/api/backup", { credentials: "same-origin" });
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
      setBackupMsg("Backup downloaded.");
    } catch (e) {
      setBackupMsg(e.message);
      setBackupErr(true);
    }
  }

  async function restoreFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!confirm("Restore this backup? The current database will be replaced.")) {
      e.target.value = "";
      return;
    }
    setBackupMsg("");
    setBackupErr(false);
    try {
      const reader = new FileReader();
      const b64 = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
        reader.onerror = () => reject(new Error("Could not read the backup file."));
        reader.readAsDataURL(file);
      });
      const d = await api("/api/backup/restore", {
        method: "POST",
        body: JSON.stringify({ data: b64 })
      });
      setBackupMsg(d.message || "Restored. Restart the server.");
      alert(d.message || "Database restored. Restart the Kwerry server to load the restored data.");
    } catch (err) {
      setBackupMsg(err.message);
      setBackupErr(true);
    } finally {
      e.target.value = "";
    }
  }

  return (
    <>
      <header>
        <div>
          <span className="eyebrow">KWERRY</span>
          <h1>Settings</h1>
          <p>Manage SerpAPI keys and your account.</p>
        </div>
      </header>

      <article className="panel settings-panel">
        <div className="settings-head">
          <div>
            <span className="eyebrow">01 · API</span>
            <h2>SerpAPI keys</h2>
            <p className="muted settings-desc">
              Add multiple keys to pool quota across accounts. Active keys are used in rotation; when one hits a limit, Kwerry tries the next.
            </p>
          </div>
          <span className={"settings-count" + (activeKeys ? " is-on" : "")}>
            {keysLoading ? "…" : `${activeKeys} active / ${keys.length} total`}
          </span>
        </div>
        {keysError && (
          <div className="error" role="alert">
            {keysError}
          </div>
        )}
        <div className="tableWrap settings-table">
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Key</th>
                <th>Status</th>
                <th>Quota</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const u = k.usage || {};
                const hasQuota = u.left != null && u.limit != null;
                const pct = hasQuota && u.limit > 0 ? Math.min(100, Math.round((u.left / u.limit) * 100)) : 0;
                const quota =
                  u.error != null ? (
                    <span className="muted">error</span>
                  ) : hasQuota ? (
                    <span className="quota">
                      <span className="quota-bar" aria-hidden="true">
                        <span className="quota-fill" style={{ width: `${pct}%` }} />
                      </span>
                      {u.left}/{u.limit}
                    </span>
                  ) : (
                    "—"
                  );

                // SerpAPI runs on two independent windows: a monthly plan
                // allowance that refills on plan_renewal_date, and a per-hour
                // rate limit. Both were fetched and thrown away before, so say
                // when the quota comes back, not just how much is left.
                const meta = [];
                if (u.error == null) {
                  const plan = [u.plan, u.used != null ? `${fmtCompact(u.used)} used this month` : null]
                    .filter(Boolean)
                    .join(" · ");
                  if (plan) meta.push(plan);

                  const until = fmtUntil(u.renewsAt);
                  if (until) {
                    const day = fmtDay(u.renewsAt);
                    meta.push(`Resets ${until === "now" ? "now" : `in ${until}`}${day ? ` · ${day}` : ""}`);
                  }

                  if (u.hourLimit != null) {
                    const used = u.hourLeft != null ? u.hourLimit - u.hourLeft : null;
                    meta.push(`${fmtCompact(u.hourLimit)}/hour${used != null ? ` · ${fmtCompact(used)} used` : ""}`);
                  }
                }

                return (
                  <tr key={k.id}>
                    <td className="label-cell">{k.label || "—"}</td>
                    <td className="mono-cell">{k.apiKeyMasked || k.masked || "—"}</td>
                    <td>
                      <button
                        className={"status-pill" + (k.isActive ? " is-on" : "")}
                        type="button"
                        onClick={() => toggleKey(k)}
                        title={k.isActive ? "Click to disable" : "Click to enable"}
                      >
                        <span className="dot" aria-hidden="true" />
                        {k.isActive ? "Active" : "Disabled"}
                      </button>
                    </td>
                    <td className="mono-cell">
                      {quota}
                      {meta.length > 0 && (
                        <div className="quota-meta">
                          {meta.map((line) => (
                            <span key={line}>{line}</span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="actions-cell">
                      <button className="btn-mini btn-danger icon-action" type="button" title="Remove" onClick={() => setPendingDelete(k)}>
                        <TrashIcon />
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!keys.length && !keysLoading && (
                <tr>
                  <td colSpan={5} className="muted">
                    No API keys yet — add your first SerpAPI key below.
                  </td>
                </tr>
              )}
              {!keys.length && keysLoading && (
                <tr>
                  <td colSpan={5} className="muted">
                    Loading keys…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <form className="key-form settings-add" onSubmit={addKey}>
          <div className="field-grow">
            <label htmlFor="keyLabel">Label</label>
            <input id="keyLabel" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Account B" autoComplete="off" />
          </div>
          <div className="field-grow">
            <label htmlFor="keyValue">API key</label>
            <div className="input-wrap">
              <input
                id="keyValue"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="SerpAPI key"
                autoComplete="off"
                required
              />
              <button
                type="button"
                className="input-toggle"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? "Hide API key" : "Show API key"}
                title={showKey ? "Hide API key" : "Show API key"}
              >
                {showKey ? <EyeSlashIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>
          <button className="btn-run" type="submit">
            Add key
          </button>
        </form>
      </article>

      <div className="settings-grid">
        <article className="panel settings-panel">
          <PanelHead
            eyebrow="02 · SECURITY"
            title="Change password"
            desc="Use at least 6 characters. Other sessions are signed out for safety."
          />
          <form className="auth-form settings-form" onSubmit={changePassword}>
            <label htmlFor="curPass">Current password</label>
            <div className="input-wrap">
              <input id="curPass" name="curPass" type={showPw.cur ? "text" : "password"} autoComplete="current-password" required />
              <button type="button" className="input-toggle" onClick={() => setShowPw((s) => ({ ...s, cur: !s.cur }))} aria-label={showPw.cur ? "Hide current password" : "Show current password"}>
                {showPw.cur ? <EyeSlashIcon /> : <EyeIcon />}
              </button>
            </div>
            <div className="pw-row">
              <div>
                <label htmlFor="newPass">New password</label>
                <div className="input-wrap">
                  <input id="newPass" name="newPass" type={showPw.next ? "text" : "password"} autoComplete="new-password" required minLength={6} />
                  <button
                    type="button"
                    className="input-toggle"
                    onClick={() => setShowPw((s) => ({ ...s, next: !s.next }))}
                    aria-label={showPw.next ? "Hide new password" : "Show new password"}
                    title={showPw.next ? "Hide new password" : "Show new password"}
                  >
                    {showPw.next ? <EyeSlashIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>
              <div>
                <label htmlFor="newPass2">Confirm new password</label>
                <div className="input-wrap">
                  <input id="newPass2" name="newPass2" type={showPw.again ? "text" : "password"} autoComplete="new-password" required minLength={6} />
                  <button
                    type="button"
                    className="input-toggle"
                    onClick={() => setShowPw((s) => ({ ...s, again: !s.again }))}
                    aria-label={showPw.again ? "Hide confirmation" : "Show confirmation"}
                    title={showPw.again ? "Hide confirmation" : "Show confirmation"}
                  >
                    {showPw.again ? <EyeSlashIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>
            </div>
            <button type="submit" className="btn-run">
              Save password
            </button>
          </form>
          {passwordMsg && (
            <div className={passwordOk ? "ok-msg" : "error"} role="alert" style={{ marginTop: 12 }}>
              {passwordMsg}
            </div>
          )}
        </article>

        <article className="panel settings-panel">
          <PanelHead
            eyebrow="03 · DATA"
            title="Database backup"
            desc="Download a full SQLite backup (searches, keywords, notes, users). Restore replaces the current database — keep a backup first."
          />
          {backupMsg && (
            <div className={backupErr ? "error" : "ok-msg"} role="alert">
              {backupMsg}
            </div>
          )}
          <div className="backup-actions">
            <button id="downloadBackup" className="btn-run" type="button" onClick={downloadBackup}>
              <DownloadIcon />
              Download backup
            </button>
            <label className="btn-ghost file-btn">
              <UploadIcon />
              Restore from file
              <input type="file" accept=".db,application/octet-stream" hidden onChange={restoreFile} />
            </label>
          </div>
          <p className="muted settings-note">After restore, restart the Kwerry server to load the restored data.</p>
        </article>
      </div>

      {/* Delete confirmation. Reuses the sign-out dialog's classes so both
          dialogs in the app look identical. The old window.confirm() could not
          say WHICH key was going away -- this names the label and masked key. */}
      {pendingDelete && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target.classList?.contains("modal")) setPendingDelete(null);
          }}
        >
          <div className="modal-card modal-sm">
            <h2>Remove API key?</h2>
            <p className="muted" style={{ margin: "0 0 var(--sp-2)" }}>
              <span className="mono-cell">
                {pendingDelete.label ? `${pendingDelete.label} · ` : ""}
                {pendingDelete.apiKeyMasked || pendingDelete.masked || "—"}
              </span>{" "}
              will stop being used for research. If it is your only key, searches will fail until you add
              another one. This cannot be undone.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-ghost btn-sm" onClick={() => setPendingDelete(null)}>
                Cancel
              </button>
              <button type="button" className="btn-run btn-sm btn-danger-solid" onClick={() => removeKey(pendingDelete)}>
                <TrashIcon />
                Remove key
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}
