import React, { useEffect, useState } from "react";
import { api, domain } from "../api.js";

function MetricsBlock({ title, s }) {
  if (!s) {
    return (
      <article className="panel panel-compact">
        <h2>{title}</h2>
        <p className="muted">Not selected.</p>
      </article>
    );
  }
  const domains = new Set((s.serp?.organic || []).map((x) => domain(x.link)).filter(Boolean)).size;
  return (
    <article className="panel panel-compact">
      <h2>{s.keyword}</h2>
      <div className="metrics metrics-inline">
        <div className="metric-mini">
          <span>Verdict</span>
          <b>{s.evaluation?.verdict || "—"}</b>
        </div>
        <div className="metric-mini">
          <span>Score</span>
          <b>{s.evaluation?.score ?? "—"}/100</b>
        </div>
        <div className="metric-mini">
          <span>Intent</span>
          <b>{s.evaluation?.intent || "—"}</b>
        </div>
        <div className="metric-mini">
          <span>Domains</span>
          <b>{domains}</b>
        </div>
      </div>
      <ul className="tight-list">
        {(s.evaluation?.reasons || []).map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      <p className="muted" style={{ margin: "8px 0 0" }}>
        Searched {s.createdAt || ""}
      </p>
    </article>
  );
}

export default function Compare() {
  const [items, setItems] = useState([]);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const d = await api("/api/searches?limit=200");
        setItems(d.items || []);
      } catch (e) {
        setError(e.message || "Failed to load searches.");
      }
    })();
  }, []);

  async function runCompare() {
    setError("");
    setResult(null);
    if (!a || !b) {
      setError("Select two keywords to compare.");
      return;
    }
    if (a === b) {
      setError("Pick two different searches.");
      return;
    }
    setLoading(true);
    try {
      const d = await api(`/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
      setResult(d);
      if (!d.a && !d.b) setError("Could not load those searches.");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const options = items.map((x) => (
    <option key={x.id} value={x.id}>
      {x.keyword} · {x.evaluation?.score ?? "—"} · {(x.createdAt || "").slice(0, 10)}
    </option>
  ));

  return (
    <>
      <header>
        <div>
          <span className="eyebrow">KWERRY</span>
          <h1>Compare keywords</h1>
          <p>Pick two saved searches and see them side by side.</p>
        </div>
      </header>

      <article className="panel panel-compact">
        <div className="compare-pickers">
          <div className="field-grow">
            <label htmlFor="pickA">Keyword A</label>
            <select id="pickA" value={a} onChange={(e) => setA(e.target.value)}>
              <option value="">{items.length ? "— select —" : "— no searches yet —"}</option>
              {options}
            </select>
          </div>
          <div className="field-grow">
            <label htmlFor="pickB">Keyword B</label>
            <select id="pickB" value={b} onChange={(e) => setB(e.target.value)}>
              <option value="">{items.length ? "— select —" : "— no searches yet —"}</option>
              {options}
            </select>
          </div>
          <button id="runCompare" type="button" className="btn-run" onClick={runCompare}>
            Compare
          </button>
        </div>

        {error && (
          <div id="compareError" className="error" role="alert">
            {error}
          </div>
        )}
        {loading && (
          <div id="compareLoading" className="loading" aria-live="polite">
            Loading comparison…
          </div>
        )}
        {!result && (
          <div id="compareEmpty" className="compare-empty">
            <p className="muted">
              {items.length ? (
                <>
                  Pick two saved searches above, then click <strong>Compare</strong>.
                </>
              ) : (
                "No saved searches yet. Run a research first on the Research page."
              )}
            </p>
          </div>
        )}
        {result && (
          <div id="compareResult" className="compare-grid">
            <MetricsBlock title="Keyword A" s={result.a} />
            <MetricsBlock title="Keyword B" s={result.b} />
          </div>
        )}
      </article>
    </>
  );
}
