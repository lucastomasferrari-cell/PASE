# Accesos — Design System ("Cocina.OS Command Center")

> **North star:** Accesos debe verse **idéntico en lenguaje visual** al launcher `cocina.os`
> (fuente de verdad: `PASE/cocina/index.html`). Mismo tipo de líneas, letras, tamaños,
> márgenes, colores, forma de separar, títulos y subtítulos. Este archivo pinta esos tokens
> como **restricción dura** — NO inventar fuentes, colores ni estilos fuera de esta lista.

---

## 1. Product context

Accesos = panel del dueño para gestionar personas, roles, accesos a apps, PIN de POS y
auditoría del ecosistema gastronómico (Neko / Maneki / Rene). Es una SPA React de una sola
ruta que cambia de sección por estado. Público: dueño / admin (poder alto, uso técnico).
Tono: **consola de mando técnica** — preciso, oscuro, monoespaciado para etiquetas de sistema.

---

## 2. Fonts (ONLY these)

- **UI / titles / body:** `Inter`, system-ui, sans-serif — weights **400, 500, 600, 700**.
- **System labels / mono / código / timestamps / IDs:** `JetBrains Mono`, monospace — weights **400, 500**.
- Clase utilitaria `.mono` = `font-family: 'JetBrains Mono', monospace`.
- **Root font-size = 16px** (NO reducir a 14px — la referencia respira; el 14px actual apretaba todo).
- `antialiased` en el body.

Import exacto:
```
https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap
```

---

## 3. Color tokens (ONLY these — CSS vars de la referencia)

```css
--pase-celeste: #75AADB;  /* acento primario: links, hover, iconos, section headers, foco */
--pase-gold:    #F5C518;  /* RESTRINGIDO: dot "System Live", cursor terminal, punto del logo */
--bg-command:   #060912;  /* fondo raíz de la app */
--card-bg:      #0D1425;  /* paneles elevados: status bar, dropdowns, tarjetas */
--border-dim:   #162035;  /* hairlines / bordes sutiles */
--text-dim:     #94A3B8;  /* texto secundario (slate azulado) — subtítulos, meta, labels */
--text-bright:  #F8FAFC;  /* texto principal / títulos */
```

Semánticos adicionales (de la referencia):
- **Status "activo" (verde):** `#10b981` con glow `0 0 8px #10b981`, dot de **6px**.
- **Chip de categoría bg:** `rgba(15,23,42,0.5)` (slate-900/50).
- **Gradiente de hairline de sección:** `from #1e293b (slate-800) to transparent`.
- **Footer bg:** `#04060B`, borde `slate-900`.
- Grises slate para micro-separadores: `slate-800`, `slate-900`.

Reglas de uso:
- **Celeste = todo acento** (hover de fila, borde de fila activa, iconos, número de sección, foco).
- **Dorado = SÓLO** el dot "System Live", el cursor parpadeante del hero, y el punto del logo `accesos●`. Nada más.
- **Verde = SÓLO** el estado operativo de una fila/ítem (ACTIVE / ONLINE / SECURE / etc.).
- Texto: títulos en `--text-bright`, subtítulos y meta en `--text-dim`. Nunca gris apagado plano.

---

## 4. Signature effects (obligatorios — es lo que "copió mal" accesos)

### 4.1 Scanline overlay (CRT sutil, encima de todo)
```css
.scanline{
  position:fixed; inset:0; width:100%; height:100%; z-index:50; pointer-events:none;
  background:linear-gradient(to bottom, transparent 50%, rgba(6,9,18,0.07) 50%);
  background-size:100% 4px;
}
```
Un `<div class="scanline">` como primer hijo del body.

### 4.2 Blinking terminal cursor (dorado)
```css
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.cursor{
  display:inline-block; width:8px; height:18px; background:var(--pase-gold);
  animation:blink 1s step-end infinite; vertical-align:middle; margin-left:4px;
}
```

### 4.3 Glow dot dorado (System Live)
```css
.glow-dot{ box-shadow:0 0 10px var(--pase-gold), 0 0 4px var(--pase-gold); }
```
Dot de **8px** (`w-2 h-2`), redondo, dorado, con `.glow-dot` + `animate-pulse`.

### 4.4 Status bar (top strip)
```css
.status-bar{
  background:rgba(13,20,37,0.95);      /* card-bg translúcido */
  backdrop-filter:blur(12px);
  border-bottom:1px solid var(--border-dim);
}
```
`sticky top-0 z-40 px-6 py-3 flex items-center justify-between`.

### 4.5 System row (fila de lista — patrón central)
```css
.system-row{
  border-bottom:1px solid rgba(22,32,53,0.6);  /* border-dim @ 60% */
  transition:all .2s ease; background:transparent;
}
.system-row:hover{
  background:rgba(117,170,219,0.04);
  border-color:var(--pase-celeste);
  box-shadow:inset 0 0 20px rgba(117,170,219,0.02);
}
```

### 4.6 Icon box (contenedor de icono de fila)
```css
.icon-box{ background:rgba(117,170,219,0.08); color:var(--pase-celeste); }
```
`w-9 h-9 rounded border border-[celeste]/20 flex items-center justify-center`, icono `text-lg`.

### 4.7 Kbd hint (atajo de teclado)
```css
.kbd-hint{
  font-size:9px; padding:1px 4px; border-radius:3px;
  background:rgba(117,170,219,0.03); border:1px solid rgba(117,170,219,0.1);
  color:var(--text-dim);
}
```

---

## 5. Typography scale (tamaños EXACTOS de la referencia)

| Elemento | Clases |
|---|---|
| **Hero prompt prefix** | `.mono text-[celeste] opacity-70` → `root@accesos:~#` |
| **Hero logo** | `text-3xl font-bold tracking-tight` → `accesos` + `.` dorado + `os` (`text-dim font-light text-xl`) |
| **Hero boot log** | `.mono text-[10px] text-dim opacity-60`, en columna, con `border-l border-slate-800 pl-4`, líneas `> INIT_SEQUENCE: SUCCESSFUL` |
| **Section header** | `.mono text-[11px] font-semibold text-[celeste] tracking-[0.3em] uppercase` → `01 / Personas` |
| **Section hairline** | `h-[1px] flex-1 bg-gradient-to-r from-slate-800 to-transparent` (se desvanece a la derecha) |
| **Row title** | `text-base font-semibold`, hover → `text-[celeste]` |
| **Row sub-suffix (.SYS)** | `.mono text-[9px] text-dim opacity-50` (ej. `POS.SYS`, `AUTH.GATE`) |
| **Row description** | `text-xs text-dim truncate` |
| **Category chip** | `.mono text-[9px] tracking-tighter bg-slate-900/50 px-2 py-0.5 rounded` (ej. `SECURITY`) |
| **Status label** | `.mono text-[9px] text-dim` junto a dot verde 6px |
| **Status-bar labels** | `.mono text-[10px] tracking-[0.2em]` |
| **Clock** | `.mono text-[11px] font-medium` (`--text-bright`) |
| **Footer meta** | `.mono text-[10px] text-dim` |

---

## 6. Layout & spacing

- **Contenedor principal:** `max-w-[1000px] mx-auto px-6 pt-8 pb-12`. Columna centrada, no full-bleed.
- **Hero header:** `mb-10 pl-2`.
- **Sección:** `mb-16`; su header interno `mb-4`.
- **Fila:** `px-4 py-4 flex items-center gap-6`. Estructura horizontal:
  `[icon-box] · [title + .SYS  /  description] · [category chip · dot+status] · [kbd-hint · chevron]`
- Las columnas derechas (`chip`, `status`) van `hidden md:flex items-center gap-8`; el bloque final (`kbd-hint`, chevron) `flex items-center gap-4 ml-4`.
- **Chevron:** `lucide:chevron-right`, celeste `opacity-30` → hover `opacity-100 translate-x-1`.
- Radios: **chicos** (`rounded` = 4px en boxes, `rounded-[3px]` en kbd). Nada de tarjetas grandes redondeadas / bento.
- **Separar por líneas, no por cajas:** las secciones se delimitan con el hairline degradado del header y los `border-bottom` de cada fila. Sin fondos de tarjeta salvo el status bar / dropdowns (`--card-bg`).

---

## 7. Iconografía

- Lucide (via `iconify-icon` en la referencia; en accesos React usar `lucide-react`, mismos nombres).
- Iconos por sección: Personas → `users`, POS → `tablet`/`monitor`, Roles → `shield-check`, Marcas → `tags`, Actividad → `scroll-text`, Mi cuenta → `user`.
- Siempre dentro de `.icon-box` cuando encabezan una fila; celeste, `text-lg`.

---

## 8. Motion

- Cursor parpadeante 1s step-end (hero).
- `animate-pulse` en el dot dorado System Live.
- Hover de fila: transición `all .2s ease` (bg + border + glow + chevron slide).
- Reloj vivo tickeando cada segundo (mono).

---

## 9. Cómo aplicar a las pantallas reales de Accesos

Accesos NO es un launcher de una pantalla: tiene secciones con listas, fichas y formularios.
El lenguaje de arriba se aplica así:

- **Shell:** status bar top (System Live dorado · LATENCY/SYNC · OPERATOR · reloj) idéntica a la referencia.
- **Home / cabecera de sección:** hero terminal `root@accesos:~# accesos.os` con log de arranque, y por sección el header `01 / Personas` con hairline degradado.
- **Listas** (Personas, Roles, Marcas, dispositivos POS): cada ítem es una **system-row** con icon-box + título + `.SYS` suffix + descripción + chip de categoría + dot de estado + chevron.
- **Formularios / fichas** (alta/edición de persona, PIN): inputs con **underline hairline** (`border-b border-dim`, foco celeste), labels `.mono text-[10px] uppercase tracking-widest`, sin cajas rellenas.
- **Chips/pills:** rellenos sutiles `slate-900/50` redondeados (NO outline rectangular).
- **Foco accesible:** ring celeste.

---

## 10. NO hacer (errores del intento actual que Lucas rechazó)

- ❌ Dot **verde** en "System Live" (debe ser **dorado**).
- ❌ Sin hero de terminal ni scanline.
- ❌ Separadores de línea **sólida completa** (deben ser hairline **degradado** que se desvanece).
- ❌ Chips **outline rectangulares** (deben ser pills rellenos slate).
- ❌ Root a 14px apretando todo (usar 16px).
- ❌ Bordes/tonos apagados grises (usar slate azulado `#94A3B8` / bordes `#162035`).
- ❌ Inventar fuentes serif/decorativas, colores neón/violeta/rosa, o gradientes fuera de esta paleta.
