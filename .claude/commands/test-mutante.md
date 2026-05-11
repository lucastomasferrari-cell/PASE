---
description: Crear un test mutante nuevo siguiendo el patrón establecido
argument-hint: <flujo a testear>
---

# Test mutante: $ARGUMENTS

Vas a agregar un test mutante E2E para el flujo **$ARGUMENTS**. La regla del repo (CLAUDE.md, decisión 2026-05-09): **toda feature nueva o cambio de lógica de plata viene con test mutante**.

## Procedimiento (NO arranques a codear sin mi OK)

### 1. Buscá un test mutante existente similar

Los tests viven en `packages/pase/tests/*_mutante.spec.ts`. Hoy hay 6 (al 2026-05-10):
- `ventas_efectivo_mutante` — INSERT directo / efecto: saldo ↑
- `gastos_mutante` — RPC atómica `crear_gasto` / efecto: saldo ↓
- `facturas_cargar_mutante` — INSERT factura + trigger proveedor.saldo
- `facturas_pagar_mutante` — RPC `pagar_factura` / setup vía DB, act vía UI
- `sueldo_pagar_mutante` — RPC `pagar_sueldo` / novedad seed + UI
- `conciliacion_mp_egreso_mutante` — RPC `fn_conciliar_mp_con_gasto` / mp_movimiento sandbox

Elegí el más cercano al flujo nuevo y leelo entero antes de proponer plan.

### 2. Investigá el flujo a testear

- ¿Dónde vive el componente? (`packages/pase/src/pages/...`)
- ¿Qué RPC dispara el botón final? Leela en `packages/pase/supabase/migrations/` para entender qué tablas toca.
- ¿Hay reversa atómica (RPC tipo `anular_*`/`eliminar_*`) o el cleanup tiene que ser híbrido?
- ¿Necesita seed permanente (proveedor, empleado, saldos_caja, etc)? Si falta, fail loud con `INSERT` accionable en el mensaje de error.

### 3. Proponé plan en plain text — esperá mi aprobación

Cubrí estos puntos siguiendo la convención:

- **Setup**: usar `Local Prueba 2` (id=7) + `createDuenoClient` helper + sentinel **único entre tests** (mirá los sentinels usados en los 6 actuales para no chocar).
- **Act**: UI o INSERT directo según convenga. Si el setup vía UI es lento, usá INSERT directo (como `facturas_pagar`) y dejá la UI solo para la acción central (el botón que dispara el flujo).
- **Asserts DB-only, snapshot estricto** (`toBe`, no `toBeGreaterThanOrEqual`).
- **Cleanup en `afterEach` con cada paso en su propio try/catch**. Si la RPC oficial de reversa es atómica (ej. `eliminar_venta`), usá esa. Si no, híbrido: RPC parcial + delete directo.
- **Capturá IDs (movId, gastoId, etc) ANTES de los asserts**. Patrón aprendido en `sueldo_pagar`: si un assert falla, el cleanup todavía tiene los IDs para revertir saldo + borrar rows. Sin esto, un fallo deja leftover en prod.
- **Pre-checks ruidosos** con mensaje accionable (`INSERT INTO ...` listo para copiar) si falta seed.

### 4. Cuando apruebe el plan

1. Codeá el spec.
2. Corré aislado: `pnpm --filter pase exec playwright test <nombre>_mutante --project=mutante --workers=1`.
3. Si pasa, corré la suite completa: `pnpm --filter pase test:e2e` (smoke paralelo + mutante serial).
4. Verificá leftovers post-suite (query directa filtrando por sentinel) — los 6 tests anteriores tienen patrón establecido para esto.
5. Reportá delta. Anotá cualquier hallazgo no-obvio (bonus de presentismo, diferencia entre `anular_factura` y `anular_movimiento`, redondeos, casing como `'Activo'` vs `'activo'`, etc.).

## Recordá

- **Producción es el único entorno**. La DB Supabase la comparten PASE y COMANDA. Sentinels muy distintivos (decimales raros como `567890.13` o números improbables como `234567.89`) hacen trivial detectar leftover si algo se rompe.
- **Cero tolerancia a leftover** post-suite. Si el cleanup falla en una corrida, hacé limpieza manual ANTES de la siguiente.
- **El proyecto `mutante` corre con `--workers=1`** (serializado) porque los tests comparten recursos seed (`Proveedor Prueba`, `Empleado Prueba`, cuentas de `saldos_caja`). El proyecto `smoke` corre en paralelo.

Si en el camino encontrás algo más complicado de lo esperado (datos faltantes, RPCs mal documentadas, comportamiento inesperado), **frená y avisame** — no inventes hacks.
