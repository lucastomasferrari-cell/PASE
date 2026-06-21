# EERR — Export "Presentación de cierre" (PDF + PPTX) — Design

> Estado: aprobado por Lucas (21-jun-2026). Próximo: writing-plans.

## Goal

Agregar al botón **Exportar** de la pantalla Reportes/EERR (`packages/pase/src/pages/EERR.tsx`) la generación de una **presentación de cierre mensual de 6 slides** del local + mes seleccionados, en dos formatos: **PDF terminado** y **PowerPoint editable (.pptx)**. Reemplaza el armado manual que Lucas hacía en Google Slides (referencia: `EERR NEKO BELGRANO ABRIL.pdf`).

**No-objetivos:** editar slides dentro de la app, mandar por mail, deck consolidado multi-local, charts de tendencia más allá de la comparación con el mes anterior.

## Contexto

- Hoy el botón "Exportar" baja: (a) **el CSV** (reemplazado el 20-jun por) (b) un **PDF de 1 hoja** (`src/lib/exportEERRPdf.ts`, estética PASE). Ese PDF de 1 hoja **se mantiene** como una opción más.
- El EERR ya computa en la pantalla casi todos los datos que necesita el cierre:
  - **Ingresos por forma de cobro:** `porMedio` (EERR.tsx ~382) = `ventas` agrupadas por `medio` + `pct()`.
  - **CMV:** `facturasCMV` / `totalCMV` (~344-346). El desglose **por categoría** sale de `facturasCMV` agrupando por `cat` (ya existe `CategoriaCMVChart`).
  - **Gastos por rubro:** `porCatFijos` (~406) + variables → agrupar `gastos` (fijo+variable) por `categoria`.
  - **Totales:** `sueldos`, `totalCargasSociales`, `totalBoletasSindicales`, `totalPublicidad`, `totalComisiones`, `totalImpuestos`, `utilBruta`, `utilNeta`, `totalVentas`.
  - **Mes anterior:** `cargarMesResumen(prevMes)` → `MesResumen` (totales/%; alcanza para los "(MARZO: X%)").
  - **Socios + %:** módulo Utilidades (`src/lib/utilidades.ts`, tabla socios con `porcentaje`/`activo`, por local).

## Las 6 slides

Estética: **identidad PASE** (celeste `#75AADB`, texto `#1A3A5E`, Inter, sobrio, sin gradientes) para fondos/títulos, **gráficos con paleta de colores legible** (no monocromo — 10 formas de cobro en un celeste no se distinguen). Slides **landscape 16:9**.

1. **Portada** — "EERR · [Local]" + "[Mes Año]". Fondo PASE con acento celeste (equivalente a la barra amarilla del original).
2. **Ingresos** — total del mes (grande) + "[Mes anterior]: $…" (comparación) + lista por forma de cobro (`porMedio`, monto + %) + **torta** de colores.
3. **Egresos · CMV** — "Costo de mercadería vendida (CMV): X%" + "([Mes ant.]: Y%)" + desglose por categoría (monto) + **dona** + "Utilidad bruta: Z%".
4. **Egresos · Gastos fijos y varios** — "GASTOS FIJOS Y VARIOS: X%" + "([Mes ant.]: Y%)" + desglose por rubro (monto) + **dona** + TOTAL.
5. **Egresos · resumen** — Marketing (`publicidad`), Personal (`sueldos+cargas+boletas`), Comisiones, Impuestos — cada uno con **% sobre ventas y $** + **Total de gastos** (`ventas − utilNeta`) + **Rentabilidad final** (`utilNeta`, margen `utilNeta/ventas`).
6. **División de ganancias** — Rentabilidad (`utilNeta`) + por cada socio activo: `utilNeta × porcentaje/100` (nombre + $). Nota editorial al pie (editable en PPTX; texto por defecto/configurable en PDF). Se **omite** si no hay socios activos o `utilNeta ≤ 0`.

Todos los % son sobre ventas brutas, salvo el reparto (sobre la rentabilidad).

## Arquitectura

Módulo nuevo `src/lib/cierre/`:

- **`cierreData.ts`** — `assembleCierre(input): CierreModel`. **Puro y testeable**: recibe los valores ya calculados del mes (los que la pantalla tiene), el `MesResumen` del mes anterior (o `null`), y la lista de socios; devuelve un `CierreModel` = `{ portada, ingresos, cmv, gastosFijos, resumen, division }` con todo formateado/derivado (incluye los datos de cada chart: `[{label, value, pct, color}]`). No hace I/O.
- **`cierreCharts.ts`** — helpers compartidos: paleta de colores (`CHART_COLORS`, ~12 tonos legibles anclados en celeste), generador de **SVG torta/dona** (para el PDF), formatos `$`/`%`, label de mes.
- **`cierrePdf.ts`** — `exportCierrePdf(model)`. Arma las 6 slides como HTML landscape (estética PASE + SVG charts de `cierreCharts`), renderiza cada una con **html2canvas** → página landscape en **jsPDF**. Import dinámico de jspdf+html2canvas (ya instaladas).
- **`cierrePptx.ts`** — `exportCierrePptx(model)`. Usa **PptxGenJS** (nueva dep, import dinámico): 6 slides con texto nativo + **charts nativos** (`pie`/`doughnut`) → PPTX editable de verdad. Mismo `CierreModel` como fuente.

`EERR.tsx`:
- El botón "Exportar" pasa a un **menú** de 3 opciones: *Resumen (1 hoja) · PDF* (el actual `exportEERRPdf`), *Presentación de cierre · PDF*, *Presentación de cierre · PowerPoint*. Seguir el patrón de UI existente (dropdown simple; si no hay componente, un toggle inline mínimo).
- Al elegir una "presentación": traer nombre del local (ya se hace), `cargarMesResumen(prevMes)` y los socios del local, armar `assembleCierre(...)`, y llamar al renderer elegido. Estado "Generando…".

### Flujo de datos
`EERR (valores del mes + prevResumen + socios)` → `assembleCierre` → `CierreModel` → (`exportCierrePdf` | `exportCierrePptx`) → descarga.

## Dependencias
- **Nueva:** `pptxgenjs` (browser, import dinámico → chunk aparte, solo se baja al exportar PPTX).
- **Existentes:** `jspdf`, `html2canvas` (ya agregadas para el PDF de 1 hoja).

## Paleta de gráficos
Anclada en PASE pero legible: celeste `#75AADB` + un set complementario sobrio (p.ej. teal `#3F8F9D`, slate `#5B6B85`, coral suave `#E0795F`, ámbar `#E3B23C`, verde `#5BA67A`, violeta apagado `#8B7BB0`, etc.). Definida en `cierreCharts.ts`. Asignación estable por orden de magnitud.

## Edge cases
- **Sin ventas (apertura):** % sobre ventas = "—"; ocultar torta de ingresos si no hay; no dividir por 0.
- **Sin mes anterior** (mes 1): omitir el "(Mes ant.: X%)".
- **Sin socios activos / utilidad ≤ 0:** omitir slide 6.
- **Muchas categorías:** agrupar el sobrante en "Otros" si supera ~10 segmentos (legibilidad de la torta), pero la lista de montos los muestra todos.
- **localActivo == null** (todos los locales): el deck usa "Todos los locales"; el reparto por socios se omite (no aplica consolidado).

## Testing
- **Unit** `cierreData.test.ts`: `assembleCierre` con datos reales de un mes — verifica totales, %s, comparación con mes anterior, split de socios, y los edge cases (ventas=0, sin socios, prevResumen=null). Es lógica de presentación: **sin mutante de plata** (no escribe DB).
- **Verificación visual:** render del PDF y del PPTX con datos de muestra (screenshot) antes de cerrar, como se hizo con el PDF de 1 hoja.

## Convenciones del repo aplicables
- Frontend puro, sin tocar RPCs ni DB (solo lecturas que el EERR ya hace + socios). Sin migraciones.
- Feature de presentación → **sin** test mutante ni cambios en e2e-full (se le avisa a Lucas; acordado para el PDF de 1 hoja también).
- Lint 0 warnings; push directo a main; verificar deploy READY.
