# Rediseño Catálogo + Recetas + Insumos + CMV — Design Document

**Fecha:** 2026-05-28
**Autor:** brainstorming session (Lucas + Claude)
**Estado:** 🟡 SPEC ESCRITO — pendiente revisión Lucas
**Approach elegido:** Mover catálogo+recetas+insumos+materias primas a PASE, COMANDA solo consume (modelo Toast/Square/R365)
**Implementación:** ⏸️ DIFERIDA — primero completar specs de todas las áreas, después plan holístico

---

## 1. Resumen ejecutivo

El catálogo y todo lo asociado (items, modificadores, combos, recetas, insumos, materias primas) hoy se administra desde **COMANDA**. Esto va **en contra del modelo industrial** que usan Toast, Square, Lightspeed, R365, MarketMan: el catálogo vive en el back-office y el POS solo lo consume.

El rediseño:

1. **Mueve toda la administración a PASE** — COMANDA queda como consumidor real-time vía Supabase Realtime.
2. **Introduce modelo de recetas anidadas 3 capas** (Yield → Prep → Menu Item) con yield % en cada nivel, alineado con R365/Apicbase. Permite:
   - Sub-recetas reusables (salsa teriyaki cambiada en 1 lugar impacta los 8 platos que la usan).
   - Cocina central productora que envía sub-recetas procesadas a locales satélite.
   - CMV preciso con yields reales del procesamiento (pescado fileteado, pollo deshuesado, etc.).
3. **Cocina central como ciudadano de primera clase** — locales pueden ser PRODUCTOR / CONSUMIDOR / MIXTO + tabla `transferencias_internas` para movimientos cross-local.
4. **Lector de recetas con IA** — usuario sube PDF/Excel/foto y Claude propone estructura editable (killer feature inspirada en MarginEdge).
5. **22 decisiones default alineadas con benchmark** documentadas en sección 2.4.

**Garantía no negociable:** la migration preserva el menú actual de Neko intacto. COMANDA sigue vendiendo durante toda la transición.

**Dependencia futura:** este spec habilita Spec #3 (Stock + CMV real con AvT) que depende de tener recetas con yield consolidadas.

---

## 2. Modelo conceptual

### 2.1. División PASE ↔ COMANDA

| Concepto | PASE (back-office) | COMANDA (frontline POS) |
|---|---|---|
| **Crear / editar items** | ✅ admin | ❌ |
| **Crear / editar modificadores** | ✅ admin | ❌ |
| **Crear / editar combos** | ✅ admin | ❌ |
| **Crear / editar recetas** | ✅ admin | ❌ |
| **Crear / editar insumos** | ✅ admin | ❌ |
| **Crear / editar materias primas** | ✅ admin | ❌ |
| **Definir precios** | ✅ admin | ❌ |
| **Ver costos / márgenes** | ✅ admin | ❌ |
| **86 (marcar agotado)** | ✅ visible | ✅ acción frontline |
| **Open Item (cobrar libre)** | ❌ | ✅ (con motivo, va a "no catalogados") |
| **Aplicar descuento** | ❌ | ✅ (con Manager Override si >X%) |
| **Reportar conteo físico** | ❌ | ✅ (acción frontline, app móvil) |
| **Reportar merma** | ❌ | ✅ (con motivo obligatorio) |

### 2.2. La pirámide de 3 capas (modelo profesional R365/Apicbase)

```
┌──────────────────────────────────────────────┐
│  MENU ITEMS (MI)                              │  ← lo que sale al cliente
│  ej: "Combinado 18 piezas $14.500"           │     receta MI = mix
│  Receta apunta a: PREPs + INSUMOS directos   │
└────────────────────┬─────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────┐
│  PREP RECIPES                                 │  ← componentes reusables
│  ej: "Salsa Teriyaki tanda 2L"               │     (sub-recetas)
│  ej: "Arroz cocido para sushi 2.5kg"         │
│  Receta apunta a: YIELDs + INSUMOS directos  │
│  Yield % expresa rendimiento del proceso     │
│  Vida útil opcional (vence en N días)         │
└────────────────────┬─────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────┐
│  YIELD RECIPES                                │  ← procesamiento materia bruta
│  ej: "Salmón fileteado limpio"               │     (1kg entero → 600g limpio)
│  ej: "Pollo deshuesado"                       │
│  Yield % expresa la pérdida de procesar      │
│  Apunta a: INSUMOS directos                  │
└────────────────────┬─────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────┐
│  INSUMOS (unificado de cocina)                │  ← lo que se trackea en stock
│  ej: "Salmón", "Arroz", "Palta"              │
│  costo = promedio ponderado de MPs activas   │
└────────────────────┬─────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────┐
│  MATERIAS PRIMAS (versión por proveedor)      │  ← lo que se compra
│  ej: "Salmón entero Pescadería X $14k/kg"    │
│  ej: "Salmón fillet Pescadería Y $22k/kg"    │
│  factor_conversion + merma_pct + precio       │
└────────────────────┬─────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────┐
│  FACTURAS DE COMPRA                           │
│  alimentan precio_actual de la MP             │
└──────────────────────────────────────────────┘
```

**Reglas importantes:**

- Una receta de cualquier capa puede mezclar otras sub-recetas + insumos directos.
- Yield % es opcional para MIs (default 100%) pero **recomendado para PREPs y YIELDs**.
- Cuando una sub-receta cambia, el costo se propaga UP automáticamente (insumos → yield → prep → MI).
- **Auto-update precios** sin aprobación (factura nueva → precio_actual MP → recetas usan nuevo desde ese momento).
- **NO recalculo histórico** — recetas vendidas usan snapshot inmutable.
- **Versioning con log** pero sin requerir aprobación (decisión simplificada).

### 2.3. Cocina central + transferencias

`locales` agrega columna `tipo`:
- `PRODUCTOR` — produce sub-recetas y las envía a otros
- `CONSUMIDOR` — solo recibe + vende
- `MIXTO` — produce algunas cosas, otras las recibe (caso más común)

**Tabla nueva `transferencias_internas`** registra movimientos:
- Origen: local que produce (ej: Maneki filetea salmón)
- Destino: local que recibe (ej: Belgrano recibe 3kg de salmón fillet)
- Sub-receta transferida (ej: "Salmón fileteado limpio")
- Cantidad
- Costo unitario al momento del envío (snapshot)
- Estado: ENVIADA → RECIBIDA → CONSUMIDA

**Stock se descuenta del origen** al enviar, **se suma al destino** al recibir. AvT por local debe considerar lo recibido como "ingreso" además de las compras directas.

### 2.4. Las 22 decisiones (resumen)

| # | Decisión | Valor | Referencia |
|---|---|---|---|
| 1 | Arquitectura PASE↔COMANDA | Catálogo PASE / POS consume | Toast/Square/R365 |
| 2 | Cocina central | Tipo de local + transferencias_internas | R365 multi-unit |
| 3 | Sub-recetas anidadas | SÍ — 3 capas (Yield/Prep/MI) | R365/Apicbase |
| 4 | Yield % obligatorio | SÍ — campo en cada receta | Apicbase |
| 5 | Modifier → ingredient mapping | NO en v1 (futuro v2) | Apicbase/MarketMan |
| 6 | Versioning recetas | Sin aprobación, solo log | Toast |
| 7 | Combos | Costo = suma de componentes | Toast/Square |
| 8 | Open Item / Quick Sale | SÍ en COMANDA, va a "no catalogados" | Universal |
| 9 | Precios variables | Forward-looking, no recalcular histórico | MarginEdge/R365 |
| 10 | Costo MP unificada | Promedio ponderado por compras | MarketMan |
| 11 | Conteo físico | Shelf-to-sheet + blind opcional | MarketMan/Crunchtime |
| 12 | Mermas con motivo | Motivo enum obligatorio | R365/Apicbase |
| 13 | AvT (Actual vs Theoretical) | Dashboard top-level PASE | Universal |
| 14 | Cajero ve costos | NO | Toast/Square |
| 15 | 86 (agotado) | Cualquier cajero | Toast |
| 16 | Edit precio en POS | NO | Toast/Square |
| 17 | Importar receta con IA | SÍ — Claude + PDF/Excel/foto | MarginEdge |
| 18 | Auto-ordering | Sugerido, NO automático | MarketMan/BlueCart |
| 19 | Multi-channel pricing | Mantener item_precios_canal | Toast |
| 20 | Modifier con precio extra | Mantener precio_extra | Toast |
| 21 | Item con foto/emoji | Foto Supabase Storage + emoji fallback | Square |
| 22 | Audit log inmutable | Tablas *_history | R365 |

---

## 3. Schema de datos

### 3.1. Tablas modificadas (no rotas — solo extensiones)

#### `locales`

```sql
ALTER TABLE locales ADD COLUMN tipo_cocina text NOT NULL DEFAULT 'MIXTO'
  CHECK (tipo_cocina IN ('PRODUCTOR','CONSUMIDOR','MIXTO'));

-- Backfill todos los locales existentes a MIXTO (default seguro)
```

#### `items`

```sql
-- Ya tiene foto_url opcional y emoji. Agregamos campos para Open Item flow:
ALTER TABLE items ADD COLUMN es_no_catalogado boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN pending_review boolean NOT NULL DEFAULT false;
-- Cuando un cajero crea Open Item en POS, va con es_no_catalogado=true + pending_review=true
-- para que el admin lo formalice (renombrar, asignar receta, asignar categoría).
```

#### `recetas`

Hoy tiene: `id, tenant_id, item_id, rendimiento, notas, activa, created_at, ...`

Cambio principal: separar `recetas` en 3 tipos:

```sql
ALTER TABLE recetas ADD COLUMN tipo text NOT NULL DEFAULT 'MI'
  CHECK (tipo IN ('YIELD','PREP','MI'));

ALTER TABLE recetas ADD COLUMN yield_pct numeric(5,2) NOT NULL DEFAULT 100.00;
-- Default 100% para MIs y para recetas migradas (no había concepto antes).

ALTER TABLE recetas ADD COLUMN vida_util_horas int NULL;
-- Opcional: para preps que vencen (salsa teriyaki 7 días, etc.)
-- Si NULL = no vence. Si tiene valor, sistema alerta cuando prep está cerca de vencer.

ALTER TABLE recetas ADD COLUMN local_produccion_id int NULL REFERENCES locales(id);
-- Si NULL = se puede producir en cualquier local.
-- Si tiene valor = solo ese local produce (ej: salsa teriyaki solo en Maneki).

ALTER TABLE recetas ADD COLUMN distribuible boolean NOT NULL DEFAULT false;
-- TRUE = el prep/yield producido en un local puede transferirse a otros.
-- Solo aplica a tipo PREP o YIELD.
```

#### `receta_insumos`

Hoy linkea `receta → insumo`. Lo extendemos para linkear también `receta → sub-receta`:

```sql
ALTER TABLE receta_insumos ADD COLUMN sub_receta_id bigint NULL REFERENCES recetas(id);

-- Constraint: o tiene insumo_id (directo) o sub_receta_id (anidado), no ambos
ALTER TABLE receta_insumos ADD CONSTRAINT chk_insumo_or_subreceta
  CHECK (
    (insumo_id IS NOT NULL AND sub_receta_id IS NULL) OR
    (insumo_id IS NULL AND sub_receta_id IS NOT NULL)
  );

-- Prevenir ciclos (una receta no puede contener a sí misma directa o indirectamente).
-- Se valida en RPC al guardar, no en DB constraint (Postgres no soporta CHECK recursivo).
```

#### `modifiers`

Hoy ya tiene `receta_modifier_id bigint NULL` (slot reservado). Lo formalizamos:

```sql
COMMENT ON COLUMN modifiers.receta_modifier_id IS
  'FK a recetas(id) cuando el modificador descuenta ingredientes específicos (v2 — feature flag). '
  'En v1 los modificadores son items aparte con su propio costo, sin impacto en stock.';

-- NO crear FK constraint todavía (se activa en v2).
```

### 3.2. Tablas nuevas

#### `transferencias_internas`

```sql
CREATE TABLE transferencias_internas (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      int REFERENCES usuarios(id),

  local_origen_id int NOT NULL REFERENCES locales(id),
  local_destino_id int NOT NULL REFERENCES locales(id),
  CONSTRAINT chk_distintos_locales CHECK (local_origen_id != local_destino_id),

  -- Qué se transfiere (sub-receta producida o insumo crudo):
  insumo_id       bigint NULL REFERENCES insumos(id),
  receta_id       bigint NULL REFERENCES recetas(id),
  CONSTRAINT chk_insumo_or_receta CHECK (
    (insumo_id IS NOT NULL AND receta_id IS NULL) OR
    (insumo_id IS NULL AND receta_id IS NOT NULL)
  ),

  cantidad        numeric(12,4) NOT NULL CHECK (cantidad > 0),
  unidad          text NOT NULL,
  costo_unitario_snapshot numeric(12,2) NOT NULL,  -- costo al momento del envío

  -- State machine:
  estado          text NOT NULL DEFAULT 'ENVIADA'
    CHECK (estado IN ('ENVIADA','RECIBIDA','CONSUMIDA','RECHAZADA')),

  -- Trazabilidad:
  enviada_at      timestamptz NOT NULL DEFAULT now(),
  enviada_por     int REFERENCES usuarios(id),
  recibida_at     timestamptz,
  recibida_por    int REFERENCES usuarios(id),
  notas           text,

  -- Si rechazada (ej: llegó en mal estado):
  motivo_rechazo  text
);

CREATE INDEX ON transferencias_internas(tenant_id, local_origen_id, estado);
CREATE INDEX ON transferencias_internas(tenant_id, local_destino_id, estado);
```

#### `ventas_no_catalogadas`

Para items vendidos como Open Item que el admin debe revisar después:

```sql
CREATE TABLE ventas_no_catalogadas (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  venta_pos_id    bigint NOT NULL REFERENCES ventas_pos(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      int REFERENCES comanda_usuarios(id),

  descripcion     text NOT NULL,           -- lo que escribió el cajero
  precio_unitario numeric(12,2) NOT NULL,
  cantidad        int NOT NULL DEFAULT 1,
  motivo          text,                    -- por qué no estaba catalogado

  -- Workflow de revisión:
  estado_revision text NOT NULL DEFAULT 'PENDIENTE'
    CHECK (estado_revision IN ('PENDIENTE','FORMALIZADO','IGNORADO')),
  revisado_at     timestamptz,
  revisado_por    int REFERENCES usuarios(id),
  item_creado_id  int REFERENCES items(id),  -- si se formalizó como item
  notas_revision  text
);

CREATE INDEX ON ventas_no_catalogadas(tenant_id, estado_revision)
  WHERE estado_revision = 'PENDIENTE';
```

#### `recetas_import_drafts`

Para el flow de "importar receta con IA":

```sql
CREATE TABLE recetas_import_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      int REFERENCES usuarios(id),

  -- Input del usuario:
  fuente          text NOT NULL CHECK (fuente IN ('PDF','EXCEL','FOTO','TEXTO_LIBRE')),
  archivo_url     text,                  -- URL en Supabase Storage si aplica
  texto_input     text,                  -- si fuente=TEXTO_LIBRE

  -- Output de Claude:
  receta_parseada jsonb NOT NULL,        -- { nombre, ingredientes: [{nombre, cantidad, unidad}] }
  confianza_pct   numeric(5,2),
  warnings        text[],

  -- Workflow:
  estado          text NOT NULL DEFAULT 'PENDIENTE_REVISION'
    CHECK (estado IN ('PENDIENTE_REVISION','APROBADA','RECHAZADA')),
  receta_id_creada bigint REFERENCES recetas(id),  -- si se aprobó
  revisada_at     timestamptz,
  revisada_por    int REFERENCES usuarios(id)
);

CREATE INDEX ON recetas_import_drafts(tenant_id, estado);
```

### 3.3. Tablas movidas/renombradas (UI, no schema)

Las pantallas que viven en COMANDA se mueven a PASE (mismo schema, mismo data, otra app):

| Pantalla COMANDA actual | Movida a PASE como | Nota |
|---|---|---|
| `pages/Catalogo/ItemsTab.tsx` | `pages/catalogo/Items.tsx` | Rediseño UX simultáneo |
| `pages/Catalogo/RecetasLista.tsx` | `pages/catalogo/Recetas.tsx` | Con editor de sub-recetas |
| `pages/Catalogo/RecetasImportar.tsx` | `pages/catalogo/RecetasImportar.tsx` | + integración Claude IA |
| `pages/Catalogo/InsumosLista.tsx` | `pages/catalogo/Insumos.tsx` | |
| `pages/Catalogo/MateriasPrimasLista.tsx` | `pages/catalogo/MateriasPrimas.tsx` | |
| `pages/Catalogo/AlertasMargenLista.tsx` | `pages/rentabilidad/Alertas.tsx` | Consolida con TabAlertas |
| `pages/Catalogo/GruposTab.tsx` | `pages/catalogo/Grupos.tsx` | |
| `pages/Catalogo/ModificadoresTab.tsx` | `pages/catalogo/Modificadores.tsx` | |
| `pages/Catalogo/CombosLista.tsx` | `pages/catalogo/Combos.tsx` | |
| `pages/Catalogo/ListaPreciosTab.tsx` | `pages/catalogo/ListaPrecios.tsx` | |
| `pages/Reportes/ReporteCMV.tsx` | `pages/rentabilidad/CMV.tsx` | Consolida con TabCMV |

### 3.4. Lo que QUEDA en COMANDA (acciones frontline)

- `VentaScreen.tsx` — leer catálogo + cobrar (consume PASE vía Supabase Realtime)
- **86 button** dentro de catálogo del POS — cualquier cajero, sync real-time
- **Open Item / Quick Sale** — modal que inserta en `ventas_no_catalogadas`
- `MostradorView.tsx` / `HandheldView.tsx` — para tablet/handheld del mozo
- `KdsView.tsx` — cocina ve pedidos
- (módulos Salón / Reservas / Tienda / Delivery quedan como están — son COMANDA puro)

### 3.5. RLS policies

Patrones idénticos a tablas existentes:

```sql
ALTER TABLE transferencias_internas ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transferencias_internas
  USING (tenant_id = auth_tenant_id());

ALTER TABLE ventas_no_catalogadas ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ventas_no_catalogadas
  USING (tenant_id = auth_tenant_id());

ALTER TABLE recetas_import_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recetas_import_drafts
  USING (tenant_id = auth_tenant_id());
```

Permisos nuevos a sumar al catálogo de slugs:
- `catalogo.editar_items` — alta/baja de items, modificadores, combos
- `catalogo.editar_recetas` — alta/baja de recetas (incl. sub-recetas)
- `catalogo.editar_insumos` — alta/baja de insumos + materias primas
- `catalogo.ver_costos` — visibilidad de costos y márgenes (gate de seguridad)
- `transferencias.crear` — crear transferencias entre locales
- `transferencias.recibir` — confirmar recepción

---

## 4. Migration de datos existentes

### 4.1. Principios

1. **Cero pérdida de catálogo.** El menú vivo de Neko sigue intacto.
2. **COMANDA sigue vendiendo durante toda la transición** — no se rompe nada en producción.
3. **Migración en 3 fases** con feature flags.

### 4.2. Mapeo del estado actual

#### Items, modificadores, combos, grupos
→ NO se tocan en schema. Solo se mueven las UI de admin de COMANDA a PASE.

#### Recetas existentes
→ Se migran al modelo 3 capas:
- Recetas actuales se marcan como `tipo='MI'` (default) con `yield_pct=100`
- Admin puede después promover recetas a `tipo='PREP'` si quiere reusar componentes
- Recetas que actualmente apuntan a "ingredientes que son procesados" pueden migrar a `tipo='YIELD'` manualmente

**Script de migration:**
```sql
UPDATE recetas SET tipo='MI', yield_pct=100 WHERE tipo IS NULL;
```

No hay conversión automática a sub-recetas — el chef hace esta optimización progresivamente cuando le conviene.

#### Insumos + materias primas
→ NO se tocan. Schema ya está bien (sprint 2026-05-15).

#### `locales.tipo_cocina`
→ Backfill todos a `MIXTO` por default. Lucas configura manualmente cuáles son `PRODUCTOR` (probablemente Maneki por ser donde se filetea pescado central).

### 4.3. Procedimiento

1. **Schema first** (sin tocar UI):
   - Agregar campos a `recetas`, `locales`, `items`, `modifiers`
   - Crear tablas nuevas (`transferencias_internas`, `ventas_no_catalogadas`, `recetas_import_drafts`)
   - Sembrar permisos nuevos en catálogo de slugs
   - Backfill `locales.tipo_cocina = 'MIXTO'`
   - Backfill `recetas.tipo = 'MI'`, `yield_pct = 100`

2. **UI nueva en PASE bajo feature flag `catalogo_v2`**:
   - 10 pantallas nuevas en `packages/pase/src/pages/catalogo/`
   - Editor de recetas con sub-recetas anidadas
   - Importador de recetas con Claude IA
   - Dashboard AvT en `pages/rentabilidad/`

3. **Cutover gradual**:
   - Activar `catalogo_v2` para Lucas + Anto solo
   - Validar contra prod 1 semana
   - Activar para todos los locales Neko
   - Marcar pantallas viejas de COMANDA como deprecated (link a PASE)

4. **Cleanup** (90 días post-cutover):
   - Eliminar pantallas de catálogo en COMANDA (las que fueron movidas)
   - COMANDA queda más liviana, foco en POS puro

---

## 5. UX / Wireframes

### 5.1. PASE → nuevo sidebar "Catálogo"

Submenú dentro de `/catalogo`:
- **Items** (lista + alta/baja)
- **Grupos** (categorías del menú)
- **Modificadores** (extras, opciones)
- **Combos** (composiciones)
- **Recetas** (editor con sub-recetas)
- **Insumos** (unificados de cocina)
- **Materias primas** (versiones por proveedor)
- **Lista de precios** (por canal)

### 5.2. Editor de Receta (la pantalla más compleja)

Concepto: árbol jerárquico con drill-down.

```
┌─────────────────────────────────────────────────────────────┐
│ Editando receta: "Combinado 18 piezas"           [Tipo: MI] │
├─────────────────────────────────────────────────────────────┤
│ Yield: 100%   Rendimiento: 1 plato         [Editar metadata]│
├─────────────────────────────────────────────────────────────┤
│ Ingredientes:                                                │
│                                                              │
│ ▼ Arroz cocido para sushi (PREP)         300g    $1.200 ⓘ  │
│   └─ Click para ver/editar sub-receta                       │
│ ▼ Pescado fileteado (YIELD)               240g    $4.800 ⓘ  │
│   └─ Click para ver/editar sub-receta                       │
│ ▼ Teriyaki Neko (PREP)                     30ml    $180 ⓘ  │
│   └─ Click para ver/editar sub-receta                       │
│ • Palta (insumo directo)                   60g    $720      │
│ • Wasabi (insumo directo)                  10g    $200      │
│                                                              │
│ [+ Agregar sub-receta]  [+ Agregar insumo directo]          │
├─────────────────────────────────────────────────────────────┤
│ COSTO TOTAL:                                       $7.100   │
│ PRECIO MADRE:                                     $14.500   │
│ MARGEN BRUTO:                                52% ($7.400)   │
└─────────────────────────────────────────────────────────────┘
[Cancelar]  [Guardar (nueva versión)]
```

Comportamiento:
- Cambiar cantidad de un ingrediente → recalcula costo en vivo
- Cambiar la sub-receta hijo → recalcula costo del padre (propagación up)
- Botón "Promover a PREP" para componentes reusables
- Validación de ciclos al guardar (receta A no puede contener receta A directa o indirectamente)
- Cada cambio crea nueva fila en `recetas_versiones` (audit log inmutable)

### 5.3. Importador de Recetas con IA

```
┌─────────────────────────────────────────────────────────────┐
│ Importar receta con IA                                       │
├─────────────────────────────────────────────────────────────┤
│ Subí o pegá tu receta:                                       │
│  [📄 PDF / Excel]  [📷 Foto]  [✍️ Texto libre]              │
├─────────────────────────────────────────────────────────────┤
│ (Si subió foto)                                              │
│ Procesando con Claude IA... ⏳                               │
├─────────────────────────────────────────────────────────────┤
│ Receta detectada (confianza 85%):                            │
│                                                              │
│ Nombre: [Salsa Teriyaki Neko       ]                         │
│                                                              │
│ Ingredientes detectados:                                     │
│ • Salsa de soja          500ml    🟢 reconocido como insumo │
│ • Azúcar                 300g     🟢 reconocido como insumo │
│ • Mirin                  200ml    🟡 NO existe como insumo  │
│                                  → [+ Crear insumo nuevo]    │
│ • Jengibre fresco        50g      🟢 reconocido            │
│                                                              │
│ ⚠️ Warnings:                                                 │
│ • La receta menciona "sake" pero la cantidad es ilegible    │
│   → completar manualmente                                    │
├─────────────────────────────────────────────────────────────┤
│ [Editar antes de aprobar]  [Aprobar y crear receta]         │
└─────────────────────────────────────────────────────────────┘
```

### 5.4. Lista de items con CMV visible

```
┌───────────────────────────────────────────────────────────────────┐
│ Items                              [+ Nuevo] [Importar Excel] [⚙]│
├───────────────────────────────────────────────────────────────────┤
│ Filtros: [Grupo ▼] [Margen ▼] [Estado: Activos ▼]  🔍 Buscar...│
├───────────────────────────────────────────────────────────────────┤
│ Nombre              Grupo    Precio    Costo    Margen   Receta  │
│ ─────────────────────────────────────────────────────────────────│
│ Combinado 18p       Sushi   $14.500   $7.100    51% ●   ✓ ver  │
│ Combinado 30p       Sushi   $22.000  $11.200    49% ●   ✓ ver  │
│ Salmón Roll x6      Sushi    $5.800   $3.100    47% ●   ✓ ver  │
│ Burger Clásica      Burger   $7.500   $2.800    63% ●   ✓ ver  │
│ Coca Cola 350       Bebidas  $1.800     $800    56% ●   ✗ sin  │
│ ...                                                              │
└───────────────────────────────────────────────────────────────────┘
●=verde (margen>40%) ●=amarillo (25-40%) ●=rojo (<25%)
```

### 5.5. Vista de Transferencias entre locales

```
┌─────────────────────────────────────────────────────────────┐
│ Transferencias internas              [+ Nueva transferencia]│
├─────────────────────────────────────────────────────────────┤
│ Filtros: [Local origen ▼] [Local destino ▼] [Estado ▼]      │
├─────────────────────────────────────────────────────────────┤
│ Fecha    Origen    Destino    Qué      Cant   Costo  Estado│
│ ──────────────────────────────────────────────────────────  │
│ 27-may   Maneki    Belgrano   Salmón   3kg    $66k  ⏳ ENV│
│ 27-may   Maneki    Belgrano   Teriyaki 500ml  $3k   ✅ REC│
│ 26-may   Maneki    Devoto     Salmón   2kg    $44k  ✅ REC│
│ ...                                                          │
└─────────────────────────────────────────────────────────────┘
```

### 5.6. COMANDA — vista del cajero (Open Item)

Botón "+ Otros" en VentaScreen:

```
┌──────────────────────────────────┐
│ Item sin catalogar              ×│
├──────────────────────────────────┤
│ Descripción:                     │
│ [_______________________]        │
│                                  │
│ Precio: $ [____]                 │
│ Cantidad: [1]                    │
│                                  │
│ Motivo (opcional):               │
│ [_______________________]        │
│                                  │
│ ℹ️ Esto se cobra ahora.          │
│   Anto lo revisará después       │
│   y decidirá si formalizarlo     │
│   como item permanente.          │
├──────────────────────────────────┤
│         [Cancelar]  [+ Agregar]  │
└──────────────────────────────────┘
```

Y en PASE, una bandeja "No catalogados pendientes":

```
┌──────────────────────────────────────────────────┐
│ Ventas no catalogadas — pendiente revisar       │
├──────────────────────────────────────────────────┤
│ Hace 3h · Belgrano · cajero Camilo               │
│ "Pancho con queso"     $1.500 × 2  = $3.000     │
│ Motivo: cliente lo pidió, no estaba en menú      │
│ [Formalizar como item nuevo] [Ignorar]           │
├──────────────────────────────────────────────────┤
│ Hace 1d · Maneki · cajero Sofía                  │
│ "Postre del día"       $2.000 × 1  = $2.000     │
│ [Formalizar como item nuevo] [Ignorar]           │
└──────────────────────────────────────────────────┘
```

---

## 6. API contracts

### 6.1. Endpoints nuevos

#### `GET /api/catalogo/items`
Lista con filtros. Incluye costo si el caller tiene permiso `catalogo.ver_costos`.

#### `POST /api/catalogo/items`
Alta de item. Requiere permiso `catalogo.editar_items`.

#### `POST /api/catalogo/recetas`
Alta de receta. Validación de ciclos. Crea fila en `recetas_versiones`.

```typescript
type CrearRecetaBody = {
  item_id?: number;        // null si es PREP o YIELD
  tipo: 'YIELD' | 'PREP' | 'MI';
  yield_pct?: number;       // default 100
  rendimiento: number;
  vida_util_horas?: number;
  local_produccion_id?: number;
  distribuible?: boolean;
  ingredientes: Array<{
    insumo_id?: number;
    sub_receta_id?: number;
    cantidad: number;
    unidad: string;
  }>;
};
```

#### `POST /api/catalogo/recetas/importar-ia`
Sube archivo o texto, llama a Claude, devuelve draft.

```typescript
type ImportarRecetaBody = {
  fuente: 'PDF' | 'EXCEL' | 'FOTO' | 'TEXTO_LIBRE';
  archivo_base64?: string;
  texto?: string;
};

type ImportarRecetaResponse = {
  draft_id: string;
  receta_parseada: { nombre: string; ingredientes: Array<{ nombre: string; cantidad: number; unidad: string; insumo_id?: number }> };
  confianza_pct: number;
  warnings: string[];
};
```

#### `POST /api/transferencias`
Crear transferencia interna. Descuenta stock del origen.

```typescript
type CrearTransferenciaBody = {
  local_origen_id: number;
  local_destino_id: number;
  insumo_id?: number;
  receta_id?: number;
  cantidad: number;
  unidad: string;
  notas?: string;
};
```

#### `POST /api/transferencias/:id/recibir`
Confirma recepción. Suma stock al destino.

#### `POST /api/transferencias/:id/rechazar`
Rechaza con motivo. Devuelve stock al origen.

#### `POST /api/comanda/open-item` (endpoint COMANDA)
Crea venta no catalogada en línea.

#### `POST /api/no-catalogados/:id/formalizar`
Convierte venta no catalogada en item permanente.

### 6.2. Endpoints modificados

- `POST /api/comanda/ventas/cobrar` — al snapshot de receta, también consulta sub-recetas anidadas (recursivo) para que el snapshot inmutable sea completo.

### 6.3. Endpoints deprecados

- Endpoints de catálogo dentro de `packages/comanda/api/` → deprecar a favor de los de PASE. Mantener 90 días.

### 6.4. Supabase Realtime

COMANDA se suscribe a cambios en:
- `items` (cambios de precio, alta/baja, 86)
- `item_modifier_groups`, `modifiers`
- `combo_componentes`
- `item_precios_canal`

Cambios en PASE se reflejan en POS < 5 segundos sin requerir refresh.

---

## 7. Reservas para futuro

### 7.1. Modifier → ingredient mapping (v2)

El campo `modifiers.receta_modifier_id` ya existe. Cuando se active v2:
- Agregar FK constraint a `recetas(id)`
- Modifier "extra queso" se vincula a receta "Queso 30g"
- Al cobrar, esta receta también se snapshotea + descuenta de stock

Implementación es additiva, no breaking.

### 7.2. Yield management explícito

`recetas.yield_pct` hoy es manual. v2 podría incluir:
- Tabla `yield_mediciones` donde el chef registra yield real medido
- Sistema sugiere yield_pct = promedio de últimas N mediciones
- Alerta si yield real diverge >X% del teórico

### 7.3. Auto-ordering automático

Hoy es sugerido. v2 podría tener feature flag por insumo:
- "Salsa de soja: auto-comprar a proveedor Y cuando bajo par"
- Solo para insumos no críticos / precio estable

### 7.4. Disputes de precio con proveedor

Cuando precio sube >X% de un día al otro:
- Alerta + draft de "dispute" para mandar al proveedor
- Workflow de aprobación de precio nuevo

---

## 8. Plan de despliegue

### Fase 0 — Schema en producción (1-2 días)
- Aplicar migrations (ALTER + nuevas tablas)
- Sembrar permisos nuevos
- Backfills (locales.tipo_cocina, recetas.tipo, recetas.yield_pct)
- Verificar asserts post-migration
- **UI vieja sigue funcionando idéntica**

### Fase 1 — UI nueva en PASE bajo feature flag (2-3 semanas)
- 10 pantallas nuevas en `packages/pase/src/pages/catalogo/`
- Editor de recetas con sub-recetas
- Importador IA
- Dashboard AvT
- Pantallas de Transferencias y No-catalogados
- Activado solo para Lucas + Anto

### Fase 2 — Cutover gradual (1-2 semanas)
- Activar `catalogo_v2` para 1 local (Maneki)
- Validar 1 semana en producción real
- Activar para 4 locales Neko + Rene
- Marcar pantallas viejas de COMANDA como deprecated con link a PASE
- COMANDA queda solo con VentaScreen + MostradorView + Open Item modal

### Fase 3 — Cleanup (90 días post-cutover)
- Eliminar 10 pantallas viejas de COMANDA
- Eliminar endpoints viejos de COMANDA
- Refactor sidebar COMANDA — más liviano

### Rollback
Si algo falla en Fase 1 o 2:
1. Desactivar `catalogo_v2` → COMANDA vieja vuelve
2. Eventos creados en `transferencias_internas` / `ventas_no_catalogadas` se preservan
3. Schema agregado es retrocompatible

---

## 9. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Recetas anidadas crean ciclos infinitos | Baja | Alto | Validación al guardar (RPC chequea grafo) |
| Chef nunca completa migration a 3 capas | Alta | Bajo | Default `tipo='MI'` deja todo funcionando como antes. La promoción a PREP es opcional. |
| Cajero abusa Open Item para evitar manager | Media | Medio | Auditoría visible en bandeja PASE + reporte semanal automático |
| IA importa recetas mal | Media | Bajo | Confianza % visible + obligatorio editar antes de aprobar |
| Transferencias huérfanas (enviadas pero no recibidas) | Media | Medio | Alertas si pasan >7 días en estado ENVIADA |
| Cocina central no se configura | Alta | Medio | Default MIXTO funciona como sistema actual. Migration a PRODUCTOR es opcional. |

---

## 10. Open questions (resolver durante implementación)

1. **Recetas con merma negativa**: ¿qué pasa si una preparación rinde MÁS que sus componentes (ej: cocción de carne con caldo)? Asumir yield > 100% válido.

2. **Modificadores en sub-recetas**: ¿una sub-receta puede tener modificadores propios? Recomendación: NO en v1, solo MIs.

3. **Insumos con múltiples unidades**: ¿"Salmón" se compra por kg pero la receta usa gramos? Hoy la conversión es manual (factor_conversion). ¿Vale la pena un sistema de unidades automático (Pint Convert)? Recomendación: diferir a v2.

4. **Histórico de precios de receta**: ¿debe haber un reporte "evolución del costo de Combinado 18p en últimos 6 meses"? Útil para entender impacto de inflación. Sí en v1 si el dato existe (recetas_versiones lo tiene).

5. **Cocina central con costos cargados**: ¿Maneki produce "Salmón fileteado" y se lo manda a Belgrano gratis o se lo factura? Asumir gratis (transferencia interna sin movimiento financiero). v2 podría agregar opción de transfer pricing.

6. **Receta con múltiples versiones activas**: ¿puede haber receta MI con versión "verano" y "invierno"? No en v1, solo 1 versión activa.

---

## 11. Cosas que NO se hacen en este spec

- **Stock real + ledger movimientos_stock** → Spec #3 (depende de este)
- **Compras integradas con OC + 3-way match** → Spec #4
- **P&L restaurantero + Prime Cost dashboard** → Spec #5
- **Refactor VentaScreen COMANDA** (queda como está, solo cambia de dónde lee) → Spec #6
- **Sistema de permisos unificado PASE↔COMANDA** → Spec #7

---

## 12. Aprobación y próximos pasos

**Estado actual:** SPEC ESCRITO — pendiente revisión Lucas.

**Próximos pasos:**
1. Lucas revisa este spec
2. Pasamos a Spec #3 (Stock + CMV con AvT) — depende técnicamente de este
3. Spec #4, #5, #6, #7 después
4. Cuando estén todos → invocar `writing-plans` para plan holístico de implementación

---

**Glosario rápido para no-coders:**
- **Catálogo** = todos los items que vendés + sus modificadores + combos + grupos
- **Receta** = lista de ingredientes y cantidades para producir un item
- **Sub-receta (PREP)** = receta de un componente reusable (ej: salsa que va en 5 platos)
- **Yield recipe** = receta de procesamiento de materia bruta (ej: filetear pescado)
- **Yield %** = qué porcentaje del ingrediente bruto sobrevive al procesarse
- **Insumo** = ingrediente unificado de cocina (ej: "Salmón")
- **Materia prima (MP)** = versión específica de un proveedor (ej: "Salmón entero Pescadería X $14k/kg")
- **CMV** = Costo de Mercadería Vendida (cuánto te cuestan los ingredientes que vendiste)
- **AvT** = Actual vs Theoretical (CMV real medido vs CMV teórico calculado por recetas)
- **86** = marcar item como agotado (jerga gastronómica universal)
- **Open Item** = vender algo que no está catalogado con precio libre
- **Transferencia interna** = un local manda producto a otro local del mismo dueño
- **Cocina central** = local que produce sub-recetas para otros locales
