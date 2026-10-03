import React, { useEffect, useState } from "react";
import { api, fmtDate } from "../api.js";

function pct(n, total) {
  if (!total) return 0;
  return Math.round((n / total) * 1000) / 10;
}

// Chart fill colours come from CSS custom properties, not hardcoded hex, so the
// dark theme can lift them. The previous inline `#1f1f1f` sat at 1.09:1 against
// the #262626 track in dark mode — effectively invisible. See --chart-*-* in
// styles.css.
function BarChart({ rows, total, colorVar }) {
  if (!rows?.length) return <p className="muted">No data yet.</p>;
  return (
    <div className="bar-chart">
      {rows.map((r, i) => {
        const width = total ? Math.max(4, Math.round((r.count / total) * 100)) : 4;
        const fill = colorVar ? `var(${colorVar(r, i)})` : "var(--chart-fill)";
        return (
          <div className="bar-row" key={i}>
            <div className="bar-label">{r.label}</div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${width}%`, background: fill }} />
            </div>
            <div className="bar-value">
              {r.count} <small>{pct(r.count, total)}%</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DayChart({ rows }) {
  if (!rows?.length) return <p className="muted">No data yet.</p>;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="day-chart">
      <div className="day-bars">
        {rows.map((r, i) => {
          const h = Math.max(6, Math.round((r.count / max) * 120));
          return (
            <div className="day-col" key={i} title={`${r.day} · ${r.count} searches`}>
              <div className="day-bar" style={{ height: `${h}px` }} />
              <div className="day-label">{String(r.day || "").slice(5)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Analytics() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const d = await api("/api/analytics");
        if (alive) setData(d);
      } catch (e) {
        if (alive) setError(e.message || "Failed to load analytics");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const t = data?.totals || {};
  const totalSearches = t.totalSearches || 0;

  return (
    <>
      <header>
        <div>
          <span className="eyebrow">KWERRY</span>
          <h1>Analytics Dashboard</h1>
          <p>Research summary: search activity, score distribution, and frequent SERP domains.</p>
        </div>
      </header>

      {loading && (
        <div className="loading" aria-live="polite">
          Loading analytics…
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <section>
          <div className="metrics" id="kpiRow">
            <div className="metric">
              <span>Total searches</span>
              <b>{t.totalSearches ?? 0}</b>
            </div>
            <div className="metric">
              <span>Unique keywords</span>
              <b>{t.uniqueKeywords ?? 0}</b>
            </div>
            <div className="metric">
              <span>Average score</span>
              <b>{t.avgScore != null ? t.avgScore + "/100" : "—"}</b>
            </div>
            <div className="metric">
              <span>Last search</span>
              <b>{t.lastSearchAt ? fmtDate(t.lastSearchAt) : "—"}</b>
            </div>
          </div>

          <div className="grid">
            <article className="panel">
              <h2>Verdict distribution</h2>
              <BarChart
                rows={(data.verdicts || []).map((v) => ({ label: v.verdict || "—", count: v.count }))}
                total={totalSearches}
                colorVar={(r) => (r.label === "OK" ? "--chart-strong" : r.label === "TEST" ? "--chart-mid" : "--chart-soft")}
              />
            </article>
            <article className="panel">
              <h2>Search intent</h2>
              <BarChart rows={(data.intents || []).map((v) => ({ label: v.intent || "—", count: v.count }))} total={totalSearches} />
            </article>
          </div>

          <div className="grid">
            <article className="panel">
              <h2>Opportunity score</h2>
              <BarChart rows={(data.scoreBuckets || []).map((v) => ({ label: v.bucket, count: v.count }))} total={totalSearches} />
            </article>
            <article className="panel">
              <h2>Search activity / day</h2>
              <DayChart rows={data.byDay || []} />
            </article>
          </div>

          <div className="grid">
            <article className="panel">
              <h2>Top keywords</h2>
              <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>Keyword</th>
                      <th>Searches</th>
                      <th>Avg score</th>
                      <th>Last searched</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.topKeywords || []).map((k, i) => (
                      <tr key={i}>
                        <td className="kw-cell">{k.keyword}</td>
                        <td>{k.searchCount}</td>
                        <td>{k.avgScore != null ? Math.round(k.avgScore * 10) / 10 : "—"}</td>
                        <td className="mono-cell">{fmtDate(k.lastSearchedAt)}</td>
                      </tr>
                    ))}
                    {!data.topKeywords?.length && (
                      <tr>
                        <td colSpan={4} className="muted">
                          No data yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </article>
            <article className="panel">
              <h2>Top SERP domains</h2>
              <BarChart
                rows={(data.topDomains || []).map((v) => ({ label: v.domain, count: v.count }))}
                total={(data.topDomains || []).reduce((s, x) => s + x.count, 0) || 1}
              />
            </article>
          </div>
        </section>
      )}
    </>
  );
}
