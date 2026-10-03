import { useCallback, useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "./icons.jsx";

const KEY = "kwerry.theme";

/** Pre-paint script in web/index.html already set <html data-theme> before React
 * mounts, so a dark-mode reload never flashes white. This reads that state. */
function current() {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export default function ThemeToggle() {
  // null on first render so client and server markup match; real theme comes
  // from <html data-theme> after mount.
  const [theme, setTheme] = useState(null);

  useEffect(() => {
    setTheme(current());
  }, []);

  const toggle = useCallback(() => {
    const next = current() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* private mode / quota: the switch still applies for this session */
    }
    setTheme(next);
  }, []);

  const dark = theme === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      title={label}
      aria-label={label}
      aria-pressed={theme === null ? undefined : dark}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
