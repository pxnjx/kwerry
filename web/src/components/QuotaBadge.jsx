import { useEffect, useState } from "react";
import { api, fmtUntil } from "../api.js";

// SerpAPI quota tracker — restores the badge the pre-React header had.
// /api/usage is admin-only and optional, so a 403 just means "no quota view".

//
// `version` is the refresh trigger: Research bumps it after every run, which is
// the only moment the numbers actually move. There is deliberately no polling,
// and the reason is worth keeping in mind. /api/usage is FREE per SerpAPI's
// docs, so hitting it on a timer would not burn quota -- but it would burn
// requests to redraw numbers that have not changed. An older POLL constant
// suggested a 60s poll was intended; it was never wired to a setInterval.
export default function QuotaBadge({ version = 0 }) {
  const [state, setState] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setRefreshing(true);
      try {
        const u = await api("/api/usage");
        if (!alive) return;
        const limit = u.totals?.limit ?? null;
        const left = u.totals?.left ?? null;
        const keys = u.keys || [];
        const keyCount = keys.length;
        // A key can come back with `error` instead of quota numbers when SerpAPI
        // rejects it — that is a real "not connected" signal, not just a missing
        // quota. Old code counted those keys and happily showed "SerpAPI
        // connected · 1 key(s)" for a key that was failing.
        const okCount = keyCount - keys.filter((k) => k.error).length;
        const connected = u.configured === true && okCount > 0;
        let label = "SerpAPI connected";
        let text = "";
        let pct = null;
        if (limit != null && left != null) {
          pct = Math.max(0, Math.min(100, Math.round((left / limit) * 100)));
          text = `${left}/${limit} searches left`;
          if (keyCount > 1) text += ` · ${keyCount} keys`;
          // The badge answers "how much" — the refill countdown answers "how long
          // until I can spend it again", which is the other half of the question.
          const until = fmtUntil(u.totals?.renewsAt);
          if (until && until !== "now") text += ` · resets in ${until}`;
        } else {
          text = keyCount ? `${keyCount} key(s)` : "quota unavailable";
        }
        const hour = u.totals?.hourLimit != null ? `${u.totals.hourLeft ?? 0}/${u.totals.hourLimit} per hour` : "";
        setState({ label, text, hour, pct, ok: connected, low: pct != null && pct <= 20 });
      } catch (e) {
        if (!alive) return;
        // Keep the last good numbers on a failed refresh. Blanking a working
        // readout because one request failed reads as "quota gone".
        setState((prev) => prev || { label: "API key required", text: "", hour: "", pct: null, ok: false, low: false });
      } finally {
        if (alive) setRefreshing(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [version]);

  if (!state) return null;

  // The dot is the scannable part; the label alone says "connected" even when
  // every key is failing. `title` spells it out for anyone who cannot use the
  // colour cue, and the text node keeps it out of the a11y tree so screen
  // readers get the plain label once, not twice.
  const dotTitle = state.ok ? "Connected — SerpAPI reachable" : "Not connected — check your SerpAPI key";
  const detail = [state.text, state.hour].filter(Boolean).join(" · ");

  return (
    <div
      className={"badge badge-usage" + (state.low ? " low" : "") + (refreshing ? " is-refreshing" : "")}
      title={detail ? `${dotTitle} · ${detail}` : dotTitle}
    >
      <span className="badge-body">
        <span className="limit-label">
          <span className={"quota-dot" + (state.ok ? " is-ok" : " is-bad")} aria-hidden="true" />
          {state.label}
        </span>
        {state.pct != null && (
          <span className="limit-bar" aria-hidden="true">
            <span className={"limit-fill" + (state.low ? " is-low" : "")} style={{ width: `${state.pct}%` }} />
          </span>
        )}
        {state.text && <span className="limit-text">{state.text}</span>}
      </span>
    </div>
  );
}
