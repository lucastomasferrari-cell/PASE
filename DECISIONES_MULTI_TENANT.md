# DECISIONES — Multi-tenant en PASE (TASK 0.15)

**Fecha:** 2026-04-28
**Branch:** main
**Status original:** Diseño completo. Esperando OK de Lucas para arrancar Etapa 1.

---

## ⚠ ESTADO REAL al 2026-05-11

El plan se ejecutó. Las migraciones 202604281200-202604281209 implementaron
el grueso del multi-tenant (tenant_id en todas las tablas + RLS dual +
auth_tenant_id() + función auth_es_superadmin()). El 2026-05-10/11 se
completó el onboarding via wizard + endpoint serverless.

### Estado de las 10 decisiones de la sección 9

| # | Decisión | Estado | Detalle |
|---|---|---|---|
| 1 | Slug tenant Neko | ✅ resuelto | `neko` en `tenants.slug` |
| 2 | Email superadmin | ✅ resuelto | `lucastomasferrari@gmail.com` |
| 3 | Catálogos per-tenant | ✅ implementado | tenant_id en proveedores, insumos, recetas, config_categorias, medios_cobro, rrhh_valores_doble |
| 4 | Etapa 3 doble policy | ✅ swap completo | RLS dual `tenant_id = auth_tenant_id() AND <scope local>` activo |
| 5 | Storage migration | ⏸ deuda controlada | 37 archivos legacy sin prefix UUID — policy dual-mode los cubre. Migration UUID-prefix pendiente para Sprint B (COMANDA pre-launch) |
| 6 | Roles permitidos | ✅ resuelto | superadmin/dueno/admin/encargado/compras/cajero |
| 7 | Plan en tenants | ✅ resuelto | columna `plan` con 'trial'/'basic'/'pro' (sin billing real aún) |
| 8 | Onboarding wizard | ✅ implementado | `OnboardingTenant.tsx` + endpoint `/api/crear-tenant` (refactor 2026-05-11 commit 7f53947 — la RPC vieja `crear_tenant` tenía bug `digest()` por search_path) |
| 9 | `tenant_admins` vs `usuarios.rol` | ✅ coexisten | Ambas tablas, RPC `crear_tenant_v2` inserta en las dos. RLS usa `usuarios.tenant_id` |
| 10 | Branch separado vs main | ✅ resuelto | Todo fue directo a main (workflow estándar) |

### Pendientes verdaderos al 2026-05-11

- **Smoke test manual del wizard** end-to-end por Lucas (crear tenant de prueba, loguear como dueño nuevo, verificar aislamiento contra Neko).
- **`SUPERADMIN_PASSWORD`** seteado en `packages/pase/.env.local` para destrabar el test mutante automático `onboarding_tenant_mutante.spec.ts`.
- **Storage migration a UUID-prefix paths** — diferido a Sprint B (no urgente, cubierto por policy dual-mode).
- **Activación de Leaked Password Protection** en Supabase — requiere SMTP configurado primero (deuda del Sprint A original, no del MVP).

El resto del documento queda como artefacto histórico del diseño.

---

## 0. Resumen ejecutivo

Convertir PASE de single-tenant (Neko) a multi-tenant por empresa. Cada cliente futuro
es un **tenant** con sus propios locales, usuarios, ventas, catálogos, todo. Lucas pasa
a tener un rol nuevo **SUPERADMIN** que está afuera de cualquier tenant y puede crear/operar
tenants ajenos para soporte.

- **No reset de data:** la data actual de Lucas se etiqueta `tenant_id = <uuid Neko>` y queda intacta.
- **Catálogos por tenant** (no globales): `config_categorias`, `medios_cobro`, `proveedores`, `insumos`, `recetas`, `rrhh_valores_doble`. Cada cliente personaliza los suyos.
- **RLS dual:** todas las policies se reescriben con filtro `tenant_id = auth_tenant_id()` agregado al filtro `local_id` existente. Superadmin bypassa.
- **Roles:** `superadmin` (nuevo, fuera de tenants), `dueno` / `admin` (dentro del tenant), `encargado` / `compras` / `cajero` (existentes, dentro del tenant).
- **Plan:** 8 etapas. Etapa 1 sienta foundation (schema sin romper RLS), etapa 2 rewrite RLS, etapas 3-7 propagan a RPCs/API/UI/storage, etapa 8 tests + cleanup.

---

## 1. Inventario del estado actual (PASO 1)

### 1.1 Tablas que necesitan `tenant_id` (35 totales)

#### Tablas raíz con `local_id` (14) — filter dual `tenant_id + local_id`

| Tabla | Fuente del `local_id` |
|---|---|
| `locales` | propia (`id`) |
| `ventas` | directa |
| `gastos` | directa |
| `facturas` | directa |
| `movimientos` | directa |
| `remitos` | directa |
| `saldos_caja` | directa |
| `caja_efectivo` | directa |
| `mp_credenciales` | directa (1 por local) |
| `mp_movimientos` | directa |
| `rrhh_empleados` | directa |
| `empleados` (legacy, 0 rows) | directa |
| `blindaje_documentos` | directa |
| `medios_cobro` | directa (NULL = global del tenant) |

#### Tablas catálogo / master (sin local_id, hoy globales) (5) — filter `tenant_id` solo

| Tabla | Notas |
|---|---|
| `proveedores` | hoy global; pasa a per-tenant. Cada tenant tiene su lista. |
| `insumos` | hoy global; pasa a per-tenant. |
| `recetas` | hoy global; pasa a per-tenant. |
| `config_categorias` | hoy global; pasa a per-tenant. |
| `rrhh_valores_doble` | hoy global; pasa a per-tenant. |
| `blindaje_tipos_documento` | hoy global; pasa a per-tenant. |

#### Tablas de auth (3) — filter `tenant_id`

| Tabla | Notas |
|---|---|
| `usuarios` | superadmin tendrá `tenant_id IS NULL`; el resto pertenece a un tenant. |
| `usuario_locales` | hereda via `usuario_id` pero agregar `tenant_id` explícito para RLS simple. |
| `usuario_permisos` | idem. |

#### Tablas hijas (heredan via parent.id) (6+) — agregar `tenant_id` explícito

| Tabla | Parent |
|---|---|
| `factura_items` | `facturas` |
| `factura_items_stock` | `facturas` |
| `receta_items` | `recetas` |
| `remito_items` | `remitos` |
| `mp_liquidaciones` | `mp_credenciales` |
| `rrhh_novedades` | `rrhh_empleados` |
| `rrhh_liquidaciones` | `rrhh_novedades` |
| `rrhh_documentos` | `rrhh_empleados` |
| `rrhh_historial_sueldos` | `rrhh_empleados` |
| `rrhh_pagos_especiales` | `rrhh_empleados` |
| `rrhh_adelantos` | `rrhh_empleados` |
| `empleado_archivos` | `empleados` (legacy) |

**Decisión sobre tablas hijas:** agregar `tenant_id` directo (no inferir vía parent). Razones: (1) RLS más simple (un solo filtro vs EXISTS subquery), (2) defensive — si el parent rompe la integridad, el child sigue protegido, (3) rendimiento (índice directo).

#### Tablas misc (1)

| Tabla | Decisión |
|---|---|
| `auditoria` | agregar columna `tenant_id` explícita (hoy va embebido en el blob jsonb del campo `detalle`). Permite RLS y queries del superadmin por tenant. |

### 1.2 RLS policies actuales

**Total policies en la DB hoy:** ~50 (en ~30 tablas).

**3 patrones canónicos identificados** (reescribir todos):

#### Patrón A — Scope macro por local

```sql
USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
```

Aplicado a: `movimientos`, `ventas`, `gastos`, `facturas`, `remitos`, `saldos_caja`, `caja_efectivo`, `mp_movimientos`, `empleados`, `rrhh_empleados`, `blindaje_documentos`, `mp_liquidaciones`.

**Reescrito a:**
```sql
USING (
  auth_es_superadmin() OR
  (tenant_id = auth_tenant_id() AND
   (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))
)
```

#### Patrón B — Scope vía parent (EXISTS)

Aplicado a: `factura_items`, `factura_items_stock`, `remito_items`, `receta_items`, `rrhh_novedades`, `rrhh_liquidaciones`, `rrhh_historial_sueldos`, `rrhh_documentos`, `rrhh_pagos_especiales`, `rrhh_adelantos`, `empleado_archivos`, `mp_liquidaciones`.

**Reescrito a:** filtro directo por `tenant_id` (porque ahora cada child tiene su columna):
```sql
USING (
  auth_es_superadmin() OR
  (tenant_id = auth_tenant_id() AND
   EXISTS (SELECT 1 FROM <parent> WHERE <parent>.id = <child>.<parent_id>
           AND (auth_es_dueno_o_admin() OR <parent>.local_id = ANY(auth_locales_visibles()))))
)
```

#### Patrón C — Master data con permiso granular

```sql
USING (auth_tiene_permiso('<modulo>'))
```

Aplicado a: `proveedores`, `insumos`, `recetas`, `receta_items`, `config_categorias`, `rrhh_valores_doble`, `medios_cobro`, `usuarios` (select_perm), `usuario_permisos` (select_perm), `usuario_locales` (select_perm).

**Reescrito a:**
```sql
USING (
  auth_es_superadmin() OR
  (tenant_id = auth_tenant_id() AND auth_tiene_permiso('<modulo>'))
)
```

#### Especiales

- `usuarios_select`: `auth_id = auth.uid() OR auth_es_dueno_o_admin()` — agregar superadmin OR + tenant filter.
- `usuarios_self_update`: `auth_id = auth.uid()` — sin cambio (cada uno actualiza su propia fila).
- `locales_read`: `USING (true)` — cerrar a `tenant_id = auth_tenant_id() OR auth_es_superadmin()`.
- `mc_select`: `USING (true)` — cerrar a `tenant_id = auth_tenant_id() OR auth_es_superadmin()`.
- `auditoria`: agregar `tenant_id` filter; superadmin bypassa para soporte.
- `auth_*` SECURITY DEFINER: agregar `auth_tenant_id()` y `auth_es_superadmin()`; modificar `auth_es_dueno_o_admin()` para que sea relativo al tenant del usuario logueado.

### 1.3 RPCs y funciones (16 user-defined + 4 helpers + triggers)

#### Helpers SECURITY DEFINER

| Función | Cambio |
|---|---|
| `auth_usuario_id()` | sin cambio (devuelve int del usuario logueado) |
| `auth_es_dueno_o_admin()` | retornar también true si `superadmin` (para que policies admin-only sigan funcionando con superadmin) |
| `auth_locales_visibles()` | filtrar por tenant en el `array_agg` |
| `auth_tiene_permiso(slug)` | sin cambio (ya verifica via `usuario_permisos`, que se filtra por RLS) |
| **`auth_tenant_id()`** (nuevo) | retorna `tenant_id` del usuario logueado o `NULL` para superadmin |
| **`auth_es_superadmin()`** (nuevo) | retorna `true` si `rol = 'superadmin'` |

#### RPCs de pagos / saldos (SECURITY INVOKER, respetan RLS)

| RPC | Necesita cambio |
|---|---|
| `_actualizar_saldo_caja` | NO (recibe `local_id`; saldos_caja ya filtrado por RLS) |
| `_auditar` | sí — agregar `tenant_id` al insert |
| `_gen_id` | NO |
| `_validar_local_autorizado` | sí — validar que `local_id` también pertenece al tenant del caller |
| `crear_movimiento_caja` | sí — derivar tenant_id del local_id (o del caller) e insertar |
| `crear_gasto` | sí — idem |
| `pagar_factura` | sí — idem |
| `pagar_remito` | sí — idem |
| `pagar_sueldo` | sí — idem |
| `pagar_aguinaldo` | sí — idem |
| `pagar_vacaciones` | sí — idem |
| `liquidacion_final_empleado` | sí — idem |
| `registrar_adelanto` | sí — idem |
| `transferencia_cuentas` | sí — idem |
| `anular_movimiento` | NO (opera sobre fila ya filtrada por RLS) |
| `anular_factura` | NO |
| `anular_remito` | NO |
| `eliminar_venta` | sí — al insertar audit, agregar tenant_id |
| `editar_venta` | sí — idem |
| `eliminar_cierre` | sí — idem |

#### RPCs MP

| RPC | Cambio |
|---|---|
| `set_mp_token` | sí — el upsert de `mp_credenciales` debe incluir `tenant_id` (derivado del local_id) |
| `get_mp_token` | NO (sólo lectura, ya filtrada por RLS de mp_credenciales) |
| `_get_mp_passphrase` | NO (helper interno, no toca tenant) |

#### Triggers

| Trigger | Cambio |
|---|---|
| `trg_auditoria_no_update` / `_no_delete` | NO (siguen impidiendo modificar audit) |
| `auditoria_no_modify` | NO |

### 1.4 API endpoints (Vercel serverless, 12 archivos)

| Endpoint | Usa service_role | Tablas tocadas | Cambio |
|---|---|---|---|
| `auth-admin.js` | sí | `usuarios` | sí — al crear usuario, asignar `tenant_id` del caller (excepto si caller es superadmin → usa el tenant_id del payload) |
| `auth-hash-passwords.js` | sí | `usuarios` | sí — filtrar por tenant si no es superadmin |
| `auth-migrate-all.js` | sí | `usuarios` | sí — script one-shot, agregar tenant_id |
| `auth-setup.js` | sí | `usuarios`, `locales` | sí — bootstrap inicial, debe asignar tenant Neko |
| `mp-generate.js` | sí | `mp_credenciales` | sí — iterar todas las credenciales (ahora múltiples tenants); cada cron run procesa todas |
| `mp-process.js` | sí | `mp_credenciales`, `mp_movimientos`, `saldos_caja` | sí — cada upsert/insert debe incluir tenant_id |
| `mp-sync.js` | sí | `mp_credenciales`, `mp_movimientos` | sí — idem |
| `_mp-token.js` | sí | `mp_credenciales` | sí — query incluye tenant_id |
| `_mp-csv.js`, `_mp-balance.js` | sí | helpers internos | NO directamente (consumen output de mp-token) |
| `claude.js` | NO (proxy) | - | NO |
| `telegram-webhook.js` | sí (?) | a verificar | sí si toca DB |

**Observación crítica:** los crons MP (`mp-generate`, `mp-process`, `mp-sync`) hoy iteran sobre `mp_credenciales` activas sin filtro de tenant. Eso seguirá funcionando: traen filas de todos los tenants y cada insert/update va con su `tenant_id` derivado del `local_id` de la credencial. Pero si un tenant tiene credenciales corruptas, no debe bloquear a los demás.

### 1.5 Componentes UI (8 con cambio + 1 nuevo)

| Componente | Cambio |
|---|---|
| `Login.tsx` | menor — el SELECT a `usuarios` ya filtrará por RLS, agarra el `tenant_id` automáticamente. **Caso edge:** si superadmin tiene `tenant_id IS NULL`, login funciona y carga lista de tenants para elegir. |
| `App.tsx` | medio — agregar al `user` enriched el `tenant` actual (nombre, slug, plan). Para superadmin, agregar mecanismo de "switch tenant" con `?tenant=<uuid>` en URL o sessionStorage override. |
| `components/Layout.tsx` (sidebar) | medio — mostrar nombre del tenant actual debajo del brand "PASE". Si superadmin está viendo otro tenant: badge naranja "viendo como [tenant]". |
| `Usuarios.tsx` | menor — query ya filtra por RLS al tenant del caller. Para superadmin: dropdown de tenant arriba. |
| `Configuracion.tsx` (Conceptos) | menor — RLS filtra automáticamente. |
| `Config.tsx` | menor — idem. |
| `Proveedores.tsx`, `Insumos.tsx`, `Recetas.tsx`, `RRHH*.tsx`, `Ventas.tsx`, `Compras.tsx`, etc. | NO cambio en componentes — RLS hace todo el trabajo. |
| **`Tenants.tsx`** (nuevo, sólo superadmin) | listado, alta, edición, desactivación de tenants. Asignación del usuario `dueno` inicial. |
| **`OnboardingTenant.tsx`** (nuevo) | wizard al crear tenant: nombre, slug, primer dueño (email + password), primer local. Ejecuta una serie de inserts atómicos. |

---

## 2. Schema diseñado (PASO 2)

### 2.1 Tabla nueva `tenants`

```sql
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      text NOT NULL,
  slug        text UNIQUE NOT NULL,           -- 'neko', 'cliente-2', etc.
  activo      boolean NOT NULL DEFAULT true,
  plan        text,                            -- placeholder billing futuro: 'basic', 'pro', 'trial'
  trial_ends_at timestamptz,                   -- placeholder billing
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_activo ON tenants(activo) WHERE activo = true;
```

### 2.2 Tabla nueva `tenant_admins`

Vínculo entre `usuarios.id` (integer) y `tenants.id` (uuid) para los roles administrativos
*dentro* del tenant. Mantiene track de quién es dueño/admin de cada tenant.

```sql
CREATE TABLE tenant_admins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id  integer NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  rol         text NOT NULL CHECK (rol IN ('dueno', 'admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, usuario_id)
);

CREATE INDEX idx_tenant_admins_tenant ON tenant_admins(tenant_id);
CREATE INDEX idx_tenant_admins_usuario ON tenant_admins(usuario_id);
```

**Nota:** `usuarios.rol` sigue siendo source of truth (porque RLS la usa hoy). `tenant_admins` es complemento — permite tener un usuario que es admin en varios tenants (ej: contador externo). En la práctica inicial, cada usuario pertenece a 1 solo tenant (`usuarios.tenant_id`), así que `tenant_admins` será 1 row por usuario admin/dueno.

### 2.3 Modificación a `usuarios`

```sql
-- 1. Columna tenant_id, NULLABLE durante migración.
ALTER TABLE usuarios ADD COLUMN tenant_id uuid REFERENCES tenants(id);

-- 2. Backfill al tenant Neko (todos los usuarios actuales pertenecen a Lucas).
UPDATE usuarios SET tenant_id = '<UUID_NEKO>' WHERE tenant_id IS NULL;

-- 3. NOT NULL después del backfill, EXCEPTO superadmin (que se queda NULL).
-- No se puede usar NOT NULL constraint directamente — usar CHECK.
ALTER TABLE usuarios ADD CONSTRAINT usuarios_tenant_check CHECK (
  rol = 'superadmin' OR tenant_id IS NOT NULL
);

-- 4. Modificar el CHECK existente del rol para incluir 'superadmin' y otros.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK (
  rol IN ('superadmin', 'dueno', 'admin', 'encargado', 'compras', 'cajero')
);

CREATE INDEX idx_usuarios_tenant ON usuarios(tenant_id);
```

### 2.4 Patrón ALTER por tabla (35 tablas)

Aplicar a cada tabla del inventario 1.1:

```sql
-- Patrón estándar (ejemplo: ventas)
ALTER TABLE ventas ADD COLUMN tenant_id uuid REFERENCES tenants(id);

-- Backfill: derivar de local_id → locales.tenant_id
UPDATE ventas SET tenant_id = (
  SELECT tenant_id FROM locales WHERE locales.id = ventas.local_id
) WHERE tenant_id IS NULL;

-- Forzar NOT NULL después del backfill.
ALTER TABLE ventas ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX idx_ventas_tenant ON ventas(tenant_id);
-- Index compuesto para queries comunes.
CREATE INDEX idx_ventas_tenant_local ON ventas(tenant_id, local_id);
```

**Casos especiales:**

- `locales`: NO tiene `local_id`. Backfill directo: `UPDATE locales SET tenant_id = '<UUID_NEKO>'`.
- Tablas catálogo sin `local_id` (`proveedores`, `insumos`, `recetas`, `config_categorias`, `rrhh_valores_doble`, `blindaje_tipos_documento`): backfill directo a Neko.
- Tablas hijas (e.g. `factura_items`): backfill desde el parent — `tenant_id = (SELECT tenant_id FROM facturas WHERE id = factura_items.factura_id)`.
- `usuario_locales`/`usuario_permisos`: backfill desde `usuarios.tenant_id`.
- `auditoria`: backfill TODO a Neko (la data legacy es toda de Lucas).
- `medios_cobro` con `local_id NULL` (medios globales): backfill por scan + assign al tenant del local que los referencie. Para Neko es trivial (todos los medios globales son de Neko).

### 2.5 NO drop default

**Decisión:** la solicitud original dice "drop default tras backfill". **No vamos a setear default en ningún momento**, porque:
- Setear default = riesgo de que un INSERT olvide tenant_id y termine pegado en Neko silently.
- Mejor: NOT NULL sin default → INSERT sin tenant_id → ERROR explícito.
- Backfill via UPDATE explícito (como en 2.4 arriba).

### 2.6 Helpers nuevos `auth_*`

```sql
-- auth_tenant_id: tenant del usuario logueado. NULL para superadmin.
CREATE OR REPLACE FUNCTION auth_tenant_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM usuarios
  WHERE auth_id = auth.uid() AND activo
  LIMIT 1;
$$;

-- auth_es_superadmin: true si el rol es 'superadmin'.
CREATE OR REPLACE FUNCTION auth_es_superadmin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE auth_id = auth.uid() AND rol = 'superadmin' AND activo
  );
$$;

-- auth_es_dueno_o_admin (modificado): incluye superadmin Y es relativo al tenant.
CREATE OR REPLACE FUNCTION auth_es_dueno_o_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE auth_id = auth.uid()
      AND rol IN ('superadmin', 'dueno', 'admin')
      AND activo
  );
$$;

-- auth_locales_visibles (modificado): filtro por tenant.
CREATE OR REPLACE FUNCTION auth_locales_visibles()
RETURNS integer[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth_es_superadmin() THEN NULL::integer[]  -- superadmin ve todos
    WHEN auth_es_dueno_o_admin() THEN
      COALESCE(
        (SELECT array_agg(l.id) FROM locales l WHERE l.tenant_id = auth_tenant_id()),
        ARRAY[]::integer[]
      )
    ELSE COALESCE(
      (SELECT array_agg(ul.local_id) FROM usuario_locales ul
       WHERE ul.usuario_id = auth_usuario_id()),
      ARRAY[]::integer[]
    )
  END;
$$;

GRANT EXECUTE ON FUNCTION auth_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION auth_es_superadmin() TO authenticated;
```

### 2.7 Patrón RLS canónico (RECETA — 4 variantes)

#### Variante 1 — Tabla con `local_id` y `tenant_id`

```sql
DROP POLICY IF EXISTS "<old_policy>" ON <tabla>;
CREATE POLICY "<tabla>_scope" ON <tabla> FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
    )
  );
```

#### Variante 2 — Tabla catálogo (sin `local_id`) con permiso granular

```sql
CREATE POLICY "<tabla>_scope" ON <tabla> FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND auth_tiene_permiso('<modulo>')
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND auth_tiene_permiso('<modulo>')
    )
  );
```

#### Variante 3 — Tabla hija (con `tenant_id` propio + scope vía parent)

```sql
CREATE POLICY "<child>_scope" ON <child> FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      EXISTS (
        SELECT 1 FROM <parent> WHERE <parent>.id = <child>.<parent_fk>
        AND (auth_es_dueno_o_admin() OR <parent>.local_id = ANY(auth_locales_visibles()))
      )
    )
  )
  WITH CHECK ( ... );
```

#### Variante 4 — Tabla raíz especial (`tenants`, `tenant_admins`)

```sql
-- tenants: superadmin lee/escribe todo; resto solo su propio tenant.
CREATE POLICY "tenants_select" ON tenants FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR id = auth_tenant_id());
CREATE POLICY "tenants_admin_write" ON tenants FOR ALL TO authenticated
  USING (auth_es_superadmin())
  WITH CHECK (auth_es_superadmin());

-- tenant_admins: superadmin escribe; dueño del tenant lee los suyos.
CREATE POLICY "ta_select" ON tenant_admins FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id());
CREATE POLICY "ta_admin_write" ON tenant_admins FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()
  ));
```

### 2.8 Storage (3 buckets)

Buckets actuales: `facturas`, `empleados`, `blindaje`.

**Decisión:** path con prefijo `<tenant_id>/...`. RLS de `storage.objects` filtra por path.

```sql
-- Patrón para bucket 'facturas':
CREATE POLICY "facturas_tenant_read" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'facturas' AND (
      auth_es_superadmin() OR
      (storage.foldername(name))[1] = auth_tenant_id()::text
    )
  );
-- Idem INSERT/UPDATE/DELETE.
```

**Migración de objetos existentes:** mover todos los archivos legacy del bucket a `<UUID_NEKO>/<nombre_actual>` con un script. Más simple si Lucas tiene pocos archivos en cada bucket — verificar volumen antes.

### 2.9 RPCs — patrón estándar

Agregar al inicio de cada RPC SECURITY INVOKER:

```sql
-- Validar que el local pertenece al tenant del caller (defense-in-depth).
v_tenant uuid := auth_tenant_id();
v_local_tenant uuid;

IF NOT auth_es_superadmin() THEN
  SELECT tenant_id INTO v_local_tenant FROM locales WHERE id = p_local_id;
  IF v_local_tenant IS NULL OR v_local_tenant != v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;
END IF;
```

Y en cada INSERT, agregar `tenant_id = v_tenant` (o `v_local_tenant` para superadmin que opera con el tenant del local).

---

## 3. Plan de migración de data

### 3.1 Snapshot pre-migración (CRÍTICO)

**Antes de TODO**: backup completo de la DB de Supabase. Si algo se pone feo, restaurar.

```sql
-- Verificación previa: nadie está logueado, no hay queries en vuelo.
SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'active' AND usename != current_user;
```

### 3.2 Orden de ejecución (no negociable — hay dependencias FK)

1. `CREATE TABLE tenants` + `CREATE TABLE tenant_admins` (sin FK aún a usuarios).
2. `INSERT INTO tenants (nombre, slug) VALUES ('Neko', 'neko') RETURNING id` → guardar UUID en variable `v_neko`.
3. `ALTER TABLE usuarios ADD COLUMN tenant_id` (NULLABLE).
4. Crear los helpers `auth_tenant_id()`, `auth_es_superadmin()` (idempotentes).
5. `UPDATE usuarios SET tenant_id = v_neko WHERE tenant_id IS NULL`.
6. **Promover Lucas a superadmin** (su email): `UPDATE usuarios SET tenant_id = NULL, rol = 'superadmin' WHERE email = '<lucas-email>'`.
7. CHECK constraint en `usuarios` (`tenant_id IS NOT NULL OR rol = 'superadmin'`).
8. Reset constraint del rol para incluir nuevos roles.
9. `ADD COLUMN tenant_id` a las 14 tablas con local_id, en orden topológico (locales primero):
   - `locales` → backfill `tenant_id = v_neko`.
   - `ventas, gastos, facturas, movimientos, remitos, saldos_caja, caja_efectivo, mp_credenciales, mp_movimientos, rrhh_empleados, blindaje_documentos, medios_cobro` → backfill desde `locales`.
   - `empleados` (legacy) → idem.
10. `ADD COLUMN tenant_id` a las 5 tablas catálogo → backfill `v_neko`.
11. `ADD COLUMN tenant_id` a `usuario_locales`, `usuario_permisos` → backfill desde `usuarios`.
12. `ADD COLUMN tenant_id` a las 12 tablas hijas → backfill desde parent.
13. `ADD COLUMN tenant_id` a `auditoria` → backfill `v_neko`.
14. `tenant_admins`: insertar 1 row por cada `dueno`/`admin` del tenant Neko.
15. `ALTER COLUMN tenant_id SET NOT NULL` en TODAS las tablas (excepto `usuarios` que tiene CHECK).
16. Crear index `idx_<tabla>_tenant` en TODAS las tablas con tenant_id.
17. Modificar `auth_es_dueno_o_admin()` y `auth_locales_visibles()` (definitive versions).
18. Reescribir TODAS las policies (eliminar las viejas, crear las nuevas con dual filter).
19. Validación post-migración: ejecutar suite de tests RLS (etapa 7).

### 3.3 Backup de RLS pre-migración

Antes de eliminar policies viejas, guardar el dump:

```sql
-- Dump al schema para rollback.
COPY (SELECT * FROM pg_policies WHERE schemaname = 'public')
  TO '/tmp/policies_backup_pre_multitenant.csv' CSV HEADER;
```

---

## 4. Plan de UI

### 4.1 Cambios en componentes existentes

#### `Login.tsx`
- Sin cambios funcionales. RLS hace que el `SELECT * FROM usuarios WHERE auth_id = ...` traiga la fila con su `tenant_id`.
- Si superadmin loguea: la fila trae `tenant_id IS NULL`. Frontend detecta y muestra modal "elegir tenant".

#### `App.tsx`
- Tras `applyLogin(usr)`: cargar tenant info con `db.from("tenants").select("*").eq("id", usr.tenant_id).single()`.
- Para superadmin: cargar lista completa con `db.from("tenants").select("*").order("nombre")` y permitir switch.
- Persistir tenant override en `sessionStorage.setItem("pase_tenant_override", uuid)` (solo superadmin).
- Pasar `tenant` enriched al context Auth.

#### `Layout.tsx` (sidebar)
- Bajo "PASE / aliado gastronómico": mostrar `tenant.nombre` en chip pequeño.
- Si `tenant_override` activo: badge naranja "viendo como [tenant]" con botón ✕ para volver.
- Si superadmin sin override: badge especial "MODO SUPERADMIN".

#### `Usuarios.tsx`
- Sin cambios para dueño/admin de tenant: RLS filtra automáticamente a su tenant.
- Para superadmin: agregar dropdown "Tenant" arriba para ver/editar usuarios de cualquier tenant.

#### `Tenants.tsx` (nuevo, /tenants — solo superadmin)
- Listado de todos los tenants con: nombre, slug, plan, activo, fecha creación, # locales, # usuarios, último login.
- Acciones: ver detalle, editar, desactivar (no borrar — soft delete via `activo = false`).
- "+ Nuevo tenant" → abre `OnboardingTenant.tsx`.

#### `OnboardingTenant.tsx` (nuevo, wizard)
- Paso 1: nombre + slug + plan (default 'trial', 14 días).
- Paso 2: primer dueño (email + nombre + password temporal → forzado a cambiar).
- Paso 3: primer local (nombre + dirección).
- Paso 4: confirmación + creación atómica vía RPC `crear_tenant`.

### 4.2 RPC nueva `crear_tenant` (SECURITY DEFINER, solo superadmin)

```sql
CREATE OR REPLACE FUNCTION crear_tenant(
  p_nombre text,
  p_slug text,
  p_plan text,
  p_dueno_email text,
  p_dueno_nombre text,
  p_dueno_password text,
  p_local_nombre text
) RETURNS uuid AS $$ ... $$;
```

Operación atómica. Si algo falla, rollback completo. Inserta tenant + dueño + local + tenant_admins en una sola transacción.

### 4.3 Sidebar nuevo item "Tenants"

Visible solo si `auth_es_superadmin()`. Debajo de "Herramientas".

---

## 5. Plan de tests RLS automáticos

### 5.1 Suite estándar de aislamiento

Crear `packages/pase/tests/rls_isolation.spec.ts` (Playwright + Supabase admin client):

```typescript
// Setup: crear 2 tenants, 2 usuarios dueño, 1 local cada uno.
// Insertar 1 venta, 1 factura, 1 gasto, 1 empleado en cada tenant via service_role.

// Test 1: Usuario T1 NO ve nada de T2.
test("aislamiento por tenant", async () => {
  const dbT1 = createClient(URL, anon, { auth: { ... } });
  await dbT1.auth.signInWithPassword({ email: t1Email, ... });

  // ASSERT: db.from('ventas').select() devuelve solo ventas de T1.
  // ASSERT: db.from('locales').select() devuelve solo locales de T1.
  // ASSERT: db.from('usuarios').select() solo el propio usuario.
  // ... iterar por las 35 tablas.
});

// Test 2: Cross-tenant write attempt → blocked.
test("T1 no puede insertar venta en local de T2", async () => {
  const { error } = await dbT1.from('ventas').insert([{ local_id: localT2, ... }]);
  expect(error).toBeTruthy();  // RLS rechaza
});

// Test 3: Superadmin ve todo.
test("superadmin ve todos los tenants", async () => {
  const dbSuper = createClient(...);
  await dbSuper.auth.signInWithPassword({ email: 'lucas@neko.com', ... });
  const { data } = await dbSuper.from('ventas').select();
  expect(data.length).toBeGreaterThan(0);  // ve todo
});
```

### 5.2 Per-table sweep

Para cada una de las 35 tablas, generar tests autocontenidos:

```typescript
const TABLAS = ['ventas', 'gastos', 'facturas', /* ... */];

for (const tabla of TABLAS) {
  test(`${tabla}: aislamiento por tenant`, async () => {
    // Inserta row en tenant T1 via service_role.
    // Loguea como usuario T2 → SELECT no debe devolverla.
    // T2 intenta INSERT con tenant_id = T1 → RLS rechaza.
  });
}
```

### 5.3 Test de RPC

Para cada RPC modificada, validar que:
1. Caller con tenant T1 no puede pasar `p_local_id` de T2 → `TENANT_MISMATCH`.
2. Superadmin puede operar en cualquier tenant.

### 5.4 Decisión: CI

Correr la suite en cada PR (futuro). Por ahora, manualmente al final de cada etapa.

---

## 6. Plan de implementación en 8 etapas

| # | Etapa | Tipo | Entrega | Riesgo |
|---|---|---|---|---|
| 1 | **Foundation schema** | DB | Tabla `tenants` + `tenant_admins` + tenant Neko + helpers `auth_tenant_id()` / `auth_es_superadmin()` + Lucas → superadmin. **No cambia RLS aún.** | BAJO |
| 2 | **Schema propagation** | DB | `ADD COLUMN tenant_id` + backfill + NOT NULL en las 35 tablas. **No cambia RLS aún.** Sistema sigue funcionando idéntico. | MEDIO (si backfill falla, queries pueden romper) |
| 3 | **RLS rewrite** | DB | Reescribir TODAS las policies con dual filter + superadmin bypass. **CAMBIO FUNCIONAL en runtime.** | **ALTO** (si rompe RLS, todos los usuarios quedan sin acceso) |
| 4 | **RPCs hardening** | DB | Agregar tenant validation a las 16 RPCs + insert de `tenant_id` en `auditoria`. | MEDIO |
| 5 | **API endpoints** | Backend | Actualizar 8 endpoints (auth-admin, mp-*, auth-setup, etc) para incluir tenant en queries. | MEDIO |
| 6 | **UI: superadmin** | Frontend | Nueva pantalla `Tenants.tsx` + `OnboardingTenant.tsx` + RPC `crear_tenant` + cambios en Login/App/Layout. | BAJO (no afecta usuarios existentes) |
| 7 | **Tests automáticos** | Tests | Suite de aislamiento RLS Playwright + per-table sweep + RPC tests. | BAJO |
| 8 | **Storage + cleanup** | DB + Backend | Migrar paths de storage a prefix `<tenant_id>/`, RLS de storage, drop de columnas legacy si quedan, comentarios actualizados. | MEDIO |

### 6.1 Detalle por etapa

#### Etapa 1 — Foundation schema (1 commit DB)
- `migrations/202604281200_tenants_foundation.sql`:
  - CREATE TABLE tenants
  - CREATE TABLE tenant_admins (sin FKs aún)
  - INSERT tenant Neko + capturar UUID
  - ADD COLUMN usuarios.tenant_id (NULLABLE)
  - UPDATE usuarios SET tenant_id = neko_uuid (todos)
  - UPDATE usuarios SET tenant_id = NULL, rol = 'superadmin' WHERE email = '<lucas>'
  - CHECK constraint nuevo en usuarios
  - Helpers auth_tenant_id() / auth_es_superadmin()
  - GRANT EXECUTE
- **Verificación post:**
  - Login funciona idéntico (RLS sigue como antes).
  - Lucas loguea como superadmin: la fila trae tenant_id NULL → frontend no rompe (todavía no usa tenant_id).
  - Otros usuarios siguen viendo lo de siempre (sus filas tienen tenant_id = neko_uuid pero RLS no lo filtra todavía).

#### Etapa 2 — Schema propagation (1 commit DB grande, atómico)
- `migrations/202604281201_tenant_id_columns.sql`:
  - ADD COLUMN tenant_id en las 35 tablas (NULLABLE).
  - Backfill cada tabla en orden topológico (16 UPDATEs).
  - SET NOT NULL.
  - Crear índices.
- **Verificación post:**
  - Sistema sigue funcionando idéntico (RLS no filtra todavía).
  - SELECT * FROM ventas — todas las filas tienen tenant_id = neko_uuid.

#### Etapa 3 — RLS rewrite (1 commit DB **CRÍTICO**)
- `migrations/202604281202_rls_multitenant.sql`:
  - DROP TODAS las policies actuales (clean slate como en 20260423_rls_real_policies.sql).
  - Modificar `auth_es_dueno_o_admin()` y `auth_locales_visibles()`.
  - Crear las nuevas policies con dual filter (3 variantes).
- **Verificación post:**
  - Usuario Neko ve TODA su data (idéntico a antes).
  - Lucas (superadmin) ve TODA la data de Neko + nada más (no hay otros tenants aún).
  - Test de bloqueo: forzar `tenant_id` distinto en SELECT → bloqueado.
- **Plan rollback:** si algo se rompe, ejecutar el dump SQL de policies pre-migración (paso 3.3).

#### Etapa 4 — RPCs hardening (1 commit DB)
- Modificar las 16 RPCs identificadas en 1.3.
- Insertar `tenant_id` en `auditoria.tenant_id` en cada RPC que audite.

#### Etapa 5 — API endpoints (1 commit backend)
- Actualizar 8 archivos en `packages/pase/api/`.
- Agregar tenant filter a queries con service_role.
- Tests E2E manuales en cada endpoint.

#### Etapa 6 — UI superadmin (2-3 commits frontend)
- Commit A: enriched `user` con tenant + Layout sidebar update + Login/App ajustes.
- Commit B: pantalla `Tenants.tsx` + RPC `crear_tenant`.
- Commit C: wizard `OnboardingTenant.tsx`.

#### Etapa 7 — Tests automáticos (1 commit tests)
- `tests/rls_isolation.spec.ts` con suite completa.
- 35 tests de tabla + 16 tests de RPC + 3 tests integration.

#### Etapa 8 — Storage + cleanup (1 commit DB + backend)
- Script de migración de objetos en buckets a prefijo tenant.
- Policies RLS de storage actualizadas.
- Cleanup de columnas legacy si quedaron (`empleados` table puede dropearse si tiene 0 rows).
- Documentar el patrón canónico en `CLAUDE.md` o similar.

---

## 7. Riesgos y mitigaciones

### 7.1 Riesgo CRÍTICO — RLS rota deja a todos sin acceso (Etapa 3)

**Mitigación:**
- Ejecutar la migración en horario bajo (madrugada AR) por si requiere rollback.
- Lucas conectado al SQL Editor de Supabase con el dump SQL del rollback listo.
- Probar primero en una **DB clon de staging** antes de producción.
- Si no hay staging: separar etapa 3 en dos sub-pasos:
  - 3a: agregar las nuevas policies SIN dropear las viejas → ambas activas (PERMISSIVE OR).
  - 3b: dropear las viejas tras 24h sin issues.

### 7.2 Riesgo ALTO — `auth_tenant_id()` retorna NULL para superadmin

Si alguna policy mal escrita hace `tenant_id = auth_tenant_id()` SIN el `auth_es_superadmin() OR`, el superadmin queda bloqueado de todo (NULL = NULL es FALSE en SQL).

**Mitigación:** todas las policies usan el patrón `auth_es_superadmin() OR (tenant_id = ...)`. Lint pre-merge: el archivo de migración no debe contener policies que no empiecen con `auth_es_superadmin() OR`.

### 7.3 Riesgo MEDIO — Cron MP rompe entre tenants

Los crons `mp-process` / `mp-sync` iteran credenciales hoy. Si una credencial de tenant T2 está mal configurada y tira excepción, ¿bloquea las de T1?

**Mitigación:** wrap cada iteración en try/catch + log + continuar. Ya lo hace el código actual (validar línea por línea).

### 7.4 Riesgo MEDIO — Auditoria histórica sin tenant_id

Hoy `auditoria.detalle` es jsonb que en algunas RPCs incluye contexto. La columna nueva `tenant_id` permite queries más eficientes al superadmin.

**Mitigación:** backfill `tenant_id = neko_uuid` para audit legacy. Aceptable porque toda la audit pre-migración es de Lucas/Neko.

### 7.5 Riesgo MEDIO — Storage paths legacy sin prefijo tenant

Archivos en buckets `facturas`/`empleados`/`blindaje` están en paths como `<local_id>/<doc>.pdf`. Si la nueva RLS de storage exige `<tenant_id>/<local_id>/<doc>.pdf`, los archivos viejos quedan inaccesibles.

**Mitigación (Etapa 8):**
- Script Node.js que itera objects, los copia al nuevo path con prefix tenant, valida copia, borra original.
- Update de columnas en facturas/blindaje_documentos que apuntan al path viejo.
- O alternativa: policy de transición que acepta `<tenant_id>/...` O `<local_id>/...` (legacy), con cleanup posterior.

### 7.6 Riesgo BAJO — Slug colision

Si onboarding intenta `slug = 'neko'` para un cliente nuevo y choca con UNIQUE.

**Mitigación:** UNIQUE constraint + RPC valida o sufija con incremental.

### 7.7 Riesgo BAJO — Performance

`tenant_id` agregado a 35 tablas con índices simples + compuestos. Tablas grandes (ventas, movimientos, mp_movimientos, auditoria) — PostgreSQL maneja bien.

**Mitigación:** EXPLAIN ANALYZE en queries críticas (Dashboard, EERR, Cashflow) post-Etapa 3. Si alguna query hace seq_scan, agregar índice compuesto específico.

---

## 8. Tiempo estimado

| Etapa | Estimado Claude |
|---|---|
| 1 — Foundation schema | 60–90 min |
| 2 — Schema propagation (35 tablas, backfill) | 90–120 min |
| 3 — RLS rewrite (50 policies) | **120–180 min** (la más compleja) |
| 4 — RPCs hardening (16 RPCs) | 90–120 min |
| 5 — API endpoints (8 archivos) | 60–90 min |
| 6 — UI superadmin (3 commits) | 180–240 min |
| 7 — Tests automáticos | 90–120 min |
| 8 — Storage + cleanup | 90–120 min |

**Total: 13–18 horas de Claude, repartido en 5–7 sesiones.** Etapa 3 es la más sensible, recomiendo hacerla con Lucas presente para smoke test inmediato.

---

## 9. Decisiones pendientes que necesito que Lucas confirme

1. **Slug del tenant Neko:** propongo `neko`. ¿OK o preferís otro (`lucas`, `pase-original`, etc)?
2. **Email superadmin:** ¿`lucastomasferrari@gmail.com` (el git identity actual) o un email separado tipo `superadmin@pase.app`?
3. **Catálogos por tenant — confirmación:** la decisión del prompt era catálogos por tenant. Confirmo que `proveedores`, `insumos`, `recetas`, `config_categorias`, `medios_cobro`, `rrhh_valores_doble`, `blindaje_tipos_documento` van a ser per-tenant, sin compartición. ¿OK o querés algunos compartidos (ej: AFIP es lo mismo para todos)?
4. **Etapa 3 con doble policy temporal (3a/3b):** ¿OK con el plan defensivo de mantener policies viejas + nuevas en paralelo 24h, o vamos directo al swap?
5. **Storage migration:** ¿hay muchos archivos en `facturas`/`blindaje`/`empleados` hoy? Si son < 100 total, un script Node.js es trivial. Si son miles, evaluar dual-policy approach.
6. **Roles permitidos en `usuarios`:** propongo añadir `'superadmin'`, `'compras'` (ya existe en frontend pero no en CHECK), `'cajero'` (ídem). ¿Confirmás los 6 roles: `superadmin`, `dueno`, `admin`, `encargado`, `compras`, `cajero`?
7. **Plan en `tenants`:** ¿quieren tener placeholder para billing futuro (`'trial'`, `'basic'`, `'pro'`) desde el día 1, o agregamos cuando llegue?
8. **Onboarding flow:** ¿lo quieren como wizard de 4 pasos en UI (lo propuesto), o un single form? El wizard es mejor UX para clientes nuevos pero más código.
9. **`tenant_admins` vs `usuarios.rol`:** mantener ambos por compatibilidad o eliminar `tenant_admins` si `usuarios.tenant_id` + `usuarios.rol` cubre todo? Mi propuesta: dejar `tenant_admins` como complemento (preparación para multi-tenant per-user en el futuro), pero no usarlo en RLS aún.
10. **Branch separado vs main:** dado el riesgo de la Etapa 3, ¿querés que las migraciones DB vayan en branch `multitenant` con merge tras smoke test, o directo a main como las etapas anteriores?

---

## 10. Próximos pasos

Esperando OK de Lucas sobre las **10 decisiones pendientes** y autorización para arrancar **Etapa 1 — Foundation schema**.

Una vez que arranque, cada etapa va a 1+ commits con build + tests verde y push individual. Etapa 3 requiere atención especial: con Lucas presente, en horario bajo, y rollback SQL listo.
