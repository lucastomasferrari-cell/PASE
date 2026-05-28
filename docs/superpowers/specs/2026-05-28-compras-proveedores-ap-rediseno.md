# Rediseño Compras + Proveedores + AP — Design Document

**Fecha:** 2026-05-28
**Autor:** brainstorming session (Lucas + Claude — decisiones default profesionales)
**Estado:** 🟡 SPEC ESCRITO — pendiente revisión Lucas
**Approach:** Workflow OC → Remito → Factura → Pago con 3-way match (estándar Toast/R365/MarginEdge/xtraCHEF) + auto-update precios MP + lector IA integrado al flow
**Depende de:** Spec #3 (Stock+CMV) — necesita movimientos_stock para registrar entradas de compra
**Implementación:** ⏸️ DIFERIDA

---

## 1. Resumen ejecutivo

El módulo de Compras actual de PASE funciona pero es **incompleto** vs los sistemas profesionales:
- ✅ Tiene facturas + remitos + proveedores con cuenta corriente parcial
- ❌ No tiene **OC (Orden de Compra)** — solo se cargan facturas cuando llegan
- ❌ No hay **3-way match** (OC + Remito + Factura validados como triángulo)
- ❌ El **lector IA** está aislado del flow (vive en `/lector-facturas-ia` aparte)
- ❌ Cada factura no **auto-actualiza el precio de la materia prima** (hay que hacerlo manual)
- ❌ No hay **vendor catalog** (códigos, precios históricos, performance del proveedor)
- ❌ No hay **approval workflow** para facturas grandes
- ❌ No hay **price trends** ni alertas por subas anómalas

El rediseño completa este loop. Lo más importante: cierra la conexión entre **compra → precio insumo → costo receta → CMV → AvT** que sin esto queda manual y propenso a errores.

**Garantía:** las facturas existentes en producción siguen vivas. Migration de schema es additiva.

**Out of scope (v2):**
- EDI con proveedores (no aplica AR PyMEs)
- Vendor email integration (proveedor manda factura por email → sistema procesa solo)
- AP automation con OCR de cheques

---

## 2. Modelo conceptual

### 2.1. El workflow completo de compra

```
┌──────────────────────────────────────────────────────────────┐
│                                                                │
│  1. ADMIN GENERA OC                                            │
│     └─ basada en "compras sugeridas" (Spec #3) o manual       │
│     └─ Estado: BORRADOR → ENVIADA                              │
│     └─ Items: cantidades + precio acordado por unidad         │
│                                                                │
│  ↓ proveedor entrega                                           │
│                                                                │
│  2. ALGUIEN DEL LOCAL RECIBE EL REMITO                         │
│     └─ Marca qué llegó realmente (puede ser parcial)          │
│     └─ Estado OC: ENVIADA → RECIBIDA_PARCIAL → RECIBIDA_TOTAL │
│     └─ Genera movimientos_stock tipo COMPRA (de Spec #3)      │
│                                                                │
│  ↓ proveedor manda factura                                     │
│                                                                │
│  3. ALGUIEN CARGA LA FACTURA (manual o vía lector IA)         │
│     └─ Sistema hace 3-way match con OC + Remito               │
│     └─ Si match perfecto y monto < umbral → auto-aprobada      │
│     └─ Si match con discrepancia o monto > umbral →           │
│        flag de revisión, requiere approval admin              │
│     └─ Auto-update precio_actual de cada MP                   │
│     └─ Estado OC: RECIBIDA_TOTAL → FACTURADA                   │
│                                                                │
│  ↓ se aprueba el pago                                          │
│                                                                │
│  4. PAGO (puede ser total o parcial)                          │
│     └─ Múltiples métodos: efectivo / transfer / cheque / MP   │
│     └─ Cuenta corriente acumula si pago parcial               │
│     └─ Estado factura: PENDIENTE → PARCIAL → PAGADA           │
│     └─ Genera movimiento de caja (sistema existente)           │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

### 2.2. 3-way match (la validación clave)

Cuando se carga una factura, el sistema valida:

| Campo | OC dice | Remito dice | Factura dice | Match? |
|---|---|---|---|---|
| Item | 10kg Salmón | 9.5kg Salmón | 9.5kg Salmón | ✅ remito y factura coinciden |
| Precio unitario | $15.000/kg | (no aplica) | $15.500/kg | 🟡 +3.3% — flag revisar |
| Cantidad total | 10kg | 9.5kg | 9.5kg | ✅ |
| Total | $150.000 | (no aplica) | $147.250 | 🟡 diff por precio unitario |

**Tolerancias configurables** por tenant:
- Precio: ±2% default (subas chicas auto-aprueban)
- Cantidad: ±1 unidad o ±2% lo que sea mayor (peso variable en carne/pescado)

**Si todo dentro de tolerancia + monto < umbral aprobación**: factura se auto-aprueba.
**Si alguna discrepancia o monto > umbral**: factura entra a bandeja de revisión, admin la mira manualmente.

### 2.3. Auto-update de precio de materia prima

Cuando se carga factura aprobada:

```sql
-- Por cada factura_item:
UPDATE materias_primas
SET precio_actual = factura_item.precio_unitario,
    precio_actualizado_at = factura.fecha
WHERE id = factura_item.materia_prima_id
  AND factura.fecha > materias_primas.precio_actualizado_at;
-- Solo actualiza si la factura es más reciente que el último update
```

Y como `insumos.costo_actual` es promedio ponderado de MPs activas (Spec #2), se recalcula automáticamente cuando alguna MP cambia.

**Forward-looking** — recetas vendidas con anterioridad NO se recalculan (preservan snapshot histórico).

### 2.4. Vendor catalog

Cada proveedor tiene su propio catálogo de items con código + precio histórico:

```
Pescadería X (vendor):
├ Código P001 — Salmón entero c/víscera   $14.000/kg (act 2026-05-20)
├ Código P002 — Salmón filete             $22.000/kg (act 2026-05-20)
├ Código P003 — Atún rojo entero          $35.000/kg (act 2026-05-18)
└ Código P004 — Langostino limpio         $18.000/kg (act 2026-05-15)
```

**Cada item del catálogo del proveedor** se mapea a una `materia_prima` interna. Ese mapeo es el "Rosetta Stone" entre el código del proveedor y nuestro catálogo. Permite:
- Lectura IA mucho más precisa (Claude reconoce "P001" como "Salmón entero" directamente)
- Reportes "este proveedor me cobró X veces este item con estos precios"
- Alertas de subas
- Vendor scorecard

### 2.5. Cuenta corriente proveedor

Funciona como hoy pero con más visibilidad:
- Saldo pendiente actual
- Próximas fechas de vencimiento
- Historial de pagos
- **Alertas** de facturas próximas a vencer (configurable, default 7 días antes)
- **Reporte AP aging** (Accounts Payable aging) — qué le debo a quién y desde cuándo (30/60/90 días)

### 2.6. Lector IA integrado al flow

Hoy `/lector-facturas-ia` es una pantalla aparte que carga facturas. **Lo movemos al flow normal**:

1. Admin entra a Compras → Cargar factura
2. Wizard ofrece 2 modos:
   - **Manual** — escribís todo (modo viejo)
   - **Con IA** — subís foto/PDF → Claude extrae → revisás → confirmás
3. **Si vino del lector IA**, sistema intenta hacer auto-match con OC pendiente del proveedor:
   - Si encuentra OC con coincidencia alta (>85%) → pre-rellena los items
   - Si no encuentra → admin asigna manualmente
4. Al confirmar, sigue el flow normal (3-way match, approval, etc.)

**Beneficio**: el lector IA deja de ser un "shortcut paralelo" y se vuelve la forma estándar de cargar facturas.

### 2.7. Approval workflow

**Umbral configurable por tenant** (default $500.000):

| Caso | Approval requerido |
|---|---|
| Match perfecto + monto < umbral | NO (auto-aprobada) |
| Match con discrepancia + cualquier monto | SÍ (admin revisa diff) |
| Monto > umbral (aunque match perfecto) | SÍ |
| Factura sin OC asociada | SÍ siempre |

Workflow: cargada → `pending_approval` → admin aprueba (o rechaza) → `aprobada` o `rechazada`.

Approval queda en log con quién + cuándo + comentario opcional.

### 2.8. Pagos

- **Múltiples métodos**: efectivo, transferencia, cheque, MP, banco (reutiliza tabla `medios_cobro` existente)
- **Pago parcial permitido** — cuenta corriente acumula
- **Pago batch** — modal "Pagar varias facturas del mismo proveedor de una vez"
- **Generación automática de movimiento de caja** (sistema existente)
- **Conciliación bancaria** — match con extracto bancario (refinement de lo existente)

### 2.9. Vendor scorecard

Reporte que muestra performance de cada proveedor:

| Métrica | Cálculo |
|---|---|
| **Reliability** | % de OCs entregadas a tiempo |
| **Quality** | % de items sin discrepancia en remito |
| **Price stability** | desvío estándar del precio en últimos 6 meses |
| **Match accuracy** | % de facturas con 3-way match perfecto |
| **Spending share** | % del total que compraste a este proveedor |

Ayuda a decidir con qué proveedor consolidar compras y cuál reemplazar.

---

## 3. Schema de datos

### 3.1. Tablas nuevas

#### `ordenes_compra`

```sql
CREATE TABLE ordenes_compra (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),
  proveedor_id    int NOT NULL REFERENCES proveedores(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      int REFERENCES usuarios(id),

  numero          text NOT NULL,                -- numeración interna OC-2026-001234
  fecha_emision   date NOT NULL,
  fecha_entrega_estimada date,

  estado          text NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN (
                    'BORRADOR','ENVIADA','RECIBIDA_PARCIAL','RECIBIDA_TOTAL',
                    'FACTURADA','PAGADA','ANULADA'
                  )),

  subtotal        numeric(15,2),
  iva             numeric(15,2),
  total           numeric(15,2),
  notas           text,

  enviada_at      timestamptz,
  recibida_at     timestamptz,                  -- cuando estado=RECIBIDA_TOTAL
  facturada_at    timestamptz,
  anulada_at      timestamptz,
  anulada_motivo  text
);

CREATE TABLE ordenes_compra_items (
  id              bigserial PRIMARY KEY,
  oc_id           bigint NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,

  materia_prima_id bigint NOT NULL REFERENCES materias_primas(id),
  codigo_proveedor text,                       -- del vendor catalog si aplica

  cantidad_pedida numeric(12,4) NOT NULL,
  cantidad_recibida numeric(12,4) NOT NULL DEFAULT 0,
  unidad          text NOT NULL,

  precio_unitario_acordado numeric(12,2) NOT NULL,
  subtotal        numeric(15,2) GENERATED ALWAYS AS
                    (cantidad_pedida * precio_unitario_acordado) STORED,

  notas           text
);

CREATE INDEX ON ordenes_compra(tenant_id, local_id, estado, fecha_emision DESC);
CREATE INDEX ON ordenes_compra(tenant_id, proveedor_id, estado);
CREATE INDEX ON ordenes_compra_items(oc_id);
```

#### `vendor_catalog`

```sql
CREATE TABLE vendor_catalog (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  proveedor_id    int NOT NULL REFERENCES proveedores(id),
  materia_prima_id bigint NOT NULL REFERENCES materias_primas(id),

  codigo_proveedor text NOT NULL,              -- ej "P001"
  nombre_proveedor text NOT NULL,              -- ej "Salmón entero c/víscera"
  unidad_venta    text NOT NULL,               -- como lo vende el proveedor

  precio_actual   numeric(12,2) NOT NULL,
  precio_actualizado_at timestamptz NOT NULL DEFAULT now(),

  activo          boolean NOT NULL DEFAULT true,

  UNIQUE (tenant_id, proveedor_id, codigo_proveedor)
);

CREATE INDEX ON vendor_catalog(tenant_id, proveedor_id, activo);
CREATE INDEX ON vendor_catalog(tenant_id, materia_prima_id);
```

#### `vendor_catalog_precio_history`

Para reportes de price trends:

```sql
CREATE TABLE vendor_catalog_precio_history (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  vendor_catalog_id bigint NOT NULL REFERENCES vendor_catalog(id),

  precio          numeric(12,2) NOT NULL,
  fuente          text NOT NULL CHECK (fuente IN ('FACTURA','MANUAL','IA')),
  factura_id      bigint REFERENCES facturas(id),
  cambio_pct      numeric(6,2),                -- vs precio anterior

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON vendor_catalog_precio_history(vendor_catalog_id, created_at DESC);
```

### 3.2. Tablas modificadas

#### `facturas`

Hoy existe. Agregamos:

```sql
ALTER TABLE facturas ADD COLUMN oc_id bigint REFERENCES ordenes_compra(id);
ALTER TABLE facturas ADD COLUMN remito_id bigint REFERENCES remitos(id);

ALTER TABLE facturas ADD COLUMN match_status text NOT NULL DEFAULT 'PENDING' CHECK (match_status IN (
  'PENDING','MATCH_OK','MATCH_DISCREPANCIA','NO_OC'
));

ALTER TABLE facturas ADD COLUMN approval_status text NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN (
  'PENDING','AUTO_APPROVED','APPROVED','REJECTED'
));
ALTER TABLE facturas ADD COLUMN approved_by int REFERENCES usuarios(id);
ALTER TABLE facturas ADD COLUMN approved_at timestamptz;
ALTER TABLE facturas ADD COLUMN approval_notes text;

ALTER TABLE facturas ADD COLUMN ia_extraida boolean NOT NULL DEFAULT false;
ALTER TABLE facturas ADD COLUMN ia_confianza_pct numeric(5,2);
ALTER TABLE facturas ADD COLUMN archivo_original_url text;
```

#### `factura_items`

```sql
ALTER TABLE factura_items ADD COLUMN materia_prima_id bigint REFERENCES materias_primas(id);
ALTER TABLE factura_items ADD COLUMN oc_item_id bigint REFERENCES ordenes_compra_items(id);

ALTER TABLE factura_items ADD COLUMN match_precio_status text CHECK (match_precio_status IN ('OK','WARN','FAIL'));
ALTER TABLE factura_items ADD COLUMN match_cantidad_status text CHECK (match_cantidad_status IN ('OK','WARN','FAIL'));
```

#### `proveedores`

```sql
ALTER TABLE proveedores ADD COLUMN tiempo_entrega_promedio_dias numeric(4,1);
ALTER TABLE proveedores ADD COLUMN tiempo_pago_acordado_dias int DEFAULT 30;
ALTER TABLE proveedores ADD COLUMN umbral_aprobacion_facturas numeric(15,2);  -- override del tenant default
ALTER TABLE proveedores ADD COLUMN ranking_calidad int CHECK (ranking_calidad BETWEEN 1 AND 5);
```

#### `tenant_config` (suponiendo existe — sino crear)

```sql
ALTER TABLE tenants ADD COLUMN compras_config jsonb DEFAULT '{}';
-- Ejemplo:
-- {
--   "tolerancia_precio_pct": 2,
--   "tolerancia_cantidad_pct": 2,
--   "umbral_aprobacion_default": 500000,
--   "alerta_vencimiento_dias": 7
-- }
```

### 3.3. RLS policies

Patrón estándar:

```sql
ALTER TABLE ordenes_compra ENABLE ROW LEVEL SECURITY;
ALTER TABLE ordenes_compra_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_catalog_precio_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_local_visible ON ordenes_compra USING (
  tenant_id = auth_tenant_id()
  AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
);

-- (idem para las demás)
```

Permisos nuevos:
- `compras.generar_oc` — crear órdenes de compra
- `compras.recibir` — confirmar recepción de remito
- `compras.cargar_factura` — cargar factura (con o sin IA)
- `compras.aprobar_factura` — aprobar facturas que requieren approval
- `compras.pagar_factura` — ejecutar pago
- `compras.ver_vendor_catalog` — ver catálogo de proveedores
- `compras.editar_vendor_catalog` — modificar catálogo

---

## 4. RPCs nuevas / modificadas

### 4.1. `fn_crear_orden_compra`

```sql
CREATE OR REPLACE FUNCTION fn_crear_orden_compra(
  p_local_id int,
  p_proveedor_id int,
  p_fecha_entrega_estimada date,
  p_items jsonb,                              -- [{materia_prima_id, cantidad, precio}]
  p_notas text,
  p_idempotency_key text DEFAULT NULL
) RETURNS bigint AS $$
BEGIN
  -- 1. Idempotency check
  -- 2. Auth + tenant + local check
  -- 3. Crear ordenes_compra estado='BORRADOR'
  -- 4. Crear ordenes_compra_items
  -- 5. Retornar oc_id
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.2. `fn_enviar_orden_compra`

Marca OC como ENVIADA. Opcionalmente genera PDF + email al proveedor (v1 solo cambia estado, email es v2).

### 4.3. `fn_recibir_remito`

```sql
CREATE OR REPLACE FUNCTION fn_recibir_remito(
  p_oc_id bigint,
  p_items_recibidos jsonb,                    -- [{oc_item_id, cantidad_recibida}]
  p_remito_numero text,
  p_remito_fecha date,
  p_idempotency_key text DEFAULT NULL
) RETURNS bigint AS $$
BEGIN
  -- 1. Idempotency check
  -- 2. Validar OC en estado ENVIADA o RECIBIDA_PARCIAL
  -- 3. Para cada item recibido:
  --    a. Update oc_item.cantidad_recibida
  --    b. Crear movimiento_stock tipo='COMPRA' con cantidad positiva
  -- 4. Si todos los items tienen cantidad_recibida >= cantidad_pedida → estado=RECIBIDA_TOTAL
  --    Si no → estado=RECIBIDA_PARCIAL
  -- 5. Crear remito row + retornar remito_id
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.4. `fn_cargar_factura` (modificación de la existente)

```sql
-- Existe versión actual. Cambios:
-- 1. Aceptar oc_id opcional (link a OC)
-- 2. Aceptar ia_extraida + ia_confianza_pct
-- 3. Hacer 3-way match automático:
--    Por cada factura_item:
--      Si oc_item_id NOT NULL: comparar precio y cantidad vs OC
--      Setear match_precio_status / match_cantidad_status
-- 4. Determinar approval_status:
--    Si match OK + monto < umbral → AUTO_APPROVED
--    Sino → PENDING (queda en bandeja)
-- 5. Si AUTO_APPROVED: ejecutar auto-update precios MP
```

### 4.5. `fn_auto_update_precios_mp`

```sql
CREATE OR REPLACE FUNCTION fn_auto_update_precios_mp(p_factura_id bigint)
RETURNS int AS $$
DECLARE
  v_updated int := 0;
BEGIN
  -- Por cada factura_item:
  --   Si su MP tiene precio_actualizado_at < factura.fecha:
  --     UPDATE materias_primas SET precio_actual = factura_item.precio_unitario
  --     INSERT en vendor_catalog_precio_history
  --     v_updated += 1
  -- Recalcular insumos.costo_actual (promedio ponderado)
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.6. `fn_aprobar_factura` / `fn_rechazar_factura`

```sql
CREATE OR REPLACE FUNCTION fn_aprobar_factura(
  p_factura_id bigint,
  p_notas text
) RETURNS void AS $$
BEGIN
  -- 1. Auth check (permiso compras.aprobar_factura)
  -- 2. Update factura: approval_status='APPROVED', approved_by, approved_at, approval_notes
  -- 3. Ejecutar fn_auto_update_precios_mp(p_factura_id)
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.7. `fn_pagar_factura` (modificación de la existente)

Ya existe con idempotency. Refinement:
- Aceptar pago parcial (cantidad < total restante)
- Si pago completo, factura.estado = 'PAGADA'
- Si pago parcial, factura.estado = 'PARCIAL' (campo nuevo en estado_pago)
- Actualizar cuenta_corriente_proveedor

### 4.8. `fn_pagar_facturas_batch`

```sql
CREATE OR REPLACE FUNCTION fn_pagar_facturas_batch(
  p_proveedor_id int,
  p_factura_ids bigint[],
  p_monto_total numeric,
  p_metodo_pago text,
  p_cuenta text,
  p_idempotency_key text DEFAULT NULL
) RETURNS bigint AS $$
BEGIN
  -- Distribuir p_monto_total entre las facturas en orden de antigüedad
  -- Cada factura recibe lo que necesita hasta agotar p_monto_total
  -- Crear UN solo movimiento de caja con el total
  -- Trazabilidad: cada factura linkea al mismo movimiento_id
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.9. `fn_calcular_vendor_scorecard`

```sql
CREATE OR REPLACE FUNCTION fn_calcular_vendor_scorecard(
  p_proveedor_id int,
  p_fecha_inicio date,
  p_fecha_fin date
) RETURNS TABLE (
  metrica text,
  valor numeric,
  descripcion text
) AS $$
BEGIN
  -- Reliability: % OCs entregadas a tiempo
  -- Quality: % items sin discrepancia en remito
  -- Price stability: desvío estándar precio últimos 6m
  -- Match accuracy: % facturas con 3-way match OK
  -- Spending share: % spending total
  RETURN QUERY ...;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.10. `fn_extraer_factura_ia` (endpoint serverless, no RPC)

Vive en `packages/pase/api/extraer-factura.js`:

```javascript
// Recibe imagen/PDF base64 + proveedor_id opcional
// Llama a Claude con prompt que incluye:
//   - Esquema esperado (items, precio, cantidad, total, fechas)
//   - Catálogo del proveedor si proveedor_id provided
//   - Vendor_catalog para mejorar reconocimiento de items
// Devuelve:
//   - Factura parseada con confianza por campo
//   - Sugerencia de match con OC pendiente si existe
//   - Warnings si algo no está claro
```

---

## 5. UX / Wireframes

### 5.1. Dashboard de Compras (nuevo)

```
┌──────────────────────────────────────────────────────────────────┐
│ Compras                                          [+ Nueva OC]    │
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────────┬──────────────┬──────────────┬──────────────┐ │
│ │ OCs abiertas │ Por aprobar  │ Por pagar    │ Sugerencias  │ │
│ │     12       │      3       │     8        │     5        │ │
│ │ esperando    │ facturas     │ vencen en    │ insumos bajo │ │
│ │ recepción    │              │ <7 días      │ par level    │ │
│ └──────────────┴──────────────┴──────────────┴──────────────┘ │
│                                                                   │
│ ⚠️ Próximos vencimientos:                                         │
│ • Pescadería X — $187k vence en 3 días                           │
│ • Distribuidora A — $89k vence en 5 días                         │
├──────────────────────────────────────────────────────────────────┤
│ TABS: [OCs] [Facturas] [Remitos] [Proveedores] [Vendor Catalog] │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2. Wizard Nueva OC

```
┌──────────────────────────────────────────────────────────────────┐
│ Nueva Orden de Compra — paso 1/3: Proveedor + Local              │
├──────────────────────────────────────────────────────────────────┤
│ Proveedor: [Pescadería X ▼]                                       │
│   ℹ️ Última compra: hace 5 días — $147k                          │
│   ℹ️ Saldo pendiente: $237k                                       │
│   ℹ️ Tiempo entrega promedio: 1.5 días                            │
│                                                                   │
│ Local destino: [Maneki ▼]                                         │
│ Fecha entrega estimada: [29-may-2026]                            │
│                                                                   │
│                                       [Cancelar]  [Siguiente →] │
└──────────────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────────────┐
│ Nueva OC — paso 2/3: Items                                       │
├──────────────────────────────────────────────────────────────────┤
│ 💡 Sugeridos por Spec #3 (compras sugeridas):                    │
│ ☑ Salmón entero (P001)  5kg × $14.000 = $70.000                  │
│ ☑ Atún rojo (P003)      2kg × $35.000 = $70.000                  │
│ ☐ Langostino (P004)     3kg × $18.000 = $54.000                  │
│                                                                   │
│ + Agregar item manual:                                            │
│ [Buscar... 🔍]                                                    │
│                                                                   │
│ TOTAL: $140.000                                                   │
│                                                                   │
│                              [← Atrás]  [Siguiente →]            │
└──────────────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────────────┐
│ Nueva OC — paso 3/3: Confirmar y enviar                          │
├──────────────────────────────────────────────────────────────────┤
│ OC-2026-001234                                                    │
│ Pescadería X → Maneki                                            │
│ Entrega: 29-may                                                   │
│                                                                   │
│ Items:                                                            │
│ • Salmón entero (P001)     5kg × $14k  = $70.000                │
│ • Atún rojo (P003)         2kg × $35k  = $70.000                │
│                                                                   │
│ Subtotal: $140.000                                                │
│ IVA: $29.400                                                      │
│ TOTAL: $169.400                                                   │
│                                                                   │
│ ¿Cómo notificar al proveedor?                                    │
│ ○ Yo le mando por WhatsApp (sistema solo guarda OC)              │
│ ○ Enviar PDF por email (v2 - no implementado todavía)             │
│                                                                   │
│ Notas: [Para cocina central. Avisar a Maneki al llegar.]         │
│                                                                   │
│                          [← Atrás]  [Guardar como BORRADOR]      │
│                                     [Enviar a proveedor]          │
└──────────────────────────────────────────────────────────────────┘
```

### 5.3. Recepción de remito

```
┌──────────────────────────────────────────────────────────────────┐
│ Recibir mercadería — OC-2026-001234                              │
├──────────────────────────────────────────────────────────────────┤
│ Pescadería X — entregó hoy 28-may                                │
│ Cargá qué llegó realmente:                                        │
│                                                                   │
│ Salmón entero (P001) — Pedido: 5kg                               │
│   Recibido: [ 4.85 ] kg  ⚠️ -3% diff (peso variable, OK)         │
│                                                                   │
│ Atún rojo (P003) — Pedido: 2kg                                   │
│   Recibido: [ 2.0 ] kg  ✓ exacto                                  │
│                                                                   │
│ Número de remito: [REM-789012]                                    │
│ Fecha remito: [28-may-2026]                                       │
│                                                                   │
│ ¿La calidad fue buena? ⭐⭐⭐⭐⭐                                   │
│ Notas: [Salmón excelente como siempre]                           │
│                                                                   │
│                              [Cancelar]  [Confirmar recepción]   │
└──────────────────────────────────────────────────────────────────┘
```

Al confirmar: genera `movimientos_stock` tipo COMPRA, transiciona OC a RECIBIDA_TOTAL (o PARCIAL).

### 5.4. Cargar factura (con IA integrada)

```
┌──────────────────────────────────────────────────────────────────┐
│ Cargar factura — Pescadería X                                    │
├──────────────────────────────────────────────────────────────────┤
│ ¿Cómo querés cargar?                                              │
│  [📷 Foto/PDF con IA]   [✍ Escribir manual]                     │
├──────────────────────────────────────────────────────────────────┤
│ (Si eligió IA)                                                    │
│ 📷 Sacá foto de la factura o subí PDF                            │
│ [Arrastrá o click aquí]                                          │
│                                                                   │
│ Procesando con Claude IA... ⏳                                   │
├──────────────────────────────────────────────────────────────────┤
│ Factura extraída (confianza 92%):                                 │
│                                                                   │
│ Número: 0001-00000123                                            │
│ Fecha: 28-may-2026                                                │
│                                                                   │
│ 🔗 Auto-matched con OC-2026-001234 (95% confianza)               │
│                                                                   │
│ Items:                                                            │
│ • Salmón entero P001                                              │
│   IA: 4.85kg × $14.500/kg = $70.325                              │
│   OC: 5kg × $14.000/kg = $70.000                                 │
│   🟡 Precio +3.5% sobre acordado                                  │
│                                                                   │
│ • Atún rojo P003                                                  │
│   IA: 2kg × $35.000/kg = $70.000                                 │
│   OC: 2kg × $35.000/kg = $70.000                                 │
│   ✓ Match perfecto                                                │
│                                                                   │
│ Total IA: $140.325  /  OC: $140.000  /  Diff: +$325               │
│                                                                   │
│ ⚠️ Esta factura requiere APROBACIÓN por la discrepancia de precio│
│                                                                   │
│              [Editar antes de aprobar]  [Confirmar y enviar]     │
└──────────────────────────────────────────────────────────────────┘
```

### 5.5. Bandeja de facturas por aprobar

```
┌──────────────────────────────────────────────────────────────────┐
│ Facturas pendientes de aprobar                                   │
├──────────────────────────────────────────────────────────────────┤
│ Pescadería X — Factura 0001-00000123 — $140.325                  │
│ 🟡 Discrepancia precio: Salmón +3.5%                              │
│ Cargada hace 2h por Anto · OC-2026-001234                        │
│   [Ver detalle]  [Aprobar]  [Rechazar]                            │
├──────────────────────────────────────────────────────────────────┤
│ Distribuidora A — Factura 0002-00000456 — $623.000                │
│ 🔴 Monto > umbral ($500k)                                         │
│ Sin OC asociada · cargada manualmente                            │
│   [Ver detalle]  [Aprobar]  [Rechazar]                            │
└──────────────────────────────────────────────────────────────────┘
```

### 5.6. Vendor catalog

```
┌──────────────────────────────────────────────────────────────────┐
│ Catálogo de Pescadería X                       [+ Agregar item] │
├──────────────────────────────────────────────────────────────────┤
│ Código  │ Nombre proveedor          │ → MP interna   │ Precio   │
│ ───────────────────────────────────────────────────────────────  │
│ P001    │ Salmón entero c/víscera  │ Salmón ent.    │ $14.500  │
│ P002    │ Salmón filete            │ Salmón fillet  │ $22.500  │
│ P003    │ Atún rojo entero         │ Atún rojo      │ $35.000  │
│ P004    │ Langostino limpio        │ Langostino     │ $18.500  │
├──────────────────────────────────────────────────────────────────┤
│ Click en código para ver historial de precios →                  │
└──────────────────────────────────────────────────────────────────┘
```

### 5.7. Vendor scorecard

```
┌──────────────────────────────────────────────────────────────────┐
│ Performance de Pescadería X — últimos 90 días                    │
├──────────────────────────────────────────────────────────────────┤
│ ⭐ Reliability: 95% (38/40 OCs a tiempo)                          │
│ 🎯 Quality: 92% (3 items con discrepancia en remito)              │
│ 📊 Price stability: ±2.1% desviación                              │
│ ✅ Match accuracy: 88% facturas con 3-way OK                      │
│ 💰 Spending share: 34% del total de compras (top proveedor)       │
│                                                                   │
│ Comparativa con otros pescaderos:                                 │
│ • Pescadería Y: Reliability 78%, precio similar — peor opción    │
│ • Pescadería Z: Reliability 99%, precio +8% — más caro pero seg  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Plan de despliegue

### Fase 0 — Schema en producción (1 día)
- 5 tablas nuevas (`ordenes_compra`, `ordenes_compra_items`, `vendor_catalog`, `vendor_catalog_precio_history`)
- ALTERs a `facturas`, `factura_items`, `proveedores`, `tenants`
- 10 RPCs nuevas + modificaciones a las existentes
- Backfills:
  - Facturas existentes: setear match_status='NO_OC', approval_status='AUTO_APPROVED' (legacy)
  - Vendor catalog: poblar desde factura_items históricos (best-effort)

### Fase 1 — UI nueva bajo feature flag `compras_v2` (2 semanas)
- Dashboard de Compras
- Wizard Nueva OC
- Recepción de remito
- Lector IA integrado al flow
- Bandeja approvals
- Vendor catalog UI
- Vendor scorecard

### Fase 2 — Cutover gradual (1 semana)
- Activar `compras_v2` para Lucas + Anto
- Validar 1 ciclo completo (OC → Remito → Factura → Pago)
- Activar para todos
- Marcar `/lector-facturas-ia` viejo como deprecated (link a flow nuevo)

### Fase 3 — Cleanup (90 días)
- Eliminar pantalla vieja del lector IA standalone
- Refactor Compras antigua

### Rollback
Si algo falla:
1. Desactivar `compras_v2` → UI vieja vuelve (sigue cargando facturas sin OC)
2. Las OCs creadas se preservan (futuras pueden usar el flow nuevo)
3. Stock generado por COMPRAS es inmutable (Spec #3 ya lo asegura)

---

## 7. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Anto carga factura sin OC asociada (caso común al principio) | Alta | Bajo | Sistema lo permite con match_status='NO_OC' + requiere approval |
| Lector IA extrae mal y aprueba | Media | Alto | Auto-approval solo si confianza_ia > 90% + match OK. Si IA<90% siempre requiere review humana. |
| Vendor catalog desactualizado | Alta | Medio | Cada factura cargada actualiza precios. Reporte de "items sin compra en >90 días". |
| Discrepancias menores generan demasiados approvals | Media | Medio | Tolerancias configurables. Default conservador, admin afloja con uso real. |
| Proveedor sube precio 15% sin avisar | Alta | Medio | Alerta automática cuando precio sube >5% de un día al otro. |
| Migration de facturas históricas pierde datos | Baja | Alto | NO se modifican facturas viejas. Schema agregado es additiva. Backfill solo de campos nuevos. |

---

## 8. Open questions

1. **OC sin remito explícito**: muchos proveedores AR no emiten remito formal, traen la mercadería directo. ¿Hacemos remito opcional? Recomendación: SÍ. Si el local "recibe mercadería" sin remito, generamos un remito interno con número auto.

2. **Factura sin OC** (caso legacy): siempre va a existir. ¿La permitimos? Recomendación: SÍ con flag obligatorio. Y sugerir crear OC retroactiva.

3. **OC modificable después de enviada**: ¿se puede editar una OC que ya está en estado ENVIADA? Recomendación: NO. Anular y crear nueva.

4. **Múltiples remitos por una OC**: proveedor entrega en 2 viajes. Recomendación: SÍ. OC puede acumular múltiples remitos hasta estado RECIBIDA_TOTAL.

5. **Múltiples facturas por una OC**: idem. Recomendación: SÍ.

6. **Una factura puede cubrir múltiples OCs**: poco común pero posible. Recomendación: SÍ — many-to-many entre facturas y OCs (tabla puente).

7. **IVA per item vs IVA total**: hoy facturas tienen iva total. ¿Necesitamos iva per item? Recomendación: NO en v1 (innecesario para CMV).

8. **Lector IA en idioma**: las facturas AR a veces vienen escaneadas mal. ¿Claude las lee OK? Probado en sprint 2026-05-09: SÍ con threshold de magnitud + coherencia (3 capas de defensa).

---

## 9. Cosas que NO se hacen en este spec

- **EDI integration** con proveedores grandes (Sysco, US Foods) — no aplica AR
- **Vendor email integration** (proveedor manda factura por email automático) — v2
- **OCR de cheques** — v2
- **Auto-OC sin aprobación** — v2 con feature flag por insumo
- **Refactor del módulo Caja** — Spec #5
- **Conciliación bancaria avanzada** — Spec #5

---

## 10. Aprobación y próximos pasos

**Estado actual:** SPEC ESCRITO — pendiente revisión Lucas.

**Próximos:**
1. Lucas revisa
2. Spec #5 (Caja + Finanzas + P&L formato restaurantero)
3. Specs restantes (#6, #7, #8)
4. Plan holístico con `writing-plans`

---

**Glosario:**
- **OC** = Orden de Compra (lo que pedís al proveedor antes de que llegue)
- **Remito** = documento que acompaña la mercadería al llegar (qué entregó)
- **Factura** = documento fiscal por lo que te cobra
- **3-way match** = validar que OC, Remito y Factura coinciden (cantidad, precio, item)
- **AP** = Accounts Payable (cuentas por pagar)
- **AP aging** = cuánto debés a quién y desde cuándo (30/60/90 días)
- **Vendor catalog** = lista de items que vende cada proveedor con sus códigos
- **Lead time** = días que tarda el proveedor en entregar
- **Catch weight** = items con peso variable (carne, pescado)
- **Match tolerance** = % de diferencia aceptable entre lo pedido y lo cobrado
- **Vendor scorecard** = reporte de performance del proveedor (reliability, quality, etc.)
