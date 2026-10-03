import React, { useEffect, useRef, useState } from "react";
import { api, go } from "../api.js";
import ThemeToggle from "./ThemeToggle.jsx";
import {
  ChartIcon,
  ClockIcon,
  CloseIcon,
  CompareIcon,
  GearIcon,
  MenuIcon,
  SearchIcon,
  SignOutIcon,
  UserIcon
} from "./icons.jsx";

const NAV = [
  { id: "research", label: "Research", Icon: SearchIcon },
  { id: "analytics", label: "Analytics", Icon: ChartIcon },
  { id: "history", label: "History", Icon: ClockIcon },
  { id: "compare", label: "Compare", Icon: CompareIcon },
  { id: "settings", label: "Settings", Icon: GearIcon }
];

// Studio signature taken from scrambled_head.studio (footer + hero eyebrow):
// mono, muted, lowercase wordmark + the scribbles credit line.
const SIGNATURE = {
  name: "scrambled_head.studio",
  meta: "(c) 2026 · All scribbles reserved."
};

// Profile row + sign-out popover. Rendered once here and used in both the
// mobile drawer and the desktop sidebar — the markup was duplicated verbatim
// before, so a popover fix had to be made twice.
function UserMenu({ user, username, popOpen, setPopOpen, setLogoutOpen }) {
  const popRef = useRef(null);

  // Close the popover on any click outside it. The trigger button stops
  // propagation, so only outside clicks reach here.
  useEffect(() => {
    if (!popOpen) return;
    const onDoc = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) setPopOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [popOpen, setPopOpen]);

  return (
    <div className="side-user-menu">
      <button
        className="side-link side-btn user-trigger"
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setPopOpen((v) => !v);
        }}
      >
        <UserIcon />
        <span className="user-label">{username}</span>
      </button>
      {popOpen && (
        <div className="user-popover" ref={popRef}>
          <div className="user-popover-head">
            <strong>{user?.username}</strong>
          </div>
          <button
            className="user-popover-item popover-danger"
            type="button"
            onClick={() => {
              setPopOpen(false);
              setLogoutOpen(true);
            }}
          >
            <SignOutIcon />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function Shell({ user, page, onNavigate, onSignOut, children }) {
  const [popOpen, setPopOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  // mobile nav drawer — closed by default, toggled by the burger.
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => {
      if (navRef.current && !navRef.current.contains(e.target)) setNavOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  // The drawer locks the page behind it; release it when it closes.
  useEffect(() => {
    document.body.style.overflow = navOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [navOpen]);

  const nav = (id) => {
    go(id);
    onNavigate?.(id);
    setPopOpen(false);
    setNavOpen(false);
  };

  // body.app-shell is set in App — the mobile top bar and the drawer both
  // render here; on desktop the drawer markup is hidden and the sidebar
  // (below) renders as the original column.
  return (
    <>
      {/* Mobile top bar — burger + brand; the nav lives in the drawer. */}

      <header className="topbar">
        <button
          className="topbar-burger"
          type="button"
          aria-label={navOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={navOpen}
          aria-controls="mobileNav"
          onClick={(e) => {
            e.stopPropagation();
            setNavOpen((v) => !v);
          }}
        >
          {navOpen ? <CloseIcon /> : <MenuIcon />}
        </button>
        <div className="brand topbar-brand">
          <span className="brand-mark" aria-hidden="true">
            <img src="/icon.svg" alt="" />
          </span>
          <div className="brand-text">
            <strong>Kwerry</strong>
          </div>
        </div>
      </header>

      {navOpen && (
        <div
          className="nav-scrim"
          onClick={() => {
            setNavOpen(false);
          }}
        />
      )}
      <nav
        id="mobileNav"
        className={"mobile-nav" + (navOpen ? " open" : "")}
        aria-label="Primary mobile"
        aria-hidden={!navOpen}
        ref={navRef}
      >
        <div className="mobile-nav-head">
          <span className="brand topbar-brand">
            <span className="brand-mark" aria-hidden="true">
              <img src="/icon.svg" alt="" />
            </span>
            <div className="brand-text">
              <strong>Kwerry</strong>
              <span>Live SERP research</span>
            </div>
          </span>
          <button
            className="mobile-nav-close"
            type="button"
            aria-label="Close navigation menu"
            onClick={(e) => {
              e.stopPropagation();
              setNavOpen(false);
            }}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="mobile-nav-scroll">
          {NAV.map((item) => (
            <a
              key={item.id}
              className={"side-link mobile-nav-link" + (page === item.id ? " active" : "")}
              href={"#" + item.id}
              onClick={(e) => {
                e.preventDefault();
                nav(item.id);
              }}
            >
              <item.Icon />
              {item.label}
            </a>
          ))}
        </div>

        <div className="mobile-nav-foot">
          <UserMenu
            user={user}
            username={user?.username || "Profile"}
            popOpen={popOpen}
            setPopOpen={setPopOpen}
            setLogoutOpen={setLogoutOpen}
          />
          <div className="side-foot mobile-nav-sign">
            <div className="side-sign">
              <a
                className="side-sign-name"
                href="https://scrambledhead.pxnjx.com/"
                target="_blank"
                rel="noopener"
              >
                {SIGNATURE.name}
              </a>
              <span className="side-sign-meta">{SIGNATURE.meta}</span>
            </div>
          </div>
        </div>
      </nav>

      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <img src="/icon.svg" alt="" />
          </span>
          <div className="brand-text">
            <strong>Kwerry</strong>
            <span>Live SERP research</span>
          </div>
        </div>
        <nav className="side-nav" aria-label="Primary">
          {NAV.map((item) => (
            <a
              key={item.id}
              className={"side-link" + (page === item.id ? " active" : "")}
              href={"#" + item.id}
              onClick={(e) => {
                e.preventDefault();
                nav(item.id);
              }}
            >
              <item.Icon />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="side-bottom">
          {/* profile row — sits above the footer strip */}
          <UserMenu
            user={user}
            username={user?.username || "Profile"}
            popOpen={popOpen}
            setPopOpen={setPopOpen}
            setLogoutOpen={setLogoutOpen}
          />

          <div className="side-foot">
            <div className="side-sign">
              <a
                className="side-sign-name"
                href="https://scrambledhead.pxnjx.com/"
                target="_blank"
                rel="noopener"
              >
                {SIGNATURE.name}
              </a>
              <span className="side-sign-meta">{SIGNATURE.meta}</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main">{children}</main>

      <ThemeToggle />

      {logoutOpen && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target.classList?.contains("modal")) setLogoutOpen(false);
          }}
        >
          <div className="modal-card modal-sm">
            <h2>Sign out?</h2>
            <p className="muted" style={{ margin: "0 0 var(--sp-2)" }}>
              You will need to sign in again to access the dashboard.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-ghost btn-sm" onClick={() => setLogoutOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-run btn-sm btn-danger-solid"
                onClick={async () => {
                  await api("/api/auth/logout", { method: "POST" }).catch(() => null);
                  onSignOut?.();
                }}
              >
                <SignOutIcon />
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
