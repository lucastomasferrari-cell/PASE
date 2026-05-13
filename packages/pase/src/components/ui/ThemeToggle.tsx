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
      <div className={styles.wrapper}>
        <button
          type="button"
          className={styles.btn}
          onClick={toggle}
          aria-label={isDark ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
          title={isDark ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
        >
          {isDark ? (
            <svg className={styles.icon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M13 9.5A5 5 0 0 1 6.5 3 5 5 0 1 0 13 9.5z" />
            </svg>
          ) : (
            <svg className={styles.icon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="8" cy="8" r="2.8" />
              <line x1="8" y1="1.5" x2="8" y2="3" />
              <line x1="8" y1="13" x2="8" y2="14.5" />
              <line x1="1.5" y1="8" x2="3" y2="8" />
              <line x1="13" y1="8" x2="14.5" y2="8" />
              <line x1="3.2" y1="3.2" x2="4.3" y2="4.3" />
              <line x1="11.7" y1="11.7" x2="12.8" y2="12.8" />
              <line x1="3.2" y1="12.8" x2="4.3" y2="11.7" />
              <line x1="11.7" y1="4.3" x2="12.8" y2="3.2" />
            </svg>
          )}
        </button>
      </div>
    </>
  );
}
