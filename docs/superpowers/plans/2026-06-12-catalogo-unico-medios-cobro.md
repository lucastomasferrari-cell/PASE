# Catálogo Único de Medios de Cobro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tier 1 #3 del informe `docs/analisis-logica-2026-06/00-INFORME-EJECUTIVO.md`: UN solo catálogo de medios de cobro en la DB compartida. `medios_cobro` (PASE) absorbe a `metodos_cobro` (COMANDA) — gana columnas `tenant_id` (fix de bug multi-tenant real: hoy la tabla NO tiene tenant y todos los tenants comparten catálogo), `slug`, `emoji`, `pide_vuelto`, `deleted_at`. COMANDA pasa a leer/escribir `medios_cobro`; una VIEW `metodos_cobro` (security_invoker) mantiene compatibilidad con clientes ya deployados. El puente de ventas traduce slug→nombre al proyectar (el POS guarda slug "efectivo" en los pagos; el EERR agrupa por nombre "EFECTIVO").

**Architecture:** Migración de datos en 4 pasos: (1) columnas nuevas en `medios_cobro`; (2) backfill multi-tenant — filas locales heredan el tenant de su local, filas globales se CLONAN por tenant existente y se borran las originales sin tenant, `tenant_id SET NOT NULL`; (3) slug autogenerado desde nombre (slugify) + `pide_vuelto=true` para `efectivo%`; (4) merge de `metodos_cobro` por (tenant, scope, slug) — match copia emoji/pide_vuelto, no-match inserta fila nueva. UNIQUEs nuevos con tenant. RLS dual tenant-scoped (lectura tenant, escritura dueño/admin ∨ permiso PASE 'configuracion' ∨ permiso COMANDA 'comanda.config.editar'). Tabla vieja renombrada a `_metodos_cobro_legacy_20260612` (backup reversible) + VIEW updatable con el nombre viejo. `fn_proyectar_venta_pos` v2 traduce metodo→nombre del catálogo (y registra el detalle YA traducido para que el reverso apunte bien). `fn_crear_cierre_ventas` gana filtro por tenant en su lookup de `cuenta_destino` (con filas por-tenant, el lookup por nombre sin tenant puede cruzar catálogos). COMANDA: services apuntan a `medios_cobro` + se agrega el catálogo al cache offline (hoy NO se cachea → no se puede cobrar offline con lista de métodos).

**Tech Stack:** Postgres/Supabase (flow oficial dry-run→apply), React/TS en ambos paquetes, Playwright mutante + e2e-full.

**Reglas del repo:** C2/C7/C9, `REVOKE FROM PUBLIC, anon`, e2e-full misma PR, push + deploy READY (¡de los DOS paquetes: pase y comanda!).

**Hechos verificados (relevamiento 12-jun):** `medios_cobro` = `id serial, nombre, local_id, cuenta_destino, activo, orden, created_at, updated_at, UNIQUE(nombre, local_id)`, RLS select USING(true) + write `auth_tiene_permiso('configuracion')`, SIN tenant_id/slug/emoji/pide_vuelto/deleted_at, baja por `activo=false`. `metodos_cobro` = tenant_id NOT NULL, slug, emoji, pide_vuelto, deleted_at, UNIQUE(tenant, COALESCE(local,0), slug) WHERE deleted_at IS NULL, trigger fn_set_updated_at, RLS dual; seeds Neko: efectivo/tarjeta_debito/tarjeta_credito/mp_qr/transferencia/otros. COMANDA usa: `services/metodosCobroService.ts` (CRUD), `services/configService.ts` (listMetodosCobro/Activos), `components/dialogs/PaymentDialog.tsx` (slug+pide_vuelto+emoji; guarda SLUG en pagos), `pages/Settings/SettingsMetodosCobro.tsx` (admin). Offline: `lib/offlineCache.ts` (CacheKey union) y `lib/sync/pullInitial.ts` NO incluyen metodos_cobro. PASE no usa metodos_cobro en ningún lado. `fn_crear_cierre_ventas` (vigente en `202605121630`) lookupea `medios_cobro` por nombre+local SIN tenant. `fn_proyectar_venta_pos` está en `202606121200`. Las RPCs de cobro NO validan el metodo (texto libre).

---

### Task 1: Migración A — schema + backfill multi-tenant + merge + RLS + view legacy

**Files:**
- Create: `packages/pase/supabase/migrations/202606122000_medios_cobro_unificado.sql`

- [ ] **Step 1: Verificaciones previas (grep en migraciones, no DB)**
- Nombre real del constraint UNIQUE viejo: `grep -n "UNIQUE" packages/pase/supabase/migrations/20260424_medios_cobro_catalogo.sql` (si es inline sin nombre, Postgres lo llamó `medios_cobro_nombre_local_id_key` — el DROP CONSTRAINT IF EXISTS de abajo cubre ambos casos, verificar nombre con `\d` no es posible → usar IF EXISTS).
- `comanda_auth_tiene_permiso` existe y es callable desde RLS: `grep -ln "comanda_auth_tiene_permiso" packages/pase/supabase/migrations/*.sql` (existe desde el sprint 24-may).
- `fn_set_updated_at` existe (la usa metodos_cobro).
- `tenants` tiene columna para filtrar borrados (`deleted_at`?) — si existe, el CROSS JOIN del backfill debe excluirlos.

- [ ] **Step 2: Escribir la migración** (todo en `BEGIN; ... COMMIT;`):

```sql
-- ============================================================
-- 202606122000_medios_cobro_unificado.sql
-- Tier 1 #3: UN catálogo de medios de cobro para PASE+COMANDA.
-- medios_cobro absorbe a metodos_cobro y gana tenant_id (fix de
-- bug multi-tenant real: la tabla era compartida entre tenants).
-- metodos_cobro queda como VIEW de compatibilidad (clientes
-- COMANDA ya deployados); la tabla vieja se conserva renombrada.
-- ============================================================

BEGIN;

-- 1) Columnas nuevas ---------------------------------------------------------
ALTER TABLE medios_cobro
  ADD COLUMN IF NOT EXISTS tenant_id  UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS slug       TEXT,
  ADD COLUMN IF NOT EXISTS emoji      TEXT,
  ADD COLUMN IF NOT EXISTS pide_vuelto BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 2) Backfill multi-tenant ---------------------------------------------------
-- 2a. Filas con local: heredan el tenant del local.
UPDATE medios_cobro mc SET tenant_id = l.tenant_id
  FROM locales l WHERE mc.local_id = l.id AND mc.tenant_id IS NULL;

-- 2b. Filas globales (local NULL, sin tenant): clonar una copia POR TENANT
--     existente (cada tenant pasa a tener su propio catálogo).
INSERT INTO medios_cobro (tenant_id, local_id, nombre, cuenta_destino, activo, orden, pide_vuelto)
SELECT t.id, NULL, g.nombre, g.cuenta_destino, g.activo, g.orden, FALSE
  FROM medios_cobro g
 CROSS JOIN tenants t
 WHERE g.tenant_id IS NULL AND g.local_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM medios_cobro x
      WHERE x.tenant_id = t.id AND x.local_id IS NULL
        AND upper(x.nombre) = upper(g.nombre)
   );
-- (si `tenants` tiene deleted_at/estado, agregar el filtro acá — ver Step 1)

-- 2c. Borrar las originales sin tenant (ya clonadas) y endurecer.
DELETE FROM medios_cobro WHERE tenant_id IS NULL;
ALTER TABLE medios_cobro ALTER COLUMN tenant_id SET NOT NULL;

-- 3) Slug + pide_vuelto ------------------------------------------------------
UPDATE medios_cobro
   SET slug = btrim(regexp_replace(lower(translate(nombre,
              'ÁÉÍÓÚÜáéíóúüÑñ', 'AEIOUUaeiouuNn')), '[^a-z0-9]+', '_', 'g'), '_')
 WHERE slug IS NULL;
-- colisiones de slug dentro del mismo (tenant, scope): sufijo con id
UPDATE medios_cobro mc SET slug = mc.slug || '_' || mc.id
 WHERE EXISTS (
   SELECT 1 FROM medios_cobro x
    WHERE x.tenant_id = mc.tenant_id
      AND COALESCE(x.local_id, 0) = COALESCE(mc.local_id, 0)
      AND x.slug = mc.slug AND x.id < mc.id
 );
ALTER TABLE medios_cobro ALTER COLUMN slug SET NOT NULL;
UPDATE medios_cobro SET pide_vuelto = TRUE WHERE slug LIKE 'efectivo%';

-- 4) Merge de metodos_cobro (COMANDA) ---------------------------------------
-- 4a. Match por (tenant, scope, slug): copiar emoji + pide_vuelto.
UPDATE medios_cobro mc
   SET emoji = COALESCE(mc.emoji, m.emoji),
       pide_vuelto = mc.pide_vuelto OR m.pide_vuelto
  FROM metodos_cobro m
 WHERE m.deleted_at IS NULL
   AND mc.tenant_id = m.tenant_id
   AND COALESCE(mc.local_id, 0) = COALESCE(m.local_id, 0)
   AND mc.slug = m.slug;

-- 4b. Los que no matchean ni por slug ni por nombre: insertar (orden 100+ para
--     que queden después de los de PASE; sin cuenta_destino — lo setea el dueño).
INSERT INTO medios_cobro (tenant_id, local_id, nombre, slug, emoji, pide_vuelto, activo, orden, cuenta_destino)
SELECT m.tenant_id, m.local_id, m.nombre, m.slug, m.emoji, m.pide_vuelto, m.activo, 100 + m.orden, NULL
  FROM metodos_cobro m
 WHERE m.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM medios_cobro mc
      WHERE mc.tenant_id = m.tenant_id
        AND COALESCE(mc.local_id, 0) = COALESCE(m.local_id, 0)
        AND (mc.slug = m.slug OR upper(mc.nombre) = upper(m.nombre))
   );

-- 5) Uniques nuevos (con tenant) + limpieza del viejo ------------------------
ALTER TABLE medios_cobro DROP CONSTRAINT IF EXISTS medios_cobro_nombre_local_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_medios_cobro_nombre
  ON medios_cobro (tenant_id, COALESCE(local_id, 0), upper(nombre))
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_medios_cobro_slug
  ON medios_cobro (tenant_id, COALESCE(local_id, 0), slug)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_medios_cobro_tenant ON medios_cobro (tenant_id, activo) WHERE deleted_at IS NULL;

-- 6) updated_at trigger (metodos_cobro lo tenía, medios_cobro no) ------------
DROP TRIGGER IF EXISTS trg_medios_cobro_set_updated_at ON medios_cobro;
CREATE TRIGGER trg_medios_cobro_set_updated_at BEFORE UPDATE ON medios_cobro
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- 7) RLS tenant-scoped (reemplaza el select USING(true)) ---------------------
DROP POLICY IF EXISTS "mc_select" ON medios_cobro;
DROP POLICY IF EXISTS "mc_write" ON medios_cobro;
CREATE POLICY mc_select ON medios_cobro FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      auth_es_superadmin() OR tenant_id = auth_tenant_id()
    )
  );
CREATE POLICY mc_write ON medios_cobro FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND (
        auth_es_dueno_o_admin()
        OR auth_tiene_permiso('configuracion')
        OR comanda_auth_tiene_permiso('comanda.config.editar')
      )
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND (
        auth_es_dueno_o_admin()
        OR auth_tiene_permiso('configuracion')
        OR comanda_auth_tiene_permiso('comanda.config.editar')
      )
    )
  );

-- 8) metodos_cobro → legacy + VIEW de compatibilidad --------------------------
-- Clientes COMANDA ya deployados siguen consultando "metodos_cobro" hasta que
-- refresquen el bundle — la view los mantiene vivos sin downtime.
ALTER TABLE metodos_cobro RENAME TO _metodos_cobro_legacy_20260612;
REVOKE ALL ON _metodos_cobro_legacy_20260612 FROM authenticated, anon, PUBLIC;

CREATE VIEW metodos_cobro
WITH (security_invoker = true) AS
SELECT id, tenant_id, local_id, created_at, updated_at, deleted_at,
       nombre, slug, emoji, pide_vuelto, activo, orden
  FROM medios_cobro;
GRANT SELECT, INSERT, UPDATE ON metodos_cobro TO authenticated;

COMMIT;
```

Notas para el implementador: (a) si el Step 1 muestra que `tenants` tiene `deleted_at` o `estado`, agregar el filtro en el CROSS JOIN de 2b; (b) la view es auto-updatable (una sola tabla base, sin agregados) → los INSERT/UPDATE del service viejo pasan al base con RLS del caller (security_invoker); (c) el trigger viejo `trg_metodos_cobro_set_updated_at` viaja con el RENAME — déjalo en la legacy (inofensivo).

- [ ] **Step 3: Commit** — `feat(medios): catalogo unico medios_cobro multi-tenant absorbe metodos_cobro (Tier1 #3)`

---

### Task 2: Migración B — traducción slug→nombre en el puente + tenant en cierre de ventas

**Files:**
- Create: `packages/pase/supabase/migrations/202606122010_medios_unificado_funciones.sql`
- Read first: `202606121200_puente_ventas_comanda.sql` (fn_proyectar_venta_pos actual — copiar ÍNTEGRA como base) y la versión VIGENTE de `fn_crear_cierre_ventas` (`grep -ln "crear_cierre_ventas" packages/pase/supabase/migrations/*.sql`, tomar timestamp más alto, ojo schema-qualified `public.`).

- [ ] **Step 1: `fn_proyectar_venta_pos` v2.** Copiar la función entera de 202606121200 y cambiar SOLO el loop de pagos: antes del upsert, traducir el metodo crudo al NOMBRE del catálogo del tenant:

```sql
-- dentro del LOOP, antes del INSERT:
SELECT mc.nombre INTO v_medio_nombre
  FROM medios_cobro mc
 WHERE mc.tenant_id = v_venta.tenant_id
   AND (mc.local_id IS NULL OR mc.local_id = v_venta.local_id)
   AND mc.deleted_at IS NULL
   AND (mc.slug = v_pago.metodo OR upper(mc.nombre) = upper(v_pago.metodo))
 ORDER BY mc.local_id NULLS LAST
 LIMIT 1;
v_medio_final := COALESCE(v_medio_nombre, v_pago.metodo);
```

y usar `v_medio_final` tanto en el INSERT/UPSERT de `ventas` como en el `detalle` JSONB (así el reverso descuenta contra el nombre correcto). Declarar `v_medio_nombre TEXT; v_medio_final TEXT;` y resetear `v_medio_nombre := NULL;` al inicio de cada vuelta. Dos slugs que traducen al mismo nombre no son problema: el upsert acumula sobre la misma fila y el detalle lleva dos entries con el mismo medio (el reverso resta ambas).

- [ ] **Step 2: `fn_crear_cierre_ventas` v2.** Copiar ÍNTEGRA la versión vigente y modificar SOLO el lookup de `cuenta_destino` sobre `medios_cobro`: agregar el filtro de tenant (derivar `v_tenant` con `SELECT tenant_id FROM locales WHERE id = p_local_id` al inicio si la función no lo tiene ya) + `AND deleted_at IS NULL`. Sin esto, con catálogos por-tenant el lookup por nombre puede agarrar la fila de OTRO tenant (la función es SECURITY DEFINER).

- [ ] **Step 3:** REVOKE/GRANT de ambas (mismas firmas), BEGIN/COMMIT, commit: `feat(medios): puente traduce slug->nombre + cierre de ventas filtra por tenant`.

---

### Task 3: Aplicar en producción

- [ ] Mismo flow de siempre: `vercel env pull` → script con DRY_RUN=1 (neutralizar BEGIN/COMMIT, transacción propia + ROLLBACK) sobre LAS DOS migraciones en orden → si verde, aplicar. Escribir el script con el Write tool (el hook de PowerShell rompe con here-strings que contienen regex).
- [ ] Verificaciones post-apply (en el mismo script): `SELECT tenant_id IS NOT NULL AS ok, COUNT(*) FROM medios_cobro GROUP BY 1` (todo true); `SELECT COUNT(*) FROM medios_cobro WHERE slug IS NULL` (0); conteo por tenant (`SELECT t.nombre, COUNT(*) FROM medios_cobro mc JOIN tenants t ON t.id=mc.tenant_id GROUP BY 1` — cada tenant ≥16); `SELECT COUNT(*) FROM metodos_cobro` (la view responde); `SELECT relkind FROM pg_class WHERE relname='metodos_cobro'` (= 'v').
- [ ] Borrar script + .env.local.tmp.

---

### Task 4: COMANDA — services a `medios_cobro` + cache offline

**Files:**
- Modify: `packages/comanda/src/services/metodosCobroService.ts`, `packages/comanda/src/services/configService.ts` (cambiar `.from("metodos_cobro")` → `.from("medios_cobro")`; los nombres de columnas son idénticos, agregar `.is("deleted_at", null)` donde la RLS de la view ya no filtra — la tabla base SÍ filtra por RLS, pero explícito es mejor).
- Modify: `packages/comanda/src/lib/offlineCache.ts` — agregar `'medios_cobro'` al union `CacheKey`.
- Modify: `packages/comanda/src/lib/sync/pullInitial.ts` — agregar `pullMediosCobro(ctx)` al `Promise.all` (copiar el patrón exacto de `pullCanales`: select de columnas que usa PaymentDialog — id, nombre, slug, emoji, pide_vuelto, activo, orden, local_id — y guardar en cache).
- Verificar: `PaymentDialog.tsx` — si lista métodos vía `listMetodosCobroActivos`, ¿tiene rama offline que deba leer del cache nuevo? Si el dialog hoy simplemente falla sin red, conectar la lectura del cache es deseable pero NO obligatorio en este sprint si excede el patrón existente — en ese caso documentarlo como pendiente en el reporte (no inventar arquitectura nueva).
- [ ] `pnpm --filter comanda typecheck` + `pnpm --filter comanda lint` + `pnpm --filter comanda test` → verdes (los tests unit de comanda que mockeen metodos_cobro pueden necesitar rename).
- [ ] Commit: `feat(comanda): medios de cobro desde el catalogo unico medios_cobro + cache offline`.

---

### Task 5: Tests

- [ ] **Mutante nuevo** `packages/pase/tests/medios_cobro_unificado_mutante.spec.ts` (DB-only, patrón createDuenoClient):
  1. **Aislamiento**: el dueño (tenant Neko) lee `medios_cobro` → todas las filas son de su tenant (consultar 2-3 filas y validar tenant_id); la view `metodos_cobro` responde las mismas filas (mismo count).
  2. **Traducción del puente**: crear venta_pos en Local Prueba 2 y cobrarla con `fn_cobrar_venta_comanda` pasando metodo = **slug** `'efectivo'` (sentinel 3333.33) → assert: la fila proyectada en `ventas` tiene `medio = 'EFECTIVO'` (el NOMBRE del catálogo, no el slug). Anular → reverso limpia (valida que el detalle guardó el nombre traducido). Reusar la mecánica del mutante del puente (`puente_ventas_comanda_mutante.spec.ts`).
  3. **Metodo desconocido**: cobrar otra venta con metodo `'metodo_inexistente_xyz'` → proyecta con ese texto crudo (fallback sin romper). Anular y limpiar.
  4. Cleanup estándar.
- [ ] **Regresión**: correr `puente_ventas_comanda_mutante.spec.ts` (usaba metodo 'EFECTIVO' por nombre — la traducción por upper(nombre) lo mantiene igual → debe seguir verde) y `ventas_efectivo_mutante.spec.ts` (carga manual + Ajustes intactos). Comando: `npx playwright test --project=mutante --workers=1 tests/<spec>`.
- [ ] **e2e-full COMPLETA**: `npx playwright test --project=e2e-full --workers=1` → verde. Ojo: el tenant E2E recibió su clon del catálogo en el backfill; si algún spec asume catálogo global compartido, ajustar a la semántica nueva (documentar).
- [ ] Commit tests.

---

### Task 6: Cierre

- [ ] Push + verificar deploy READY de **pase** y de **comanda** (son proyectos Vercel separados).
- [ ] Smoke sugerido a Lucas: COMANDA → Settings → Métodos de cobro (debe listar el catálogo unificado: los 6 de COMANDA + los 16 de PASE mergeados) y PASE → Ajustes → Medios de cobro (ídem, con los nuevos de COMANDA al final).
- [ ] Memoria: archivo nuevo del sprint + MEMORY.md. Incluir: el bug multi-tenant que se cerró, la view legacy (borrable cuando todos los clientes refresquen), `_metodos_cobro_legacy_20260612` como backup, pendiente Tier 3 (seed de catálogo en crear_tenant — tenant nuevo hoy queda con catálogo vacío), pendiente menor (rama offline del PaymentDialog si no se conectó).

---

## Self-review

- **Cobertura**: una sola tabla compartida (pedido explícito de Lucas) ✅; bug tenant_id cerrado ✅; slug/emoji/pide_vuelto preservados para el POS ✅; cuenta_destino preservado para PASE ✅; clientes deployados no se rompen (view) ✅; puente traduce slug→nombre (el "EFECTIVO" del POS y el del EERR son la misma cosa) ✅; lookup de cierre de ventas tenant-safe ✅; offline cache del catálogo ✅; C2 mutante + e2e-full ✅.
- **Riesgos**: (1) el RENAME de metodos_cobro + CREATE VIEW es el paso más delicado — si algo griteara, la legacy conserva TODO el dato (reversible: drop view + rename back); (2) RLS de medios_cobro pasa de USING(true) a tenant-scoped — `useMediosCobro` de PASE no filtra por tenant pero la RLS ahora lo hace por él (comportamiento correcto); el FALLBACK hardcodeado de constants.ts sigue siendo deuda Tier 3; (3) tenant nuevo queda sin catálogo hasta el seed de Tier 3 — documentado.
- **Tipos**: columnas de la view = exactamente las que consumen los services de COMANDA; slug NOT NULL post-backfill; uniques parciales con COALESCE(local_id,0) replican el patrón probado de metodos_cobro.
