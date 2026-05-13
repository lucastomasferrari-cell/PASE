import { useEffect, useState } from "react";
import styles from "./ThemeToggle.module.css";

type Theme = "light" | "dark";
const STORAGE_KEY = "pase-theme";

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark" || attr === "light") return attr;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch { /* localStorage bloqueado */ }
  return "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* localStorage bloqueado */ }
  }, [theme]);

  const toggle = () => setTheme(t => (t === "dark" ? "light" : "dark"));
  const isDark = theme === "dark";

  return (
    <>
      <div className={styles.divider} aria-hidden />
      <button
        type="button"
        className={styles.toggle}
        onClick={toggle}
        aria-label={isDark ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
        title={isDark ? "Tema claro" : "Tema oscuro"}
      >
        <span className={styles.label}>{isDark ? "Tema oscuro" : "Tema claro"}</span>
        {isDark ? (
          <svg className={styles.icon} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 8.5A5 5 0 0 1 5.5 2a5 5 0 1 0 6.5 6.5z" />
          </svg>
        ) : (
          <svg className={styles.icon} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="7" cy="7" r="2.5" />
            <line x1="7" y1="1" x2="7" y2="2.5" />
            <line x1="7" y1="11.5" x2="7" y2="13" />
            <line x1="1" y1="7" x2="2.5" y2="7" />
            <line x1="11.5" y1="7" x2="13" y2="7" />
            <line x1="2.6" y1="2.6" x2="3.6" y2="3.6" />
            <line x1="10.4" y1="10.4" x2="11.4" y2="11.4" />
            <line x1="2.6" y1="11.4" x2="3.6" y2="10.4" />
            <line x1="10.4" y1="3.6" x2="11.4" y2="2.6" />
          </svg>
        )}
      </button>
    </>
  );
}
