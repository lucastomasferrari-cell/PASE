# Unificar los 3 wrappers `_offline` Tipo 1 (duplicadores) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, tarea por tarea.

**Goal:** Deuda estructural del Tier 2 (informe H4). De los 13 wrappers `_offline` de COMANDA, **10 son "delegadores" finos ya cuidados por el test de contrato #43** (resuelven UUID + llaman a la canónica) → fuera de alcance. Los **3 "duplicadores" Tipo 1 tienen DOS cuerpos completos** (online `fn_X_comanda` + offline `fn_X_comanda_offline`) que pueden divergir en silencio sin que el #43 lo cace. Este plan los UNIFICA: la canónica online gana `p_idempotency_uuid` (y resolución por UUID donde aplica) opcional + el dedup, y el `_offline` queda como **alias de una línea**. Un solo cuerpo = imposible divergir. Un **test de paridad** (online vs offline → mismo resultado) lo bloquea para siempre.

**Los 3 a unificar (inventario 13-jun):**
| Canónica online (vigente) | Wrapper offline (vigente) | Qué agrega el offline |
|---|---|---|
| `fn_abrir_venta_comanda` | `fn_abrir_venta_comanda_offline` (202605161400) | dedup por `idempotency_uuid` + guarda el uuid en `ventas_pos` |
| `fn_agregar_item_comanda` | `fn_agregar_item_comanda_offline` (202605161400) | dedup por `idempotency_uuid` + resuelve venta por uuid + guarda uuids en `ventas_pos_items` |
| `fn_mandar_curso_comanda` | `fn_mandar_curso_comanda_offline` (202605161400) | resuelve venta por uuid (no hace INSERT, hace UPDATE de items del curso) |

**Fuera de alcance (documentado):** los 10 delegadores (cobrar, anular venta/item, cortesía, precio, descuento, transferir/unir/partir, agregar_pago). Son finos, ya fixeados el 11-jun, y el #43 cuida que no llamen a inners inexistentes. Unificarlos es fase futura de bajo ROI.

**Arquitectura:** Para cada uno de los 3: (1) localizar la versión VIGENTE de la canónica online Y del wrapper offline; (2) **DIFFEAR los dos cuerpos** — confirmar que difieren SOLO en (a) dedup por idempotency_uuid, (b) guardar el uuid, (c) resolución de venta por uuid; si difieren en algo más (validación extra, asignación de turno, etc.) → NEEDS_CONTEXT antes de tocar; (3) reescribir la canónica = cuerpo online + params opcionales `p_idempotency_uuid` / `p_venta_idempotency_uuid` (trailing, DEFAULT NULL) + el dedup/resolución/storage condicionado a que vengan; (4) el `_offline` se reduce a `RETURN fn_X_comanda(..., p_idempotency_uuid := ...)`. Firma de la canónica: params nuevos al FINAL con DEFAULT → los callers online actuales no se rompen. El cliente NO se toca (sigue pegándole a `_offline` vía pushQueue; el alias forwardea). Online (flag off) pega a la canónica directo. Ambos comparten cuerpo.

**Reglas del repo:** money-logic en prod (cuidado), trampa-de-versiones ×5 este mes → SIEMPRE grep de la versión más alta + diff contra ella, C2 mutante (paridad), `REVOKE FROM PUBLIC, anon`, dry-run con ROLLBACK, e2e-full + offline mutantes verdes, push + deploy comanda READY.

---

### Task 1: Recon de diff — los 3 pares online vs offline (NO escribe SQL)

**Files:** ninguno (solo lectura + reporte)

- [ ] Para CADA uno de los 3 (`fn_abrir_venta_comanda`, `fn_agregar_item_comanda`, `fn_mandar_curso_comanda`):
  - Localizar la versión VIGENTE de la canónica online: `grep -rn "CREATE OR REPLACE FUNCTION (public\.)?fn_X_comanda\b" packages/pase/supabase/migrations/` (sin `_offline`), tomar el timestamp más alto. OJO `public.` schema-qualified.
  - El wrapper `_offline` vigente está en 202605161400 (verificar que no haya posterior).
  - **DIFF textual** de los dos cuerpos. Reportar: ¿difieren SOLO en idempotency_uuid (dedup + storage + resolución de venta)? ¿O hay OTRAS diferencias (validaciones, columnas seteadas, turno_caja, numero_local, auth checks, triggers)?
- [ ] Reportar las firmas EXACTAS de los 6 (3 canónicas + 3 wrappers) + el resultado del diff. **Si algún par difiere en algo más que idempotency → marcar ese caso como BLOQUEADO para unificar (se documenta y se deja con su wrapper) y seguir solo con los que son diff-limpio.**

(Esta tarea la hace el controlador leyendo, o un subagente Explore. Su salida define exactamente qué reescribir en Task 2.)

---

### Task 2: Migración — unificar los 3 (canónica + alias)

**Files:** Create `packages/pase/supabase/migrations/202606130700_unificar_wrappers_tipo1.sql`

Para cada uno de los 3 (solo los diff-limpio de Task 1):

- [ ] **Canónica online v2** = copia EXACTA de la vigente + estos cambios mínimos:
  - Agregar al final de la firma: `p_idempotency_uuid uuid DEFAULT NULL` (abrir venta) / `p_venta_idempotency_uuid uuid DEFAULT NULL, p_idempotency_uuid uuid DEFAULT NULL` (agregar item, mandar curso — necesitan resolver venta).
  - Al inicio del body: si viene `p_idempotency_uuid` → dedup (`SELECT id FROM ventas_pos[_items] WHERE idempotency_uuid = ... ; IF found RETURN`). Para agregar_item/mandar_curso: si `p_venta_id IS NULL` → `v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid)` y usar `v_venta_id` en vez de `p_venta_id` en todo el resto.
  - En el INSERT: agregar la columna `idempotency_uuid` (y `venta_idempotency_uuid` para items) con el valor del param (NULL si no vino — la columna es nullable UNIQUE, NULLs no colisionan).
  - Mantener TODO lo demás IDÉNTICO a la canónica vigente (auth, numero_local, recalc total, etc.).
  - REVOKE/GRANT igual que la canónica vigente.
- [ ] **Wrapper `_offline` v2** = alias de una línea (misma firma actual del wrapper para no romper pushQueue):
  ```sql
  CREATE OR REPLACE FUNCTION fn_abrir_venta_comanda_offline(<misma firma actual>)
  RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN
    RETURN fn_abrir_venta_comanda(
      p_local_id, p_canal_id, p_modo, p_mesa_id, p_mozo_id, p_cajero_id,
      p_cliente_id, p_covers, p_tab_nombre, p_idempotency_uuid  -- forwardea el uuid
      -- p_idempotency_key se ignora / o se pasa si la canónica lo toma
    );
  END; $$;
  ```
  (Adaptar args al orden real. El wrapper conserva su firma EXACTA actual — pushQueue le pasa esos params. Solo el CUERPO cambia a forwardeo. REVOKE FROM PUBLIC, anon + GRANT authenticated, service_role.)
- [ ] Para `fn_mandar_curso_comanda`: la canónica hace UPDATE de items por curso; el offline resuelve venta por uuid primero. Unificar = canónica acepta `p_venta_idempotency_uuid` y resuelve si `p_venta_id IS NULL`. El wrapper → alias.
- [ ] BEGIN/COMMIT, $$ balanceados. Commit `refactor(comanda): unificar 3 wrappers _offline Tipo1 — canonica acepta idempotency_uuid, wrapper=alias`.

---

### Task 3: Aplicar en prod (dry-run) + smoke

- [ ] env pull → script Write tool → DRY_RUN=1 (ROLLBACK) → aplicar.
- [ ] Smoke: las 3 canónicas tienen el param `p_idempotency_uuid` (`pg_get_function_arguments`); los 3 wrappers existen, anon NO en proacl, y su cuerpo ya NO tiene INSERT propio (solo el `RETURN fn_...`). Limpiar temporales.

---

### Task 4: Tests de paridad + regresión

- [ ] **Mutante de PARIDAD** nuevo `packages/pase/tests/wrappers_tipo1_paridad_mutante.spec.ts` (DB-only, Local Prueba 2): para abrir-venta y agregar-item, llamar la canónica directa (sin uuid) y el wrapper `_offline` (con uuid) con los MISMOS inputs y assertar que producen filas equivalentes (mismos campos salvo id/uuid/timestamps). Y dedup: 2 calls al `_offline` con mismo uuid → mismo id. Esto bloquea divergencia futura.
- [ ] **Regresión**: `offline_first_mutante.spec.ts` + `cobro_offline_mutante.spec.ts` (`--project=mutante`) → verdes (ejercitan abrir/agregar/mandar offline). Si fallan por el refactor → es bug de la unificación, arreglar la migración (no el test).
- [ ] **e2e-full COMPLETA** (`--project=e2e-full`) → verde (incluye #43 contrato + flujos POS). El #43 debe seguir verde (los wrappers existen y llegan a lógica de negocio).
- [ ] **comanda unit** (`pnpm --filter comanda test`) → verde (los services no cambiaron, pero por las dudas).
- [ ] Commit tests.

---

### Task 5: Cierre

- [ ] Push + deploy comanda + pase READY (la migración es de DB compartida; el deploy de pase también la “ve” aunque no cambie front).
- [ ] Memoria: 3 Tipo 1 unificados (un cuerpo, wrapper=alias, paridad testeada); los 10 delegadores quedan como fase futura (finos + #43); Fase 2 (cliente deja de agregar `_offline`, borrar wrappers) sigue pendiente y NO urgente.

---

## Self-review
- Alcance acotado al riesgo real (3 duplicadores de cuerpo completo), no a los 13. Los 10 delegadores quedan documentados como bajo-ROI + ya guardados por #43.
- Riesgo: toca abrir-venta/agregar-item (las ops más frecuentes). Mitigado: Task 1 DIFFEA antes de tocar (frena si hay diferencias no-idempotency → trampa de versiones), params nuevos son trailing-opcional (online no se rompe), wrapper conserva firma (pushQueue no se toca), mutante de paridad + offline mutantes + e2e-full.
- Si Task 1 revela que algún par difiere en algo más que idempotency, ese se SALTEA (se queda con su wrapper) y se documenta — no se fuerza la unificación.
- Cliente intacto (Fase 2 futura). pushQueue intacto.
