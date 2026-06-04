# RRHH — Liquidación final con control manual + Recibos de sueldo imprimibles

**Fecha:** 2026-06-04
**Autor:** Lucas (dirigiendo) + Claude
**Estado:** Diseño aprobado en chat (incl. mockup del recibo aprobado vía companion visual). Pendiente review del spec.

## Resumen
Dos cosas pedidas por Lucas:
1. **Liquidación final con control manual** — mejora sobre lo que YA existe: poder elegir
   con/sin preaviso e indemnización 1x o 2x (doble indemnización).
2. **Recibos de sueldo imprimibles** (NUEVO) — generar una hoja A4 prolija para imprimir,
   firmar y archivar, con el desglose completo del sueldo, cómo se pagó (efectivo/MP), a qué
   mes corresponde, datos del empleado y del negocio. Para sueldo mensual y liquidación final.

## Lo que YA existe (no se reescribe)
- `calcularLiquidacionFinal` (rrhh.ts): proporcional mes, vacaciones no gozadas, SAC
  proporcional, indemnización (sueldo × años), preaviso (15 días o 1 sueldo según antigüedad),
  integración mes. Con motivos: Renuncia / Despido sin causa / Despido con causa / Acuerdo mutuo.
- UI Liquidación Final en RRHHLegajo.tsx (modal con desglose) + RPC `liquidacion_final_empleado`
  (recibe `p_total` calculado en el front, genera + paga). Aguinaldo/vacaciones: `pagar_aguinaldo`,
  `pagar_vacaciones`.
- Datos del empleado en `rrhh_empleados`: nombre, apellido, **cuil**, puesto, fecha_inicio,
  modo_pago, sueldo_mensual. `rrhh_empleados.id` es **UUID**.
- Liquidación pagada en `rrhh_liquidaciones`: sueldo_base, total_horas_extras, monto_presentismo,
  descuento_ausencias, total_dobles, total_feriados, total_vacaciones, adelantos,
  otros_descuentos, total_a_pagar, pagos_realizados, cuota_num, cuotas_total, novedad_id.
- Pago real (split efectivo/MP) en `movimientos` con `liquidacion_id` (cuenta + importe).
- PASE **NO** tiene datos fiscales del negocio (razón social, CUIT, dirección) — solo el nombre
  del local. Hay que agregar un settings.

## Decisiones (Lucas, 04-jun)
- Liquidación: **control manual** (con/sin preaviso, indemnización 1x/2x).
- Recibo: **vista de impresión** (HTML + `@media print`, Ctrl+P / "Guardar como PDF"), no librería PDF.
- Recibo: **individual + "todos los del mes"** (tanda, un recibo por hoja).
- Alcance v1: **sueldo mensual + liquidación final** (aguinaldo/vacaciones después).
- Estilo recibo: **informal + firma** (mockup aprobado), no formato legal Ley 20.744.

---

## Parte 1 — Liquidación final con control manual

### Cálculo (`src/lib/calculos/rrhh.ts`)
- `calcularLiquidacionFinal` gana 2 params opcionales:
  - `incluir_preaviso?: boolean` (default según motivo: true para despido sin causa).
  - `indemnizacion_mult?: 1 | 2` (default 1).
- Efecto: `preaviso = incluir_preaviso ? <calculado> : 0`; `indemnizacion = <calculado> * indemnizacion_mult`.
  Solo aplican cuando hay indemnización/preaviso (despido sin causa). No tocan los otros conceptos.

### UI (`src/pages/RRHHLegajo.tsx`, modal liquidación final)
- Cuando motivo = "Despido sin causa": mostrar **checkbox "Con preaviso"** (default ✓) +
  **selector "Indemnización: 1x / 2x"**. Re-calcular el desglose en vivo con esos valores.
- El total recalculado se pasa a `liquidacion_final_empleado` como hoy (`p_total`). **Sin cambio
  de RPC** (ya recibe el total del front).

### Tests
- Unit `rrhh.test.ts`: liquidación con `incluir_preaviso:false` (preaviso=0) y `indemnizacion_mult:2`
  (indemnización ×2), total correcto.
- Mutante `liquidacion_final_*`: pagar liquidación final con sin-preaviso + 2x → movimiento/total
  reflejan el monto manual (reusar patrón de `liquidacion_final_mutante.spec.ts` existente).

---

## Parte 2 — Recibos de sueldo imprimibles

### A) Datos del negocio (settings)
- Nueva tabla `rrhh_recibo_config` (por local): `local_id INT PK`, `razon_social TEXT`,
  `cuit TEXT`, `direccion TEXT`, `tenant_id`, `created_at`, `updated_at`. RLS estándar por local.
- RPC `upsert_recibo_config(p_local_id, p_razon_social, p_cuit, p_direccion)` (auth rrhh) — o
  escritura directa con RLS (tabla de config, no ledger financiero → permitido). **Decisión:**
  upsert directo desde el cliente con RLS (más simple; no es tabla financiera).
- UI: un botón/modal "Datos del negocio (recibos)" en la pestaña Sueldos base (o Sueldos) para
  cargar los 3 campos. Fallback en el recibo: si vacío, usa el nombre del local.

### B) Modelo del recibo (`src/lib/recibos.ts`)
- `construirReciboSueldo({ liquidacion, movimientos, empleado, negocio, mes, anio })`:
  función pura que arma el modelo del recibo: lista de conceptos (label + monto + signo),
  total, split de pago por medio (efectivo / Mercado Pago / otros, derivado de movimientos por
  cuenta), período, datos empleado + negocio, total en letras.
- `numeroALetras(n)`: helper español (entero de pesos) para la línea "recibí conforme la suma de
  $X (… pesos)". Testeable.

### C) Componente de recibo (`src/components/recibos/ReciboSueldo.tsx`)
- Renderiza UN recibo con el layout aprobado (encabezado negocio + período, datos empleado,
  desglose haberes/descuentos, forma de pago efectivo/MP, pie de firma). Estilos pensados para
  impresión A4.

### D) Vista de impresión (`src/components/recibos/PrintRecibos.tsx`)
- Overlay/route que renderiza 1..N `ReciboSueldo` con `page-break-after: always` entre ellos +
  un stylesheet `@media print` que oculta todo menos los recibos. Botón "Imprimir" → `window.print()`.
- Recibe una lista de recibos ya construidos.

### E) Triggers
- **TabSueldos** (sueldo mensual):
  - En la card de una cuota **pagada**: botón "🖨 Recibo" → construye el recibo de esa liquidación
    (lee movimientos por `liquidacion_id`) y abre la vista de impresión.
  - Toolbar: "Imprimir todos los del mes" → todas las liquidaciones **pagadas** del mes/local →
    tanda de recibos.
- **RRHHLegajo** (liquidación final): tras pagar (o sobre una liq final existente), botón
  "🖨 Recibo" → recibo de liquidación final (desglose de conceptos finales + forma de pago).

### Datos / fuentes (sin ambigüedad)
- Desglose mensual: campos de `rrhh_liquidaciones`. Split de pago: `movimientos` con
  `liquidacion_id` (agrupar por `cuenta`: efectivo vs MP/transferencia vs otros por heurística de
  nombre, igual que TabSueldos pre-llena el pago).
- Mes/año: de la `rrhh_novedades` ligada (mes, anio) o del período de la liquidación.
- Empleado: `rrhh_empleados`. Negocio: `rrhh_recibo_config` (fallback nombre local).

### Tests
- Unit: `numeroALetras` (varios casos) + `construirReciboSueldo` (desglose + split correcto desde
  liquidación + movimientos de ejemplo).
- Render/smoke: `ReciboSueldo` renderiza con data de ejemplo sin error. (Recibos = solo lectura,
  no mueven plata → sin mutante de plata.)
- E2E full: opcional, un chequeo liviano de que el botón "Recibo" aparece en una liq pagada.

## Cumplimiento reglas Capa 1
- C1/C2/C4: la parte de plata (liquidación final) ya usa RPC atómica + tendrá mutante. Recibos
  son lectura. `rrhh_recibo_config` no es tabla financiera (escritura directa OK).
- C3 applyLocalScope en queries con local_id. C7 tabla nueva con tenant_id/created_at/RLS dual.
- C8: componentes nuevos, no rutas nuevas en App.tsx (se montan dentro de RRHH) → sin cambio App.tsx.

## Fuera de alcance (v1)
- Recibo de aguinaldo / vacaciones (segunda tanda).
- Formato legal Ley 20.744 (aportes, contribuciones, doble ejemplar).
- Firma digital / envío por mail/WhatsApp del recibo (hoy es imprimir + firmar físico).
- Logo del negocio en el recibo (se puede sumar después; v1 solo texto).
