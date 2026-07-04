# PASE — Extractable Components

> SuperDesign init file. Components relevant to the TopBar/header area that could be extracted or modified.

## Current component map

### 1. Sidebar (`Layout.tsx` — `Sidebar` export)

**Location**: `src/components/Layout.tsx` lines 53-201
**Status**: Monolithic — embedded in Layout.tsx alongside TopBar and all global CSS.

**What it does**:
- Fixed left sidebar (220px expanded, 56px collapsed "rail" mode)
- Brand logo "pase." with gold dot
- Collapse/expand toggle (persisted to localStorage)
- Local selector dropdown (when user has >1 local)
- Collapsible section groups (Operacion, Direccion, Herramientas, Sistema)
- NavLink items with SVG icons, active state highlighting
- Mobile: transforms to off-canvas drawer (translateX) at <=1024px

**Key CSS classes**: `.sb`, `.sb-rail`, `.sb-header`, `.sb-brand-row`, `.sb-brand-text`, `.brand-dot`, `.sb-workspace`, `.sb-nav`, `.sb-group`, `.sb-group-hd`, `.nav-item`, `.nav-item.active`, `.hamburger`, `.overlay-sb`

**Props**: user, onLogout, locales, localActivo, setLocalActivo, tenant, tenantOverride, onClearOverride

---

### 2. TopBar (`Layout.tsx` — `TopBar` export)

**Location**: `src/components/Layout.tsx` lines 203-268
**Status**: Standalone component but defined in the same file as Sidebar.

**What it does**:
- Fixed position top-right (`position:fixed; top:0; right:0; z-index:15`)
- Contains 3 elements in a row:
  1. `<BandejaEntradaBoton>` — notification bell with gold badge
  2. `<ThemeToggle>` — light/dark mode icon button
  3. Avatar circle button → dropdown with user name/role + "Actualizar app" + "Cerrar sesion"

**Key CSS classes**: `.pase-topbar`, `.pase-topbar-avatar`, `.pase-topbar-dropdown`, `.pase-topbar-dd-header`, `.pase-topbar-dd-name`, `.pase-topbar-dd-role`, `.pase-topbar-dd-sep`, `.pase-topbar-dd-item`, `.pase-topbar-dd-logout`

**Props**: user, onLogout

**Current issues**:
- TopBar is `position:fixed` with no background — content scrolls behind it.
- At `<=1024px` mobile, its padding changes to `14px 60px 14px 56px` to avoid collision with hamburger button.
- No separator between TopBar and page content — PageHeader starts where `.main` padding begins.
- TopBar has `z-index:15` which is BELOW the sidebar's `z-index:20`.

---

### 3. PageHeader (`src/components/ui/PageHeader.tsx`)

**Location**: `src/components/ui/PageHeader.tsx`
**Status**: Standalone shared component, used on every page.

**What it does**:
- 2-column grid: gold vertical anchor line (2px) | content
- Optional overline text (small, muted, above title)
- h1 title with clamp(22px, 2.6vw, 30px)
- Optional subtitle after " . " separator
- Optional InfoTooltip (gold sun icon)
- Optional actions (right-aligned on desktop, stacked on mobile <=640px)
- Bottom border separator (0.5px)

**Relationship to TopBar**: PageHeader lives INSIDE `.main` (the scrollable content area). TopBar lives OUTSIDE `.main` (fixed). They have no direct relationship — the TopBar floats over the top-right corner of the main content.

---

### 4. ThemeToggle (`src/components/ui/ThemeToggle.tsx`)

**Location**: `src/components/ui/ThemeToggle.tsx` + `ThemeToggle.module.css`
**Status**: Standalone, CSS Module scoped.

**What it does**:
- 28x28 icon button (sun for light, moon for dark)
- Toggles `data-theme="dark"` on `<html>`
- Persists to localStorage

---

### 5. BandejaEntradaBoton (`src/components/BandejaEntradaBoton.tsx`)

**Location**: `src/components/BandejaEntradaBoton.tsx`
**Status**: Standalone, inline styles only (no CSS module).

**What it does**:
- Bell icon button (20x20 SVG)
- Gold badge with unread count
- Click opens a `position:fixed` popover (bottom:70, left:8, width:380) with notification list
- Each notification: icon + source label + relative time + title + description
- "Marcar todas" button

**Note**: The popover positioning (bottom:70, left:8) seems designed for when this lived in the sidebar. Now that it lives in the TopBar (top-right), the positioning may be wrong — it opens at bottom-left of the viewport.

---

## Extraction recommendations

### Already extracted (clean boundaries):
- `PageHeader` — clean, self-contained, own CSS via `<style>` tag
- `ThemeToggle` — clean, CSS Module
- `BandejaEntradaBoton` — clean, inline styles
- `Card` — clean, CSS Module
- `Modal` — clean, CSS Module
- `EmptyState` — clean, inline styles

### Should be extracted from Layout.tsx:
- **Sidebar** and **TopBar** should each be their own file. Currently both live in `Layout.tsx` alongside ~500 lines of global CSS.
- The **`css` template literal** (global styles) should ideally be a proper CSS file, but it contains legacy variable aliases in a `:root` block that need to co-exist with `tokens.css`.

### Component that doesn't exist yet but is implied:
- **AppShell** or **LayoutWrapper** — something that composes Sidebar + TopBar + main area + decorative background. Currently this composition happens directly in `App.tsx` (lines 839-1068).
