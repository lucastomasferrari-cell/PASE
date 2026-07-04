# PASE — Shared UI Primitives

> SuperDesign init file. Full source code of reusable UI components used in the layout, header, and page structure.

## Stack

- React 19 + TypeScript (strict)
- Vite 8
- Custom CSS (NO Tailwind) — CSS Modules for component-scoped styles, global CSS in Layout.tsx template literal
- CSS custom properties defined in `src/styles/tokens.css`
- Font: Inter (Google Fonts import in Layout.tsx CSS)

---

## PageHeader (`src/components/ui/PageHeader.tsx`)

Standardized page header used on every page. Gold anchor line on the left, title with optional Fraunces italic spans, info tooltip, and right-aligned actions.

```tsx
import type { ReactNode } from "react";

import { InfoTooltip } from "./InfoTooltip";

interface PageHeaderProps {
  title: string | ReactNode;
  subtitle?: string;
  overline?: string;
  info?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, overline, info, actions }: PageHeaderProps) {
  return (
    <div className="pase-page-header">
      <div className="pase-page-header__anchor" aria-hidden="true" />
      <div className="pase-page-header__body">
        {overline && <div className="pase-page-header__overline">{overline}</div>}
        <div className="pase-page-header__title-row">
          <div className="pase-page-header__title-wrap">
            <h1 className="pase-page-header__title">
              {title}
              {subtitle && <span className="pase-page-header__subtitle"> · {subtitle}</span>}
            </h1>
            {info && <InfoTooltip maxWidth={320}>{info}</InfoTooltip>}
          </div>
          {actions && <div className="pase-page-header__actions">{actions}</div>}
        </div>
      </div>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@1,400;1,500&display=swap');

        .pase-page-header {
          display: grid;
          grid-template-columns: 2px 1fr;
          gap: 16px;
          margin: 4px 0 24px;
          padding-bottom: 14px;
          border-bottom: 0.5px solid var(--pase-border);
        }
        .pase-page-header__anchor {
          width: 2px;
          background: linear-gradient(
            to bottom,
            transparent,
            var(--pase-gold) 25%,
            var(--pase-gold) 75%,
            transparent
          );
          align-self: stretch;
          min-height: 36px;
        }
        .pase-page-header__body { min-width: 0; }
        .pase-page-header__overline {
          font-size: 10px;
          color: var(--pase-text-muted);
          letter-spacing: 0.04em;
          margin-bottom: 6px;
        }
        .pase-page-header__title-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          flex-wrap: wrap;
        }
        .pase-page-header__title-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .pase-page-header__title {
          margin: 0;
          font-size: clamp(22px, 2.6vw, 30px);
          font-weight: 500;
          color: var(--pase-text);
          letter-spacing: -0.025em;
          line-height: 1.1;
          font-family: var(--pase-font);
        }
        .pase-page-header__title .ph-italic,
        .pase-page-header__title .ph-italic * {
          font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
          font-style: italic;
          font-weight: 400;
        }
        .pase-page-header__subtitle {
          color: var(--pase-text-muted);
          font-weight: 400;
          font-size: 0.65em;
          margin-left: 4px;
          letter-spacing: -0.01em;
        }
        .pase-page-header__actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
        }
        @media (max-width: 640px) {
          .pase-page-header {
            margin: 2px 0 16px;
            padding-bottom: 12px;
            grid-template-columns: 2px 1fr;
            gap: 12px;
          }
          .pase-page-header__title-row {
            flex-direction: column;
            align-items: stretch;
            gap: 10px;
          }
          .pase-page-header__title-wrap {
            justify-content: flex-start;
          }
          .pase-page-header__actions {
            justify-content: flex-start;
          }
        }
      `}</style>
    </div>
  );
}
```

---

## InfoTooltip (`src/components/ui/InfoTooltip.tsx`)

Gold "Sol de Mayo" icon button that shows a tooltip on hover/focus/click. Used alongside PageHeader titles.

```tsx
import { useState, useRef, useEffect } from "react";

interface InfoTooltipProps {
  children: React.ReactNode;
  position?: "top" | "right" | "bottom" | "left";
  maxWidth?: number;
  size?: number;
}

export function InfoTooltip({ children, position = "right", maxWidth = 280, size = 16 }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tooltipPositionStyle: React.CSSProperties = (() => {
    switch (position) {
      case "top":    return { bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)" };
      case "bottom": return { top: "calc(100% + 6px)",    left: "50%", transform: "translateX(-50%)" };
      case "left":   return { right: "calc(100% + 6px)",  top: "50%",  transform: "translateY(-50%)" };
      case "right":
      default:       return { left: "calc(100% + 6px)",   top: "50%",  transform: "translateY(-50%)" };
    }
  })();

  return (
    <span ref={wrapRef} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        aria-label="Mas informacion"
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          width: size + 6,
          height: size + 6,
          padding: 0,
          background: "transparent",
          border: "none",
          cursor: "help",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          transition: "background 0.15s ease",
        }}
        onPointerEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--pase-celeste-100)"; }}
        onPointerLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >
        <SunIcon size={size} />
      </button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            zIndex: 1000,
            background: "var(--pase-bg)",
            color: "var(--pase-text)",
            border: "0.5px solid var(--pase-celeste-300)",
            borderRadius: "var(--pase-radius-md, 8px)",
            padding: "8px 12px",
            fontSize: 11,
            lineHeight: 1.45,
            fontFamily: "var(--pase-font)",
            fontWeight: 400,
            letterSpacing: "-0.005em",
            maxWidth,
            width: "max-content",
            boxShadow: "0 4px 12px rgba(26, 58, 94, 0.08)",
            pointerEvents: "none",
            ...tooltipPositionStyle,
          }}
        >
          {children}
        </span>
      )}
    </span>
  );
}

function SunIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="var(--pase-gold, #F5C518)" strokeWidth="0.9" strokeLinecap="round">
        <line x1="8" y1="0.5" x2="8" y2="2.4" />
        <line x1="8" y1="13.6" x2="8" y2="15.5" />
        <line x1="0.5" y1="8" x2="2.4" y2="8" />
        <line x1="13.6" y1="8" x2="15.5" y2="8" />
        <line x1="2.6" y1="2.6" x2="4" y2="4" />
        <line x1="12" y1="12" x2="13.4" y2="13.4" />
        <line x1="2.6" y1="13.4" x2="4" y2="12" />
        <line x1="12" y1="4" x2="13.4" y2="2.6" />
      </g>
      <g stroke="var(--pase-gold, #F5C518)" strokeWidth="0.65" strokeLinecap="round">
        <line x1="4.7" y1="1" x2="5.3" y2="2.3" />
        <line x1="11.3" y1="1" x2="10.7" y2="2.3" />
        <line x1="1" y1="4.7" x2="2.3" y2="5.3" />
        <line x1="1" y1="11.3" x2="2.3" y2="10.7" />
        <line x1="13.7" y1="5.3" x2="15" y2="4.7" />
        <line x1="13.7" y1="10.7" x2="15" y2="11.3" />
        <line x1="5.3" y1="13.7" x2="4.7" y2="15" />
        <line x1="10.7" y1="13.7" x2="11.3" y2="15" />
      </g>
      <circle cx="8" cy="8" r="3.1" fill="var(--pase-gold, #F5C518)" />
      <circle cx="6.85" cy="7.4" r="0.32" fill="var(--pase-text, #1A3A5E)" />
      <circle cx="9.15" cy="7.4" r="0.32" fill="var(--pase-text, #1A3A5E)" />
      <path d="M 6.8 8.7 Q 8 9.4 9.2 8.7" stroke="var(--pase-text, #1A3A5E)" strokeWidth="0.32" strokeLinecap="round" fill="none" />
    </svg>
  );
}
```

---

## ThemeToggle (`src/components/ui/ThemeToggle.tsx`)

Light/dark theme toggle icon button. Lives in the TopBar (top-right). Persists to localStorage.

```tsx
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
  } catch {}
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
    try { localStorage.setItem(STORAGE_KEY, theme); } catch {}
  }, [theme]);

  const toggle = () => setTheme(t => (t === "dark" ? "light" : "dark"));
  const isDark = theme === "dark";

  return (
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
  );
}
```

**ThemeToggle.module.css:**

```css
.btn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--pase-text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
  padding: 0;
  flex-shrink: 0;
}
.btn:hover {
  background: var(--pase-celeste-100);
  color: var(--pase-text);
}
.icon {
  width: 16px;
  height: 16px;
}
```

---

## BandejaEntradaBoton (`src/components/BandejaEntradaBoton.tsx`)

Notification bell button in the TopBar. Shows gold badge with unread count. Click opens a fixed popover with notification list.

```tsx
import { useState, useRef, useEffect, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { useBandejaEntrada, type Notif, type NotifSource } from "../lib/useBandejaEntrada";
import { fmt_dt_ar } from "@pase/shared/utils";
import { PinIcon, KeyIcon, AlertIcon, CalendarIcon, BellIcon, WalletIcon } from "./ui";
import type { Usuario } from "../types";

interface Props {
  user: Usuario;
}

const SOURCE_ICON_RENDER: Record<NotifSource, () => ReactElement> = {
  tarea:                () => <PinIcon size={14} tone="muted" />,
  override:             () => <KeyIcon size={14} tone="muted" />,
  factura_vencida:      () => <AlertIcon size={14} tone="gold" />,
  factura_por_vencer:   () => <CalendarIcon size={14} tone="muted" />,
  mp_sin_conciliar:     () => <WalletIcon size={14} tone="muted" />,
  solicitud_pendiente:  () => <KeyIcon size={14} tone="gold" />,
};

const SOURCE_LABELS: Record<NotifSource, string> = {
  tarea: "Tarea",
  override: "Codigo usado",
  factura_vencida: "Vencidas",
  factura_por_vencer: "Por vencer",
  mp_sin_conciliar: "MP sin conciliar",
  solicitud_pendiente: "Solicitud pendiente",
};

export function BandejaEntradaBoton({ user }: Props) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { notifs, loading, countNoLeidas, marcarLeida, marcarTodasLeidas } = useBandejaEntrada(user);

  // ... close-on-click-outside and ESC handler ...

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={countNoLeidas > 0 ? `${countNoLeidas} notificaciones sin leer` : "Bandeja de entrada"}
        title="Bandeja de entrada"
        style={{
          position: "relative",
          background: "transparent",
          border: "none",
          padding: 6,
          cursor: "pointer",
          color: countNoLeidas > 0 ? "var(--pase-text)" : "var(--pase-text-muted)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Bell SVG icon 20x20 */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {countNoLeidas > 0 && (
          <span style={{
            position: "absolute", top: 2, right: 2,
            minWidth: 16, height: 16, padding: "0 4px",
            background: "var(--pase-gold)", color: "#1A3A5E",
            borderRadius: 999, fontSize: 10, fontWeight: 500,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontVariantNumeric: "tabular-nums",
          }}>
            {countNoLeidas > 99 ? "99+" : countNoLeidas}
          </span>
        )}
      </button>
      {/* Popover: position:fixed, bottom:70, left:8, width:380 */}
    </div>
  );
}
```

---

## Card (`src/components/ui/Card.tsx`)

Base container component. Variants: default (white bg), soft (bg-soft), anchor (celeste solid, white text). Optional onClick makes it interactive with hover lift.

```tsx
import type { ReactNode } from "react";
import styles from "./Card.module.css";

type CardVariant = "default" | "soft" | "anchor";
type CardPadding = "none" | "md" | "lg";

interface CardProps {
  children: ReactNode;
  variant?: CardVariant;
  padding?: CardPadding;
  className?: string;
  onClick?: () => void;
  ariaLabel?: string;
  label?: ReactNode;
  action?: ReactNode;
}

export function Card({
  children, variant = "default", padding = "md", className, onClick, ariaLabel, label, action,
}: CardProps) {
  const cls = [
    styles.card,
    styles[`variant_${variant}`],
    styles[`padding_${padding}`],
    onClick ? styles.clickable : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  const content = (
    <>
      {(label || action) && (
        <header className={styles.header}>
          {label && <div className={styles.label}>{label}</div>}
          {action && <div className={styles.action}>{action}</div>}
        </header>
      )}
      {children}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} aria-label={ariaLabel}>
        {content}
      </button>
    );
  }
  return <div className={cls} aria-label={ariaLabel}>{content}</div>;
}
```

**Card.module.css:**

```css
.card {
  border-radius: var(--pase-radius-card);
  font-family: var(--pase-font);
  color: var(--pase-text);
  display: block;
  text-align: left;
  width: 100%;
  border: var(--pase-border-thin) solid var(--pase-border);
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
  position: relative;
  overflow: hidden;
}
.variant_default { background: var(--pase-bg); }
.variant_soft { background: var(--pase-bg-soft); }
.variant_anchor {
  background: var(--pase-celeste);
  color: #fff;
  border-color: var(--pase-celeste);
  box-shadow: 0 2px 6px rgba(90, 143, 168, 0.15);
}
.variant_anchor::after {
  content: "";
  position: absolute;
  bottom: -40px; right: -40px;
  width: 130px; height: 130px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  pointer-events: none;
}
.padding_none { padding: 0; }
.padding_md   { padding: 14px 16px; }
.padding_lg   { padding: 18px 20px; }
.clickable { cursor: pointer; }
.clickable:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(15, 30, 45, 0.06);
  border-color: var(--pase-celeste-300);
}
.header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 10px; margin-bottom: 8px; position: relative; z-index: 1;
}
.label {
  font-size: var(--pase-fs-sm); font-weight: 500;
  letter-spacing: var(--pase-ls-snug); color: var(--pase-text-muted);
}
.variant_anchor .label { color: rgba(255, 255, 255, 0.78); }
```

---

## Modal (`src/components/ui/Modal.tsx`)

Reusable dialog with overlay, fade-in animation, focus trap, and ESC close. Used throughout the app for forms and detail views.

```tsx
import { useEffect, useRef } from "react";
import type { ReactNode, MouseEvent } from "react";
import styles from "./Modal.module.css";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: number;
  preventCloseOnOverlay?: boolean;
}

export function Modal({ isOpen, onClose, title, subtitle, children, footer, maxWidth = 720, preventCloseOnOverlay = false }: ModalProps) {
  // ... focus trap, ESC close, scroll lock ...
  if (!isOpen) return null;
  return (
    <div className={styles.overlay} onClick={onOverlayClick} role="presentation">
      <div ref={dialogRef} className={styles.dialog} style={{ maxWidth }} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>{title}</div>
            {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Cerrar">X</button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}
```

**Modal.module.css:**

```css
.overlay {
  position: fixed; inset: 0;
  background: rgba(26, 58, 94, 0.18);
  z-index: 100;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  padding-left: 220px; /* offset for fixed sidebar */
  opacity: 0;
  animation: fadeIn 0.18s ease forwards;
}
@keyframes fadeIn { to { opacity: 1; } }
.dialog {
  background: var(--pase-bg);
  border-radius: var(--pase-radius-card);
  border: 0.5px solid var(--pase-border);
  padding: 22px 24px;
  width: 100%;
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  transform: scale(0.96); opacity: 0;
  animation: scaleIn 0.2s ease 0.05s forwards;
  box-shadow: 0 12px 40px rgba(26, 58, 94, 0.12);
}
@keyframes scaleIn { to { transform: scale(1); opacity: 1; } }
.header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
.title { font-size: 17px; font-weight: 500; color: var(--pase-text); letter-spacing: -0.02em; }
.subtitle { font-size: 11px; color: var(--pase-text-muted); margin-top: 4px; }
.closeBtn { width: 28px; height: 28px; border-radius: 7px; border: none; background: transparent; color: var(--pase-text-muted); cursor: pointer; font-size: 16px; }
.closeBtn:hover { background: var(--pase-bg-soft); color: var(--pase-text); }
.footer { margin-top: 18px; padding-top: 14px; border-top: 0.5px solid var(--pase-border); display: flex; gap: 8px; }
.footer > * { flex: 1; }
@media (max-width: 1024px) { .overlay { padding-left: 20px; } }
@media (max-width: 540px) { .overlay { padding: 12px; } .dialog { padding: 18px 16px; } }
```

---

## EmptyState (`src/components/ui/EmptyState.tsx`)

Empty state component for tables/lists with icon, title, description, and optional CTA.

```tsx
import type { ReactNode } from "react";

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  cta?: ReactNode;
  size?: "compact" | "normal";
}

export function EmptyState({ icon, title, description, cta, size = "normal" }: Props) {
  const padY = size === "compact" ? 24 : 48;
  return (
    <div style={{ padding: `${padY}px 24px`, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      {icon && <div style={{ fontSize: size === "compact" ? 28 : 40, lineHeight: 1, opacity: 0.7, marginBottom: 4 }}>{icon}</div>}
      <div style={{ fontSize: "var(--pase-fs-md)", fontWeight: 500, color: "var(--pase-text)", letterSpacing: "var(--pase-ls-snug)" }}>{title}</div>
      {description && <p style={{ margin: 0, fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", lineHeight: 1.5, maxWidth: 400 }}>{description}</p>}
      {cta && <div style={{ marginTop: 8 }}>{cta}</div>}
    </div>
  );
}
```

---

## PageContainer (`src/components/ui/PageContainer.tsx`)

Standardized page content wrapper with consistent padding. Not currently used on all pages (most rely on `.main` padding from Layout.tsx).

```tsx
import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  width?: "full" | "wide" | "narrow";
}

const WIDTHS = { full: "100%", wide: 1280, narrow: 640 };

export function PageContainer({ children, width = "full" }: Props) {
  return (
    <div style={{ maxWidth: WIDTHS[width], margin: width === "full" ? undefined : "0 auto", padding: "24px 24px 32px" }} className="pase-page-container">
      {children}
      <style>{`@media (max-width: 640px) { .pase-page-container { padding: 16px !important; } }`}</style>
    </div>
  );
}
```
