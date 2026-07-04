# PASE — Design Tokens & CSS Variables

> SuperDesign init file. Complete token system from `src/styles/tokens.css` + Layout.tsx globals.

## Token architecture

1. **`src/styles/tokens.css`** — canonical design tokens (imported in `main.tsx` / `index.html`)
2. **Layout.tsx `css` string** — legacy aliases that map old var names to new `--pase-*` tokens
3. **`src/styles/polish.css`** — shadow/transition/animation polish layer (appended to Layout CSS)
4. **`src/index.css`** — minimal root reset + number input spinner removal
5. **No Tailwind** — everything is custom CSS with CSS custom properties

## Activation

- Light mode: default (no data attribute)
- Dark mode: `<html data-theme="dark">` — set by ThemeToggle, persisted to localStorage key `pase-theme`
- Bootstrap script in `index.html` reads localStorage before React hydrates (prevents flash)

---

## Complete `:root` tokens (LIGHT MODE)

```css
:root {
  color-scheme: light;

  /* === BRAND COLOR === */
  --pase-celeste: #75AADB;        /* celeste bandera argentina, IRAM 7677-2002 */

  /* === CELESTE DERIVATIVES (hovers, sparklines, soft backgrounds) === */
  --pase-celeste-100: #EAF3FB;    /* fondo hover/active, separadores */
  --pase-celeste-200: #D7E8F5;    /* sparkline bajo */
  --pase-celeste-300: #9DC3E2;    /* sparkline medio */

  /* === TEXT === */
  --pase-text:       #1A3A5E;     /* primario, headers, numeros */
  --pase-text-muted: #6E8CAB;     /* labels, sub-textos, placeholders */

  /* === BORDERS === */
  --pase-border:        #E0EAF4;  /* finos de cards y separadores */
  --pase-border-strong: #D0DCEA;  /* inputs, frames principales */

  /* === BACKGROUNDS === */
  --pase-bg:      #FFFFFF;        /* fondo principal (cards, modales) */
  --pase-bg-page: #EFF3F8;        /* fondo de pagina/canvas */
  --pase-bg-soft: #EBF0F6;        /* titlebar, secciones */
  --pase-bg-out:  #E5EAF1;        /* iconos "salida"/grises */

  /* === GOLD ACCENT (restricted: logo dot + InfoTooltip sol icon) === */
  --pase-gold: #F5C518;

  /* === SEMANTIC LEGACY COLORS === */
  --ok:      #2C7A55;              /* verde positivo */
  --success: #2C7A55;
  --warn:    #D97706;              /* dorado dim (warning / vencimientos) */
  --danger:  #B91C1C;              /* rojo error / anulado */

  /* === "ARGENTINA" PALETTE (optional warm tones) === */
  --pase-celeste-pastel: #C9DDEF;
  --pase-crema:          #FAF6EC;
  --pase-crema-soft:     #F8F3E4;

  /* === TYPOGRAPHY === */
  --pase-font: "Inter", system-ui, -apple-system, sans-serif;

  --pase-fs-xs:   10px;   /* microbadges, hints */
  --pase-fs-sm:   11px;   /* overlines, captions, table labels */
  --pase-fs-base: 13px;   /* body default */
  --pase-fs-md:   15px;   /* emphasis, summaries */
  --pase-fs-lg:   18px;   /* section subtitles */
  --pase-fs-xl:   22px;   /* page titles */
  --pase-fs-2xl:  28px;   /* KPI saldos */
  --pase-fs-3xl:  38px;   /* KPI ancla (Caja Efectivo, Facturacion) */

  /* Letter spacing */
  --pase-ls-tight:   -0.025em;    /* titles xl+ */
  --pase-ls-snug:    -0.01em;     /* md/lg */
  --pase-ls-overline: 0.06em;     /* uppercase overlines */

  /* === SPACING (4px base) === */
  --pase-space-1:  4px;
  --pase-space-2:  8px;
  --pase-space-3:  12px;
  --pase-space-4:  16px;
  --pase-space-5:  20px;
  --pase-space-6:  24px;
  --pase-space-8:  32px;

  /* === INPUT/BUTTON HEIGHTS === */
  --pase-h-sm: 30px;   /* filter inputs */
  --pase-h-md: 36px;   /* default buttons/inputs */
  --pase-h-lg: 42px;   /* primary CTAs */

  /* === BORDER RADIUS === */
  --pase-radius-card: 14px;       /* cards, frames */
  --pase-radius-md:   8px;        /* buttons, nav items */
  --pase-radius-pill: 999px;      /* badges, tabs */

  /* === BORDER WIDTH === */
  --pase-border-thin: 0.5px;      /* all borders are thin */

  /* === SHADOWS (multi-layer, blue-tinted) === */
  --pase-shadow-xs:  0 1px 2px rgba(26,58,94,0.04);
  --pase-shadow-sm:  0 1px 2px rgba(26,58,94,0.04), 0 2px 4px rgba(26,58,94,0.04);
  --pase-shadow-md:  0 2px 4px rgba(26,58,94,0.03), 0 4px 12px rgba(26,58,94,0.06);
  --pase-shadow-lg:  0 4px 8px rgba(26,58,94,0.03), 0 8px 24px rgba(26,58,94,0.08);
  --pase-shadow-xl:  0 8px 16px rgba(26,58,94,0.04), 0 16px 48px rgba(26,58,94,0.10);

  /* === DURATIONS & EASINGS === */
  --pase-duration-fast:   0.12s;
  --pase-duration-normal: 0.2s;
  --pase-duration-slow:   0.35s;
  --pase-ease-out:     cubic-bezier(0.22, 0.61, 0.36, 1);
  --pase-ease-in-out:  cubic-bezier(0.45, 0, 0.55, 1);
  --pase-ease-spring:  cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

---

## Complete `[data-theme="dark"]` tokens (DARK MODE)

Inspired by Argentina 2006 away kit (navy blue with celeste details).

```css
[data-theme="dark"] {
  color-scheme: dark;

  --pase-bg:      #141E30;        /* graphite-blue cards */
  --pase-bg-page: #0C1220;        /* darker canvas */
  --pase-bg-soft: #1A2540;        /* elevated panels */
  --pase-bg-out:  #2A3550;        /* secondary sections */

  --pase-text:       #F0F4F8;     /* near-white with cool tint */
  --pase-text-muted: #93A8C2;

  --pase-border:        #2A3550;
  --pase-border-strong: #3F4D6E;

  --pase-celeste-100: #1E3155;    /* hover/active bg */
  --pase-celeste-200: #2E4878;    /* sparkline low */
  --pase-celeste-300: #4A6FA8;    /* sparkline mid */

  /* --pase-celeste and --pase-gold stay the same (brand anchors) */

  /* Darker shadows */
  --pase-shadow-xs:  0 1px 2px rgba(0,0,0,0.12);
  --pase-shadow-sm:  0 1px 2px rgba(0,0,0,0.12), 0 2px 4px rgba(0,0,0,0.10);
  --pase-shadow-md:  0 2px 4px rgba(0,0,0,0.10), 0 4px 12px rgba(0,0,0,0.15);
  --pase-shadow-lg:  0 4px 8px rgba(0,0,0,0.10), 0 8px 24px rgba(0,0,0,0.20);
  --pase-shadow-xl:  0 8px 16px rgba(0,0,0,0.12), 0 16px 48px rgba(0,0,0,0.25);
}
```

### Dark mode overrides in tokens.css:

```css
[data-theme="dark"] .kpi,
[data-theme="dark"] .panel,
[data-theme="dark"] .caja-card,
[data-theme="dark"] .modal,
[data-theme="dark"] .login-card {
  background: var(--pase-bg-soft);
}
[data-theme="dark"] .panel-hd,
[data-theme="dark"] .modal-hd,
[data-theme="dark"] .modal-ft {
  background: var(--pase-bg-soft);
}
[data-theme="dark"] .badge.b-danger,
[data-theme="dark"] .badge.b-warn,
[data-theme="dark"] .badge.b-anulada {
  background: rgba(220, 38, 38, 0.18);
  color: #FCA5A5;
  border: 0.5px solid rgba(220, 38, 38, 0.35);
}
[data-theme="dark"] thead th { background: var(--pase-bg-out); }
[data-theme="dark"] tbody tr:hover { background: var(--pase-bg-out); }
```

---

## Legacy variable aliases (Layout.tsx `:root` block)

Maps old variable names (used in ~20+ screens) to canonical `--pase-*` tokens:

```css
:root {
  --bg:       var(--pase-bg);
  --s1:       var(--pase-bg-soft);
  --s2:       var(--pase-bg-soft);
  --s3:       var(--pase-celeste-100);
  --bd:       var(--pase-border);
  --bd2:      var(--pase-border-strong);
  --acc:      var(--pase-celeste);
  --txt:      var(--pase-text);
  --muted:    var(--pase-text-muted);
  --muted2:   var(--pase-text-muted);
  --danger:   var(--pase-text);         /* intentionally muted — no alarm chromatics */
  --success:  var(--pase-celeste);      /* positive in celeste, not green */
  --warn:     var(--pase-text-muted);
  --info:     var(--pase-text-muted);
  --r:        var(--pase-radius-md);
}
```

---

## Dark mode decorative line (Layout.tsx)

A 4px gradient line at the top-right corner, only in dark mode:

```css
[data-theme="dark"] body::after {
  content: '';
  position: fixed;
  top: 0;
  right: 0;
  width: 280px;
  height: 4px;
  background: linear-gradient(90deg, var(--pase-celeste), var(--pase-gold));
  opacity: 0.55;
  pointer-events: none;
  z-index: 100;
}
```

---

## Design rules (from DESIGN_SYSTEM.md context)

1. **Single brand celeste**: `--pase-celeste` (#75AADB). No other blues/teals in the product.
2. **Gold restricted**: `--pase-gold` (#F5C518) only in logo dot, InfoTooltip sun icon, and notification badge.
3. **No role-based colors**: User roles distinguished only by text, not color.
4. **Text always** `--pase-text` or `--pase-text-muted`. Never pure black or generic gray.
5. **Borders 0.5px** everywhere.
6. **No gradients** (except decorative dark mode line). No deep box-shadows.
7. **Font weights**: 400 (normal text), 500 (emphasis + numbers). Never 600+.
8. **Font family**: Inter only. `Fraunces` italic available for special editorial words in PageHeader.
