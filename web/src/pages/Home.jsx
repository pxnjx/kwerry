import React from "react";
import { go } from "../api.js";
import { ChartIcon, DownloadIcon, LockIcon, SearchIcon } from "../components/icons.jsx";
import ThemeToggle from "../components/ThemeToggle.jsx";

export default function Home({ user, onOpen }) {
  const open = onOpen || (() => go(user ? "research" : "login"));

  return (
    <div className="landing">
      <ThemeToggle />
      <header className="landing-top">
        <div className="landing-top-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <img src="/icon.svg" alt="" />
            </span>
            <div className="brand-text">
              <strong>Kwerry</strong>
              <span>Live SERP research</span>
            </div>
          </div>
          {/* No header CTA. The hero below still carries "Start researching" +
              "Sign in", so a signed-out visitor keeps a clear path to the login
              screen without the top bar repeating it. The only control left up
              here is the theme toggle. */}
        </div>
      </header>

      <main className="landing-main">
        <section className="hero">
          <span className="eyebrow">LIVE SERP KEYWORD RESEARCH</span>
          <h1>
            Real search data.
            <br />
            Smarter keyword calls.
          </h1>
          <p className="hero-sub">
            Kwerry scores opportunity from live Google and Bing results, expands ideas from autocomplete and related searches, and exports a clean Markdown report — with every page URL included.
          </p>
          <div className="hero-cta">
            <button className="btn-run" type="button" onClick={open}>
              Start researching
            </button>
            <button className="btn-ghost" type="button" onClick={() => go("login")}>
              Sign in
            </button>
          </div>
        </section>

        <section className="feature-grid">
          <article className="feature-card">
            <div className="feature-icon" aria-hidden="true">
              <SearchIcon />
            </div>
            <h2>Live SERP scoring</h2>
            <p>Opportunity score, verdict, intent, and domain diversity from real Google/Bing results — not guesswork.</p>
          </article>
          <article className="feature-card">
            <div className="feature-icon" aria-hidden="true">
              <ChartIcon />
            </div>
            <h2>Analytics dashboard</h2>
            <p>Track every search, score distribution, top keywords, and the domains that own your SERPs.</p>
          </article>
          <article className="feature-card">
            <div className="feature-icon" aria-hidden="true">
              <DownloadIcon />
            </div>
            <h2>Markdown export</h2>
            <p>One-click reports with clickable title links and a full URL list for every SERP page.</p>
          </article>
          <article className="feature-card">
            <div className="feature-icon" aria-hidden="true">
              <LockIcon />
            </div>
            <h2>Local &amp; private</h2>
            <p>Runs on your machine with local accounts. Your research history stays in your own database.</p>
          </article>
        </section>
      </main>

      <footer className="site-footer landing-foot">
        <span>
          (c) 2026{" "}
          <a className="footer-link" href="https://scrambledhead.pxnjx.com/" target="_blank" rel="noopener">
            <strong>scrambled_head.studio</strong>
          </a>{" "}
          · All scribbles reserved.
        </span>
      </footer>
    </div>
  );
}
