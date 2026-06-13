# Seed de catálogo para tenant nuevo + matar fallback Neko (Tier 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, tarea por tarea.

**Goal:** Tier 3 (informe 05-permisos-ajustes §2.2 / hallazgo "no hay defaults, hay datos de Neko"). Hoy un tenant nuevo arranca con `config_categorias`/`medios_cobro`/`rrhh_puestos` en CERO, y los hooks `useCategorias`/`useMediosCobro` caen a un fallback hardcodeado con las categorías REALES de Neko (EDESUR, SUSHIMAN PM, WOKI…) → el cliente nuevo ve en sus dropdowns categorías ajenas que no existen en su DB. "Día 1 roto/confuso". Fix: (1) sembrar un catálogo default GENÉRICO AR al crear el tenant (función `fn_seed_catalogo_tenant` llamada desde `crear_tenant_v2` + backfill de tenants existentes vacíos), y (2) que los hooks, cuando la DB devuelve 0 filas (tenant genuinamente vacío), muestren VACÍO — NO los datos de Neko.

**Template genérico AR (liviano, editable desde Ajustes):**
- **Gastos** (~22 en 7 familias por `tipo`/`grupo`): Fijos (Alquiler, Luz, Gas, Agua, Internet, Seguro, Mantenimiento, Otros fijos), Variables (Compras generales, Limpieza, Librería/insumos, Envíos, Reparaciones, Otros variables), Publicidad y MKT (Redes/Community, Pauta digital, Otras publicidades), Comisiones (Comisión MercadoPago, Comisión plataformas delivery, Comisiones bancarias, Otras comisiones), Impuestos (IVA, Ingresos Brutos, Retenciones, Otros impuestos), Retiros socios (Retiro socio), Juicios (Juicios y demandas, Honorarios legales).
- **Compras / CMV** (~9): Alimentos frescos, Bebidas, Vinos, Almacén, Packaging, Limpieza e higiene, Papelería, Equipamiento, Otros.
- **Ingresos** (~6): Liquidación delivery, Liquidación MercadoPago, Ingreso por evento, Ingreso socio, Devolución proveedor, Otro ingreso.
- **Medios de cobro** (~10, con slug/emoji/pide_vuelto/cuenta_destino): Efectivo (💵, pide_vuelto, cuenta 'Caja Chica'), Efectivo delivery (💵, pide_vuelto, 'Caja Chica'), Tarjeta débito (💳), Tarjeta crédito (💳), QR / billetera (📱), Transferencia (🏦), MercadoPago (📱), Link de pago (🔗), Delivery apps (🛵), Otros (•).
- **Puestos** (~8): Dueño, Encargado, Cocinero, Mozo, Cajero, Bachero/Limpieza, Barman, Cadete/Delivery.

(Nombres en Title Case legible, no MAYÚSCULA. Lucas puede renombrar/borrar/agregar desde Ajustes — son solo el punto de partida.)

**Arquitectura:** `fn_seed_catalogo_tenant(p_tenant_id uuid)` SECURITY DEFINER, idempotente (`NOT EXISTS` por nombre+tipo), inserta el template para ese tenant. `crear_tenant_v2` la llama tras crear el tenant (patrón verificado: restore_tenant trae catálogos del backup JSON, no conflicto). Backfill: correr la función para cada tenant existente que NO tenga categorías de gasto (→ vacío; **Neko se saltea porque ya tiene su catálogo real**). Hooks: distinguir "0 filas sin error" (tenant vacío → mostrar vacío/empty-state) de "error duro" (transitorio → fallback defensivo). El leak de Neko en el caso del bug (tenant nuevo/vacío) desaparece.

**Reglas:** C7 (multi-tenant — todas las tablas tienen tenant_id NOT NULL, el seed lo pasa explícito), `REVOKE FROM PUBLIC, anon` en la función nueva (GRANT a service_role; crear_tenant la invoca con service_role), dry-run con ROLLBACK, e2e-full misma PR, push + deploy READY.

**Hechos verificados (recon 13-jun):** `crear_tenant_v2` (vigente 202605102318) crea tenant+dueño+local+tenant_admins, NO siembra catálogos; GRANT solo service_role. `config_categorias(tipo, grupo, nombre, activo, orden, tenant_id NOT NULL)` — tipos: gasto_fijo/gasto_variable/gasto_publicidad/gasto_comision/gasto_impuesto/retiro_socio/gasto_juicios_demandas/cat_compra/cat_ingreso; grupos: Gastos Fijos/Gastos Variables/Publicidad y MKT/Comisiones/Impuestos/Retiros Socios/CMV/INGRESOS. `medios_cobro` unificada (tenant_id, slug NOT NULL, emoji, pide_vuelto, cuenta_destino, orden). `rrhh_puestos(nombre, activo, orden, tenant_id NOT NULL, UNIQUE(tenant_id,nombre))`. Patrón de seed por-tenant a copiar: `202605223700_seed_categoria_juicios.sql` (CROSS JOIN VALUES + NOT EXISTS). Fallback en `constants.ts` (GASTOS_FIJOS etc. = datos de Neko); hooks `useCategorias.ts:209-253` y `useMediosCobro.ts:112-172` caen al fallback en error O 0-rows. seed E2E (`seed-tenant.ts:318-331`) inserta 3 cats + 3 puestos + 3 medios a mano.

---

### Task 1: Migración — `fn_seed_catalogo_tenant` + wire en crear_tenant_v2 + backfill

**Files:** Create `packages/pase/supabase/migrations/202606130800_seed_catalogo_tenant.sql`

- [ ] **Step 0:** Confirmar firma vigente de `crear_tenant_v2` (grep, más alta) + el nombre EXACTO de la variable del tenant_id recién creado dentro de su body (para insertar el `PERFORM`). Confirmar los `grupo` exactos que espera el EERR (mirar `202605121500` y cómo agrupa el EERR) para que el seed use los grupos correctos.

- [ ] **Step 1:** Escribir la migración:
  - `fn_seed_catalogo_tenant(p_tenant_id uuid) RETURNS void` SECURITY DEFINER SET search_path=public. Body: 3 INSERT...SELECT con CROSS JOIN VALUES (categorias, medios, puestos) cada uno con `NOT EXISTS` por (tenant_id, nombre[, tipo]) para idempotencia. Categorías con `tipo` Y `grupo` correctos. Medios con slug (slugify del nombre), emoji, pide_vuelto, cuenta_destino. Puestos con orden.
  - `REVOKE ALL ON FUNCTION fn_seed_catalogo_tenant(uuid) FROM PUBLIC, anon; GRANT EXECUTE TO service_role, authenticated;` (authenticated por si se llama desde un endpoint con sesión dueño; el dedup lo hace seguro).
  - **Wire**: `CREATE OR REPLACE FUNCTION crear_tenant_v2(...)` = copia EXACTA de la vigente + `PERFORM fn_seed_catalogo_tenant(v_tenant_id);` justo antes del RETURN (con el nombre real de la var). Conservar firma/GRANT/auth EXACTOS.
  - **Backfill**: al final de la migración, `DO $$` que recorre `tenants WHERE activo` y `PERFORM fn_seed_catalogo_tenant(t.id)` SOLO si el tenant NO tiene ninguna fila `config_categorias` con `tipo='gasto_fijo'` (= vacío → Neko se saltea porque tiene las suyas). La idempotencia por nombre lo hace seguro igual.
  - BEGIN/COMMIT.

- [ ] **Step 2:** Commit `feat(tenant): seed de catalogo generico AR al crear tenant + backfill vacios (Tier3)`.

---

### Task 2: Aplicar en prod (dry-run) + verificación

- [ ] env pull → script Write tool → DRY_RUN=1 (ROLLBACK) → aplicar.
- [ ] Verificación: `SELECT t.nombre, COUNT(*) FILTER (WHERE c.tipo LIKE 'gasto%') gastos, COUNT(*) FILTER (WHERE c.tipo='cat_compra') compras, COUNT(*) FILTER (WHERE c.tipo='cat_ingreso') ingresos FROM tenants t LEFT JOIN config_categorias c ON c.tenant_id=t.id GROUP BY t.nombre` → Neko conserva sus 62 (NO duplicadas), los demás tenants tienen ~22/9/6. `medios_cobro` y `rrhh_puestos` por tenant ≥ template. Limpiar temporales.

---

### Task 3: Frontend — fallback no filtra Neko en tenant vacío

**Files:** Modify `packages/pase/src/lib/useCategorias.ts`, `packages/pase/src/lib/useMediosCobro.ts`

- [ ] En ambos hooks: separar el caso **`!error && data.length === 0`** (tenant genuinamente vacío) del caso **`error`** (transitorio).
  - 0 filas sin error → setear arrays VACÍOS con `source='db'` (NO fallback). El tenant no tiene catálogo (con el seed esto casi no pasa, pero si pasa, mostrar vacío es correcto — los dropdowns quedan vacíos y el empty-state de Ajustes invita a crear; NUNCA mostrar Neko).
  - error duro → mantener el fallback actual (defensivo; transitorio). Dejar el `console.warn` existente.
- [ ] Verificar que las pantallas que consumen estos hooks toleran arrays vacíos (Ajustes muestra empty-state, Gastos/Ventas muestran combo vacío + opción de crear). Si algún componente asume ≥1 elemento, ajustar mínimamente.
- [ ] `pnpm --filter pase typecheck && lint`. Commit `fix(catalogos): tenant vacio muestra catalogo vacio, no el fallback con datos de Neko`.

---

### Task 4: E2E + tests

- [ ] **seed-tenant.ts**: el tenant E2E ahora recibe el catálogo automático al crearse (crear_tenant_v2 lo siembra). Ajustar `seed-tenant.ts`: quitar (o dejar idempotente) los 3 inserts manuales de categorías/puestos/medios — si se dejan, no rompen (NOT EXISTS), pero lo limpio es confiar en el auto-seed y solo agregar lo que el test necesite específico. Verificar que los tests que dependían de "INSUMOS COCINA"/"ALQUILER"/"SUELDOS" sigan teniendo lo que necesitan (o ajustar a nombres del template).
- [ ] **Invariante/assert nuevo**: en algún spec de la suite (o uno nuevo `45-tenant-seed-catalogo.spec.ts`), assertar que el tenant E2E recién creado tiene el catálogo sembrado (≥15 gastos, ≥1 medio con cuenta_destino='Caja Chica', ≥1 puesto) y que NINGUNA categoría es de Neko (no hay 'EDESUR'/'SUSHIMAN PM').
- [ ] **Mutante** opcional `seed_catalogo_tenant_mutante.spec.ts`: llamar `fn_seed_catalogo_tenant` dos veces sobre el tenant E2E (idempotencia: no duplica) y assertar el set. Cleanup: no borrar el catálogo del tenant E2E (es del seed). Si es más limpio, omitir el mutante y confiar en el assert e2e.
- [ ] Correr e2e-full COMPLETA (`--project=e2e-full`) → verde. OJO: el cambio toca crear_tenant_v2 → el globalSetup crea el tenant E2E con él; verificar que el seed no rompe el setup (más filas, pero idempotente).
- [ ] Commit tests.

---

### Task 5: Cierre

- [ ] Push + deploy pase READY.
- [ ] Smoke sugerido a Lucas: crear un tenant de prueba (o mirar uno de los existentes que no sea Neko) → Ajustes muestra el catálogo genérico, no el de Neko.
- [ ] Memoria: seed de catálogo cerrado; template genérico AR (editable); fallback de Neko neutralizado para tenant vacío; PENDIENTE Tier 3 que queda (plantilla por tipo de negocio estilo Square "mostrador/salón/barra" = mejora futura; alta única de persona; checklist de onboarding en Inicio; constants.ts del fallback sigue con nombres de Neko para el caso de ERROR duro — documentado, bajo impacto).

---

## Self-review
- Cobertura: seed al crear tenant ✅, backfill de vacíos sin tocar Neko ✅, fallback no filtra Neko en tenant vacío ✅, e2e refleja el seed ✅, idempotente ✅.
- Riesgo: toca `crear_tenant_v2` (lo usa el endpoint serverless + el globalSetup E2E). Mitigado: copia exacta + un PERFORM, dry-run, e2e-full valida el setup. El backfill es idempotente y saltea Neko (guard por gasto_fijo).
- Decisión de producto (nombres del template): defaults genéricos editables; Lucas puede ajustarlos. NO se tocan los 62 de Neko.
- Fuera de alcance (documentado): plantilla por tipo de negocio (Square-style, 1 pregunta → defaults), alta única de persona, checklist onboarding, y hacer genérico el fallback de constants.ts para el caso de error duro (bajo impacto: solo afecta el flash transitorio en error para un tenant no-Neko).
