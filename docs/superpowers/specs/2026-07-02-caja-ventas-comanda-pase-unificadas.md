# Spec — Caja y ventas COMANDA ↔ PASE unificadas (detrás de flag)

**Fecha:** 2026-07-02 · **Autor:** Lucas + Claude · **Estado:** BORRADOR para revisión de Lucas
**Regla de oro:** se construye TODO **apagado por default** (feature flag por local).
Se prende recién cuando el local **migra de Maxirest a COMANDA** como fuente de ventas.
Prenderlo antes = **doble-conteo** (Maxirest + COMANDA cargando la misma venta).

---

## 1. Qué pidió Lucas (02-jul)
1. La **caja / caja chica de COMANDA** tiene que estar linkeada a la **caja de PASE**:
   todos los movimientos de caja de COMANDA (aperturas, ventas en efectivo, retiros,
   depósitos, ajustes, cobros) tienen que impactar la caja de PASE.
2. Las **ventas de COMANDA con TODAS las formas de pago** tienen que sumar a las
   `ventas` de PASE — las que hoy entran por el **cierre/import de Maxirest**.
3. Dejarlo **listo pero apagado** para el día de la migración de Maxirest.

## 2. Estado actual (lo que hay hoy)
- **PASE caja:** `movimientos` + `saldos_caja` (cuentas: Caja Efectivo, Banco, MP, etc.).
  Toda mutación pasa por RPCs atómicas (`crear_movimiento_caja`, `crear_gasto`, etc.).
- **PASE ventas / EERR:** `ventas` (base devengada). Hoy en Neko las ventas entran por
  **import de Maxirest** (`pase/src/lib/maxirest/parser.ts` → parsea el export → `ventas`).
- **COMANDA caja:** tablas PROPIAS `turnos_caja` + `movimientos_caja`, RPCs propias
  (`fn_abrir_turno_caja_comanda`, `fn_cerrar_turno_caja_comanda`, `fn_movimiento_caja_comanda`,
  `fn_cobrar_venta_comanda`, …). **Separada** de la caja de PASE.
- **COMANDA ventas:** `ventas_pos` + `ventas_pos_pagos`. Existe un **puente PARCIAL**
  (12-jun, [[project_pase_sprint_puente_ventas_12_jun]]): al cobrar se proyecta
  `ventas_pos → ventas`. ⚠️ **A VERIFICAR antes de construir:** si ese puente está ACTIVO
  hoy en los locales Neko (que además usan Maxirest), YA habría doble-conteo latente →
  hay que confirmar su estado real y, si está prendido, apagarlo/gate-arlo con el flag.

## 3. Riesgo central: doble-conteo
Para un mismo local, la **fuente de ventas** para el EERR tiene que ser **UNA**:
Maxirest **O** COMANDA, nunca las dos. El flag es lo que garantiza el corte limpio.
Mismo principio para la caja: si COMANDA empieza a impactar `saldos_caja` de PASE, el
efectivo de esas ventas NO puede además entrar por otra vía.

## 4. Feature flag (la pieza clave)
- Flag **por local** (no global): `comanda_fuente_de_verdad` (o `comanda_caja_pase_unificada`).
  Vive en `config`/`locales` o en el catálogo de features por tenant/local. **Default OFF.**
- **OFF (hoy):** COMANDA sigue con su caja propia; PASE toma ventas de Maxirest. Cero cambios.
- **ON (post-migración de un local):**
  - COMANDA proyecta caja + ventas a PASE.
  - El import de Maxirest para ESE local queda **bloqueado** (o se ignora en el parser)
    para no duplicar. → el parser debe chequear el flag por local y saltear los locales ON.
- Se prende **local por local** a medida que cada uno deja Maxirest.

## 5. Diseño

### 5.1 Ventas COMANDA → `ventas` de PASE (EERR)
- Al **cobrar** en COMANDA (`fn_cobrar_venta_comanda`), si el local está ON, insertar/
  proyectar la venta en `ventas` de PASE con **todas las formas de pago** desglosadas
  (efectivo, tarjeta, MP, transferencia, QR, delivery, etc.), fecha del hecho económico,
  local, y un `origen='comanda'` + `venta_pos_id` para idempotencia/trazabilidad.
- Anulaciones/refunds de COMANDA tienen que revertir la proyección (o insertar la
  contrapartida negativa) para que el EERR cuadre.
- **Idempotencia obligatoria:** una `ventas_pos` no puede proyectar dos veces (índice único
  por `venta_pos_id` en `ventas`).
- Mapeo de forma de pago COMANDA (`metodos_cobro`) → categoría/medio de PASE: **a definir**
  (tabla de mapeo o convención por slug). Es lo que hace que "todas las formas de pago sumen".

### 5.2 Caja COMANDA → caja de PASE (`movimientos` + `saldos_caja`)
- Cada movimiento de `movimientos_caja` de COMANDA (apertura de turno, venta efectivo,
  retiro, depósito, ajuste, cobro no-efectivo) genera el **movimiento equivalente** en PASE
  vía `crear_movimiento_caja` (o una RPC puente `fn_puente_caja_comanda_a_pase`), mapeando:
  - **Cuenta:** efectivo COMANDA → "Caja Efectivo" del local en PASE; no-efectivo (MP/banco)
    → la cuenta PASE correspondiente. **Mapeo cuenta↔cuenta a definir** (por local).
  - **Signo/tipo:** venta = ingreso; retiro = egreso; depósito = ingreso/transferencia; etc.
- Idempotencia por `movimiento_caja_id` (índice único en `movimientos`).
- **Decisión de producto pendiente (Lucas):** ¿la caja de COMANDA *es* la caja de PASE de
  ese local (una sola caja, COMANDA escribe directo), o son dos cajas espejadas que se
  concilian? Recomendado: **una sola caja por local** — COMANDA es el frontal, PASE el libro
  mayor; COMANDA escribe en `movimientos`/`saldos_caja` de PASE vía RPC puente. Evita
  reconciliación y descuadres.

### 5.3 Cierre de turno
- Al cerrar turno en COMANDA (`fn_cerrar_turno_caja_comanda`), si ON: el cierre se refleja
  en PASE (saldo esperado vs contado, diferencias). El "cierre ciego" ya existe en PASE
  ([[project-pase-sprint-mesa-modelo-12-jun]]) — reusar ese modelo.

## 6. Puntos a VERIFICAR antes de construir (bloqueantes del spec)
1. **¿El puente `ventas_pos → ventas` está activo HOY en los locales Neko?** Si sí, ¿ya
   está doble-contando con Maxirest, o esos locales no importan Maxirest? (Leer la versión
   vigente de `fn_cobrar_venta_comanda` y el estado del import Maxirest por local.)
2. **Mapeo de cuentas** COMANDA (medios_cobro / cuenta de caja) ↔ PASE (cuentas de `saldos_caja`
   + categorías de ingreso). Hace falta una tabla o convención por local.
3. **¿Una caja o dos?** (§5.2) — decisión de Lucas.
4. **Reversa de anulaciones/refunds** COMANDA → cómo revierte en `ventas` y `movimientos`.
5. **Formas de pago:** confirmar el set completo y a qué medio/categoría de PASE mapea cada una.

## 7. Plan de implementación (todo detrás del flag OFF)
1. **F0 — Flag + gate.** Crear el flag por local. Gate-ar el parser de Maxirest (saltea
   locales ON) y el puente de ventas (solo proyecta si ON). Sin comportamiento nuevo con OFF.
2. **F1 — Ventas → PASE.** RPC/puente idempotente `ventas_pos → ventas` (todas las formas de
   pago) + reversa de anulaciones. Test mutante (regla C2): cobrar en COMANDA con flag ON en
   `Local Prueba 2` → aparece 1 venta en `ventas`, sin duplicar; anular → se revierte.
3. **F2 — Caja → PASE.** Puente `movimientos_caja` → `movimientos`/`saldos_caja` con mapeo de
   cuentas + idempotencia. Test mutante: venta efectivo / retiro / depósito impactan la caja
   de PASE del local; sin OFF, no tocan nada.
4. **F3 — Cierre de turno** reflejado en PASE.
5. **F4 — Verificación E2E** en `Local Prueba 2` con flag ON: un turno completo
   (abrir → ventas varias formas de pago → retiro → cerrar) cuadra caja + EERR, y con Maxirest
   apagado para ese local no hay doble-conteo. Actualizar `tests/e2e-full`.

## 8. Reglas del proyecto que aplican
- Toda RPC nueva de plata: idempotencia (C1), test mutante (C2), `applyLocalScope`/RLS,
  error codes UPPER_SNAKE, SECURITY DEFINER con auth check (C11). Ver `CLAUDE.md`.
- COMANDA mantiene su paleta navy propia en el POS ([[feedback_comanda_paleta_separada]]).
- Nada de esto cambia comportamiento con el flag OFF → seguro de mergear apagado.
