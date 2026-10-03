import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import ThemeToggle from "../components/ThemeToggle.jsx";

export default function Login({ onSuccess }) {
  // The "Create account" tab appears only when the SERVER says so — it owns
  // the ENABLE_SIGNUP switch that guards POST /api/auth/register. For a local
  // install that is off, so the tab is normally absent and the tablist below
  // is hidden entirely rather than showing a lonely "Sign in" tab.
  //
  // This used to read import.meta.env.VITE_ENABLE_SIGNUP, a build-time copy
  // baked into dist/ by Vite that could silently disagree with the server.
  const [signupOn, setSignupOn] = useState(false);
  const [mode, setMode] = useState("login");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api("/api/auth/config")
      .then((d) => {
        if (alive) setSignupOn(d.signupEnabled === true);
      })
      .catch(() => {
        /* server unreachable — treat as sign-in only, which is the safe default */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Guard against landing on the register form after the tab is pulled away.
  useEffect(() => {
    if (!signupOn && mode === "register") setMode("login");
  }, [signupOn, mode]);

  async function submitLogin(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const form = new FormData(e.target);
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password")
        })
      });
      onSuccess?.();
    } catch (error) {
      setErr(error.message || "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitRegister(e) {
    e.preventDefault();
    setErr("");
    const form = new FormData(e.target);
    const pass = form.get("password");
    const pass2 = form.get("password2");
    if (pass !== pass2) {
      setErr("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ username: form.get("username"), password: pass })
      });
      onSuccess?.();
    } catch (error) {
      setErr(error.message || "Registration failed.");
    } finally {
      setBusy(false);
    }
  }

  // One node, rendered inside whichever form is active. It has to live INSIDE
  // <form> now so it can sit in the same flex row as the submit button —
  // before it was a sibling rendered after </form>, which put it on its own
  // line underneath the button.
  const errorNode = err ? (
    <div className="error" role="alert">
      {err}
    </div>
  ) : null;

  return (
    <main className="auth-card">
        <ThemeToggle />
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            <img src="/icon.svg" alt="" />
          </span>
          <div className="brand-text">
            <strong>Kwerry</strong>
            <span>Live SERP research</span>
          </div>
        </div>

        {/* With signup off there is only one tab, which would render as a
            lonely underline under "Sign in" — hide the strip entirely and let
            the h1 carry the heading. */}
        {signupOn ? (
          <div className="auth-tabs" role="tablist">
            <button
              className={"tab" + (mode === "login" ? " active" : "")}
              type="button"
              onClick={() => {
                setMode("login");
                setErr("");
              }}
            >
              Sign in
            </button>
            <button
              className={"tab" + (mode === "register" ? " active" : "")}
              type="button"
              onClick={() => {
                setMode("register");
                setErr("");
              }}
            >
              Create account
            </button>
          </div>
        ) : null}

        {mode === "login" ? (
          <form className="auth-form" autoComplete="on" onSubmit={submitLogin}>
            <h1>Sign in</h1>
            <p className="auth-sub">Use your local Kwerry account.</p>
            <label htmlFor="loginUser">Username</label>
            <input id="loginUser" name="username" autoComplete="username" required />
            <label htmlFor="loginPass">Password</label>
            <input id="loginPass" name="password" type="password" autoComplete="current-password" required />
            <div className="auth-actions">
              {errorNode}
              <button className="btn-run" type="submit" disabled={busy}>
                Sign in
              </button>
            </div>
          </form>
        ) : (
          <form className="auth-form" autoComplete="on" onSubmit={submitRegister}>
            <h1>Create account</h1>
            <p className="auth-sub">Local account on this machine.</p>
            <label htmlFor="regUser">Username</label>
            <input id="regUser" name="username" autoComplete="username" required />
            <label htmlFor="regPass">Password</label>
            <input id="regPass" name="password" type="password" autoComplete="new-password" required />
            <label htmlFor="regPass2">Confirm password</label>
            <input id="regPass2" name="password2" type="password" autoComplete="new-password" required />
            <div className="auth-actions">
              {errorNode}
              <button className="btn-run" type="submit" disabled={busy}>
                Create account
              </button>
            </div>
          </form>
        )}

        {/* Signup is off, so the screen offers no way to recover a forgotten
            password. Point at the one place that can fix it, instead of
            leaving people stuck on a dead end. */}
        {mode === "login" && !signupOn ? (
          <p className="auth-note">
            No account yet? Set <code>SEED_ADMIN_USERNAME</code> and{" "}
            <code>SEED_ADMIN_PASSWORD</code> in <code>.env</code>, then restart the server. To allow
            sign-ups instead, set <code>ENABLE_SIGNUP=true</code>.
          </p>
        ) : null}

        <a className="auth-back" href="/">
          ← Back to home
        </a>
      </main>
  );
}
