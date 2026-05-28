# Rediseño Permisos unificados PASE↔COMANDA — Design Document

**Fecha:** 2026-05-28
**Autor:** brainstorming session (Lucas + Claude — decisiones default profesionales)
**Estado:** 🟡 SPEC ESCRITO — pendiente revisión Lucas
**Approach:** Single identity (Supabase Auth) + dual permissions tables + catálogo de slugs unificado + roles predefinidos como templates
**Depende de:** El sprint COMANDA Autónomo (24-may) ya separó las identidades. Este spec formaliza y completa.
**Implementación:** ⏸️ DIFERIDA

---

## 1. Resumen ejecutivo

El sprint del 24-may separó las identidades de COMANDA (tabla `comanda_usuarios` independiente). Falta cerrar el modelo de permisos para que sea **coherente, mantenible y vendible**:

- ✅ Auth compartido (mismo Supabase Auth) — funciona
- ✅ Profile dual (`usuarios` PASE + `comanda_usuarios` COMANDA) — funciona
- ❌ Catálogo de slugs disperso (algunos en migrations, otros hardcoded en TS)
- ❌ Sin roles predefinidos (cada usuario se configura desde cero)
- ❌ Sin gate explícito sobre info sensible (costos, márgenes, sueldos)
- ❌ Sin audit log de cambios de permisos
- ❌ UI de gestión rudimentaria

Este spec completa:
1. **Catálogo de slugs unificado** en tabla — fuente única de verdad
2. **Roles predefinidos como templates** (Dueño, Encargado, Cajero, etc.)
3. **Gates específicos para info sensible** (`catalogo.ver_costos`, `finanzas.ver_pl`, etc.)
4. **Audit log** de cambios de permisos
5. **UI mejorada** — vista por usuario con tabs PASE/COMANDA/Locales/Audit
6. **Onboarding wizard** para usuario nuevo (asigna rol template + opcional COMANDA mirror)
7. **Solicitudes de cambio de permiso** (workflow approval para cambios sensibles)

**Garantía:** auth + permisos existentes siguen funcionando idénticos. Spec es additivo.

---

## 2. Modelo conceptual

### 2.1. Las 3 capas de la identidad

```
┌─────────────────────────────────────────┐
│  CAPA 1 — IDENTIDAD                      │
│  auth.users (Supabase Auth)              │
│  email + password (single source)        │
└──────┬──────────────────────┬────────────┘
       │                      │
       ▼                      ▼
┌──────────────────┐  ┌──────────────────┐
│ usuarios (PASE)  │  │ comanda_usuarios │
│ rol_pase         │  │ (COMANDA)        │
│ tenant_id        │  │ rol_pos          │
│ activo           │  │ tenant_id        │
│ ...              │  │ pin_pos          │
└──────────────────┘  └──────────────────┘
       │                      │
       ▼                      ▼
┌──────────────────┐  ┌──────────────────┐
│ usuario_permisos │  │ comanda_usuario_ │
│ (slugs PASE)     │  │ permisos         │
│                  │  │ (slugs COMANDA)  │
└──────────────────┘  └──────────────────┘
       │                      │
       └──────────┬───────────┘
                  ▼
       ┌──────────────────┐
       │ usuario_locales  │
       │ (scoping local)  │
       │ — compartido     │
       └──────────────────┘
```

**Key insight**: un mismo `auth.users.id` puede tener:
- Solo perfil PASE (ej: contador remoto)
- Solo perfil COMANDA (ej: cajero que solo cobra)
- Ambos perfiles con permisos distintos (ej: Lucas — admin PASE + cajero COMANDA cuando cubre turno)

### 2.2. Catálogo de slugs unificado

Hoy los slugs viven dispersos:
- Algunos en `usuario_permisos` (free-text)
- Algunos hardcoded en `src/lib/auth.ts` o `tienePermiso()`
- COMANDA tiene su catálogo separado

Unificamos con tabla:

```sql
permiso_catalogo:
  slug TEXT PK
  app ENUM ('PASE','COMANDA')
  grupo TEXT (categoría UI: "Operación", "Financiero", "Catálogo", etc.)
  descripcion TEXT (visible en UI de asignación)
  sensibilidad ENUM ('NORMAL','SENSIBLE','CRITICO')
  requiere_approval BOOLEAN (cambios requieren 2FA del dueño)
  activo BOOLEAN
```

**Ejemplos:**

| slug | app | grupo | sensibilidad |
|---|---|---|---|
| rrhh.gestionar | PASE | Operación | NORMAL |
| rrhh.ver_sueldos | PASE | Financiero | SENSIBLE |
| catalogo.ver | PASE | Catálogo | NORMAL |
| catalogo.editar_items | PASE | Catálogo | NORMAL |
| catalogo.editar_precios | PASE | Catálogo | SENSIBLE |
| catalogo.ver_costos | PASE | Financiero | SENSIBLE |
| finanzas.ver_pl | PASE | Financiero | CRITICO |
| compras.aprobar_facturas_mayores | PASE | Financiero | CRITICO |
| transferencias.aprobar_cross_local | PASE | Financiero | CRITICO |
| comanda.cobrar | COMANDA | Venta | NORMAL |
| comanda.marcar_86 | COMANDA | Operación | NORMAL |
| comanda.open_item | COMANDA | Venta | NORMAL |
| comanda.aplicar_descuento_chico | COMANDA | Venta | NORMAL |
| comanda.aplicar_descuento_grande | COMANDA | Venta | SENSIBLE |
| comanda.anular_venta | COMANDA | Venta | SENSIBLE |
| comanda.manager_override | COMANDA | Manager | CRITICO |
| comanda.kds_marcar_listo | COMANDA | Cocina | NORMAL |
| comanda.cerrar_caja | COMANDA | Caja | NORMAL |
| comanda.justificar_diferencia | COMANDA | Caja | SENSIBLE |

**Sensibilidad** define el UX:
- NORMAL: checkbox simple
- SENSIBLE: checkbox con ícono ⚠️ + tooltip explicativo
- CRITICO: requiere 2FA del dueño para asignar/quitar

### 2.3. Roles predefinidos como templates

En vez de "configurar desde cero cada usuario", ofrecemos templates:

| Rol | App | Resumen |
|---|---|---|
| **Dueño** | PASE + COMANDA | Todo permitido |
| **Encargado PASE** | PASE | Operación + RRHH + Compras, NO finanzas sensibles |
| **Contador** | PASE | Solo Finanzas + EERR + lectura compras, sin operación |
| **Manager Local** | PASE + COMANDA | COMANDA full + PASE lectura de su local |
| **Cajero** | COMANDA | Cobrar + 86 + open_item, NO descuentos grandes |
| **Mozo** | COMANDA | Cobrar + handheld + mesas, sin caja |
| **Cocinero** | COMANDA | KDS + mermas, sin ventas |
| **Bartender** | COMANDA | KDS bar + ventas bebidas, sin descuentos |
| **Rider** | COMANDA | Solo RiderPWA |
| **Solo lectura** | PASE | Read-only general (auditor externo) |

**Cómo se usa:**
1. Crear usuario nuevo → selector "Asignar rol" → muestra templates
2. Al asignar, copia los permisos del template a `usuario_permisos`
3. Después de asignar, los permisos son **editables individualmente** (template es seed, no constraint)
4. Si el dueño quita un permiso, NO afecta el template ni a otros usuarios con el mismo rol

**Templates como código** (NO en DB):
- Vienen definidos en `src/lib/permission_templates.ts` (PASE + COMANDA)
- Versionable en git
- Si Lucas quiere modificar un template, se hace via PR (cambio chico)
- Si quiere crear un template custom, se permite via UI también (tabla `roles_custom` opcional v2)

### 2.4. Gates específicos para info sensible

Hoy hay riesgo de que un cajero con `catalogo.ver` también vea costos (porque la UI los muestra). Los gates explícitos:

```
catalogo.ver           → muestra items, precios, modificadores
catalogo.editar_items  → puede editar (no implica ver costos)
catalogo.editar_precios → puede cambiar precio_madre (gate aparte)
catalogo.ver_costos    → muestra costo_actual + margen (SENSIBLE)
```

UI debe respetar:
- Cajero ve catálogo SIN columna costos/margen
- Manager local con `catalogo.editar_items` pero no `catalogo.ver_costos` → ve catálogo editable SIN ver costos
- Solo admin con `catalogo.ver_costos` ve la matriz completa

**Aplicación**: backend filtra columnas según permisos. Frontend NO confía en frontend (siempre re-chequea via RLS o RPC).

### 2.5. Manager Override flow

Cuando un cajero hace acción que requiere override:

```
Cajero quiere descuento 25% (>15%)
   ↓
COMANDA: si user.permisos.includes('comanda.aplicar_descuento_grande') → permite directo
         si NO → crea solicitud Manager Override
   ↓
Sistema busca managers presentes (usuarios con permiso `comanda.manager_override` activos)
   ↓
Manager presente físicamente:
   - Notif local en su tablet/celu
   - Cajero ve "Pedile pin al manager Pedro"
   - Manager toca pin numérico en COMANDA del cajero
   - O entra a su sesión COMANDA y aprueba

Manager remoto (cuando no hay manager físico):
   - Push al celu del manager (apertura directa de la solicitud)
   - Manager aprueba o rechaza con comentario
   - COMANDA recibe via Realtime
```

**Auditoría**: cada override queda log con: cajero, manager, monto, motivo, fecha/hora.

### 2.6. Audit log de cambios de permiso

Toda asignación/quita de permiso queda log:

```sql
permisos_history:
  id, tenant_id, usuario_id_afectado, usuario_id_que_cambio,
  app, slug, accion (GRANT|REVOKE), antes (bool), despues (bool),
  motivo_opcional, ip, created_at
```

**Reportes**:
- Vista por usuario: "todos los cambios de permiso de este user"
- Reporte mensual auto: "estos permisos se asignaron/quitaron en mayo"
- Alerta inmediata: cambios CRITICO requieren notif al dueño

### 2.7. Scoping por local (ya existe — formalización)

`usuario_locales` ya existe. Refinement:
- Documentar combinación con permisos: "comanda.cobrar" + "solo Belgrano"
- Validar en backend: si usuario hace acción sobre local que no tiene asignado → RLS reject
- `applyLocalScope` (regla C3) sigue siendo obligatorio en frontend

### 2.8. Solicitudes de cambio de permiso

Para cambios CRITICO (umbral configurable):

```
Lucas quiere asignar `finanzas.ver_pl` a contador externo
   ↓
UI: "Este permiso es CRITICO. Confirmá con 2FA"
   ↓
2FA al celu de Lucas (TOTP existing) → confirma
   ↓
Permiso asignado + log + notif al usuario afectado
```

Para cambios NORMAL/SENSIBLE: directo (sin 2FA).

---

## 3. Schema de datos

### 3.1. Tablas nuevas

#### `permiso_catalogo`

```sql
CREATE TABLE permiso_catalogo (
  slug            text PRIMARY KEY,
  app             text NOT NULL CHECK (app IN ('PASE','COMANDA')),
  grupo           text NOT NULL,                       -- categoría UI
  descripcion     text NOT NULL,
  sensibilidad    text NOT NULL DEFAULT 'NORMAL'
                    CHECK (sensibilidad IN ('NORMAL','SENSIBLE','CRITICO')),
  requiere_approval boolean NOT NULL DEFAULT false,
  activo          boolean NOT NULL DEFAULT true,
  orden_ui        int NOT NULL DEFAULT 0
);

-- Seed inicial con todos los slugs existentes + los nuevos de specs #1-#6
INSERT INTO permiso_catalogo (slug, app, grupo, descripcion, sensibilidad) VALUES
  ('rrhh.gestionar', 'PASE', 'Operación', 'Gestionar empleados y novedades', 'NORMAL'),
  ('rrhh.ver_sueldos', 'PASE', 'Financiero', 'Ver sueldos de empleados', 'SENSIBLE'),
  ('catalogo.ver', 'PASE', 'Catálogo', 'Ver catálogo de items', 'NORMAL'),
  ('catalogo.editar_items', 'PASE', 'Catálogo', 'Crear/editar items y modificadores', 'NORMAL'),
  ('catalogo.editar_precios', 'PASE', 'Catálogo', 'Modificar precios de items', 'SENSIBLE'),
  ('catalogo.ver_costos', 'PASE', 'Financiero', 'Ver costos y márgenes', 'SENSIBLE'),
  ('catalogo.editar_recetas', 'PASE', 'Catálogo', 'Crear/editar recetas', 'NORMAL'),
  ('catalogo.editar_insumos', 'PASE', 'Catálogo', 'Crear/editar insumos y materias primas', 'NORMAL'),
  ('compras.generar_oc', 'PASE', 'Compras', 'Generar órdenes de compra', 'NORMAL'),
  ('compras.recibir', 'PASE', 'Compras', 'Confirmar recepción de remito', 'NORMAL'),
  ('compras.cargar_factura', 'PASE', 'Compras', 'Cargar factura (manual o IA)', 'NORMAL'),
  ('compras.aprobar_factura', 'PASE', 'Financiero', 'Aprobar facturas (workflow)', 'SENSIBLE'),
  ('compras.aprobar_facturas_mayores', 'PASE', 'Financiero', 'Aprobar facturas > umbral', 'CRITICO'),
  ('compras.pagar_factura', 'PASE', 'Financiero', 'Ejecutar pago de facturas', 'SENSIBLE'),
  ('stock.ver', 'PASE', 'Stock', 'Ver stock actual', 'NORMAL'),
  ('stock.cargar_merma', 'PASE/COMANDA', 'Stock', 'Cargar mermas', 'NORMAL'),
  ('stock.aprobar_merma', 'PASE', 'Stock', 'Aprobar mermas > umbral', 'SENSIBLE'),
  ('stock.contar', 'PASE/COMANDA', 'Stock', 'Realizar conteos físicos', 'NORMAL'),
  ('stock.cerrar_conteo', 'PASE/COMANDA', 'Stock', 'Cerrar y aplicar ajustes de conteo', 'SENSIBLE'),
  ('stock.ver_avt', 'PASE', 'Financiero', 'Ver dashboard AvT', 'SENSIBLE'),
  ('finanzas.ver_pl', 'PASE', 'Financiero', 'Ver P&L restaurantero', 'CRITICO'),
  ('finanzas.firmar_dsr', 'PASE', 'Operación', 'Firmar DSR diario', 'NORMAL'),
  ('finanzas.ver_dsr', 'PASE', 'Operación', 'Ver DSRs históricos', 'NORMAL'),
  ('finanzas.configurar_alertas', 'PASE', 'Financiero', 'Configurar thresholds anomaly detection', 'SENSIBLE'),
  ('finanzas.gestionar_bank_rules', 'PASE', 'Financiero', 'Reglas conciliación bancaria', 'SENSIBLE'),
  ('caja.ver_movimientos', 'PASE', 'Operación', 'Ver movimientos de caja', 'NORMAL'),
  ('caja.crear_movimiento', 'PASE', 'Operación', 'Crear movimientos de caja', 'NORMAL'),
  ('caja.transferir_same_local', 'PASE', 'Operación', 'Transferir entre cuentas del mismo local', 'NORMAL'),
  ('caja.transferir_cross_local', 'PASE', 'Financiero', 'Transferir entre locales', 'SENSIBLE'),
  ('caja.anular_movimiento', 'PASE', 'Operación', 'Anular movimientos', 'SENSIBLE'),

  -- COMANDA slugs
  ('comanda.cobrar', 'COMANDA', 'Venta', 'Cobrar ventas en POS', 'NORMAL'),
  ('comanda.marcar_86', 'COMANDA', 'Operación', 'Marcar items agotados', 'NORMAL'),
  ('comanda.open_item', 'COMANDA', 'Venta', 'Vender items no catalogados', 'NORMAL'),
  ('comanda.aplicar_descuento_chico', 'COMANDA', 'Venta', 'Descuentos hasta umbral', 'NORMAL'),
  ('comanda.aplicar_descuento_grande', 'COMANDA', 'Venta', 'Descuentos sobre umbral', 'SENSIBLE'),
  ('comanda.anular_venta', 'COMANDA', 'Venta', 'Anular ventas', 'SENSIBLE'),
  ('comanda.cortesia', 'COMANDA', 'Venta', 'Marcar items como cortesía', 'SENSIBLE'),
  ('comanda.cambiar_precio_item', 'COMANDA', 'Venta', 'Modificar precio en venta', 'SENSIBLE'),
  ('comanda.manager_override', 'COMANDA', 'Manager', 'Aprobar overrides de cajeros', 'CRITICO'),
  ('comanda.kds_marcar_listo', 'COMANDA', 'Cocina', 'Bumping en KDS', 'NORMAL'),
  ('comanda.cerrar_caja', 'COMANDA', 'Caja', 'Cerrar caja del turno', 'NORMAL'),
  ('comanda.justificar_diferencia', 'COMANDA', 'Caja', 'Justificar diferencias de caja', 'SENSIBLE'),
  ('comanda.abrir_caja', 'COMANDA', 'Caja', 'Abrir caja del turno', 'NORMAL'),
  ('comanda.reabrir_venta', 'COMANDA', 'Venta', 'Reabrir venta cerrada', 'CRITICO'),
  ('comanda.salon_admin', 'COMANDA', 'Salón', 'Administrar layout del salón', 'NORMAL'),
  ('comanda.crear_transferencia', 'COMANDA', 'Stock', 'Crear transferencias entre locales', 'NORMAL'),
  ('comanda.recibir_transferencia', 'COMANDA', 'Stock', 'Confirmar recepción de transferencia', 'NORMAL'),
  ('comanda.imprimir_tickets', 'COMANDA', 'Operación', 'Imprimir/reimprimir tickets', 'NORMAL'),
  ('comanda.configurar_estaciones', 'COMANDA', 'Cocina', 'Configurar estaciones de cocina', 'NORMAL');
```

#### `permisos_history` (audit log)

```sql
CREATE TABLE permisos_history (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  created_at      timestamptz NOT NULL DEFAULT now(),

  usuario_id_afectado int NOT NULL,            -- referenced from usuarios o comanda_usuarios
  app             text NOT NULL CHECK (app IN ('PASE','COMANDA')),
  slug            text NOT NULL,

  accion          text NOT NULL CHECK (accion IN ('GRANT','REVOKE')),
  antes           boolean,                     -- valor previo
  despues         boolean,                     -- valor nuevo

  usuario_id_que_cambio int REFERENCES usuarios(id),
  motivo          text,
  ip              text,
  user_agent      text
);

CREATE INDEX ON permisos_history(tenant_id, usuario_id_afectado, created_at DESC);
CREATE INDEX ON permisos_history(tenant_id, created_at DESC);
```

#### `solicitudes_permiso` (workflow approval para CRITICO)

```sql
CREATE TABLE solicitudes_permiso (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  solicitado_por  int REFERENCES usuarios(id),

  usuario_id_target int NOT NULL,
  app             text NOT NULL,
  slug            text NOT NULL,
  accion          text NOT NULL CHECK (accion IN ('GRANT','REVOKE')),
  motivo          text,

  estado          text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN (
                    'PENDIENTE','APROBADA','RECHAZADA','EXPIRADA'
                  )),
  resuelta_at     timestamptz,
  resuelta_por    int REFERENCES usuarios(id),
  notas_resolucion text,

  expira_at       timestamptz                   -- 7 días por default
);

CREATE INDEX ON solicitudes_permiso(tenant_id, estado);
```

### 3.2. Tablas modificadas

#### `usuario_permisos` (existe, formalización)

```sql
-- Agregar FK al catálogo:
ALTER TABLE usuario_permisos
  ADD CONSTRAINT fk_slug_catalogo
  FOREIGN KEY (slug) REFERENCES permiso_catalogo(slug);

-- Agregar columna activo (soft delete en vez de quitar):
ALTER TABLE usuario_permisos ADD COLUMN activo boolean NOT NULL DEFAULT true;
ALTER TABLE usuario_permisos ADD COLUMN granted_by int REFERENCES usuarios(id);
ALTER TABLE usuario_permisos ADD COLUMN granted_at timestamptz DEFAULT now();
```

#### `comanda_usuario_permisos` (asumiendo existe — sino crear similar)

```sql
ALTER TABLE comanda_usuario_permisos
  ADD CONSTRAINT fk_slug_catalogo_comanda
  FOREIGN KEY (slug) REFERENCES permiso_catalogo(slug);
```

#### `usuarios`

```sql
ALTER TABLE usuarios ADD COLUMN rol_template text;
-- Solo informativo: cuál template se aplicó. Cambios post-asignación
-- NO actualizan el template (template es seed).
```

### 3.3. Templates de roles (en código, no DB)

```typescript
// packages/pase/src/lib/permission_templates.ts

export const ROLE_TEMPLATES: Record<string, RoleTemplate> = {
  DUENO: {
    nombre: 'Dueño',
    descripcion: 'Acceso total a PASE y COMANDA',
    permisos_pase: ['*'],
    permisos_comanda: ['*'],
  },

  ENCARGADO_PASE: {
    nombre: 'Encargado PASE',
    descripcion: 'Operación + RRHH + Compras, NO finanzas sensibles',
    permisos_pase: [
      'rrhh.gestionar',
      'catalogo.ver', 'catalogo.editar_items',
      'compras.generar_oc', 'compras.recibir', 'compras.cargar_factura',
      'stock.ver', 'stock.cargar_merma', 'stock.contar',
      'caja.ver_movimientos', 'caja.crear_movimiento', 'caja.transferir_same_local',
      'finanzas.firmar_dsr', 'finanzas.ver_dsr',
    ],
    permisos_comanda: [],
  },

  CONTADOR: {
    nombre: 'Contador',
    descripcion: 'Solo Finanzas + EERR + lectura compras',
    permisos_pase: [
      'finanzas.ver_pl',                       // CRITICO — requiere approval
      'finanzas.ver_dsr',
      'catalogo.ver', 'catalogo.ver_costos',   // SENSIBLE
      'rrhh.gestionar', 'rrhh.ver_sueldos',    // SENSIBLE
      'caja.ver_movimientos',
      'compras.cargar_factura', 'compras.pagar_factura',
    ],
    permisos_comanda: [],
  },

  MANAGER_LOCAL: {
    nombre: 'Manager Local',
    descripcion: 'COMANDA full + PASE lectura del local asignado',
    permisos_pase: [
      'rrhh.gestionar',
      'catalogo.ver',
      'stock.ver', 'stock.ver_avt',
      'caja.ver_movimientos',
      'finanzas.firmar_dsr', 'finanzas.ver_dsr',
      'compras.recibir',
    ],
    permisos_comanda: [
      'comanda.cobrar', 'comanda.marcar_86', 'comanda.open_item',
      'comanda.aplicar_descuento_chico', 'comanda.aplicar_descuento_grande',
      'comanda.anular_venta', 'comanda.cortesia', 'comanda.cambiar_precio_item',
      'comanda.manager_override',              // CRITICO
      'comanda.kds_marcar_listo', 'comanda.cerrar_caja', 'comanda.abrir_caja',
      'comanda.justificar_diferencia', 'comanda.reabrir_venta',
      'comanda.salon_admin',
      'comanda.crear_transferencia', 'comanda.recibir_transferencia',
      'comanda.imprimir_tickets',
    ],
  },

  CAJERO: {
    nombre: 'Cajero',
    descripcion: 'COMANDA básico: cobrar + 86 + open_item',
    permisos_pase: [],
    permisos_comanda: [
      'comanda.cobrar',
      'comanda.marcar_86',
      'comanda.open_item',
      'comanda.aplicar_descuento_chico',
      'comanda.kds_marcar_listo',
      'comanda.cerrar_caja', 'comanda.abrir_caja',
      'comanda.imprimir_tickets',
    ],
  },

  MOZO: {
    nombre: 'Mozo',
    descripcion: 'COMANDA mesas + handheld, sin caja',
    permisos_pase: [],
    permisos_comanda: [
      'comanda.cobrar',                        // cobra desde handheld
      'comanda.marcar_86',
      'comanda.aplicar_descuento_chico',
      'comanda.kds_marcar_listo',
      'comanda.imprimir_tickets',
    ],
  },

  COCINERO: {
    nombre: 'Cocinero',
    descripcion: 'KDS + mermas, sin ventas',
    permisos_pase: [],
    permisos_comanda: [
      'comanda.kds_marcar_listo',
      'stock.cargar_merma',
    ],
  },

  BARTENDER: {
    nombre: 'Bartender',
    descripcion: 'KDS bar + ventas bebidas, sin descuentos',
    permisos_pase: [],
    permisos_comanda: [
      'comanda.cobrar',
      'comanda.marcar_86',
      'comanda.kds_marcar_listo',
      'stock.cargar_merma',
    ],
  },

  RIDER: {
    nombre: 'Rider',
    descripcion: 'Solo RiderPWA',
    permisos_pase: [],
    permisos_comanda: ['comanda.rider'],       // slug específico de delivery
  },

  SOLO_LECTURA: {
    nombre: 'Solo lectura',
    descripcion: 'Read-only general — auditor externo',
    permisos_pase: [
      'catalogo.ver',
      'stock.ver',
      'caja.ver_movimientos',
      'finanzas.ver_dsr',
    ],
    permisos_comanda: [],
  },
};
```

### 3.4. RLS y permisos sobre `permiso_catalogo`

```sql
ALTER TABLE permiso_catalogo ENABLE ROW LEVEL SECURITY;

-- Catálogo es lectura abierta (todos los usuarios pueden ver qué permisos existen):
CREATE POLICY catalog_read_open ON permiso_catalogo FOR SELECT
  USING (true);

-- Escritura solo superadmin (mantener catálogo es admin del sistema):
CREATE POLICY catalog_write_superadmin ON permiso_catalogo FOR ALL
  USING (auth_es_superadmin());

-- permisos_history: tenant_isolated read
CREATE POLICY tenant_history_read ON permisos_history FOR SELECT
  USING (tenant_id = auth_tenant_id());

-- solicitudes_permiso: tenant_isolated, solo dueño/admin pueden resolver
CREATE POLICY tenant_solicitudes ON solicitudes_permiso
  USING (tenant_id = auth_tenant_id());
```

---

## 4. RPCs y endpoints

### 4.1. `fn_asignar_rol_template`

```sql
CREATE OR REPLACE FUNCTION fn_asignar_rol_template(
  p_usuario_id int,
  p_template_id text,
  p_aplicar_a_comanda boolean DEFAULT true
) RETURNS void AS $$
BEGIN
  -- 1. Auth check (admin/dueño)
  -- 2. Lookup template (en código TS, NO DB — esto sería un endpoint REST)
  -- 3. Para cada slug en permisos_pase:
  --    INSERT en usuario_permisos
  --    LOG en permisos_history
  -- 4. Si aplicar_a_comanda y existe comanda_usuario:
  --    Para cada slug en permisos_comanda:
  --      INSERT en comanda_usuario_permisos
  --      LOG en permisos_history
  -- 5. Update usuarios.rol_template
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

(Nota: como los templates viven en TS, esto es realmente un endpoint REST `/api/asignar-rol` que llama a la RPC `fn_grant_permisos_batch`.)

### 4.2. `fn_grant_permiso`

```sql
CREATE OR REPLACE FUNCTION fn_grant_permiso(
  p_usuario_id int,
  p_app text,
  p_slug text,
  p_motivo text
) RETURNS void AS $$
DECLARE v_sensibilidad text;
BEGIN
  -- 1. Auth check (admin/dueño)
  -- 2. Lookup sensibilidad en permiso_catalogo
  -- 3. Si sensibilidad = CRITICO:
  --    Si no viene del flow de solicitud aprobada, REJECT
  -- 4. INSERT en usuario_permisos o comanda_usuario_permisos
  -- 5. LOG en permisos_history (con motivo, ip, user_agent)
  -- 6. Trigger notif al usuario afectado
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.3. `fn_revoke_permiso`

Similar pero quita el permiso. CRITICO también requiere flow de solicitud.

### 4.4. `fn_solicitar_permiso_critico`

```sql
CREATE OR REPLACE FUNCTION fn_solicitar_permiso_critico(
  p_usuario_id_target int,
  p_app text,
  p_slug text,
  p_accion text,
  p_motivo text
) RETURNS uuid AS $$
BEGIN
  -- 1. Validar que slug existe y es CRITICO
  -- 2. Insert en solicitudes_permiso con estado=PENDIENTE, expira_at=now()+7d
  -- 3. Notif al dueño (push)
  -- 4. Retornar solicitud_id
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.5. `fn_resolver_solicitud_permiso`

```sql
CREATE OR REPLACE FUNCTION fn_resolver_solicitud_permiso(
  p_solicitud_id uuid,
  p_aprobar boolean,
  p_2fa_code text,
  p_notas text
) RETURNS void AS $$
BEGIN
  -- 1. Validar 2FA del dueño (si aprobar=true y slug es CRITICO)
  -- 2. Update solicitudes_permiso: estado, resuelta_at, resuelta_por
  -- 3. Si aprobada: ejecutar fn_grant_permiso o fn_revoke_permiso
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.6. `fn_crear_usuario_con_rol`

Endpoint REST `/api/crear-usuario`:

```javascript
async function crearUsuario(body) {
  // 1. Crear auth.users via Supabase Auth admin
  // 2. INSERT usuarios (PASE profile)
  // 3. Si role_template incluye comanda: INSERT comanda_usuarios
  // 4. Asignar usuario_locales
  // 5. Llamar fn_asignar_rol_template
  // 6. Mandar email de bienvenida con password temporal
  // 7. Retornar nuevo usuario
}
```

### 4.7. `/api/permisos/efectivos`

GET endpoint que devuelve permisos efectivos del usuario logueado:
```typescript
{
  pase: ['rrhh.gestionar', 'catalogo.ver', ...],
  comanda: ['comanda.cobrar', 'comanda.marcar_86', ...],
  locales: [1, 4],              // local_ids visibles
  rol_template: 'MANAGER_LOCAL',
  ultima_actualizacion: '2026-05-28T10:30:00Z',
}
```

Cache 5 min en sessionStorage. Invalidación via Realtime al cambiar permisos.

---

## 5. UX / Wireframes

### 5.1. Pantalla Usuarios (refactor)

```
┌──────────────────────────────────────────────────────────────────┐
│ Usuarios                                          [+ Nuevo usuario]│
├──────────────────────────────────────────────────────────────────┤
│ Filtros: [App: Todos ▼] [Rol: Todos ▼] [Local ▼] [Activos ▼]     │
├──────────────────────────────────────────────────────────────────┤
│ Nombre              │ Rol             │ App        │ Locales      │
│ ─────────────────────────────────────────────────────────────────│
│ Lucas Ferrari       │ Dueño           │ PASE+COMAN│ Todos        │
│ Anto Pereira        │ Encargado PASE  │ PASE      │ Todos        │
│ Pedro Salinas       │ Cocinero        │ COMANDA   │ Belgrano     │
│ Camilo Argañaraz    │ Cajero          │ COMANDA   │ Belgrano     │
│ Marcelo F.          │ Manager Local   │ PASE+COMAN│ V.Crespo     │
│ Sofía García        │ Cajero          │ COMANDA   │ V.Crespo     │
│ ...                                                                │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2. Vista detalle de usuario

```
┌──────────────────────────────────────────────────────────────────┐
│ ← Volver a Usuarios                                               │
│                                                                   │
│ Camilo Argañaraz                            [Desactivar usuario] │
│ camilo@neko.ar                                                    │
│ Rol asignado: Cajero · Última login: hace 2h                     │
├──────────────────────────────────────────────────────────────────┤
│ TABS: [Datos] [PASE perm] [COMANDA perm] [Locales] [Audit]      │
├──────────────────────────────────────────────────────────────────┤
│ (Si tab PASE perm seleccionado)                                   │
│ Permisos PASE                                                      │
│ [Asignar otro rol template ▼]                                    │
│                                                                   │
│ ✗ Sin permisos PASE                                               │
│ Este usuario solo opera COMANDA. Para sumarle PASE permisos,     │
│ asigná rol template o agregá manual.                              │
│                                                                   │
│ [+ Agregar permiso individual]                                    │
├──────────────────────────────────────────────────────────────────┤
│ (Si tab COMANDA perm seleccionado)                                │
│ Permisos COMANDA                                                   │
│                                                                   │
│ Venta                                                              │
│ ☑ comanda.cobrar              Cobrar ventas en POS               │
│ ☑ comanda.open_item           Vender items no catalogados        │
│ ☑ comanda.aplicar_descuento_chico  Descuentos hasta 15%          │
│ ☐ comanda.aplicar_descuento_grande ⚠️ Descuentos sobre 15%        │
│ ☐ comanda.anular_venta        ⚠️ Anular ventas                    │
│ ☐ comanda.cortesia            ⚠️ Marcar como cortesía             │
│                                                                   │
│ Operación                                                          │
│ ☑ comanda.marcar_86           Marcar items agotados              │
│ ☑ comanda.kds_marcar_listo    Bumping en KDS                     │
│ ☑ comanda.imprimir_tickets    Imprimir tickets                   │
│                                                                   │
│ Caja                                                              │
│ ☑ comanda.abrir_caja          Abrir caja del turno               │
│ ☑ comanda.cerrar_caja         Cerrar caja del turno              │
│ ☐ comanda.justificar_diferencia ⚠️ Justificar diferencias        │
│                                                                   │
│ Manager (CRITICO)                                                 │
│ ☐ comanda.manager_override    🔴 Aprobar overrides (requiere 2FA)│
│                                                                   │
│                              [Cancelar] [Guardar cambios]         │
└──────────────────────────────────────────────────────────────────┘
```

### 5.3. Audit log de un usuario

```
┌──────────────────────────────────────────────────────────────────┐
│ Audit — Camilo Argañaraz                                         │
├──────────────────────────────────────────────────────────────────┤
│ 28-may 10:30 · Lucas asignó rol template "Cajero"                │
│   ✅ Permisos otorgados: cobrar, open_item, descuento_chico, etc │
│                                                                   │
│ 15-may 14:22 · Anto otorgó comanda.cortesia                       │
│   Motivo: "Capacitación para cubrir turno extra"                  │
│   ⚠️ Permiso SENSIBLE                                              │
│                                                                   │
│ 10-may 09:15 · Sistema otorgó comanda.cobrar (creación inicial)  │
└──────────────────────────────────────────────────────────────────┘
```

### 5.4. Solicitud de permiso CRITICO

```
┌──────────────────────────────────────────────────────────────────┐
│ Asignar permiso CRITICO                                           │
├──────────────────────────────────────────────────────────────────┤
│ Usuario: Camilo Argañaraz                                         │
│ Permiso: comanda.manager_override                                 │
│ Acción: GRANT                                                     │
│                                                                   │
│ Motivo: [Capacitación nuevo manager local Belgrano  ]            │
│                                                                   │
│ ⚠️ Este es un permiso CRITICO.                                    │
│ Confirmá con tu código 2FA del celu:                              │
│                                                                   │
│ Código: [______]                                                  │
│                                                                   │
│                          [Cancelar]  [Confirmar y asignar]       │
└──────────────────────────────────────────────────────────────────┘
```

### 5.5. Onboarding usuario nuevo

```
┌──────────────────────────────────────────────────────────────────┐
│ Crear nuevo usuario                                               │
├──────────────────────────────────────────────────────────────────┤
│ Datos personales                                                  │
│ Nombre: [_______________]                                         │
│ Email:  [_______________]                                         │
│ Teléfono: [_______________] (opcional, para 2FA)                  │
│                                                                   │
│ Rol                                                               │
│ [Cajero ▼]                                                        │
│   → COMANDA básico: cobrar, marcar 86, abrir/cerrar caja          │
│                                                                   │
│ ¿También crear perfil COMANDA?                                    │
│ ⚫ Sí (recomendado — el rol incluye permisos COMANDA)             │
│ ⚪ Solo PASE                                                       │
│                                                                   │
│ Locales asignados                                                 │
│ ☑ Belgrano                                                        │
│ ☐ Villa Crespo                                                    │
│ ☐ Devoto                                                          │
│ ☐ Maneki                                                          │
│ ☐ Rene Cantina                                                    │
│                                                                   │
│ Password temporal: [generado automático]                          │
│ ☑ Forzar cambio de password al primer login                      │
│ ☑ Enviar email de bienvenida con instrucciones                   │
├──────────────────────────────────────────────────────────────────┤
│                              [Cancelar]  [Crear usuario]          │
└──────────────────────────────────────────────────────────────────┘
```

### 5.6. Vista comparativa de roles

```
┌──────────────────────────────────────────────────────────────────┐
│ Roles disponibles                                                 │
├──────────────────────────────────────────────────────────────────┤
│ Buscar template: [_____________]                                  │
│                                                                   │
│ ┌────────────────┬─────────────────────────────────────────────┐ │
│ │ DUEÑO          │ Todo + Todo                                  │ │
│ │ ENCARGADO PASE │ Operación + RRHH + Compras, sin finanzas    │ │
│ │ CONTADOR       │ Solo Finanzas + EERR + lectura compras      │ │
│ │ MANAGER LOCAL  │ COMANDA full + PASE lectura local           │ │
│ │ CAJERO         │ COMANDA: cobrar + 86 + open_item            │ │
│ │ MOZO           │ COMANDA: cobrar + handheld + mesas          │ │
│ │ COCINERO       │ COMANDA: KDS + mermas                        │ │
│ │ BARTENDER      │ COMANDA: KDS bar + ventas bebidas           │ │
│ │ RIDER          │ COMANDA: RiderPWA                            │ │
│ │ SOLO LECTURA   │ PASE: read-only general                      │ │
│ └────────────────┴─────────────────────────────────────────────┘ │
│                                                                   │
│ Click en un template para ver el detalle de permisos              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Plan de despliegue

### Fase 0 — Schema en producción (1 día)
- 3 tablas nuevas (`permiso_catalogo`, `permisos_history`, `solicitudes_permiso`)
- Seed completo del catálogo (~50 slugs)
- ALTERs a `usuario_permisos`, `comanda_usuario_permisos`, `usuarios`
- 6 RPCs nuevas
- Cron: cleanup de solicitudes_permiso expiradas

### Fase 1 — UI nueva bajo feature flag `permisos_v2` (1-2 semanas)
- Refactor pantalla Usuarios (lista + detalle con tabs)
- Selector de rol template + UI de asignación
- Vista checkboxes con grupos + sensibilidad visual
- Audit log de cambios
- Flow solicitud CRITICO con 2FA
- Onboarding wizard usuario nuevo
- Vista comparativa de roles

### Fase 2 — Cutover (1 semana)
- Activar para Lucas + Anto
- Migration backward-compatible: usuarios existentes siguen funcionando
- Aplicar templates retroactivamente solo si Lucas lo aprueba (no automático)
- Activar para todos

### Fase 3 — Cleanup (90 días)
- Validar que todos los slugs hardcoded en TS están en el catálogo
- Eliminar lookups duplicados
- Documentar para vendedores del sistema

---

## 7. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Migration rompe permisos existentes | Baja | Crítico | Schema additivo. Permisos existentes siguen funcionando. |
| Template equivocado a usuario sensible | Media | Alto | Confirmación visible con preview de permisos antes de aplicar. |
| Cambios CRITICO sin 2FA | Baja | Crítico | RPC valida 2FA antes de aplicar. Sin código → reject. |
| Cache stale después de cambio | Alta | Bajo | Invalidación via Realtime + check fresh al inicio de cada operación sensible. |
| Audit log crece muchísimo | Media | Bajo | Partición por mes + archivo trimestral a tabla histórica. |
| Slugs nuevos en specs futuros se olvidan seedear | Alta | Bajo | Lint rule: lookup en catálogo es obligatorio al usar `tienePermiso(slug)`. |

---

## 8. Open questions

1. **Tenant-level templates custom**: ¿permitir que cada tenant cree sus propios templates además de los del sistema? Recomendación: v2.

2. **Permisos temporarios**: ¿soportar "Camilo tiene `comanda.cortesia` solo hasta el 31-jun"? Útil para coberturas. Recomendación: v2 con campo `expira_at` opcional.

3. **Delegation**: ¿el dueño puede delegar "podés asignar permisos hasta X nivel" a un encargado? Recomendación: v2.

4. **Multi-tenant un mismo email**: si Lucas vende PASE a otro restaurante y termina usando el mismo email de auth en 2 tenants, ¿cómo? Recomendación: forzar email único por tenant. Si querés cross-tenant, es otra solución (futuro).

5. **Roles legacy en `usuarios.rol`**: hoy hay 'dueno' / 'admin' / 'encargado' en columna `rol`. ¿Mantener o deprecar? Recomendación: mantener para compatibilidad pero documentar que el sistema fino son los slugs.

---

## 9. Cosas que NO se hacen

- **Multi-tenant identity cross-tenant** (un email no puede usar 2 tenants)
- **Permisos temporales con expiración** → v2
- **Delegation de admin** → v2
- **SAML / SSO empresarial** → v2 cuando haya cliente empresa
- **Audit log forwarding a Splunk/Datadog** → v2

---

## 10. Aprobación y próximos pasos

**Estado actual:** SPEC ESCRITO — pendiente revisión Lucas.

**Próximos:**
1. Lucas revisa
2. Spec #8 (Tienda + Delivery) — OPCIONAL, decidir si va o se difiere
3. Plan holístico con `writing-plans` con set completo

---

**Glosario:**
- **Slug** = identificador único de permiso (ej: `comanda.cobrar`)
- **Template** = receta de permisos pre-armada para un rol típico
- **Sensibilidad** = nivel de riesgo del permiso (NORMAL / SENSIBLE / CRITICO)
- **2FA** = autenticación de 2 factores (código TOTP del celu)
- **Audit log** = registro inmutable de cambios
- **Single identity** = un usuario, un email, un password — múltiples perfiles
- **Dual permissions** = permisos separados PASE / COMANDA en mismo usuario
