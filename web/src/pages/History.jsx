import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDate, go } from "../api.js";
import { DownloadIcon, OpenIcon, SearchIcon, TrashIcon } from "../components/icons.jsx";

const PAGE_SIZE = 10;

// One pending PATCH per row, flushed 600ms after the last keystroke. Field is
// keyed by id+field so editing notes and tags of the same row stay independent.
function useDebouncedMeta(ms = 600) {
  const timers = useRef(new Map());
  const dirty = useRef(new Map());
  useEffect(() => {
    const pending = timers.current;
    const unsent = dirty.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      unsent.clear();
    };
  }, []);
  return useCallback((id, body) => {
    const key = `${id}:${Object.keys(body).join(",")}`;
    dirty.current.set(key, { id, body });
    clearTimeout(timers.current.get(key));
    timers.current.set(
      key,
      setTimeout(async () => {
        timers.current.delete(key);
        const next = dirty.current.get(key);
        if (!next) return;
        try {
          await api(`/api/searches/${encodeURIComponent(next.id)}`, {
            method: "PATCH",
            body: JSON.stringify(next.body)
          });
          dirty.current.delete(key);
        } catch {
          /* keep the latest edit queued for the next change to retry */
        }
      }, ms)
    );
  }, [ms]);
}

export default function History() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (query, p) => {
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((p - 1) * PAGE_SIZE)
    });
    if (query) params.set("q", query);
    try {
      const d = await api(`/api/searches?${params}`);
      const list = d.items || [];
      setItems(list);
      setTotal(d.total ?? list.length);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(q, page);
  }, [q, page, load]);

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function openDetail(id) {
    window.history.pushState({}, "", `/research?load=${encodeURIComponent(id)}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    go("research");
  }

  // Debounce the notes/tags PATCHes: onChange fires on every keystroke, and
  // without this a note of any length is one request per character.
  const saveMeta = useDebouncedMeta();

  return (
    <>
      <header>
        <div>
          <span className="eyebrow">KWERRY</span>
          <h1>Search history</h1>
          <p>Every research run, with notes, tags, and filters.</p>
        </div>
        <button
          id="exportCsv"
          className="btn-ghost btn-sm"
          type="button"
          onClick={() => {
            const params = new URLSearchParams();
            if (q) params.set("q", q);
            location.href = `/api/export/csv?${params}`;
          }}
        >
          <DownloadIcon />
          Export CSV
        </button>
      </header>

      <article className="panel">
        <div className="history-head">
          <h2>All searches</h2>
        </div>
        <div className="history-toolbar history-toolbar-full">
          <div className="search-bar">
            <SearchIcon className="search-icon" />
            <input
              id="searchFilter"
              className="search-input"
              type="search"
              placeholder="Filter keyword…"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setPage(1);
                  load(q.trim(), 1);
                }
              }}
            />
            {q ? (
              <button
                type="button"
                className="search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setQ("");
                  setPage(1);
                  load("", 1);
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        </div>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Keyword</th>
                <th>Score</th>
                <th>Verdict</th>
                <th>Tags</th>
                <th>Notes</th>
                <th>Searched at</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="historyTable">
              {items.map((x, i) => (
                <tr key={x.id}>
                  <td>{(page - 1) * PAGE_SIZE + i + 1}</td>
                  <td className="kw-cell">
                    <a
                      href={`/research?load=${encodeURIComponent(x.id)}`}
                      onClick={(e) => {
                        e.preventDefault();
                        openDetail(x.id);
                      }}
                    >
                      {x.keyword}
                    </a>
                  </td>
                  <td>{x.evaluation?.score ?? "—"}</td>
                  <td>{x.evaluation?.verdict || "—"}</td>
                  <td>
                    <input
                      className="cell-input tags-input"
                      defaultValue={(x.tags || []).join(", ")}
                      placeholder="tag1, tag2"
                      onChange={(e) =>
                        saveMeta(x.id, {
                          tags: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean)
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input notes-input"
                      defaultValue={x.notes || ""}
                      placeholder="Add note…"
                      onChange={(e) => saveMeta(x.id, { notes: e.target.value })}
                    />
                  </td>
                  <td className="mono-cell">{fmtDate(x.createdAt)}</td>
                  <td className="actions-cell">
                    <a
                      className="icon-action"
                      href={`/research?load=${encodeURIComponent(x.id)}`}
                      title="Open"
                      onClick={(e) => {
                        e.preventDefault();
                        openDetail(x.id);
                      }}
                    >
                      <OpenIcon />
                      Open
                    </a>
                    <button
                      className="btn-mini btn-danger icon-only"
                      type="button"
                      title="Delete"
                      aria-label="Delete this search record"
                      onClick={async () => {
                        if (!confirm("Delete this search record?")) return;
                        await api(`/api/searches/${encodeURIComponent(x.id)}`, { method: "DELETE" });
                        load(q, page);
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              ))}
              {!items.length && !loading && (
                <tr>
                  <td colSpan={8} className="muted">
                    No search history yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="history-foot">
          <span className="muted" id="historyCount">
            {total
              ? `Showing ${items.length ? (page - 1) * PAGE_SIZE + 1 : 0}–${(page - 1) * PAGE_SIZE + items.length} of ${total}`
              : "No search history yet."}
          </span>
          <nav className="pagination" id="historyPagination" aria-label="History pages">
            {totalPages > 1 && (
              <>
                <button
                  className="page-btn"
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  ‹
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
                  .map((p, idx, arr) => (
                    <React.Fragment key={p}>
                      {idx > 0 && p - arr[idx - 1] > 1 && <span className="page-dots">…</span>}
                      <button
                        className={"page-btn" + (p === page ? " active" : "")}
                        type="button"
                        onClick={() => setPage(p)}
                      >
                        {p}
                      </button>
                    </React.Fragment>
                  ))}
                <button
                  className="page-btn"
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  ›
                </button>
              </>
            )}
          </nav>
        </div>
      </article>
    </>
  );
}
