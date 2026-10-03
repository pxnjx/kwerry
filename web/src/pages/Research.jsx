import React, { useEffect, useMemo, useState } from "react";
import { api, domain, fmtCompact, fmtDate } from "../api.js";
import { DownloadIcon, SearchIcon } from "../components/icons.jsx";
import QuotaBadge from "../components/QuotaBadge.jsx";

const FEATURE_LABELS = {
  aiOverview: "AI Overview",
  paa: "People Also Ask",
  related: "Related searches",
  shopping: "Shopping",
  local: "Local pack",
  ads: "Ads",
  images: "Images",
  videos: "Videos",
  news: "Top stories",
  knowledgeGraph: "Knowledge panel",
  featuredSnippet: "Featured snippet"
};

function TrendChart({ trends }) {
  const [tip, setTip] = useState(null);
  if (!trends?.series?.length) return <p className="muted">No Google Trends series.</p>;
  const pts = trends.series.map((p, i) => ({ i: i + 1, date: p.date || `#${i + 1}`, value: Number(p.value) || 0 }));
  const max = Math.max(1, trends.max || Math.max(...pts.map((p) => p.value), 1));
  const W = 360, H = 130, padX = 16, padY = 18;
  const n = pts.length;
  const step = n > 1 ? (W - padX * 2) / (n - 1) : 0;
  const xAt = (idx) => padX + idx * step;
  const yAt = (v) => padY + (1 - v / max) * (H - padY * 2);
  const coords = pts.map((p, i) => [xAt(i), yAt(p.value)]);
  let d = `M ${coords[0][0].toFixed(2)} ${coords[0][1].toFixed(2)}`;
  for (let i = 1; i < n; i++) {
    const [x0, y0] = coords[i - 1];
    const [x1, y1] = coords[i];
    d += ` C ${(x0 + (x1 - x0) / 3).toFixed(2)} ${y0.toFixed(2)}, ${(x0 + (x1 - x0) * 2 / 3).toFixed(2)} ${y1.toFixed(2)}, ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  const areaD = d + ` L ${coords[n - 1][0].toFixed(2)} ${H - padY} L ${coords[0][0].toFixed(2)} ${H - padY} Z`;
  const trendD = `M ${coords[0][0].toFixed(2)} ${coords[0][1].toFixed(2)} L ${coords[n - 1][0].toFixed(2)} ${coords[n - 1][1].toFixed(2)}`;
  const dir = trends.direction || "stable";
  const dirClass = dir === "rising" ? "up" : dir === "falling" ? "down" : "flat";
  const dirLabel = dir === "rising" ? "Trend ↑ rising" : dir === "falling" ? "Trend ↓ falling" : "Trend → stable";

  return (
    <div className="trend-wrap">
      <div className="trend-plot" onMouseLeave={() => setTip(null)}>
        <svg className="trend-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <path className="trend-area" d={areaD} />
          <path className="trend-line" d={d} fill="none" vectorEffect="non-scaling-stroke" />
          <path className={`trend-guide trend-guide-${dirClass}`} d={trendD} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="trend-dots">
          {pts.map((p, i) => (
            <span
              key={i}
              className={"trend-dot" + (tip?.i === p.i ? " on" : "")}
              style={{ left: `${(xAt(i) / W) * 100}%`, top: `${(yAt(p.value) / H) * 100}%` }}
              onMouseEnter={() => setTip({ ...p, left: (xAt(i) / W) * 100, top: (yAt(p.value) / H) * 100 })}
            />
          ))}
        </div>
        {tip && (
          <div className="trend-tip" style={{ left: `${Math.min(75, Math.max(0, tip.left - 15))}%`, top: `${Math.max(0, tip.top - 20)}%` }}>
            <b>#{tip.i} · {tip.date}</b>
            <span>interest {tip.value}/100</span>
          </div>
        )}
      </div>
      <div className="trend-meta">
        <span className={`trend-dir trend-dir-${dirClass}`}>{dirLabel}</span>
        <span className="muted">avg {trends.avg} · peak {trends.max}</span>
      </div>
      <div className="trend-ends muted">
        <span>{pts[0].date}</span>
        <span>0–100</span>
        <span>{pts[n - 1].date}</span>
      </div>
    </div>
  );
}

function renderRecItem(x, key) {
  return (
    <div className="rec" key={key}>
      <b>{x.text}</b>
      <small>
        {x.source} · {x.type}
      </small>
    </div>
  );
}

export default function Research() {
  const [mode, setMode] = useState("single");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [tab, setTab] = useState("overview");
  const [fromHistory, setFromHistory] = useState(null);
  // Bumped after every research run to tell <QuotaBadge> to refetch /api/usage.
  // The server clears its 60s usage cache at the same moment, so the refetch
  // returns post-run quota rather than the pre-run snapshot.
  const [usageVersion, setUsageVersion] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("load");
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const d = await api(`/api/searches/${encodeURIComponent(id)}`);
        if (!alive) return;
        setResult(d);
        setFromHistory({ createdAt: d.createdAt, keyword: d.keyword });
        setTab("overview");
      } catch (e) {
        if (alive) setError(e.message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function runSingle(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const form = new FormData(e.target);
      const d = await api("/api/research", {
        method: "POST",
        body: JSON.stringify({
          keyword: form.get("keyword"),
          engine: form.get("engine"),
          location: form.get("location"),
          goal: form.get("goal")
        })
      });
      setResult(d);
      setTab("overview");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      // In finally, not on success: quota may have been spent even when the run
      // threw (e.g. every key rejected), and a failed run is exactly when the
      // remaining figure matters most.
      setUsageVersion((v) => v + 1);
    }
  }

  async function runBulk(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const form = new FormData(e.target);
      const list = String(form.get("keywords") || "")
        .split(/[\n,]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      const d = await api("/api/research/bulk", {
        method: "POST",
        body: JSON.stringify({
          keywords: list,
          engine: form.get("engine"),
          location: form.get("location"),
          goal: form.get("goal")
        })
      });
      setResult({ bulk: true, ...d });
      setTab("overview");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      // Same reason as runSingle. The server invalidates its usage cache once
      // for the whole batch, so this is a single refetch no matter how many
      // keywords the batch contained.
      setUsageVersion((v) => v + 1);
    }
  }

  const metrics = useMemo(() => {
    if (!result || result.bulk) return null;
    const trends = result.trends || result.serp?.trends;
    return {
      verdict: result.evaluation?.verdict || "—",
      score: result.evaluation?.score != null ? result.evaluation.score + "/100" : "—",
      intent: result.evaluation?.intent || "—",
      domains: new Set((result.serp?.organic || []).map((x) => domain(x.link))).size,
      trends: trends ? `${trends.avg}${trends.direction === "rising" ? " ↑" : trends.direction === "falling" ? " ↓" : " →"}` : "—",
      total: result.serp?.totalResults != null ? fmtCompact(result.serp.totalResults) : "—"
    };
  }, [result]);

  return (
    <>
      <header>
        <div>
          <span className="eyebrow">LIVE SERP RESEARCH</span>
          <h1>Research</h1>
          <p>Research keywords from real SERPs, not local guesses.</p>
        </div>
        <QuotaBadge version={usageVersion} />
      </header>

      <article className="panel form-compact form">
        <div className="form-modes">
          <button
            type="button"
            className={"tab" + (mode === "single" ? " active" : "")}
            onClick={() => setMode("single")}
          >
            Single keyword
          </button>
          <button
            type="button"
            className={"tab" + (mode === "bulk" ? " active" : "")}
            onClick={() => setMode("bulk")}
          >
            Bulk research
          </button>
        </div>

        {mode === "single" ? (
          <form className="form-main form-research" onSubmit={runSingle}>
            <div className="field-grow">
              <label htmlFor="keyword">Keyword</label>
              <input
                id="keyword"
                name="keyword"
                placeholder="e.g. website development services"
                autoComplete="off"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="engine">Engine</label>
              <select id="engine" name="engine" defaultValue="google">
                <option value="google">Google</option>
                <option value="bing">Bing</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="location">Location</label>
              <input id="location" name="location" defaultValue="Indonesia" />
            </div>
            <div className="field">
              <label htmlFor="goal">Goal</label>
              <select id="goal" name="goal" defaultValue="seo">
                <option value="seo">Keyword research</option>
                <option value="article">SEO article</option>
                <option value="landing">Landing page</option>
                <option value="product">Product/category</option>
              </select>
            </div>
            <button className="btn-run btn-run-right" type="submit">
              <SearchIcon />
              Research
            </button>
          </form>
        ) : (
          <form className="form-main bulk-layout" onSubmit={runBulk}>
            <div className="field-grow bulk-grow">
              <label htmlFor="bulkKeywords">Keywords (one per line, max 25)</label>
              <textarea
                id="bulkKeywords"
                name="keywords"
                rows={6}
                placeholder={"keyword one\nkeyword two\nkeyword three"}
                required
              />
            </div>
            <div className="bulk-side">
              <div className="bulk-fields">
                <div className="field">
                  <label htmlFor="bulkEngine">Engine</label>
                  <select id="bulkEngine" name="engine" defaultValue="google">
                    <option value="google">Google</option>
                    <option value="bing">Bing</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="bulkLocation">Location</label>
                  <input id="bulkLocation" name="location" defaultValue="Indonesia" />
                </div>
                <div className="field">
                  <label htmlFor="bulkGoal">Goal</label>
                  <select id="bulkGoal" name="goal" defaultValue="seo">
                    <option value="seo">Keyword research</option>
                    <option value="article">SEO article</option>
                    <option value="landing">Landing page</option>
                    <option value="product">Product/category</option>
                  </select>
                </div>
              </div>
              <button className="btn-run bulk-run" type="submit">
                <SearchIcon />
                Run bulk research
              </button>
            </div>
          </form>
        )}
      </article>

      {loading && (
        <div className="loading" aria-live="polite">
          Fetching SERP and analyzing keyword…
        </div>
      )}
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}

      {fromHistory && (
        <div className="history-banner" role="status">
          <span>
            Showing saved search of <strong>{fromHistory.keyword}</strong> — searched on <strong>{fmtDate(fromHistory.createdAt)}</strong>
          </span>
          <button
            className="btn-ghost btn-sm"
            type="button"
            onClick={() => {
              setFromHistory(null);
              setResult(null);
              window.history.pushState({}, "", "/research");
            }}
          >
            New search
          </button>
        </div>
      )}

      {result && (
        <section>
          <div className="result-toolbar">
            <div className="metrics metrics-inline" id="metricsBar">
              {result.bulk ? (
                <>
                  <div className="metric-mini">
                    <span>Done</span>
                    <b>{result.results?.length || 0}/{result.total || 0}</b>
                  </div>
                </>
              ) : (
                <>
                  <div className="metric-mini">
                    <span>Verdict</span>
                    <b>{metrics.verdict}</b>
                  </div>
                  <div className="metric-mini">
                    <span>Score</span>
                    <b>{metrics.score}</b>
                  </div>
                  <div className="metric-mini">
                    <span>Intent</span>
                    <b>{metrics.intent}</b>
                  </div>
                  <div className="metric-mini">
                    <span>Domains</span>
                    <b>{metrics.domains}</b>
                  </div>
                  <div className="metric-mini">
                    <span>Trends</span>
                    <b>{metrics.trends}</b>
                  </div>
                  <div className="metric-mini">
                    <span>Index</span>
                    <b>{metrics.total}</b>
                  </div>
                </>
              )}
            </div>
            {!result.bulk && (
              <button
                className="btn-ghost btn-sm"
                type="button"
                onClick={async () => {
                  const r = await fetch("/api/report", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(result)
                  });
                  const blob = await r.blob();
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = `keyword-report-${Date.now().toString(36)}.md`;
                  a.click();
                }}
              >
                <DownloadIcon />
                Report .md
              </button>
            )}
          </div>

          <div className="result-tabs" role="tablist">
            {["overview", "serp", "ideas", "brief"].map((t) => (
              <button
                key={t}
                className={"tab" + (tab === t ? " active" : "")}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
              >
                {t === "ideas" ? "Keyword Ideas" : t === "brief" ? "Content Brief" : t === "serp" ? "SERP" : "Overview"}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <div className="tab-panel active">
              <div className="grid grid-compact">
                <article className="panel panel-compact">
                  <h2>Why this score?</h2>
                  <ul className="tight-list">
                    {(result.bulk ? ["All keywords completed."] : result.evaluation?.reasons || []).map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </article>
                <article className="panel panel-compact">
                  <h2>Top recommendations</h2>
                  {(result.bulk ? result.results || [] : (result.recommendations || []).slice(0, 5)).map((x, i) =>
                    result.bulk
                      ? (
                          <div className="rec" key={i}>
                            <b>{x.keyword}</b>
                            <small>
                              {x.evaluation?.verdict} · {x.evaluation?.score} ·{" "}
                              <a
                                href="#"
                                onClick={(e) => {
                                  e.preventDefault();
                                  setResult(x);
                                  setTab("overview");
                                }}
                              >
                                Open
                              </a>
                            </small>
                          </div>
                        )
                      : (
                          renderRecItem(x, i)
                        )
                  )}
                </article>
              </div>

              {!result.bulk && (
                <>
                  <article className="panel panel-compact demand-panel">
                    <h2>Demand &amp; competition</h2>
                    <div className="demand-layout">
                      <div className="signals">
                        <div className="signal">
                          <span>Google index</span>
                          <b>{result.serp?.totalResults != null ? `~${fmtCompact(result.serp.totalResults)}` : "n/a"}</b>
                        </div>
                        <div className="signal">
                          <span>Dated results</span>
                          <b>{(result.serp?.organic || []).filter((x) => x.date).length}/10</b>
                        </div>
                        <div className="signal">
                          <span>AI Overview</span>
                          <b>{result.serp?.aiOverview?.present ? `yes · ${result.serp.aiOverview.referenceCount || 0} citations` : "no"}</b>
                        </div>
                      </div>
                      <div className="trends-box">
                        <TrendChart trends={result.trends || result.serp?.trends} />
                      </div>
                    </div>
                  </article>

                  <article className="panel panel-compact aio-panel">
                    <h2>SERP features &amp; AI Overview</h2>
                    <div className="chips chips-compact">
                      {Object.entries(result.serp?.features || {})
                        .filter(([, v]) => v)
                        .map(([k]) => (
                          <span className="chip" key={k}>
                            {FEATURE_LABELS[k] || k}
                          </span>
                        ))}
                    </div>
                    <div className="ai-box">
                      {result.serp?.aiOverview?.present ? (
                        <>
                          <div className="ai-focus">
                            <div className="ai-body">
                              {(result.serp.aiOverview.outline || []).map((b, i) =>
                                b.type === "list" ? (
                                  <ul className="ai-list" key={i}>
                                    {b.items.map((it, j) => (
                                      <li key={j}>{it}</li>
                                    ))}
                                  </ul>
                                ) : b.type === "heading" ? (
                                  <h3 className="ai-head" key={i}>
                                    {b.text}
                                  </h3>
                                ) : (
                                  <p className="ai-para" key={i}>
                                    {b.text}
                                  </p>
                                )
                              )}
                            </div>
                          </div>
                          <div className="ai-panels">
                            <article className="mini-card">
                              <h3 className="subhead">Mentions ({result.serp.aiOverview.mentions?.length || 0})</h3>
                              <ol className="cite-list">
                                {(result.serp.aiOverview.mentions || []).map((m, i) => (
                                  <li key={i}>
                                    {m.link ? <a href={m.link} target="_blank" rel="noopener">{m.text}</a> : m.text}
                                  </li>
                                ))}
                              </ol>
                            </article>
                            <article className="mini-card">
                              <h3 className="subhead">Citations ({result.serp.aiOverview.citations?.length || 0})</h3>
                              <ol className="cite-list">
                                {(result.serp.aiOverview.citations || []).map((c, i) => (
                                  <li key={i}>
                                    {c.link ? <a href={c.link} target="_blank" rel="noopener">{c.title || c.source || c.domain}</a> : c.title || c.source}
                                  </li>
                                ))}
                              </ol>
                            </article>
                          </div>
                        </>
                      ) : (
                        <p className="muted">No AI Overview on this SERP.</p>
                      )}
                    </div>
                  </article>
                </>
              )}
            </div>
          )}

          {tab === "serp" && (
            <div className="tab-panel active">
              <article className="panel panel-compact">
                <h2>Top SERP</h2>
                <div className="tableWrap">
                  <table className="serp-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Result</th>
                        <th>Domain</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(result.serp?.organic || []).map((x, i) => (
                        <tr key={i}>
                          <td className="pos-cell">{x.position}</td>
                          <td>
                            <a className="serp-title" target="_blank" rel="noopener" href={x.link}>
                              {x.title}
                            </a>
                            <div className="serp-snippet">{x.snippet}</div>
                            <div className="serp-url">
                              <a target="_blank" rel="noopener" href={x.link}>
                                {x.link}
                              </a>
                              {x.date ? <span className="serp-date">{x.date}</span> : null}
                            </div>
                          </td>
                          <td className="dom-cell">{domain(x.link)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            </div>
          )}

          {tab === "ideas" && (
            <div className="tab-panel active">
              <article className="panel panel-compact">
                <h2>Keyword &amp; wording recommendations</h2>
                <div className="rec-list">
                  {(result.recommendations || []).map((x, i) => renderRecItem(x, i))}
                </div>
              </article>
              <div className="grid grid-compact">
                <article className="panel panel-compact">
                  <h2>People Also Ask</h2>
                  <div className="chips chips-compact">
                    {(result.serp?.paa || []).map((x, i) => (
                      <span className="chip" key={i}>
                        {x}
                      </span>
                    ))}
                  </div>
                </article>
                <article className="panel panel-compact">
                  <h2>Related Searches</h2>
                  <div className="chips chips-compact">
                    {(result.serp?.related || []).map((x, i) => (
                      <span className="chip" key={i}>
                        {x}
                      </span>
                    ))}
                  </div>
                </article>
              </div>
              <article className="panel panel-compact" style={{ marginTop: "var(--sp-2)" }}>
                <h2>Keyword clusters</h2>
                {(result.clusters || result.serp?.clusters || []).map((c) => (
                  <div className="cluster-group" key={c.key || c.label}>
                    <h3 className="subhead">
                      {c.label} <span className="muted">({c.items.length})</span>
                    </h3>
                    <div className="chips chips-compact">
                      {c.items.map((it, i) => (
                        <span className="chip" key={i}>
                          {it.text}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </article>
            </div>
          )}

          {tab === "brief" && (
            <div className="tab-panel active">
              <article className="panel panel-compact">
                <h2>Content brief</h2>
                {(() => {
                  const brief = result.contentBrief || result.serp?.contentBrief;
                  if (!brief) return <p className="muted">No brief yet — run a research.</p>;
                  return (
                    <div>
                      <p className="muted">Target: {brief.wordCountTarget || "—"}</p>
                      <h3 className="subhead">Title ideas</h3>
                      <ul className="tight-list">
                        {(brief.titleSuggestions || []).map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                      <h3 className="subhead">Outline</h3>
                      <div className="outline">
                        {(brief.outline || []).map((o, i) => (
                          <div className={`outline-row level-${o.level}`} key={i}>
                            <span className="outline-lvl">H{o.level}</span>
                            <span>{o.text}</span>
                          </div>
                        ))}
                      </div>
                      <h3 className="subhead">FAQ</h3>
                      <ul className="tight-list">
                        {(brief.faq || []).map((q, i) => (
                          <li key={i}>{q}</li>
                        ))}
                      </ul>
                      {!!(brief.entities || []).length && (
                        <>
                          <h3 className="subhead">Entities to mention</h3>
                          <div className="chips chips-compact">
                            {brief.entities.map((e, i) => (
                              <span className="chip chip-sm" key={i}>
                                {e}
                              </span>
                            ))}
                          </div>
                        </>
                      )}
                      {!!(brief.secondaryKeywords || []).length && (
                        <>
                          <h3 className="subhead">Secondary keywords</h3>
                          <div className="chips chips-compact">
                            {brief.secondaryKeywords.map((e, i) => (
                              <span className="chip" key={i}>
                                {e}
                              </span>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })()}
              </article>
            </div>
          )}
        </section>
      )}
    </>
  );
}
