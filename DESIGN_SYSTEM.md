# PASE — Sistema de Diseño v1.0

> Documento de referencia para la nueva identidad visual de PASE.
> Estilo: **bento asimétrico + calm design + paleta celeste bandera argentina**.
> Definido el 13-May-26. Aplica a todo el frontend de PASE (react + ts + vite).

---

## 1. Resumen ejecutivo

Rediseño completo de UI con tres pilares:
1. **Paleta monocromática celeste argentino** (#75AADB) con un único acento dorado moneda (#F5C518) en detalles mínimos.
2. **Layout bento asimétrico** en pantallas principales (un KPI grande ancla + varias chicas).
3. **Calm design**: sin gradientes, sin sombras profundas, bordes finos 0.5px, mucho whitespace, números grandes con sparklines.

---

## 2. Tokens de color

Crear como CSS variables en `:root` (o en Tailwind config si usa Tailwind).

```css
:root {
  /* Color de marca — único celeste */
  --pase-celeste: #75AADB;        /* celeste bandera argentina, IRAM 7677-2002 */

  /* Derivados claros del celeste — para sparklines, hovers, fondos suaves */
  --pase-celeste-100: #EAF3FB;    /* fondo hover/active, separadores */
  --pase-celeste-200: #D7E8F5;    /* sparkline bajo */
  --pase-celeste-300: #9DC3E2;    /* sparkline medio */

  /* Texto */
  --pase-text:       #1A3A5E;     /* texto primario, headers, números */
  --pase-text-muted: #6E8CAB;     /* labels, sub-textos, placeholders */

  /* Bordes */
  --pase-border:        #EAF3FB;  /* bordes finos de cards y separadores */
  --pase-border-strong: #DCE8F4;  /* bordes de inputs, frames principales */

  /* Fondos */
  --pase-bg:        #FFFFFF;      /* fondo principal */
  --pase-bg-soft:   #F4F9FD;      /* fondo de titlebar, secciones */
  --pase-bg-out:    #F2F5F8;      /* fondo de íconos "salida"/grises */

  /* Acento dorado — uso muy restringido */
  --pase-gold:      #F5C518;      /* SOLO punto del logo y indicador "en vivo" */
}
```

### Reglas de uso de color (importantísimas)
- **#75AADB es el único celeste de marca.** No usar ningún otro azul/celeste en ninguna parte del producto.
- **Dorado solo en 2 lugares**: el punto final del logo `pase.` y el indicador "en vivo" de la card anchor. Nada más. Cualquier intento de usarlo en CTAs, botones, badges, etc → rechazar.
- Los celestes claros (100/200/300) son derivados del mismo tono, no colores nuevos.
- Texto siempre `--pase-text` o `--pase-text-muted`. Nunca negro puro ni gris genérico.
- **Roles de usuario sin color.** El sistema actual usa azules/púrpuras/verdes/rojos en `lib/auth.ts` para distinguir dueño / admin / encargado / cajero / superadmin. Decisión 2026-05-13: **eliminar el color por rol**. La distinción se comunica solo con el texto del rol (label). Avatares de usuario van todos en `--pase-celeste`. Aplica también a badges, chips y cualquier indicador de rol.

---

## 3. Tipografía

```css
:root {
  --pase-font: "Inter", system-ui, -apple-system, sans-serif;
}
```

- **Familia única**: Inter (o system-ui de fallback).
- **Pesos permitidos: solo 400 y 500.** Nunca 600+, queda pesado y rompe el calm design.
- **Letter-spacing negativo** en todo lo grande:
  - Logo `pase.` → `-0.035em`
  - Títulos h1/h2 → `-0.02em` a `-0.03em`
  - Números grandes (KPIs, anchor) → `-0.03em`
- **Tabular-nums** en todos los números monetarios (precios, totales, montos).
- **Sentence case** siempre. Nunca Title Case ni ALL CAPS, salvo el link "VER TODO" del listado de movimientos que va en mayúsculas tracking `0.02em`.

### Escala
| Uso | Tamaño | Peso |
|---|---|---|
| Número anchor (KPI principal) | 30px | 500 |
| Números KPI chicos | 24px | 500 |
| Logo | 26px | 500 |
| Título pantalla (h1) | 18px | 500 |
| Card titles / section heads | 13px | 500 |
| Body | 12px | 400 |
| Labels / sublabels | 11px | 500 |
| Microtext (subs, links small) | 10–10.5px | 400–500 |

---

## 4. Bordes, radios y espaciados

```css
:root {
  --pase-radius-card:  14px;     /* cards y frame principal */
  --pase-radius-md:    8px;      /* botones, items de nav, íconos de tx */
  --pase-radius-pill:  999px;    /* tabs de chart, badges */
  --pase-border-thin:  0.5px;    /* todos los bordes son finos */
}
```

- Bordes siempre 0.5px (nunca 1px). Color: `var(--pase-border)`.
- Padding cards regulares: `14px 16px`.
- Padding anchor card: `16px 18px`.
- Gap entre cards del bento: `10px`.
- Padding del main content: `20px`.
- Sidebar ancho: `168px`. Padding interno: `22px 10px`.

---

## 5. Componentes clave

### 5.1 Logo `pase.`
```jsx
<div className="logo">
  pase<span className="logo-dot">.</span>
</div>
```
```css
.logo {
  font-size: 26px;
  font-weight: 500;
  color: var(--pase-text);
  text-align: center;        /* centrado en el sidebar */
  padding: 6px 0 26px;
  letter-spacing: -0.035em;
  line-height: 1;
}
.logo-dot {
  color: var(--pase-gold);   /* único uso del dorado en el logo */
}
```

### 5.2 Sidebar
- Fondo blanco, no gris.
- Logo centrado arriba con padding inferior generoso (26px).
- Items de nav: padding `8px 12px`, radius 8px, gap 2px entre items.
- Estado normal: `color: var(--pase-text-muted)`.
- Hover: `background: var(--pase-bg-soft)`.
- Active: `background: var(--pase-celeste-100); color: var(--pase-text); font-weight: 500`.
- Íconos: 14px, Tabler outline (`ti ti-*`). Nunca filled.

### 5.3 Card anchor (KPI principal del bento)
- Background sólido `var(--pase-celeste)`.
- Ocupa 2 filas en el grid (`grid-row: span 2`).
- Mínimo alto: 188px.
- Decoración 1 (sutil): círculo blanco translúcido `rgba(255,255,255,0.14)` de 170px posicionado bottom-right `-50px / -50px`. Sin sombra ni blur.
- Decoración 2 (indicador "en vivo"): círculo dorado 6×6px en top-right `17px / 18px` con halo `box-shadow: 0 0 0 4px rgba(245,197,24,0.28)`.
- Número grande: 30px, blanco puro.
- Label superior: blanco `opacity: 0.78`.
- Footer interno: meta a la izquierda en blanco `opacity: 0.7`, pill "en vivo" a la derecha con background `rgba(255,255,255,0.22)` y padding `3px 9px`.

### 5.4 Cards regulares (KPIs chicos)
- Background blanco.
- Border `0.5px solid var(--pase-border)`.
- Radius 14px.
- Estructura interna:
  - Label (11px, muted, weight 500)
  - Número (24px, primary, weight 500)
  - Delta (11px, primary, weight 500, `margin-top: 5px`)
  - Sparkline (26px alto, `margin-top: 12px`)

### 5.5 Sparklines
- 7 barras (puede variar).
- Width flexible, gap 2px, border-radius 1px.
- Background por defecto: `var(--pase-celeste-200)`.
- Penúltima barra: `var(--pase-celeste-300)` (clase `.mid`).
- Última barra: `var(--pase-celeste)` (clase `.hi`).
- Alturas en porcentaje (`height: 55%` etc).

### 5.6 Chart bars (gráfico principal)
- 5 niveles de la gama celeste, asignados según valor:
  - b1: `var(--pase-celeste-100)`
  - b2: `var(--pase-celeste-200)`
  - b3: `var(--pase-celeste-300)`
  - b4: `var(--pase-celeste)`
- Radius `4px 4px 1px 1px`.
- Gap 6px.

### 5.7 Filas de transacción / listado
- Padding `6px 0`, border-bottom `0.5px solid var(--pase-border)`.
- Última fila sin border.
- Ícono izquierdo: 26×26px, radius 8px, background `var(--pase-celeste-100)` para entradas / `var(--pase-bg-out)` para salidas. Color del ícono: `var(--pase-text)` / `var(--pase-text-muted)` respectivamente.
- Label en peso 500, sublabel en muted 10.5px.
- Monto: `font-variant-numeric: tabular-nums`, peso 500.

### 5.8 Avatar
- 32×32px, círculo, background `var(--pase-celeste)`, texto blanco peso 500.

### 5.9 Tabs (ej. 7d / 30d / 90d)
- Padding `3px 8px`, radius 999px.
- Inactivo: texto muted, sin background.
- Activo: background `var(--pase-celeste-100)`, color `var(--pase-text)`.

---

## 6. Layout bento (dashboard)

Grid asimétrico 3 columnas × 2 filas:

```
+-----------+--------+--------+
|           | KPI 2  | KPI 3  |
|  ANCHOR   +--------+--------+
|           | KPI 4  | KPI 5  |
+-----------+--------+--------+
|   CHART (1.5fr)    |  TX    |
+--------------------+--------+
```

```css
.bento {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr;
  grid-template-rows: auto auto;
  gap: 10px;
}
.anchor { grid-row: span 2; }

.row {
  display: grid;
  grid-template-columns: 1.5fr 1fr;
  gap: 10px;
  margin-top: 14px;
}
```

---

## 7. Reglas — qué NO hacer

- ❌ Gradientes de cualquier tipo.
- ❌ Box-shadows profundas. Solo halo en el dot dorado del anchor.
- ❌ Más de un color de marca. **Solo #75AADB.** Ningún otro azul, ningún violeta, ningún verde de "éxito" — los positivos se comunican con el mismo celeste.
- ❌ Pesos de fuente 600 o superiores.
- ❌ Title Case o ALL CAPS (salvo "VER TODO").
- ❌ Bordes 1px o más gruesos.
- ❌ Dorado en CTAs, badges, alertas, o cualquier elemento que no sean los 2 puntos definidos.
- ❌ Mezclar familias tipográficas. Solo Inter.
- ❌ Sombras decorativas en cards. Solo borde fino.

## 8. Reglas — qué SÍ hacer

- ✅ CSS variables para absolutamente todo color, radio y tipo.
- ✅ Bordes 0.5px finos en todos lados.
- ✅ Whitespace generoso (padding cards 14–16px, gaps 10px, padding main 20px).
- ✅ `font-variant-numeric: tabular-nums` en cualquier número monetario.
- ✅ Letter-spacing negativo en headlines.
- ✅ Sparklines inline en KPIs (en vez de charts separados grandes).
- ✅ Layout bento donde haya KPIs (dashboard, reportes, pantallas resumen).
- ✅ Mobile responsive: el bento colapsa a 1 columna en <640px; el sidebar pasa a drawer.

---

## 9. Plan de implementación por fases

### Fase 1 — Design tokens (1 commit, ~30 min)
- Crear archivo `src/styles/tokens.css` (o extender `tailwind.config.ts`) con todas las variables CSS.
- Importar globalmente en `main.tsx` o equivalente.
- **No tocar nada de UI todavía.** Solo dejar tokens disponibles.
- **Smoke test**: nada visual cambia, las variables están en DevTools.

### Fase 2 — Tipografía y reset base (1 commit, ~30 min)
- Importar Inter (Google Fonts o `@fontsource/inter`).
- Setear `--pase-font` en `body`.
- Aplicar pesos permitidos (400/500). Buscar y eliminar usos de 600/700/bold.
- **Smoke test**: la app sigue funcional pero ya con Inter en todas las pantallas.

### Fase 3 — Componentes base (3–5 commits)
Tocar en orden:
1. **Logo** + Sidebar (1 commit).
2. **Card / CardAnchor** componente reutilizable (1 commit).
3. **Sparkline** componente reutilizable (1 commit).
4. **Botones, Tabs, Pills** (1 commit).
5. **Inputs y forms** (1 commit) — bordes finos, foco con halo celeste, sin shadows.

### Fase 4 — Pantalla Dashboard (1–2 commits)
- Refactor del Dashboard a layout bento asimétrico.
- KPI grande ancla con el monto del día.
- 4 KPIs chicos con sparklines.
- Chart de 7 días debajo izquierda, últimos movimientos derecha.

### Fase 5 — Otras pantallas (4–6 commits, una por pantalla)
- Listado de Movimientos.
- Pantalla MP / conciliación.
- Detalle de movimiento (modal o página).
- Configuración / Locales.
- Reportes.
- Caja.

### Fase 6 — Estados especiales (1–2 commits)
- Empty states con copy amable y un ícono Tabler outline en `--pase-text-muted`.
- Loading: skeleton con `--pase-celeste-100` shimmer (sin gradiente, animación de opacidad simple).
- Errores: texto en `--pase-text`, sin rojos. Comunicar con copy, no con color.

### Fase 7 — Polish y dark mode (opcional, 2–3 commits)
- Dark mode con la misma paleta pero invertida (texto claro sobre fondo oscuro casi negro).
- Mobile responsive de cada pantalla.
- Detalles finos: focus rings, transiciones.

---

## 10. Convenciones de commits

Siguiendo el flow de Lucas (directo a main, sin PRs):

```
feat(design): add design tokens for new identity
feat(design): apply Inter typography globally
feat(sidebar): redesign with centered logo + new palette
feat(dashboard): rebuild as bento layout with anchor KPI
refactor(components): extract reusable Sparkline component
style(buttons): apply new palette to all button variants
```

Cada commit hace una sola cosa, push directo a main.

---

## 11. Smoke test checklist (Lucas hace al final)

Por pantalla revisar:
- [ ] Único celeste visible es #75AADB (chequear con color picker si hay duda).
- [ ] Dorado solo en logo y en el indicador "en vivo" del KPI principal.
- [ ] No hay gradientes, sombras profundas, ni colores fuera de la paleta.
- [ ] Tipografía Inter en TODAS las pantallas.
- [ ] No hay pesos 600+.
- [ ] Bordes finos 0.5px en cards e inputs.
- [ ] Logo `pase.` centrado en el sidebar, 26px.
- [ ] Números monetarios alineados (tabular-nums activo).
- [ ] Mobile: sidebar colapsa, bento se apila a 1 columna.
- [ ] Dark mode (si está implementado) usa la misma paleta invertida correctamente.

---

## 12. HTML de referencia (mockup aprobado)

El mockup que Lucas aprobó como referencia final está en este repo (o adjunto separado).
Estructura clave a respetar:
- Frame con titlebar simulado (los 3 dots + url).
- Sidebar 168px con logo centrado + nav.
- Main 20px padding con topbar + bento + row inferior.
- Anchor card con número 30px, footer interno, círculo decorativo bottom-right, dot dorado top-right.
- 4 KPIs chicos con sparklines.
- Chart de 7 barras con gama celeste ascendente.
- Lista de 4 movimientos con íconos cuadrados redondeados.

---

## 13. Notas para Claude Code

- **Stack**: React + TypeScript + Vite + Tailwind (verificar si usa Tailwind o CSS modules).
- **Si usa Tailwind**: extender el theme en `tailwind.config.ts` con los tokens. Crear utilities custom para los más usados.
- **Si usa CSS modules / styled-components**: importar `tokens.css` global y referenciar via `var(--pase-*)`.
- **No usar librerías nuevas**. Trabajar con lo que ya está en `package.json`.
- **Componentes reutilizables**: extraer `Card`, `CardAnchor`, `Sparkline`, `Bento`, `KpiTile` en `src/components/ui/`.
- **Iconos**: si todavía no está, instalar `@tabler/icons-react` o usar el webfont. Outline siempre.
- **Animaciones**: solo transitions sutiles (0.15s ease en hovers). Nada de Framer Motion para este sprint.
- **Accesibilidad**: el contraste de #75AADB blanco sobre celeste es 2.5:1. Para textos pequeños sobre el anchor usar opacity reducida que sume contraste percibido. Para texto crítico, fallback al texto en negro/blanco puro.

---

Fin del documento. Cualquier ambigüedad: priorizar el mockup HTML aprobado como verdad de campo.
