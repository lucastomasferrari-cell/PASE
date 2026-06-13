# Caja COMANDA Tier 2 — Cierre Ciego + Turno por Caja — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development o executing-plans, tarea por tarea.

**Goal:** Tier 2 ítems 6 del informe `docs/analisis-logica-2026-06/00-INFORME-EJECUTIVO.md`. **(a) Cierre de caja CIEGO por default** (hoy la UI muestra el esperado y AUTOCOMPLETA el declarado → el arqueo nunca detecta nada; Toast lo modela como permiso: quien no lo tiene cuenta a ciegas y ve la diferencia recién después de declarar). **(b) Turno por CAJA en vez de por local** (hoy `uniq_turno_abierto_per_local` impide dos cajas en paralelo). El ítem (c) reversos pendientes del informe YA está implementado (F1.7 `202605151720` + fix trigger 202606091510, mutante `reversos_pendientes_drain_mutante.spec.ts` verde) — verificado 12-jun, NO se toca.

**Hechos del relevamiento (12-jun):** `turnos_caja` con `UNIQUE(local_id) WHERE estado='abierto'`; cierre = `fn_cerrar_turno_caja_comanda` (202605051800:671-724, upgrade sprint 7 con idempotency+breakdown — ubicar VIGENTE) recibe `p_monto_final_declarado` y devuelve calculado+diferencia DESPUÉS de cerrar (eso ya es blind-friendly); el problema es 100% UI: `packages/comanda/src/pages/Caja/CajaCerrar.tsx:49` autocompleta `montoEfectivoDeclarado` con el esperado y línea ~62 lo muestra. Permisos: las RPCs chequean `comanda.caja.abrir/cerrar/movimientos` pero esos slugs NO están seedeados en `rol_pos_permisos` (202605151740: solo ventas.cobrar/anular; dueno='*'); frontend `usePermiso` (usePermiso.ts:96-111) = bypass dueño Supabase ∪ slugs del rol_pos (cache 1h). No existe entidad `cajas` (turno = local+cajero implícito). UI apertura `CajaAbrir.tsx` (monto inicial + notas). `fn_cobrar_venta_comanda` toma `turno_caja_id` DE LA VENTA (seteado al abrirla con "el turno abierto del local"). Servicio: `packages/comanda/src/services/turnosCajaService.ts` (+ su .test.ts).

---

## Parte A — Cierre ciego (sprint chico, primero)

### Task A1: Migración — permisos de caja seedeados + slug de "ver esperado"

**Files:** Create `packages/pase/supabase/migrations/202606130200_caja_permisos_cierre_ciego.sql`

- [ ] Localizar el seed vigente de `rol_pos_permisos` (202605151740 y posteriores — trampa de versiones). Escribir migración:

```sql
BEGIN;
-- Permisos de caja que las RPCs ya chequean pero nunca se seedearon,
-- + el permiso nuevo: VER el esperado al cerrar (sin él, cierre CIEGO).
INSERT INTO rol_pos_permisos (rol_pos, slug) VALUES
  ('cajero',    'comanda.caja.abrir'),
  ('cajero',    'comanda.caja.cerrar'),
  ('encargado', 'comanda.caja.abrir'),
  ('encargado', 'comanda.caja.cerrar'),
  ('encargado', 'comanda.caja.movimientos'),
  ('encargado', 'comanda.caja.ver_esperado_cierre'),
  ('manager',   'comanda.caja.abrir'),
  ('manager',   'comanda.caja.cerrar'),
  ('manager',   'comanda.caja.movimientos'),
  ('manager',   'comanda.caja.ver_esperado_cierre')
ON CONFLICT DO NOTHING;
-- dueno ya tiene '*'. El CAJERO no recibe ver_esperado_cierre: cuenta a ciegas.
COMMIT;
```
(Verificar el constraint/PK real de rol_pos_permisos para el ON CONFLICT; si el catálogo de slugs vive además en otra tabla `comanda_permisos_catalogo`, agregar el slug nuevo ahí con descripción.)

### Task A2: UI — CajaCerrar ciego por default

**Files:** `packages/comanda/src/pages/Caja/CajaCerrar.tsx`

- [ ] `const puedeVerEsperado = usePermiso('comanda.caja.ver_esperado_cierre')`.
- [ ] NO autocompletar nunca el declarado (eliminar el `setMontoEfectivoDeclarado(...)` de la línea ~49; input arranca vacío SIEMPRE, también para quien ve el esperado — declarar es contar).
- [ ] El bloque que muestra "esperado/calculado" y los totales por método ANTES de declarar: visible solo si `puedeVerEsperado`; si no, en su lugar un hint "Contá el efectivo físico y cargalo. La diferencia se calcula al cerrar."
- [ ] La pantalla post-cierre (la RPC devuelve calculado+diferencia) se muestra IGUAL para todos — el ciego es antes de declarar, no después (estándar Toast).
- [ ] Si el dialog tiene modo "denominaciones" (breakdown), aplica igual: sin precarga.
- [ ] `pnpm --filter comanda typecheck && pnpm --filter comanda lint && pnpm --filter comanda test` verdes (ajustar `turnosCajaService.test.ts` solo si mockea el autocompletado).

### Task A3: Aplicar migración (flow oficial dry-run) + test

- [ ] Aplicar 202606130200 (dry-run → apply; verificación: SELECT de rol_pos_permisos con los slugs nuevos).
- [ ] Test: extender `packages/comanda/tests/` con un mutante chico O asserts en el unit test del service: rol cajero NO incluye `ver_esperado_cierre`, manager SÍ (query directa a rol_pos_permisos). El comportamiento UI ciego se valida con typecheck+review (no hay infra de UI-test de COMANDA para esto — no inventar).
- [ ] Commit + push + deploy comanda READY.

---

## Parte B — Turno por caja (sprint estructural, segundo)

### Task B1: Migración — entidad `cajas` + turnos por caja

**Files:** Create `packages/pase/supabase/migrations/202606130300_turnos_por_caja.sql`

- [ ] Tabla `cajas (id SERIAL PK, tenant_id UUID NOT NULL, local_id INTEGER NOT NULL REFERENCES locales(id), nombre TEXT NOT NULL, activo BOOLEAN DEFAULT TRUE, orden INTEGER DEFAULT 0, created_at/updated_at, UNIQUE(local_id, nombre))` + RLS tenant+local (patrón estándar) + realtime publication si COMANDA la va a refrescar.
- [ ] **Seed**: una caja "Caja 1" por cada local existente con actividad de turnos (`SELECT DISTINCT local_id FROM turnos_caja` ∪ locales activos del tenant).
- [ ] `turnos_caja ADD COLUMN caja_id INTEGER REFERENCES cajas(id)`; backfill: turnos existentes → la "Caja 1" de su local; `SET NOT NULL` después del backfill.
- [ ] Reemplazar el unique: `DROP INDEX uniq_turno_abierto_per_local; CREATE UNIQUE INDEX uniq_turno_abierto_per_caja ON turnos_caja(caja_id) WHERE estado='abierto';`
- [ ] `fn_abrir_turno_caja_comanda` v2 (copiar VIGENTE — sprint 7 idempotency): + `p_caja_id INTEGER DEFAULT NULL`; si NULL → resolver la única caja activa del local (si hay >1 → error `CAJA_REQUERIDA`); validar caja∈local; el check "turno ya abierto" pasa a ser por caja. **Firma: agregar el param AL FINAL con DEFAULT** para no romper los callers/wrappers existentes.
- [ ] `fn_trg_drenar_reversos_al_abrir_turno` (F1.7): revisar que drene por LOCAL (los reversos son del local, cualquier caja que abra los absorbe — correcto; si filtra por otra cosa, ajustar).
- [ ] Ventas: al abrir venta, `turno_caja_id` se resuelve hoy como "el turno abierto del local" — con multi-caja pasa a ser "el turno de LA CAJA del dispositivo": buscar dónde se resuelve (fn_abrir_venta_comanda toma turno del local — verificar) y aceptar `p_turno_caja_id`/derivar de la caja seleccionada. Si la venta la abre un mozo sin caja (handheld), `turno_caja_id` puede ser NULL y se asigna AL COBRAR con la caja del cajero — verificar cómo lo hace `fn_cobrar_venta_comanda` y ajustar mínimo necesario.
- [ ] `fn_cron`/reportes que asuman un turno por local: grep `turnos_caja` en migraciones+frontend para detectar otros asumidores del unique viejo.

### Task B2: UI — selector de caja

- [ ] `CajaAbrir.tsx`: si el local tiene >1 caja activa, select "Caja" (persistir la elegida en localStorage del dispositivo como default); si tiene 1, invisible.
- [ ] Pantalla `/caja`: mostrar nombre de la caja del turno abierto; si hay varias abiertas, la del dispositivo.
- [ ] Settings COMANDA: CRUD mínimo de cajas (lista + alta + renombrar + desactivar) en la sección de local — patrón de SettingsMetodosCobro.
- [ ] PaymentDialog/cobro: sin cambios si el turno se resuelve server-side.

### Task B3: Tests + cierre

- [ ] Mutante `packages/comanda/tests/turnos_por_caja_mutante.spec.ts`: 2 cajas en Local Prueba 2 → abrir turno en ambas en paralelo (antes imposible) → cobrar una venta en cada una → cerrar ambas con montos distintos → asserts de movimientos/diferencias por turno correcto; reverso pendiente se drena al abrir cualquiera.
- [ ] Regresión: `reversos_pendientes_drain_mutante.spec.ts` + e2e-full COMPLETA (el spec 02 cobra con turno — debe seguir verde con la caja default).
- [ ] Push + deploys + memoria.

---

## Self-review
- (a) ataca exactamente el gap del informe (el esperado visible/autocompletado) con el modelo Toast (permiso); el backend ya era blind-friendly (devuelve diferencia post-cierre). Limitación conocida y aceptada: un cajero técnico podría consultar movimientos_caja por API (RLS se lo permite) — el ciego es de UI; endurecerlo a nivel RLS es post-piloto, documentar en memoria.
- (b) mantiene compat: param nuevo con DEFAULT, backfill de caja única por local, el unique nuevo es estrictamente más permisivo. El drenaje de reversos queda por local (cualquier caja absorbe).
- Riesgo principal de (b): puntos del código que asumen "el turno abierto del local" (singular) — el grep de Task B1 último punto es obligatorio antes de escribir.
