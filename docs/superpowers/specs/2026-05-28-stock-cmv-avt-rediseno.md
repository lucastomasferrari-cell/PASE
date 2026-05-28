# Rediseño Stock + CMV real + AvT — Design Document

**Fecha:** 2026-05-28
**Autor:** brainstorming session (Lucas + Claude — decisiones default profesionales)
**Estado:** 🟡 SPEC ESCRITO — pendiente revisión Lucas
**Approach:** Ledger inmutable `movimientos_stock` + cache derivado `stock_actual` (patrón Square/Toast probado) + auto-depleción al vender + conteo móvil + AvT como KPI estrella
**Depende de:** Spec #2 (Catálogo + Recetas + Insumos) — necesita recetas con sub-recetas y yield % consolidados
**Implementación:** ⏸️ DIFERIDA — esperar todos los specs y plan holístico

---

## 1. Resumen ejecutivo

El stock hoy en PASE+COMANDA es **fantasma**: las tablas existen (módulo "Stock/Rentabilidad sprints 1-4 DB-only" anotado en memoria) pero no hay tracking real, no hay auto-depleción al vender, no hay conteo confiable, no hay AvT.

Este rediseño aplica el **mismo patrón que ya funcionó para `saldos_caja`** (deuda C4-F16 cerrada): ledger inmutable de movimientos + cache derivado mantenido por trigger. Es el patrón estándar Square/Toast/QuickBooks.

**Lo que cambia:**
1. **Tabla `movimientos_stock`** como ledger inmutable de todo lo que entra/sale (compra+, venta−, merma−, ajuste±, transferencia±, producción±).
2. **`stock_actual` como cache derivado** mantenido por trigger AFTER INSERT/UPDATE/DELETE.
3. **Auto-depleción al cobrar venta**: la RPC `fn_cobrar_venta_comanda` resuelve recursivamente las sub-recetas anidadas (Spec #2) y descuenta los insumos base.
4. **Conteo móvil "shelf-to-sheet"** con blind count + partial count opcionales — patrón MarketMan/Crunchtime.
5. **Mermas con motivo enum obligatorio** + foto opcional + approval para mermas grandes.
6. **AvT dashboard como pantalla estrella** del módulo Rentabilidad — el KPI número 1 de gastronomía profesional.
7. **Compras sugeridas con fill-to-par** considerando lead time del proveedor.
8. **RPC `fn_producir_prep`** para registrar producción de sub-recetas con yield real medido.

**Garantía no negociable:** Neko sigue operando durante toda la transición. El sistema viejo (stock fantasma) coexiste con el nuevo hasta el cutover.

**Lo que NO se hace:** lotes/batch tracking (FIFO conceptual con promedio ponderado en v1), ML de demand forecast (manual en v1).

---

## 2. Modelo conceptual

### 2.1. El paradigma "ledger + cache"

Repetimos el patrón que ya funcionó para `saldos_caja`:

```
┌────────────────────────────────────────┐
│  movimientos_stock (LEDGER inmutable)   │
│  cada entrada es un hecho histórico     │
│  NUNCA se borra ni se modifica          │
└──────────────┬─────────────────────────┘
               │ trigger AFTER INSERT/UPDATE/DELETE
               ▼
┌────────────────────────────────────────┐
│  stock_actual (CACHE derivado)          │
│  (insumo_id, local_id) → cantidad       │
│  Recalculado por trigger                │
│  Se puede rebuild desde el ledger       │
└────────────────────────────────────────┘
```

**Beneficios** (mismos que ganamos con saldos_caja):
- **Auditoría perfecta** — cualquier saldo se puede reconciliar al céntimo desde el ledger
- **Rebuild posible** — si el cache se corrompe, se regenera desde movimientos
- **Multi-fuente** — compras, ventas, transferencias, ajustes, producción suman al mismo ledger sin coupling
- **Performance** — lecturas hit el cache, escrituras solo en ledger

### 2.2. Stock por (insumo, local)

**No existe "stock global del tenant".** Cada local tiene su propio inventario:

```
stock_actual:
  (insumo_id=salmon, local_id=1 Belgrano)   = 2.5 kg
  (insumo_id=salmon, local_id=2 V.Crespo)   = 3.8 kg
  (insumo_id=salmon, local_id=3 Devoto)     = 1.2 kg
  (insumo_id=salmon, local_id=4 Maneki)     = 8.0 kg   ← cocina central
  (insumo_id=salmon, local_id=5 Rene)       = 1.5 kg
```

Esto refleja la realidad operativa de Neko (cocina central + 4 locales satélite) y es el patrón universal (MarketMan, Apicbase, R365).

### 2.3. Tipos de movimiento (ledger entries)

| Tipo | Signo cantidad | Cuándo se genera | Quién |
|---|---|---|---|
| `COMPRA` | + | Factura cargada en Compras | RPC `pagar_factura` / `recibir_remito` |
| `VENTA` | − | Cobro en POS COMANDA | RPC `fn_cobrar_venta_comanda` |
| `MERMA` | − | Carga manual desde COMANDA o PASE | RPC `crear_merma` |
| `AJUSTE_CONTEO` | ± | Cierre de conteo físico | RPC `cerrar_conteo` |
| `AJUSTE_MANUAL` | ± | Corrección admin (raro) | RPC `crear_ajuste_stock` |
| `TRANSFERENCIA_OUT` | − | Envío a otro local | RPC `crear_transferencia` |
| `TRANSFERENCIA_IN` | + | Recepción desde otro local | RPC `recibir_transferencia` |
| `PRODUCCION_OUTPUT` | + | Sub-receta producida (PREP) | RPC `fn_producir_prep` |
| `PRODUCCION_INPUT` | − | Insumos consumidos para producir prep | (idem, atomicidad) |

Todos los tipos son inmutables. Si hay error, se crea movimiento opuesto con tipo `AJUSTE_MANUAL` (mismo patrón que `movimientos` de caja).

### 2.4. Auto-depleción al cobrar venta

Cuando COMANDA confirma una venta, la RPC `fn_cobrar_venta_comanda` ya hace snapshot de las recetas (Spec #2). Agregamos:

1. Para cada item vendido, resolver la receta snapshoteada
2. Resolver recursivamente sub-recetas anidadas hasta llegar a insumos directos
3. Por cada insumo final con su cantidad calculada, generar 1 movimiento `VENTA` con cantidad negativa

```sql
-- Ejemplo: vendió 1 "Combinado 18 piezas"
-- Receta MI snapshoteada:
--   - 300g "Arroz cocido para sushi" (PREP)
--   - 240g "Pescado fileteado" (YIELD)
--   - 30ml "Teriyaki Neko" (PREP)
--   - 60g palta (insumo directo)
--   - 10g wasabi (insumo directo)

-- Resolviendo PREP "Arroz cocido para sushi":
--   - 120g arroz crudo (1kg yield 250% → 300g cocido = 120g crudo)
--   - 12ml vinagre arroz para sushi

-- Resolviendo YIELD "Pescado fileteado":
--   - 400g salmón entero (yield 60% → 240g fillet = 400g entero)

-- Resolviendo PREP "Teriyaki Neko":
--   (depende de la receta de teriyaki — supongamos)
--   - 0.5ml salsa soja
--   - 0.3ml mirin

-- Movimientos generados (todos negativos):
INSERT INTO movimientos_stock VALUES
  (insumo_id=arroz, local_id=N, cantidad=-120g, tipo='VENTA', venta_id=X),
  (insumo_id=vinagre, local_id=N, cantidad=-12ml, tipo='VENTA', venta_id=X),
  (insumo_id=salmon, local_id=N, cantidad=-400g, tipo='VENTA', venta_id=X),
  (insumo_id=salsa_soja, local_id=N, cantidad=-0.5ml, tipo='VENTA', venta_id=X),
  (insumo_id=mirin, local_id=N, cantidad=-0.3ml, tipo='VENTA', venta_id=X),
  (insumo_id=palta, local_id=N, cantidad=-60g, tipo='VENTA', venta_id=X),
  (insumo_id=wasabi, local_id=N, cantidad=-10g, tipo='VENTA', venta_id=X);
```

**Reglas importantes:**
- El resolver recursivo usa la **versión snapshoteada** de cada receta (Spec #2), no la versión vigente. Esto garantiza que vender ayer un Combinado descuenta lo que la receta decía ayer.
- Si el local NO produce las sub-recetas (es CONSUMIDOR), se asume que las recibió por transferencia previa. El stock de la sub-receta también puede trackearse si es distribuible.
- **Stock negativo permitido pero alertado** — vendiste algo de lo que no tenés stock registrado (probablemente carga retrasada de compra). El sistema lo muestra en rojo + envía alerta diaria.

### 2.5. Producción de sub-recetas (PREPs)

Cuando Maneki produce 2L de Teriyaki Neko:

```
RPC fn_producir_prep(receta_id=teriyaki_2L, local_id=4_Maneki, cantidad_producida=2.1L)
                                                                ↑ rendimiento real medido

Pasos atómicos:
1. Resolver receta del PREP → componentes esperados
2. Para cada componente, generar movimiento PRODUCCION_INPUT (negativo) del insumo/sub-receta
3. Generar 1 movimiento PRODUCCION_OUTPUT (positivo) de la sub-receta producida
   - cantidad = 2.1L (lo que rindió real, no el teórico)
   - El yield_real se calcula: 2.1 / 2.0 = 105% (vs el yield_pct teórico de la receta)
4. Si yield_real diverge >10% del teórico, alertar (puede indicar receta mal cargada o falta de control)
```

**Stock de PREPs**: si la sub-receta es `distribuible=true` (Spec #2), tiene stock propio. Se decrece cuando se vende un MI que la usa, o cuando se transfiere a otro local.

### 2.6. Conteo físico mobile-first

**Patrón "shelf-to-sheet"** (MarketMan/Crunchtime):
- Cada local tiene su `count_sheet` configurado: orden de insumos según el recorrido físico del depósito/cocina/heladera
- El manager camina con el celu por el local, va viendo cada insumo en el orden esperado, carga cantidad real

**Modos opcionales:**

**Blind count**: el sistema NO muestra el stock teórico hasta que el manager termina y cierra. Evita el sesgo "esperaba 5kg, vi 4.8kg, cargo 5kg igual". Es opcional por contagio.

**Partial count**: el manager puede contar solo una categoría (ej: solo carnes esta semana, lácteos la próxima). Más realista que el conteo full mensual que nadie hace.

**Conteo de PREPs**: si una sub-receta es `distribuible`, también se cuenta (ej: cuántos litros de teriyaki quedan en la heladera).

### 2.7. Mermas con motivo

Cualquier merma requiere motivo (enum):

| Motivo | Descripción |
|---|---|
| `VENCIDO` | Pasó fecha de vencimiento |
| `DERRAMADO` | Accidente físico |
| `QUEMADO` | Error en cocina |
| `CLIENTE_DEVOLVIO` | Plato devuelto |
| `CAMBIO_RECETA` | Receta cambió, lo anterior no se usa |
| `MAL_ESTADO` | Llegó/se descubrió en mal estado |
| `ROBO_SOSPECHADO` | Stock que falta sin explicación |
| `OTROS` | Con texto libre obligatorio |

**Foto opcional** (obligatoria si merma > $X — configurable por tenant).
**Manager approval** para mermas > $X (sistema Solicitudes ya existe).
**Bandeja "mermas pendientes review"** en PASE para que admin vea resumen semanal.

### 2.8. AvT (Actual vs Theoretical) — el KPI estrella

**Fórmula** (universal en industria):

```
Stock Teórico Final = Stock Inicial + Compras + Transferencias_IN + Producciones_OUT
                    − Ventas_Teóricas − Mermas − Transferencias_OUT − Producciones_IN

Stock Real Final = último conteo físico cerrado

Variance ($) = (Stock Teórico Final − Stock Real Final) × costo_unitario
Variance (%) = Variance ($) / Costo_Total_Teórico × 100
```

**Semáforos** (benchmark TouchBistro):
- 🟢 **Verde**: AvT < 2% — excelente control
- 🟡 **Amarillo**: AvT 3-5% — normal en la industria
- 🔴 **Rojo**: AvT > 5% — alarma, investigar

**Drill-down**:
1. Vista top-level: AvT total del local en el mes
2. Por categoría: dónde está la fuga (carnes / lácteos / bebidas / etc.)
3. Por insumo: qué insumo específico tiene mayor variance
4. Detalle de movimientos: ledger de ese insumo en el período (compras, ventas, mermas, conteos, ajustes)

**Reporte mensual auto**: el día 1 de cada mes, sistema:
- Calcula AvT del mes anterior por local
- Genera reporte PDF
- Push notification + email al admin
- Si algún local está en rojo (>5%), alerta destacada

### 2.9. Compras sugeridas (fill-to-par)

**Par level** = stock objetivo mínimo por (insumo, local). Configurable.

**Lead time** del proveedor = días que tarda en llegar el pedido.

**Algoritmo de sugerencia**:
```
Para cada insumo del local:
  consumo_promedio_diario = movimientos_ventas_últimos_30_días / 30
  stock_proyectado_a_lead_time = stock_actual − (consumo_promedio_diario × lead_time)
  
  Si stock_proyectado_a_lead_time < par_level:
    cantidad_a_pedir = par_level + (consumo_promedio_diario × 7) − stock_proyectado_a_lead_time
    sugerir OC al proveedor preferido
```

**NO compra solo** — sistema genera draft de OC que admin revisa y aprueba.

**Demand forecast v1** = promedio simple últimos 30 días con ajuste estacional manual (admin puede subir 20% en feriados). v2 podría ser ML.

---

## 3. Schema de datos

### 3.1. Tablas nuevas

#### `movimientos_stock` (ledger)

```sql
CREATE TABLE movimientos_stock (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      int REFERENCES usuarios(id),

  -- Qué + dónde + cuánto:
  insumo_id       bigint REFERENCES insumos(id),
  sub_receta_id   bigint REFERENCES recetas(id),  -- para PREPs distribuibles
  CONSTRAINT chk_insumo_or_subreceta CHECK (
    (insumo_id IS NOT NULL AND sub_receta_id IS NULL) OR
    (insumo_id IS NULL AND sub_receta_id IS NOT NULL)
  ),
  local_id        int NOT NULL REFERENCES locales(id),
  cantidad        numeric(12,4) NOT NULL,    -- signed: + suma, - resta
  unidad          text NOT NULL,             -- snapshot al momento

  -- Tipo:
  tipo            text NOT NULL CHECK (tipo IN (
                    'COMPRA','VENTA','MERMA',
                    'AJUSTE_CONTEO','AJUSTE_MANUAL',
                    'TRANSFERENCIA_OUT','TRANSFERENCIA_IN',
                    'PRODUCCION_OUTPUT','PRODUCCION_INPUT'
                  )),

  -- Costo unitario al momento del movimiento (para cálculos de AvT):
  costo_unitario_snapshot numeric(12,4) NOT NULL,

  -- Trazabilidad — opcional, FK al hecho origen:
  factura_item_id    bigint REFERENCES factura_items(id),   -- si tipo=COMPRA
  venta_pos_id       bigint REFERENCES ventas_pos(id),       -- si tipo=VENTA
  venta_pos_item_id  bigint REFERENCES ventas_pos_items(id), -- si tipo=VENTA
  merma_id           bigint,                                 -- si tipo=MERMA (FK abajo)
  conteo_id          bigint,                                 -- si tipo=AJUSTE_CONTEO
  transferencia_id   bigint REFERENCES transferencias_internas(id),
  produccion_id      bigint,                                 -- si tipo=PRODUCCION_*

  notas              text
);

CREATE INDEX ON movimientos_stock(tenant_id, insumo_id, local_id, created_at DESC);
CREATE INDEX ON movimientos_stock(tenant_id, local_id, tipo, created_at DESC);
CREATE INDEX ON movimientos_stock(tenant_id, sub_receta_id, local_id) WHERE sub_receta_id IS NOT NULL;
CREATE INDEX ON movimientos_stock(venta_pos_id) WHERE venta_pos_id IS NOT NULL;

-- Inmutabilidad:
CREATE OR REPLACE FUNCTION fn_movimientos_stock_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'movimientos_stock es inmutable. Crear movimiento opuesto con tipo AJUSTE_MANUAL.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_movimientos_stock_no_update
  BEFORE UPDATE OR DELETE ON movimientos_stock
  FOR EACH ROW EXECUTE FUNCTION fn_movimientos_stock_immutable();
```

#### `stock_actual` (cache derivado)

```sql
CREATE TABLE stock_actual (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  insumo_id       bigint REFERENCES insumos(id),
  sub_receta_id   bigint REFERENCES recetas(id),
  CONSTRAINT chk_stock_insumo_or_subreceta CHECK (
    (insumo_id IS NOT NULL AND sub_receta_id IS NULL) OR
    (insumo_id IS NULL AND sub_receta_id IS NOT NULL)
  ),
  local_id        int NOT NULL REFERENCES locales(id),

  cantidad_actual numeric(12,4) NOT NULL DEFAULT 0,
  unidad          text NOT NULL,
  costo_unitario_promedio numeric(12,4) NOT NULL DEFAULT 0,  -- promedio ponderado
  valor_total     numeric(15,2) GENERATED ALWAYS AS (cantidad_actual * costo_unitario_promedio) STORED,

  ultima_actualizacion timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, COALESCE(insumo_id, sub_receta_id), local_id)
);

CREATE INDEX ON stock_actual(tenant_id, local_id);
CREATE INDEX ON stock_actual(tenant_id, cantidad_actual) WHERE cantidad_actual < 0;  -- alertas
```

#### Trigger de recálculo

```sql
CREATE OR REPLACE FUNCTION fn_recalcular_stock_actual() RETURNS trigger AS $$
DECLARE
  v_insumo_id bigint;
  v_sub_receta_id bigint;
  v_local_id int;
  v_tenant_id uuid;
  v_total numeric(12,4);
  v_costo_promedio numeric(12,4);
BEGIN
  -- Tomar PK del row afectado
  v_insumo_id := COALESCE(NEW.insumo_id, OLD.insumo_id);
  v_sub_receta_id := COALESCE(NEW.sub_receta_id, OLD.sub_receta_id);
  v_local_id := COALESCE(NEW.local_id, OLD.local_id);
  v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);

  -- Recalcular suma + promedio ponderado de costo (solo movimientos positivos)
  SELECT
    COALESCE(SUM(cantidad), 0),
    COALESCE(
      SUM(CASE WHEN cantidad > 0 THEN cantidad * costo_unitario_snapshot ELSE 0 END) /
      NULLIF(SUM(CASE WHEN cantidad > 0 THEN cantidad ELSE 0 END), 0),
      0
    )
  INTO v_total, v_costo_promedio
  FROM movimientos_stock
  WHERE tenant_id = v_tenant_id
    AND COALESCE(insumo_id, sub_receta_id) = COALESCE(v_insumo_id, v_sub_receta_id)
    AND local_id = v_local_id;

  -- UPSERT en cache
  INSERT INTO stock_actual (tenant_id, insumo_id, sub_receta_id, local_id, cantidad_actual, unidad, costo_unitario_promedio)
  VALUES (v_tenant_id, v_insumo_id, v_sub_receta_id, v_local_id, v_total, 'kg' /* TODO derive */, v_costo_promedio)
  ON CONFLICT (tenant_id, COALESCE(insumo_id, sub_receta_id), local_id)
  DO UPDATE SET cantidad_actual = v_total, costo_unitario_promedio = v_costo_promedio, ultima_actualizacion = now();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_actual_recalc
  AFTER INSERT ON movimientos_stock
  FOR EACH ROW EXECUTE FUNCTION fn_recalcular_stock_actual();
```

#### `mermas`

```sql
CREATE TABLE mermas (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      int REFERENCES usuarios(id),

  insumo_id       bigint REFERENCES insumos(id),
  sub_receta_id   bigint REFERENCES recetas(id),
  CONSTRAINT chk_merma_target CHECK (
    (insumo_id IS NOT NULL AND sub_receta_id IS NULL) OR
    (insumo_id IS NULL AND sub_receta_id IS NOT NULL)
  ),
  local_id        int NOT NULL REFERENCES locales(id),
  cantidad        numeric(12,4) NOT NULL CHECK (cantidad > 0),
  unidad          text NOT NULL,

  motivo          text NOT NULL CHECK (motivo IN (
                    'VENCIDO','DERRAMADO','QUEMADO','CLIENTE_DEVOLVIO',
                    'CAMBIO_RECETA','MAL_ESTADO','ROBO_SOSPECHADO','OTROS'
                  )),
  motivo_detalle  text,                     -- obligatorio si motivo='OTROS'
  foto_url        text,                     -- opcional, obligatorio si valor>$X (config tenant)
  valor_estimado  numeric(15,2),

  -- Approval workflow para mermas grandes:
  requiere_approval boolean NOT NULL DEFAULT false,
  aprobada        boolean,
  aprobada_at     timestamptz,
  aprobada_por    int REFERENCES usuarios(id),
  solicitud_id    uuid REFERENCES manager_solicitudes(id),  -- link al sistema existente

  -- Trazabilidad al movimiento generado:
  movimiento_stock_id bigint REFERENCES movimientos_stock(id)
);

CREATE INDEX ON mermas(tenant_id, local_id, created_at DESC);
CREATE INDEX ON mermas(tenant_id, requiere_approval, aprobada) WHERE requiere_approval AND aprobada IS NULL;
```

#### `conteos`

```sql
CREATE TABLE conteos (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      int REFERENCES usuarios(id),

  fecha_corte     date NOT NULL,           -- a qué fecha aplica el conteo
  modo            text NOT NULL CHECK (modo IN ('FULL','PARTIAL','BLIND','BLIND_PARTIAL')),
  categoria_filter text,                   -- si PARTIAL, qué categoría se cuenta

  estado          text NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN (
                    'BORRADOR','EN_PROGRESO','CERRADO','VALIDADO','ANULADO'
                  )),

  -- Sumario al cerrar:
  items_contados  int NOT NULL DEFAULT 0,
  items_pendientes int NOT NULL DEFAULT 0,
  variance_total_valor numeric(15,2),       -- valor $ de la diferencia teórico-real

  cerrado_at      timestamptz,
  cerrado_por     int REFERENCES usuarios(id),
  validado_at     timestamptz,
  validado_por    int REFERENCES usuarios(id),
  notas           text
);

CREATE TABLE conteos_lineas (
  id              bigserial PRIMARY KEY,
  conteo_id       bigint NOT NULL REFERENCES conteos(id) ON DELETE CASCADE,

  insumo_id       bigint REFERENCES insumos(id),
  sub_receta_id   bigint REFERENCES recetas(id),
  CONSTRAINT chk_conteo_linea_target CHECK (
    (insumo_id IS NOT NULL AND sub_receta_id IS NULL) OR
    (insumo_id IS NULL AND sub_receta_id IS NOT NULL)
  ),

  cantidad_teorica numeric(12,4) NOT NULL,  -- snapshot del stock_actual al iniciar
  cantidad_real    numeric(12,4),            -- lo que el manager carga
  variance         numeric(12,4) GENERATED ALWAYS AS (cantidad_real - cantidad_teorica) STORED,
  variance_valor   numeric(15,2),

  contado_at       timestamptz,
  contado_por      int REFERENCES usuarios(id),
  notas            text
);

CREATE INDEX ON conteos(tenant_id, local_id, estado);
CREATE INDEX ON conteos_lineas(conteo_id);
```

#### `count_sheets` (orden de conteo por local)

```sql
CREATE TABLE count_sheets (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),

  insumo_id       bigint REFERENCES insumos(id),
  sub_receta_id   bigint REFERENCES recetas(id),
  CONSTRAINT chk_count_sheet_target CHECK (
    (insumo_id IS NOT NULL AND sub_receta_id IS NULL) OR
    (insumo_id IS NULL AND sub_receta_id IS NOT NULL)
  ),

  orden           int NOT NULL,            -- posición en el recorrido del depósito
  zona            text,                    -- ej "Heladera 1", "Depósito seco", "Freezer"
  activo          boolean NOT NULL DEFAULT true
);

CREATE INDEX ON count_sheets(tenant_id, local_id, orden) WHERE activo;
```

#### `par_levels` (compras sugeridas)

```sql
CREATE TABLE par_levels (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),
  insumo_id       bigint NOT NULL REFERENCES insumos(id),

  par_minimo      numeric(12,4) NOT NULL,   -- bajo esto, alerta
  par_objetivo    numeric(12,4) NOT NULL,   -- a esto apunta el fill-to-par
  unidad          text NOT NULL,

  proveedor_preferido_id int REFERENCES proveedores(id),
  lead_time_dias  int NOT NULL DEFAULT 1,

  activo          boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ON par_levels(tenant_id, local_id, insumo_id) WHERE activo;
```

#### `producciones` (registro de PREPs producidos)

```sql
CREATE TABLE producciones (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      int REFERENCES usuarios(id),

  receta_id       bigint NOT NULL REFERENCES recetas(id),
  receta_version_id bigint REFERENCES recetas_versiones(id),  -- snapshot
  cantidad_teorica numeric(12,4) NOT NULL,
  cantidad_real    numeric(12,4) NOT NULL,
  yield_real_pct   numeric(5,2) GENERATED ALWAYS AS
                     (cantidad_real / NULLIF(cantidad_teorica, 0) * 100) STORED,
  unidad           text NOT NULL,

  -- Si yield_real diverge >X% del teórico, queda flagueado:
  yield_alert      boolean NOT NULL DEFAULT false,

  notas            text
);

CREATE INDEX ON producciones(tenant_id, receta_id, created_at DESC);
CREATE INDEX ON producciones(tenant_id, yield_alert) WHERE yield_alert;
```

### 3.2. Tablas modificadas

```sql
-- mermas tiene FK opcional a movimientos_stock — agregamos la FK back:
ALTER TABLE movimientos_stock
  ADD CONSTRAINT fk_movimientos_stock_merma
  FOREIGN KEY (merma_id) REFERENCES mermas(id);

-- conteos tiene FK opcional desde movimientos_stock — idem:
ALTER TABLE movimientos_stock
  ADD CONSTRAINT fk_movimientos_stock_conteo
  FOREIGN KEY (conteo_id) REFERENCES conteos(id);

-- producciones:
ALTER TABLE movimientos_stock
  ADD CONSTRAINT fk_movimientos_stock_produccion
  FOREIGN KEY (produccion_id) REFERENCES producciones(id);
```

### 3.3. RLS policies

Patrón estándar (mismo que tablas existentes):

```sql
-- Activar en todas las nuevas
ALTER TABLE movimientos_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_actual      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mermas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE conteos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE conteos_lineas    ENABLE ROW LEVEL SECURITY;
ALTER TABLE count_sheets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE par_levels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE producciones      ENABLE ROW LEVEL SECURITY;

-- Patrón tenant_id + local visible:
CREATE POLICY tenant_local_visible ON movimientos_stock USING (
  tenant_id = auth_tenant_id()
  AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
);

-- (idem para las demás)
```

Permisos nuevos a sumar:
- `stock.ver` — ver stock_actual de locales asignados
- `stock.cargar_merma` — cargar mermas
- `stock.aprobar_merma` — aprobar mermas grandes
- `stock.contar` — realizar conteos
- `stock.cerrar_conteo` — cerrar y aplicar ajustes
- `stock.ver_avt` — ver dashboard AvT (incluye costos, gateado)
- `stock.configurar_par` — definir par levels

---

## 4. RPCs nuevas

### 4.1. `fn_cobrar_venta_comanda` — modificación

La RPC existente ya hace snapshot de recetas. Agregamos al final:

```sql
-- Por cada item vendido, generar movimientos_stock recursivamente:
-- 1. Cargar receta snapshoteada (recetas_versiones)
-- 2. Resolver árbol de sub-recetas → llegar a insumos directos
-- 3. INSERT en movimientos_stock con tipo='VENTA', cantidad negativa
-- Detalle de la función recursiva: ver pseudocódigo en sección 4.6
```

### 4.2. `fn_crear_merma`

```sql
CREATE OR REPLACE FUNCTION fn_crear_merma(
  p_insumo_id bigint,
  p_sub_receta_id bigint,
  p_local_id int,
  p_cantidad numeric,
  p_motivo text,
  p_motivo_detalle text,
  p_foto_url text,
  p_idempotency_key text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_merma_id bigint;
  v_movimiento_id bigint;
  v_costo numeric;
  v_valor numeric;
  v_requiere_approval boolean;
  v_limite numeric;
BEGIN
  -- 1. Idempotency check
  -- 2. Auth + tenant check
  -- 3. Validación: motivo='OTROS' requiere motivo_detalle
  -- 4. Calcular valor estimado (cantidad × costo_actual del insumo)
  -- 5. Determinar si requiere approval (valor > tenant_config.merma_limite_aprobacion)
  -- 6. Si requiere approval, crear manager_solicitud, NO crear movimiento todavía
  -- 7. Si NO requiere approval, INSERT en mermas + INSERT en movimientos_stock
  -- 8. Retornar merma_id
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.3. `fn_aprobar_merma`

Llamada cuando admin aprueba una merma pendiente. Crea el movimiento_stock real.

### 4.4. `fn_iniciar_conteo`

```sql
CREATE OR REPLACE FUNCTION fn_iniciar_conteo(
  p_local_id int,
  p_modo text,
  p_categoria_filter text
) RETURNS bigint AS $$
BEGIN
  -- 1. Crear conteo en estado 'EN_PROGRESO'
  -- 2. Para cada insumo del count_sheet del local (filtrado por categoría si PARTIAL):
  --    INSERT en conteos_lineas con cantidad_teorica = stock_actual snapshot
  -- 3. Retornar conteo_id
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.5. `fn_cerrar_conteo`

```sql
CREATE OR REPLACE FUNCTION fn_cerrar_conteo(
  p_conteo_id bigint
) RETURNS void AS $$
BEGIN
  -- 1. Validar que conteo está EN_PROGRESO + todas las líneas tienen cantidad_real
  -- 2. Para cada línea con variance != 0:
  --    INSERT en movimientos_stock tipo='AJUSTE_CONTEO', cantidad = variance,
  --    conteo_id = p_conteo_id
  -- 3. Actualizar conteos: estado='CERRADO', cerrado_at, variance_total_valor
  -- 4. Crear notificación al admin con resumen
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.6. `fn_producir_prep`

```sql
CREATE OR REPLACE FUNCTION fn_producir_prep(
  p_receta_id bigint,
  p_local_id int,
  p_cantidad_real numeric,
  p_notas text
) RETURNS bigint AS $$
DECLARE
  v_produccion_id bigint;
  v_componente record;
  v_cantidad_necesaria numeric;
BEGIN
  -- 1. Validar receta es tipo PREP o YIELD
  -- 2. Crear producciones row con cantidad_teorica = rendimiento de la receta
  --    y cantidad_real = p_cantidad_real
  -- 3. Para cada componente de la receta (receta_insumos):
  --    Si es insumo directo:
  --      INSERT en movimientos_stock tipo='PRODUCCION_INPUT', cantidad negativa
  --    Si es sub-receta:
  --      RECURSIVAMENTE consumir esa sub-receta (de stock si distribuible, o
  --      desarmar en sus componentes finales si no)
  -- 4. INSERT en movimientos_stock tipo='PRODUCCION_OUTPUT', cantidad = p_cantidad_real,
  --    insumo o sub_receta según el output de la receta
  -- 5. Si yield_real diverge >10% del yield_pct teórico, set yield_alert=true
  -- 6. Retornar produccion_id
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.7. `fn_calcular_avt`

```sql
CREATE OR REPLACE FUNCTION fn_calcular_avt(
  p_local_id int,
  p_fecha_inicio date,
  p_fecha_fin date,
  p_categoria_filter text DEFAULT NULL
) RETURNS TABLE (
  insumo_id bigint,
  insumo_nombre text,
  categoria text,
  stock_inicial numeric,
  compras numeric,
  ventas_teoricas numeric,
  mermas numeric,
  transferencias_in numeric,
  transferencias_out numeric,
  producciones_out numeric,
  producciones_in numeric,
  stock_teorico_final numeric,
  stock_real_final numeric,
  variance_cantidad numeric,
  variance_valor numeric,
  variance_pct numeric
) AS $$
BEGIN
  -- Cálculo según fórmula sección 2.8
  RETURN QUERY ...;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.8. `fn_sugerir_compras`

```sql
CREATE OR REPLACE FUNCTION fn_sugerir_compras(
  p_local_id int
) RETURNS TABLE (
  insumo_id bigint,
  insumo_nombre text,
  stock_actual numeric,
  par_minimo numeric,
  par_objetivo numeric,
  consumo_promedio_diario numeric,
  stock_proyectado_lead_time numeric,
  cantidad_sugerida numeric,
  proveedor_preferido text,
  costo_estimado numeric
) AS $$
BEGIN
  -- Algoritmo sección 2.9
  RETURN QUERY ...;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## 5. UX / Wireframes

### 5.1. PASE → sub-menú nuevo "Stock"

Dentro de `/rentabilidad` (consolidando lo que hoy es PASE Rentabilidad + COMANDA Inventario):

```
/rentabilidad
├── Dashboard AvT  ← pantalla estrella
├── Stock actual (por local)
├── Mermas (bandeja + alta)
├── Conteos físicos
├── Compras sugeridas
├── Producción PREPs
└── Configuración (par levels, count sheets)
```

### 5.2. Dashboard AvT (la pantalla más importante)

```
┌──────────────────────────────────────────────────────────────────┐
│ AvT — Mayo 2026                       [Local: Todos ▼] [Período]│
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────────┬──────────────┬──────────────┬──────────────┐  │
│ │ Belgrano      │ Villa Crespo │ Devoto        │ Maneki        │  │
│ │ 🟢 1.8%       │ 🟡 3.4%      │ 🔴 6.2%       │ 🟢 2.1%       │  │
│ │ -$42.300      │ -$89.500     │ -$187.400     │ -$51.200      │  │
│ └──────────────┴──────────────┴──────────────┴──────────────┘  │
│                                                                    │
│ ⚠️ Devoto en rojo — investigar. Click para drill-down →          │
├──────────────────────────────────────────────────────────────────┤
│ TOP 5 INSUMOS CON MÁS VARIANCE (TODOS LOS LOCALES)                │
│ 1. Salmón fillet      −2.3kg = −$45.800   (mermas? robos?)       │
│ 2. Palta              −1.8kg = −$18.200   (vencimiento?)         │
│ 3. Arroz cocido       +1.2kg = +$3.600    (over-yield?)          │
│ 4. Queso muzzarella   −0.9kg = −$8.100                            │
│ 5. Coca Cola lata     −12 un = −$8.400    (¿faltante de caja?)   │
├──────────────────────────────────────────────────────────────────┤
│ MERMAS TOP MOTIVOS (MAYO)                                          │
│ • VENCIDO: $34.200      • DERRAMADO: $12.500                     │
│ • CLIENTE_DEVOLVIO: $8.100   • OTROS: $5.400                     │
└──────────────────────────────────────────────────────────────────┘
```

Click en Devoto → drill-down a vista detalle con ledger.

### 5.3. Conteo móvil (mobile-first)

```
┌────────────────────────────────────┐
│ Conteo Devoto — 27-may             │
│ Modo: BLIND_PARTIAL (Carnes)       │
│ Progreso: 12/24 items contados     │
├────────────────────────────────────┤
│ Heladera 1 — estante superior      │
├────────────────────────────────────┤
│ ✓ Salmón fillet                    │
│   Cargado: 2.4 kg                  │
│ ✓ Atún fillet                      │
│   Cargado: 1.8 kg                  │
│ ▶ Langostino limpio                │
│   [_____ ] kg                      │
│   [Cargar] [Saltar] [Foto]         │
│ ○ Pollo deshuesado                 │
│ ○ Carne picada                     │
└────────────────────────────────────┘
       [Pausar]  [Cerrar conteo]
```

Al cerrar (modo blind): muestra la diferencia teórica vs real con semáforos.

### 5.4. Carga de merma rápida (COMANDA mobile)

```
┌────────────────────────────────────┐
│ Nueva merma                       ×│
├────────────────────────────────────┤
│ Insumo:                            │
│ [Buscar... 🔍 ] o [☆ Favoritos]   │
│                                    │
│ Cantidad:                          │
│ [ 1.5 ] kg                         │
│                                    │
│ Motivo: (obligatorio)              │
│ ┌──────────────────────────────┐  │
│ │ ❌ Vencido                    │  │
│ │ ❌ Derramado                  │  │
│ │ ❌ Quemado                    │  │
│ │ ✓ Cliente devolvió            │  │
│ │ ❌ Cambio de receta           │  │
│ │ ❌ Mal estado                 │  │
│ │ ❌ Robo sospechado            │  │
│ │ ❌ Otros (especificar)        │  │
│ └──────────────────────────────┘  │
│                                    │
│ Foto: [📷 Tomar foto] (opcional)  │
│                                    │
│ Notas: [______________]            │
├────────────────────────────────────┤
│      [Cancelar]  [Registrar]      │
└────────────────────────────────────┘
```

### 5.5. Compras sugeridas

```
┌──────────────────────────────────────────────────────────────────┐
│ Compras sugeridas — Belgrano                  [Generar OC →]    │
├──────────────────────────────────────────────────────────────────┤
│ ☐ Salmón fillet      Stock: 1.2kg  Par: 3kg                      │
│   Sugerido: 5kg (cubre 7 días)  Proveedor: Pescadería X         │
│   Costo estimado: $77.000                                         │
│                                                                   │
│ ☐ Palta              Stock: 0.8kg  Par: 2kg                      │
│   Sugerido: 4kg (cubre 7 días)  Proveedor: Verdulería Z         │
│   Costo estimado: $14.400                                         │
│                                                                   │
│ ☐ Arroz para sushi   Stock: 8kg   Par: 15kg                      │
│   Sugerido: 25kg (cubre 14 días)  Proveedor: Distribuidora A    │
│   Costo estimado: $42.500                                         │
├──────────────────────────────────────────────────────────────────┤
│ Total OC: $133.900    [Seleccionar todos]  [Generar OC]          │
└──────────────────────────────────────────────────────────────────┘
```

### 5.6. Producción de PREP (cocina central)

```
┌──────────────────────────────────────────────────────────────────┐
│ Producir sub-receta                                              │
├──────────────────────────────────────────────────────────────────┤
│ Sub-receta: [Teriyaki Neko tanda 2L  ▼]                          │
│ Local productor: [Maneki  ▼]                                     │
│                                                                   │
│ Componentes a consumir:                                          │
│ • Salsa de soja:    500ml  ($1.500)                              │
│ • Azúcar:           300g   ($240)                                │
│ • Mirin:            200ml  ($800)                                │
│ • Jengibre:         50g    ($150)                                │
│ COSTO TOTAL: $2.690                                              │
│                                                                   │
│ Rendimiento teórico: 2.0 L                                       │
│ ¿Cuánto rindió real?: [ 2.1 ] L                                  │
│ Yield real: 105% (vs teórico 100% — OK)                          │
│                                                                   │
│ Notas: [_______________]                                         │
├──────────────────────────────────────────────────────────────────┤
│                       [Cancelar]  [Confirmar producción]         │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Plan de despliegue

### Fase 0 — Schema en producción (1-2 días)
- 8 tablas nuevas + 4 ALTERs
- Trigger de cache derivado
- 7 RPCs nuevas
- Backfill stock_actual desde compras existentes (si Lucas quiere arranque "cargado" en vez de cero)

### Fase 1 — UI nueva en PASE bajo feature flag `stock_v2` (2 semanas)
- Dashboard AvT
- Conteo móvil
- Mermas con motivo
- Compras sugeridas
- Producción PREPs
- Configuración par levels + count sheets

### Fase 2 — Cutover gradual (1 semana)
- Activar para Maneki (cocina central) primero
- Validar producción de Teriyaki + transferencias a otros locales
- Activar para los otros 3 Neko + Rene
- Marcar pantallas viejas de Inventario en COMANDA como deprecated

### Fase 3 — Cleanup (90 días)
- Eliminar pantallas viejas Inventario en COMANDA
- COMANDA queda solo con vista "stock_actual readonly" + alta de mermas + conteos (acciones frontline)

### Rollback
Si algo falla en Fase 1 o 2:
1. Desactivar `stock_v2` → vista vieja vuelve
2. movimientos_stock ya generados se preservan (son inmutables)
3. stock_actual se puede recalcular desde el ledger en cualquier momento (no se pierde data)

---

## 7. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Stock inicial mal cargado | Alta | Alto | Conteo full el día del cutover + ajustar todos los stock_actual desde ese baseline |
| Cajeros no cargan mermas | Alta | Medio | Recordatorios automáticos + reporte semanal de "no se cargó ninguna merma esta semana" |
| Recetas con yield mal calibrado | Alta | Medio | Sistema de yield_alert + producción tracking sirve para ajustar yield_pct con datos reales |
| AvT alto pero por carga retrasada | Media | Bajo | Pre-flight check: si hay compras pendientes de cargar, alertar antes de mostrar AvT |
| Multi-local con transferencias rotas | Media | Alto | Conteo semanal + reconciliación obligatoria de transferencias pendientes |
| Performance: trigger recalcula stock cada movimiento | Baja | Bajo | Stock_actual es per (insumo, local) — recálculo es rápido. Si crece >10M movimientos/local, considerar materialized view. |

---

## 8. Open questions

1. **Backfill inicial**: ¿el día del cutover hacemos conteo full de todos los locales para arrancar con baseline conocido? Recomendación: SÍ, vale el día de trabajo.

2. **Costos históricos en stock_actual.costo_unitario_promedio**: ¿el promedio se calcula sobre TODAS las compras históricas o solo últimas 90 días? Recomendación: últimas 90 días con sliding window — refleja precio actual mejor.

3. **PREP que vence**: si una tanda de Teriyaki vence y nadie la usa, ¿genera MERMA automática? Recomendación: NO automática. Sistema alerta "Teriyaki vence en 24h, quedan 0.5L". Si nadie hace nada, sigue ahí. La merma se carga manual.

4. **Conteo cuando hay venta abierta**: si Belgrano hace conteo a la noche pero hay 3 mesas abiertas todavía, ¿qué stock se cuenta? Recomendación: el stock real (lo que el manager ve en el depósito). Las ventas abiertas se descontarán cuando se cobren y generan ajuste futuro.

5. **Receta con yield negativo declarado** (ej: yield 80% — perdí 20%): el movimiento PRODUCCION_INPUT cobra los insumos teóricos del 100%, pero el OUTPUT solo registra el 80%. La merma del 20% queda implícita. ¿Vale registrarla explícita como merma? Recomendación: no en v1, el yield ya la captura.

6. **Insumo en múltiples unidades**: hoy resolvemos con factor_conversion en materias_primas. ¿Vale un sistema de unidades automático tipo Pint Convert? Recomendación: diferir v2.

---

## 9. Cosas que NO se hacen en este spec

- **Lotes / batch tracking real (FIFO con lote)** → v2 cuando vale la pena
- **ML demand forecast** → v2
- **Auto-OC sin aprobación** → futuro feature flag
- **Integración EDI con proveedores grandes (Sysco, etc.)** → no aplica AR
- **Refactor del módulo Compras** → Spec #4

---

## 10. Aprobación y próximos pasos

**Estado actual:** SPEC ESCRITO — pendiente revisión Lucas.

**Próximos:**
1. Lucas revisa
2. Spec #4 (Compras + Proveedores + AP) — depende de este
3. Spec #5 (Caja + Finanzas)
4. Specs restantes (#6, #7, #8)
5. Plan holístico con `writing-plans`

---

**Glosario:**
- **Ledger** = tabla inmutable de movimientos (cada fila es un hecho histórico)
- **Cache derivado** = tabla con saldos actuales que se recalcula desde el ledger
- **AvT (Actual vs Theoretical)** = comparación entre stock real medido vs stock teórico calculado
- **Variance** = diferencia entre teórico y real
- **Shrinkage** = "fuga" de stock (mermas + robos + errores)
- **Par level** = stock objetivo mínimo
- **Fill-to-par** = comprar lo necesario para llegar al par objetivo
- **Lead time** = días que tarda el proveedor en entregar
- **Shelf-to-sheet** = lista de conteo ordenada por estante físico
- **Blind count** = contar sin ver el teórico (evita influencia)
- **Yield** = rendimiento (qué % del input sale como output usable)
