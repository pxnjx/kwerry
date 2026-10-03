/* Per-page document metadata.
   Every claim in these strings is something the code actually does: the SERP
   fetch, AI Overview with citations, Trends, autocomplete, scoring, bulk runs,
   Compare, Analytics, and the Markdown/CSV exports all exist as routes. Nothing
   here is aspirational copy.

   The crawler-visible tags in index.html stay static; this only keeps the
   title/description/og pair in step when the user navigates, so a pasted link
   to /research previews as Research rather than as the generic home blurb. */

const PAGES = {
  home: {
    title: "Kwerry — Live SERP keyword research",
    desc:
      "Local-first keyword research from live Google and Bing SERPs: AI Overview citations, Google Trends, autocomplete ideas, opportunity scoring, and Markdown export."
  },
  login: {
    title: "Sign in — Kwerry",
    desc: "Sign in to your local Kwerry account to reach your keyword research dashboard."
  },
  research: {
    title: "Research — Kwerry",
    desc:
      "Research a keyword against a live SERP: opportunity score, AI Overview outline and citations, Google Trends, related queries, content brief, and keyword clusters."
  },
  analytics: {
    title: "Analytics — Kwerry",
    desc: "Search activity, opportunity score distribution, and the domains that own your SERPs."
  },
  history: {
    title: "History — Kwerry",
    desc: "Every saved search with its score, verdict, notes, and tags, kept in your own database."
  },
  compare: {
    title: "Compare — Kwerry",
    desc: "Put two saved searches side by side to see how score, results, and SERP ownership changed."
  },
  settings: {
    title: "Settings — Kwerry",
    desc:
      "Manage the SerpAPI key pool with live monthly and hourly quota, change your password, and back up or restore the local database."
  }
};

// Rewrites the tag in place when it exists, creates it otherwise. Reusing the
// node keeps crawlers that read once from seeing a duplicate pair.
function upsertMeta(attr, key, content) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export function applyMeta(page) {
  const p = PAGES[page] || PAGES.home;
  document.title = p.title;
  upsertMeta("name", "description", p.desc);
  upsertMeta("property", "og:title", p.title);
  upsertMeta("property", "og:description", p.desc);
  upsertMeta("property", "og:url", `${location.origin}${location.pathname}`);
}