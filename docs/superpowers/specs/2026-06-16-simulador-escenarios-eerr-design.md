# Spec — Simulador de escenarios en Reportes (EERR) · PASE

**Fecha:** 2026-06-16
**Autor:** Lucas + Claude
**Estado:** Diseño para revisión

> Primera de dos features pedidas por Lucas. La segunda — **Cierre / bloqueo de mes** (marcar un mes cerrado y bloquear ediciones + altas con fecha en ese mes) — es un sub-proyecto aparte, con su propia spec/plan, a hacer DESPUÉS de este. La "foto congelada" de un mes la dará ese bloqueo; este simulador es solo análisis en vivo.

---

## 1. Objetivo

Dar al dueño un **what-if sobre la rentabilidad** dentro de **Reportes**: parado en el Estado de Resultados de un mes (en curso o anterior), tocar las líneas del EERR y ver al instante cómo cambia la **Utilidad Neta y el margen**. Sirve para simular escenarios ("¿y si bajo el CMV?", "¿y si subo ventas?", "¿y si recorto un gasto fijo?") sin tocar ningún dato real.

---

## 2. Decisiones tomadas (brainstorm 16-jun)

- **Dónde:** dentro de **Reportes (EERR)**, ahí mismo. Un modo "Simular" sobre el reporte que ya se muestra.
- **Qué mes:** el que elijas — **mes en curso o cualquier mes anterior** (el mismo selector de período de Reportes).
- **Nivel:** las **líneas del Estado de Resultados** (no por categoría/ítem ni por "palancas").
- **Edición:** cada línea es un **monto en $ independiente**; se puede sobrescribir el $ o aplicar un **ajuste en %**. Las líneas **no se escalan entre sí**: si subís Ventas y no tocás el CMV, el CMV en $ queda igual y su **% sobre ventas baja solo** (el margen sube). Es la decisión explícita de Lucas.
- **Persistencia:** **ninguna**. Es en vivo; no se guardan escenarios ni foto. (La estabilidad/foto de meses pasados la da el futuro bloqueo de mes.)
- **Solo lectura:** no escribe en la DB. No mueve plata.

---

## 3. Las líneas del EERR (base de la simulación)

Son las que ya calcula `EERR.tsx` hoy (`filasPyL` / `MesResumen`), en este orden:

| Línea | key | tipo | editable |
|---|---|---|---|
| Ventas Brutas | `ventas` | ingreso | ✅ |
| Compras de mercadería (CMV) | `cmv` | costo | ✅ |
| **Utilidad Bruta** | `utilBruta` | subtotal | — (calculada) |
| Gastos Fijos | `gastosFijos` | costo | ✅ |
| Gastos Variables | `gastosVar` | costo | ✅ |
| Sueldos | `sueldos` | costo | ✅ |
| Cargas Sociales | `cargasSociales` | costo | ✅ |
| Publicidad y MKT | `publicidad` | costo | ✅ |
| Comisiones | `comisiones` | costo | ✅ |
| Impuestos | `impuestos` | costo | ✅ |
| Otros Gastos | `otrosGastos` | costo | ✅ |
| **Utilidad Neta** | `utilNeta` | subtotal | — (calculada) |

Reglas de cálculo (idénticas al EERR actual):
- `utilBruta = ventas − cmv`
- `utilNeta = utilBruta − (gastosFijos + gastosVar + sueldos + cargasSociales + publicidad + comisiones + impuestos + otrosGastos)`
- `% de cada línea = línea / ventas` (recalculado contra las **ventas simuladas**)
- `margen neto = utilNeta / ventas`

---

## 4. Arquitectura

**Todo en el frontend. Sin migración, sin RPC, sin tabla.**

- **`src/lib/eerrSimulador.ts`** (nuevo) — función pura testeable:
  - Tipo `LineasEERR` = los 10 montos editables (las keys de arriba sin los subtotales).
  - Tipo `AjusteLinea` = `{ tipo: "abs"; valor: number }` (nuevo $) o `{ tipo: "pct"; valor: number }` (ajuste %, ej. −10).
  - `simularEERR(base: LineasEERR, ajustes: Partial<Record<keyof LineasEERR, AjusteLinea>>) → ResultadoEERR` donde `ResultadoEERR` trae las líneas resultantes + `utilBruta`, `utilNeta`, `margenNeto`, y el `delta` de utilNeta vs base.
  - Es la única pieza con lógica → lleva **test unitario** (`eerrSimulador.test.ts`).
- **UI en Reportes** — una sección/modo "Simular" que:
  - Reusa los valores base que `EERR.tsx` ya computa para el mes/local seleccionado (no se recalcula nada nuevo del backend).
  - Botón/toggle **"Simular"**: prende el modo; las líneas pasan a editables.
  - Por línea: input con el $ base + opción de ajuste en % (ej. campo o steppers). Subtotales y % se recalculan en vivo llamando a `simularEERR`.
  - Vista **Real vs Simulado** lado a lado + **delta de Utilidad Neta** resaltado (verde/rojo).
  - **"Reset"** vuelve todo al real; salir de "Simular" deja el reporte normal.
  - Respeta el **local activo** y el período igual que Reportes hoy.
- `EERR.tsx` es grande (~44KB): la sección del simulador va en un componente propio (ej. `src/pages/reportes/SimuladorEERR.tsx`) que recibe la base por props, para no engordar el archivo.

---

## 5. UX (resumen)

1. Reportes muestra el EERR del mes/local elegido (como hoy).
2. Aparece un botón **"Simular escenario"**.
3. Al activarlo: las 10 líneas editables muestran su valor base y permiten cambiarlo ($ directo o ajuste %). Los subtotales y porcentajes se actualizan al instante.
4. Arriba/al costado: **Utilidad Neta Real vs Simulada** + diferencia + margen real vs simulado.
5. **Reset** y **Salir** disponibles. Nada se guarda.

---

## 6. Fuera de alcance (a propósito)

- **Persistencia de escenarios o foto** → no. La foto/estabilidad la da el futuro **Cierre/bloqueo de mes**.
- **Auto-escalado de costos variables** con las ventas → no (líneas independientes, decisión de Lucas).
- **Simulación por categoría/ítem/empleado** → no (es a nivel línea de EERR). El simulador de CMV/precios por ítem ya existe aparte en Rentabilidad.
- **Bloqueo de edición / cierre de período** → sub-proyecto siguiente.

---

## 7. Testing

- **Unitario obligatorio:** `eerrSimulador.test.ts` cubre `simularEERR` — ajuste por $ y por %, recálculo de utilBruta/utilNeta/margen, el caso "subo ventas sin tocar CMV → margen sube / CMV% baja", líneas a 0, y delta correcto.
- **NO** lleva test mutante ni e2e-full de plata: la regla C2/e2e-full es para RPCs que mueven plata; esto es solo lectura/análisis en el frontend (no hay DB). Se documenta el motivo del skip (acordado con Lucas).
- Typecheck + lint + build verdes antes de cerrar.

---

## 8. Reglas del repo aplicables

- Lazy/route no cambia (vive dentro de Reportes, que ya está ruteada).
- Sin `local_id` nuevo en queries (no hay queries nuevas; reusa la base ya computada).
- Comunicación de cambios a Lucas antes de mergear; push directo a `main`.

---

## 9. Criterio de éxito (MVP)

Parado en Reportes sobre un mes (en curso o anterior), el dueño toca "Simular", cambia una o varias líneas del EERR (en $ o %), y ve **al instante** la Utilidad Neta y el margen simulados vs los reales, con la diferencia clara — sin que se altere ningún dato real ni quede nada guardado.
