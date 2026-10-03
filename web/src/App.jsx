import React, { useEffect, useState, useCallback } from "react";
import { api, go, pathForPage } from "./api.js";
import { applyMeta } from "./meta.js";
import Shell from "./components/Shell.jsx";
import Login from "./pages/Login.jsx";
import Home from "./pages/Home.jsx";
import Research from "./pages/Research.jsx";
import History from "./pages/History.jsx";
import Analytics from "./pages/Analytics.jsx";
import Compare from "./pages/Compare.jsx";
import Settings from "./pages/Settings.jsx";

const BODY_CLASS = {
  home: "landing",
  login: "auth-page",
  research: "app-shell",
  history: "app-shell",
  analytics: "app-shell",
  compare: "app-shell",
  settings: "app-shell"
};

export default function App() {
  const [page, setPage] = useState(pathForPage());
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  const refreshUser = useCallback(async () => {
    try {
      const d = await api("/api/auth/me");
      setUser(d.user);
    } catch {
      setUser(null);
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  useEffect(() => {
    const onPop = () => setPage(pathForPage());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Routing rules, resolved in one place so the URL and the screen can never
  // disagree. `authChecked` gates all of it: until /api/auth/me returns we do
  // not yet know who this is, so we must not redirect on a guess.
  //
  //   signed in  + on /login           -> /research   (never ask a signed-in
  //                                                     user to sign in again)
  //   signed out + on a protected page -> /login
  //   /home is public either way      -> stays put
  //
  // The second rule is the one that was missing. server.js redirects protected
  // paths on a hard load, but `npm run dev` serves index.html for every path
  // with no auth check at all, so the SPA would boot AT /research, render the
  // login form, and leave the address bar still reading /research. Landing is
  // excluded deliberately — it is the public entry point.
  const PROTECTED = new Set(["research", "history", "analytics", "compare", "settings"]);
  const activePage = !authChecked
    ? page
    : user
      ? page === "login" ? "research" : page
      : PROTECTED.has(page) ? "login" : page;

  useEffect(() => {
    if (activePage !== page) go(activePage);
  }, [activePage, page]);

  useEffect(() => {
    document.body.className = BODY_CLASS[activePage] || "app-shell";
    // Title + description + og pair, so a shared /research link previews as
    // Research instead of repeating the home blurb.
    applyMeta(activePage);
  }, [activePage]);

  if (!authChecked) return null;

  const toApp = () => {
    refreshUser();
    go("research");
    setPage("research");
  };

  if (activePage === "login") {
    return <Login onSuccess={toApp} />;
  }

  if (activePage === "home") {
    return (
      <Home
        user={user}
        onOpen={user ? () => { go("research"); setPage("research"); } : toApp}
      />
    );
  }

  // Anything reaching here is a protected page with a signed-in user — the
  // activePage rules above guarantee both, so there is no `!user` branch left to
  // reach the login screen without also moving the URL.
  const pages = {
    research: <Research />,
    history: <History />,
    analytics: <Analytics />,
    compare: <Compare />,
    settings: <Settings />
  };

  return (
    <Shell user={user} page={activePage} onNavigate={setPage} onSignOut={() => { setUser(null); go("login"); setPage("login"); }}>
      {pages[activePage] || <Research />}
    </Shell>
  );
}
