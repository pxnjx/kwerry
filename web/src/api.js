export async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      ...(opts.body && !(opts.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...(opts.headers || {})
    },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}

export function fmtCompact(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n ?? "");
  if (x >= 1e9) return (x / 1e9).toFixed(1) + "B";
  if (x >= 1e6) return (x / 1e6).toFixed(1) + "M";
  if (x >= 1e3) return (x / 1e3).toFixed(1) + "K";
  return String(x);
}

export function domain(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* --- SerpAPI quota reset ---------------------------------------------------
   SerpAPI sends plan_renewal_date as a bare "YYYY-MM-DD", which Date parses as
   UTC midnight. Both helpers below stay pinned to UTC on purpose: formatting in
   the viewer's timezone can shift the label a day backwards (00:00 UTC is still
   "yesterday" in any negative offset), which would misreport the refill day. */

// "3d 18h" / "18h 5m" / "5m" / "now". Returns null when there is nothing to
// count down to, so callers can hide the whole line instead of showing "—".
export function fmtUntil(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const ms = t - Date.now();
  if (ms <= 0) return "now";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

// "Oct 7" — the absolute refill date, UTC-pinned to match fmtUntil.
export function fmtDay(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const ROUTES = {
  home: "/",
  login: "/login",
  research: "/research",
  analytics: "/analytics",
  history: "/history",
  compare: "/compare",
  settings: "/settings"
};

export function pathForPage() {
  const p = window.location.pathname.replace(/\/+$/, "") || "/";
  const page = Object.keys(ROUTES).find((k) => ROUTES[k] === p);
  return page || "home";
}

export function go(page) {
  const href = ROUTES[page] || "/";
  if (window.location.pathname !== href) {
    window.history.pushState({}, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
