# Rediseño Caja + Finanzas + P&L — Design Document

**Fecha:** 2026-05-28
**Autor:** brainstorming session (Lucas + Claude — decisiones default profesionales)
**Estado:** 🟡 SPEC ESCRITO — pendiente revisión Lucas
**Approach:** P&L formato AAA Prime Cost (estándar gastronómico US) + DSR + cash flow forecast + anomaly detection + sales mix avanzado
**Depende de:** Specs #1 (RRHH para mano de obra), #3 (Stock+CMV) y #4 (Compras) — este consolida todos los componentes
**Implementación:** ⏸️ DIFERIDA

---

## 1. Resumen ejecutivo

La parte de Caja en PASE ya es bastante madura (multi-cuenta, ledger inmutable, conciliación). El gap es **el lado financiero/analítico**: lo que un dueño de restaurante necesita ver semanalmente para tomar decisiones.

Hoy PASE tiene **EERR base devengada** (formato contable AR genérico). Falta el **P&L formato restaurantero** que mira la industria — con **Prime Cost** (CMV + Mano de Obra) como KPI nº1, sales mix segmentado, menu engineering, anomaly detection, cash flow forecast.

Este spec **NO refactoriza la parte de Caja existente** (movimientos + saldos + conciliación). Refactor solo conciliación bancaria con auto-matching mejorado. La mayoría del spec es **construcción nueva de capa analítica**.

**Lo que se agrega:**
1. **Dashboard P&L restaurantero** — formato AAA Prime Cost por local + consolidado
2. **Daily Sales Report (DSR)** — el reporte que el manager firma al cerrar el día
3. **Cash flow forecast 30 días** — proyección con compras pendientes + sueldos + obligaciones
4. **Anomaly detection** — alertas automáticas con reglas + IA opcional
5. **Sales mix avanzado** — por hora / canal / día semana / estacionalidad
6. **Menu engineering matrix** — Star / Plowhorse / Puzzle / Dog
7. **Conciliación bancaria mejorada** — auto-matching, sugerencias, batch
8. **Multi-local consolidation** — roll-up + comparativa
9. **Reportes semanales auto** por email + push

**Garantía:** caja + movimientos + saldos + EERR existentes NO se tocan. Todo es additivo encima.

**Lo que NO se hace (v2):**
- Cash flow forecast con ML
- Anomaly detection con AI predictiva avanzada
- Integración directa AFIP para F.931 / Libro Sueldos Digital
- Multi-currency

---

## 2. Modelo conceptual

### 2.1. Prime Cost — el KPI nº1 de la industria gastronómica

```
Prime Cost = CMV + Mano de Obra
% Prime Cost = (CMV + Mano de Obra) / Ventas × 100

Target industry: < 60%
Verde:    < 55%   excelente
Amarillo: 55-65%  normal
Rojo:     > 65%   alarma
```

Toast/R365/MarginEdge lo tratan como KPI single-most-important. Es el primer número que ve el dueño cada mañana.

**Componentes:**
- **CMV (Costo Mercadería Vendida)** = suma de costos teóricos de las recetas de items vendidos (viene de Specs #2 + #3)
- **Mano de Obra** = liquidaciones del período devengado + cargas sociales (viene de Spec #1)
- **Ventas** = facturado neto del período (ya existe en PASE)

### 2.2. P&L Restaurantero (formato AAA)

Distinto al EERR contable AR genérico. Estructura:

```
VENTAS
  Ventas brutas
  − Descuentos
  − Anulaciones
  − Cortesías
  = VENTAS NETAS

COSTOS DIRECTOS
  − CMV (alimentos)
  − CMV (bebidas)
  − Mano de obra directa (cocina + salón)
  − Cargas sociales
  = MARGEN BRUTO

OPERATING EXPENSES
  − Alquiler
  − Servicios (luz, agua, gas, internet)
  − Mantenimiento
  − Comisiones (Rappi, MP, etc.)
  − Marketing/publicidad
  − Otros gastos operativos
  = EBITDA

NO OPERATING
  − Intereses
  − Impuestos (IIBB, etc.)
  = RESULTADO NETO
```

**Diferencia clave vs EERR actual:**
- EERR es "asientos contables" agrupados por cuenta
- P&L restaurantero está agrupado por **decisiones que un dueño puede tomar** (¿bajo CMV? ¿bajo labor? ¿mejorar mix?)

Coexisten: el EERR sigue existiendo para el contador, el P&L es para el dueño.

### 2.3. Daily Sales Report (DSR)

Reporte que el manager firma al cerrar el día. Toast lo llama "End of Day Report", R365 "DSR".

**Contenido**:

```
DSR — Belgrano — 27-may-2026 (Sábado)

VENTAS DEL DÍA
  Total: $487.300 (147 tickets · $3.316 promedio)
  vs sábado pasado: +12% 📈
  vs promedio últimas 4 semanas sábados: +8%

POR HORARIO
  12-15h Almuerzo: $156k (32%)
  15-19h Tarde:    $48k  (10%)
  19-23h Cena:     $234k (48%)
  23-02h Noche:    $49k  (10%)

POR CANAL
  Salón:     $312k (64%)
  Mostrador: $87k  (18%)
  Delivery:  $89k  (18%)

POR MEDIO DE COBRO
  Efectivo:     $98k  (20%)
  Transfer/MP:  $185k (38%)
  Crédito:      $145k (30%)
  Débito:       $59k  (12%)

INDICADORES OPERATIVOS
  Tickets: 147   (vs 132 sábado pasado)
  Covers: 312    (cubiertos cobrados)
  Ticket promedio: $3.316
  Cover promedio: $1.562

DESCUENTOS Y ANULACIONES
  Descuentos: $12.500 (2.6%)
  Anulaciones: 2 ($8.400) — motivo: cliente devolvió
  Cortesías: $3.200 (0.7%)

PROPINAS
  Total: $34.200 (7% sobre ventas)
  Reparto: ver detalle

NOVEDADES RRHH
  3 empleados trabajaron · 0 ausencias · 1 doble (Pedro)

MERMAS DEL DÍA
  $5.400 — 2 items (1 salmón vencido, 1 plato devuelto)

CIERRE DE CAJA
  Efectivo teórico: $98.000
  Efectivo real:    $97.500
  Diferencia:       -$500 (0.5%) — dentro de tolerancia

[Firmar y cerrar día]
```

**El manager firma**, queda en audit log inmutable. Anto / Lucas reciben el DSR por email al día siguiente.

### 2.4. Cash Flow Forecast 30 días

Proyección visual:

```
SALDO ACTUAL
  Caja efectivo: $187k
  Caja chica:     $32k
  MP:            $1.245k
  Banco:         $3.840k
  TOTAL:         $5.304k

PRÓXIMOS 30 DÍAS — INGRESOS PROYECTADOS
  Ventas estimadas (basado en histórico × estacionalidad): $24.500k
  Liquidaciones MP pendientes: $987k
  Cobros pendientes (cuentas corrientes clientes): $145k

PRÓXIMOS 30 DÍAS — EGRESOS PROYECTADOS
  Compras pendientes (OCs enviadas + facturas no pagadas): $4.200k
  Sueldos próximos (Spec #1 RRHH calcula): $8.500k
  Alquileres y servicios fijos: $2.100k
  AFIP / IIBB: $1.800k

SALDO PROYECTADO AL DÍA 30: $13.349k

⚠️ ALERTAS:
  • Pico de salida 15-jun: $2.300k (sueldos quincena + alquileres)
  • Saldo en banco baja a $1.890k el 15-jun — considerar transferencia desde MP
  • Si ventas caen -10%, saldo final cae a $11.000k (aún positivo)
```

**Reglas:**
- Ventas proyectadas = promedio últimos 30 días × ajuste estacional manual
- Compras proyectadas = OCs en estado ENVIADA/RECIBIDA + facturas no pagadas
- Sueldos = liquidaciones del Spec #1 calculadas forward
- Alquileres/servicios = gastos recurrentes marcados como tales
- AFIP = histórico mensual

### 2.5. Anomaly Detection

**Reglas determinísticas (v1):**

| Tipo | Disparo | Severidad |
|---|---|---|
| Costo MP subió | +X% vs último cargado | 🟡 si 5-15%, 🔴 si >15% |
| Costo MP bajó sospechoso | -X% (puede ser error de carga) | 🟡 si >10% |
| Venta por debajo de promedio | Día con ventas < promedio − 2σ | 🟡 alerta |
| Mermas inusuales | Merma diaria > promedio × 1.5 | 🟡 |
| Diferencia de caja | Diferencia > $X o > N% | 🟡 si <2%, 🔴 si >5% |
| AvT en rojo | Variance > 5% mensual | 🔴 (ya cubierto Spec #3) |
| Gasto fuera de patrón | Categoría con monto >promedio × 2 | 🟡 |
| Empleado sin novedades nunca | Sospechoso "no llega tarde nunca" | 🟢 informativo |
| Proveedor sube siempre +X% | Patrón de inflación específica | 🟡 mensual |

**Cada alerta:**
- Notif push admin
- Email diario agrupado (no spam)
- Aparece en dashboard top de PASE
- Se puede dismiss con motivo (queda log)

**IA opcional (v2):**
- Detección de patrones complejos (correlaciones entre variables)
- Predicción de demanda
- Forecast más preciso

### 2.6. Sales Mix avanzado

**Heatmap por hora del día**:
```
Hora    Lun  Mar  Mié  Jue  Vie  Sáb  Dom
10-12     ░    ░    ░    ░    ▒    ▓    █
12-14     ▓    ▓    ▓    ▓    █    █    █
14-16     ░    ░    ░    ░    ▒    ▓    ▒
16-18     ░    ░    ░    ░    ░    ░    ░
18-20     ▒    ▒    ▒    ▓    ▓    █    █
20-22     ▓    ▓    ▓    █    █    █    █
22-24     ▒    ▒    ▒    ▓    █    █    ▓
```
░ flojo  ▒ moderado  ▓ bueno  █ pico

**Por canal:**
- Salón
- Mostrador
- Delivery propio (con tu motor)
- Rappi
- PedidosYa
- Maxirest (para los que migran)
- MenuQR (orden desde mesa con QR)
- WhatsApp (manual)

**Por categoría:**
- Sushi
- Hot
- Bebidas con/sin alcohol
- Postres
- Combos

### 2.7. Menu Engineering Matrix

Clasifica cada item del menú por **Popularidad** × **Rentabilidad**:

```
              POPULARIDAD
              Baja      Alta
              ┌──────────┬──────────┐
RENTABILIDAD  │          │          │
              │ PUZZLE   │ STAR     │ ← Alta margen
Alta          │ (alto    │ (todos   │
              │ margen,  │ ganan,   │
              │ poco se  │ es lo    │
              │ pide)    │ ideal)   │
              ├──────────┼──────────┤
              │ DOG      │ PLOWHORSE│ ← Baja margen
Baja          │ (mata)   │ (popular │
              │          │ pero     │
              │          │ poco     │
              │          │ margen)  │
              └──────────┴──────────┘
```

**Acción sugerida por cuadrante:**
- **STAR** ⭐ — destacar en menú, no tocar precio
- **PUZZLE** 🧩 — promover más (combos, sugerencias del mozo)
- **PLOWHORSE** 🐎 — subir precio cuidadoso o bajar costo (cambiar receta)
- **DOG** 🐕 — sacar del menú o re-formular

**Cómo se calcula:**
- Popularidad = (ventas del item / ventas totales) ranking dividido en cuartiles
- Rentabilidad = (precio - costo) / precio ranking dividido en cuartiles

Esto es **el reporte más útil para decisiones de menú**. Toast/R365 lo destacan como killer feature.

### 2.8. Conciliación bancaria mejorada

Hoy PASE tiene conciliación bancaria pero es bastante manual. Mejoras:

**Auto-matching** con tolerancia:
- Mismo monto + mismo día → match automático
- Mismo monto + ±1 día → sugerencia
- Mismo monto + comerciante coincide → sugerencia

**Conciliación batch**:
- Banco muestra 1 transferencia de $50.000 que pagó 5 facturas chicas
- Sistema sugiere split del banco entre las 5 facturas según monto

**Alertas de movimientos huérfanos**:
- Banco tiene movimientos que no existen en PASE → flag para investigar (cargos olvidados, comisiones bancarias, etc.)
- PASE tiene movimientos sin match en banco → flag

**Reporte semanal de salud bancaria**:
- % de movimientos conciliados
- Movimientos pendientes review
- Diferencia entre saldo PASE y saldo banco

### 2.9. Multi-local consolidation

**Roll-up automático**:
- P&L del tenant = suma de P&Ls de cada local
- KPIs comparados: Prime Cost % por local + promedio del tenant
- Distribución de gastos compartidos (publicidad central, software, etc.)

**Comparativa local vs local**:
```
              Belgrano   V.Crespo  Devoto    Maneki    Rene
Ventas        $4.2M      $3.8M     $2.9M     $5.1M     $1.4M
CMV %         32%        35%       38% 🔴   30%       40% 🔴
Labor %       28%        30%       33% 🟡   25%       38% 🔴
Prime Cost    60%        65% 🟡   71% 🔴   55% ⭐    78% 🔴
EBITDA $      $890k      $620k     $290k     $1.420k   $40k
```

**Insight automático**:
> "Devoto tiene Prime Cost 71% (rojo). El CMV está 6 puntos arriba del promedio. Revisar mermas y AvT."

> "Maneki es tu mejor local. Considerar replicar prácticas en los otros."

### 2.10. Cash drawer mejorado

Refinement del flow de cierre:

**Conteo ciego al cerrar**:
- Cajero cuenta efectivo físico SIN ver el teórico
- Carga el monto
- Sistema compara con teórico → muestra diferencia
- Si diferencia > tolerancia, requiere justificación obligatoria
- Aprobación de manager si > $X

**Reportes**:
- "Top cajeros con menos diferencias" (gamification opcional)
- "Cajeros con diferencias recurrentes" (red flag investigar)

---

## 3. Schema de datos

### 3.1. Tablas nuevas

#### `dsr_reportes`

```sql
CREATE TABLE dsr_reportes (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),
  fecha           date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Snapshot del día (todos los KPIs calculados):
  ventas_brutas       numeric(15,2) NOT NULL,
  descuentos          numeric(15,2) NOT NULL,
  anulaciones         numeric(15,2) NOT NULL,
  cortesias           numeric(15,2) NOT NULL,
  ventas_netas        numeric(15,2) NOT NULL,

  tickets_count       int NOT NULL,
  covers_count        int NOT NULL,
  ticket_promedio     numeric(15,2) NOT NULL,
  cover_promedio      numeric(15,2) NOT NULL,

  ventas_por_canal    jsonb,
  ventas_por_horario  jsonb,
  ventas_por_categoria jsonb,
  ventas_por_medio_pago jsonb,

  propinas_total      numeric(15,2),
  mermas_dia          numeric(15,2),
  mermas_dia_count    int,

  cmv_teorico         numeric(15,2),       -- de Spec #3
  cmv_pct             numeric(5,2),

  caja_efectivo_teorico numeric(15,2),
  caja_efectivo_real    numeric(15,2),
  diferencia_caja       numeric(15,2),

  empleados_trabajaron  int,
  dobles_dia            int,
  ausencias_dia         int,

  comparativa_semana_anterior_pct numeric(6,2),
  comparativa_promedio_4_semanas_pct numeric(6,2),

  -- Firma del manager:
  firmado boolean NOT NULL DEFAULT false,
  firmado_at timestamptz,
  firmado_por int REFERENCES usuarios(id),
  observaciones text,

  UNIQUE (tenant_id, local_id, fecha)
);

CREATE INDEX ON dsr_reportes(tenant_id, local_id, fecha DESC);
```

#### `pl_snapshots` (P&L histórico mensual)

```sql
CREATE TABLE pl_snapshots (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int REFERENCES locales(id),     -- null = consolidado tenant
  periodo_inicio  date NOT NULL,
  periodo_fin     date NOT NULL,
  generado_at     timestamptz NOT NULL DEFAULT now(),

  ventas_brutas       numeric(15,2) NOT NULL,
  ventas_netas        numeric(15,2) NOT NULL,
  cmv_alimentos       numeric(15,2) NOT NULL,
  cmv_bebidas         numeric(15,2) NOT NULL,
  mano_obra_directa   numeric(15,2) NOT NULL,
  cargas_sociales     numeric(15,2) NOT NULL,
  margen_bruto        numeric(15,2) NOT NULL,

  alquiler            numeric(15,2),
  servicios           numeric(15,2),
  mantenimiento       numeric(15,2),
  comisiones          numeric(15,2),
  marketing           numeric(15,2),
  otros_op            numeric(15,2),
  ebitda              numeric(15,2),

  intereses           numeric(15,2),
  impuestos_var       numeric(15,2),
  resultado_neto      numeric(15,2),

  -- KPIs derivados:
  cmv_pct             numeric(5,2),
  labor_pct           numeric(5,2),
  prime_cost_pct      numeric(5,2),
  ebitda_pct          numeric(5,2)
);

CREATE INDEX ON pl_snapshots(tenant_id, local_id, periodo_inicio DESC);
```

#### `cash_flow_proyecciones`

Snapshot semanal de la proyección 30 días (para tener histórico):

```sql
CREATE TABLE cash_flow_proyecciones (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  generada_at     timestamptz NOT NULL DEFAULT now(),
  fecha_corte     date NOT NULL,            -- desde cuando empieza la proyección

  saldo_actual_total numeric(15,2),
  saldos_por_cuenta jsonb,

  ingresos_30d_proyectados jsonb,
  egresos_30d_proyectados jsonb,
  saldo_proyectado_30d numeric(15,2),

  alertas jsonb,
  recomendaciones jsonb
);

CREATE INDEX ON cash_flow_proyecciones(tenant_id, generada_at DESC);
```

#### `anomalias_detectadas`

```sql
CREATE TABLE anomalias_detectadas (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int REFERENCES locales(id),
  detectada_at    timestamptz NOT NULL DEFAULT now(),

  tipo            text NOT NULL CHECK (tipo IN (
    'COSTO_MP_SUBIO','COSTO_MP_BAJO_SOSPECHOSO','VENTA_BAJA',
    'MERMA_INUSUAL','DIFERENCIA_CAJA','AVT_ROJO','GASTO_FUERA_PATRON',
    'PROVEEDOR_SUBE_RECURRENTE','OTRO'
  )),
  severidad       text NOT NULL CHECK (severidad IN ('INFO','WARNING','CRITICAL')),

  descripcion     text NOT NULL,
  contexto_data   jsonb,                    -- datos específicos (cuál insumo, qué local, etc.)

  -- Workflow:
  estado          text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN (
    'PENDIENTE','REVISADA','DESCARTADA','RESUELTA'
  )),
  reviewed_by     int REFERENCES usuarios(id),
  reviewed_at     timestamptz,
  resolution_notes text
);

CREATE INDEX ON anomalias_detectadas(tenant_id, estado, severidad, detectada_at DESC);
```

#### `bank_match_rules` (auto-matching conciliación bancaria)

```sql
CREATE TABLE bank_match_rules (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),

  prioridad       int NOT NULL,
  nombre          text NOT NULL,

  -- Reglas (JSONB para flexibilidad):
  condicion       jsonb NOT NULL,
  -- Ejemplo: {"monto_match": "exact", "fecha_tolerancia_dias": 1,
  --           "descripcion_contiene": ["PESCADERIA X", "PESCAD X"]}

  accion          text NOT NULL CHECK (accion IN ('AUTO_MATCH','SUGGEST','IGNORE')),
  activo          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

#### `menu_engineering_snapshots`

Snapshot mensual del posicionamiento de cada item:

```sql
CREATE TABLE menu_engineering_snapshots (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int REFERENCES locales(id),     -- null = tenant total
  periodo_inicio  date NOT NULL,
  periodo_fin     date NOT NULL,
  item_id         int NOT NULL REFERENCES items(id),

  unidades_vendidas int NOT NULL,
  ventas_total      numeric(15,2) NOT NULL,
  costo_total       numeric(15,2) NOT NULL,
  margen_bruto      numeric(15,2) NOT NULL,
  margen_pct        numeric(5,2) NOT NULL,

  popularidad_rank  int NOT NULL,
  rentabilidad_rank int NOT NULL,
  popularidad_quartile int NOT NULL CHECK (popularidad_quartile BETWEEN 1 AND 4),
  rentabilidad_quartile int NOT NULL CHECK (rentabilidad_quartile BETWEEN 1 AND 4),

  clasificacion     text NOT NULL CHECK (clasificacion IN ('STAR','PUZZLE','PLOWHORSE','DOG'))
);

CREATE INDEX ON menu_engineering_snapshots(tenant_id, local_id, periodo_inicio DESC);
CREATE INDEX ON menu_engineering_snapshots(tenant_id, clasificacion, periodo_inicio DESC);
```

### 3.2. Tablas modificadas

#### `gastos`

```sql
ALTER TABLE gastos ADD COLUMN tipo_gasto text DEFAULT 'OTROS' CHECK (tipo_gasto IN (
  'ALQUILER','SERVICIOS','MANTENIMIENTO','COMISIONES','MARKETING',
  'IMPUESTOS','INTERESES','OTROS_OP','OTROS_NO_OP'
));
ALTER TABLE gastos ADD COLUMN recurrente boolean NOT NULL DEFAULT false;
ALTER TABLE gastos ADD COLUMN recurrencia text;  -- 'MENSUAL','SEMANAL','ANUAL'
```

#### `tenants`

```sql
ALTER TABLE tenants ADD COLUMN finanzas_config jsonb DEFAULT '{}';
-- Ejemplo:
-- {
--   "prime_cost_target_pct": 60,
--   "anomaly_thresholds": { "costo_mp_warn": 5, "costo_mp_critical": 15 },
--   "cierre_caja_tolerancia_pct": 2,
--   "cierre_caja_tolerancia_monto": 500,
--   "cash_flow_horizon_days": 30,
--   "reportes_semanales_email": true,
--   "reportes_semanales_destinatarios": ["lucas@neko.ar"]
-- }
```

### 3.3. RLS policies

Patrón estándar:

```sql
ALTER TABLE dsr_reportes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pl_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_flow_proyecciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE anomalias_detectadas ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_match_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_engineering_snapshots ENABLE ROW LEVEL SECURITY;

-- (policies estándar tenant_local_visible)
```

Permisos nuevos:
- `finanzas.ver_pl` — ver P&L y dashboards financieros
- `finanzas.firmar_dsr` — firmar DSR (manager)
- `finanzas.ver_dsr` — ver DSRs históricos (admin)
- `finanzas.configurar_alertas` — modificar thresholds anomaly detection
- `finanzas.gestionar_bank_rules` — modificar reglas de conciliación

---

## 4. RPCs nuevas

### 4.1. `fn_generar_dsr`

```sql
CREATE OR REPLACE FUNCTION fn_generar_dsr(
  p_local_id int,
  p_fecha date
) RETURNS bigint AS $$
BEGIN
  -- 1. Calcular todas las métricas del día consultando:
  --    ventas_pos, movimientos, mermas, conteos, rrhh_eventos
  -- 2. Insert en dsr_reportes
  -- 3. Si ya existe DSR para ese (local, fecha), regenerar (UPSERT)
  -- 4. Calcular comparativas histórico
  -- 5. Retornar dsr_id
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.2. `fn_firmar_dsr`

```sql
CREATE OR REPLACE FUNCTION fn_firmar_dsr(
  p_dsr_id bigint,
  p_observaciones text
) RETURNS void AS $$
BEGIN
  -- 1. Auth check (permiso finanzas.firmar_dsr)
  -- 2. Update dsr: firmado=true, firmado_at, firmado_por, observaciones
  -- 3. Trigger envío de email/push al admin
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.3. `fn_generar_pl_snapshot`

```sql
CREATE OR REPLACE FUNCTION fn_generar_pl_snapshot(
  p_local_id int,                          -- NULL para consolidado
  p_periodo_inicio date,
  p_periodo_fin date
) RETURNS bigint AS $$
BEGIN
  -- 1. Calcular ventas del período
  -- 2. Calcular CMV usando recetas snapshoteadas en ventas (de Spec #2+3)
  -- 3. Calcular mano de obra del período (de Spec #1)
  -- 4. Sumar gastos por tipo
  -- 5. Calcular ratios (CMV%, Labor%, Prime Cost%)
  -- 6. Insert en pl_snapshots
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.4. `fn_calcular_cash_flow_forecast`

```sql
CREATE OR REPLACE FUNCTION fn_calcular_cash_flow_forecast(
  p_horizon_days int DEFAULT 30
) RETURNS jsonb AS $$
BEGIN
  -- 1. Saldo actual de todas las cuentas
  -- 2. Ingresos proyectados:
  --    - Ventas: promedio últimos 30d × estacionalidad × horizon_days
  --    - Liquidaciones MP pendientes
  --    - Cobros pendientes clientes
  -- 3. Egresos proyectados:
  --    - Compras: OCs no pagadas + facturas vencen en horizon
  --    - Sueldos: liquidaciones del Spec #1 forward
  --    - Gastos recurrentes mensuales/semanales prorrateados
  --    - Impuestos: histórico mensual proyectado
  -- 4. Generar alertas si saldo proyectado < 0 en algún día
  -- 5. Snapshot en cash_flow_proyecciones
  -- 6. Retornar JSON con timeline
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.5. `fn_detectar_anomalias` (cron diario)

```sql
CREATE OR REPLACE FUNCTION fn_detectar_anomalias() RETURNS int AS $$
DECLARE
  v_count int := 0;
BEGIN
  -- Aplicar TODAS las reglas determinísticas:
  -- 1. Costos MP que subieron/bajaron mucho
  -- 2. Ventas anómalas
  -- 3. Mermas inusuales
  -- 4. Diferencias de caja
  -- 5. AvT en rojo
  -- 6. Gastos fuera de patrón
  -- 7. Proveedores con subas recurrentes
  --
  -- Para cada hallazgo: INSERT en anomalias_detectadas
  -- (con dedup: no crear duplicada si ya hay una PENDIENTE del mismo tipo)
  --
  -- Trigger push + email al admin con resumen diario
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.6. `fn_calcular_menu_engineering` (cron mensual)

```sql
CREATE OR REPLACE FUNCTION fn_calcular_menu_engineering(
  p_local_id int,
  p_periodo_inicio date,
  p_periodo_fin date
) RETURNS int AS $$
BEGIN
  -- 1. Por cada item vendido en el período:
  --    - unidades_vendidas, ventas_total, costo_total (de recetas snapshoteadas)
  --    - margen_pct
  -- 2. Rankear por popularidad (unidades) y rentabilidad (margen %)
  -- 3. Dividir en cuartiles
  -- 4. Clasificar:
  --    Quartile pop 1-2 + quartile rent 1-2 = STAR
  --    Quartile pop 1-2 + quartile rent 3-4 = PLOWHORSE
  --    Quartile pop 3-4 + quartile rent 1-2 = PUZZLE
  --    Quartile pop 3-4 + quartile rent 3-4 = DOG
  -- 5. INSERT en menu_engineering_snapshots
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.7. `fn_auto_match_bancario` (cron al importar extracto)

```sql
CREATE OR REPLACE FUNCTION fn_auto_match_bancario(
  p_movimientos_bancarios_ids bigint[]
) RETURNS int AS $$
BEGIN
  -- Por cada movimiento bancario sin match:
  --   Aplicar bank_match_rules ordenadas por prioridad
  --   Si encuentra match exacto → auto-conciliar
  --   Si encuentra sugerencia → flag como "sugerido" para review
  --   Si no encuentra nada → flag como "huérfano"
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.8. `fn_enviar_reporte_semanal` (cron lunes 9am)

```sql
CREATE OR REPLACE FUNCTION fn_enviar_reporte_semanal() RETURNS int AS $$
BEGIN
  -- Por cada tenant con configuración reportes_semanales_email=true:
  --   1. Generar P&L de la semana
  --   2. Generar resumen Prime Cost por local
  --   3. Listar anomalías de la semana
  --   4. Enviar email con PDF adjunto a destinatarios configurados
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## 5. UX / Wireframes

### 5.1. Dashboard Finanzas (nuevo — pantalla principal)

```
┌──────────────────────────────────────────────────────────────────┐
│ Finanzas                                  [Período: Mayo 2026 ▼]│
├──────────────────────────────────────────────────────────────────┤
│ PRIME COST DEL TENANT                                             │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │  🟡 62.5%                                                   │  │
│ │  (target <60%)                                              │  │
│ │  CMV: 33% + Labor: 29.5%                                    │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│ POR LOCAL                                                         │
│ ┌──────────┬──────────┬──────────┬──────────┬──────────┐       │
│ │ Belgrano │ V.Crespo │ Devoto   │ Maneki   │ Rene     │       │
│ │ 🟢 58%   │ 🟡 63%   │ 🔴 72%   │ 🟢 56%   │ 🔴 78%   │       │
│ └──────────┴──────────┴──────────┴──────────┴──────────┘       │
│                                                                   │
│ ⚠️ ALERTAS DE LA SEMANA (4)                                       │
│ • Pescadería X subió salmón +12% (28-may)                        │
│ • Diferencia caja Devoto $1.500 (27-may)                         │
│ • Mermas anómalas Maneki ayer ($8.400 vs promedio $2.100)        │
│ • Devoto AvT en rojo 6.2% mayo                                    │
│                                                                   │
│ TABS: [P&L] [DSR] [Cash Flow] [Menu Engineering] [Sales Mix]    │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2. P&L vista detallada

```
┌──────────────────────────────────────────────────────────────────┐
│ P&L — Belgrano — Mayo 2026                  [Comparar con: Abr ▼]│
├──────────────────────────────────────────────────────────────────┤
│                          Monto      % Ventas   vs Abr             │
│ ──────────────────────────────────────────────────────────────   │
│ VENTAS                                                            │
│   Ventas brutas        $4.487k     100.0%      +8%                │
│   − Descuentos         −$132k       −2.9%      +12% ⚠            │
│   − Anulaciones         −$48k       −1.1%      −20%               │
│   = VENTAS NETAS       $4.307k      96.0%      +9%                │
│                                                                   │
│ COSTOS DIRECTOS                                                   │
│   − CMV (alimentos)    −$1.245k    −28.9%      +5%                │
│   − CMV (bebidas)        −$180k     −4.2%      +2%                │
│   − Mano de obra         −$987k    −22.9%      +0%                │
│   − Cargas sociales      −$295k     −6.8%      +0%                │
│   = MARGEN BRUTO        $1.600k     37.2%      +14% ⭐            │
│                                                                   │
│ OPERATING EXPENSES                                                │
│   − Alquiler            −$420k      −9.7%      +0%                │
│   − Servicios            −$98k      −2.3%      +5%                │
│   − Comisiones          −$210k      −4.9%      +12% ⚠            │
│   − Marketing            −$45k      −1.0%      −10%               │
│   − Otros op             −$87k      −2.0%      +3%                │
│   = EBITDA               $740k      17.2%      +18% ⭐            │
│                                                                   │
│ INDICADORES CLAVE                                                 │
│   CMV %:           33.1%  🟢 (target <35%)                       │
│   Labor %:         29.7%  🟢 (target <30%)                       │
│   Prime Cost %:    62.8%  🟡 (target <60%)                       │
│   EBITDA %:        17.2%  🟢                                      │
└──────────────────────────────────────────────────────────────────┘
```

### 5.3. DSR mobile (manager cierra el día)

```
┌────────────────────────────────────┐
│ Cerrar día                         │
│ Belgrano — 28-may-2026 (Mié)       │
├────────────────────────────────────┤
│ VENTAS                              │
│ Total: $387.500 (118 tickets)       │
│ vs mié pasado: +12% 📈              │
│                                    │
│ INDICADORES                         │
│ Tickets: 118                       │
│ Cubiertos: 245                     │
│ Ticket promedio: $3.284            │
│                                    │
│ CIERRE CAJA EFECTIVO                │
│ Teórico: $78.500                   │
│ Real contado: [____]               │
│ (cargar después de contar)         │
│                                    │
│ OBSERVACIONES                       │
│ [...........................]      │
│                                    │
│ ✅ Las cifras se cargan automático │
│   No necesitás chequear nada       │
│                                    │
│      [Firmar y cerrar día]         │
└────────────────────────────────────┘
```

### 5.4. Cash Flow Forecast

```
┌──────────────────────────────────────────────────────────────────┐
│ Cash Flow — próximos 30 días                                      │
├──────────────────────────────────────────────────────────────────┤
│ SALDO ACTUAL: $5.304k                                             │
│                                                                   │
│ ┌────────────────────────────────────────────────────────┐      │
│ │ Gráfico timeline (línea de saldo proyectado)            │      │
│ │  $13M ─                                                  │      │
│ │  $10M ─    ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁                              │      │
│ │   $5M ─ ──╱           ╲──                               │      │
│ │   $2M ─                  ╲ ⚠️ mínimo $1.890k 15-jun     │      │
│ │   $0   ─────────────────────────────────────             │      │
│ │       hoy           +15d          +30d                   │      │
│ └────────────────────────────────────────────────────────┘      │
│                                                                   │
│ EGRESOS GRANDES PRÓXIMOS:                                         │
│ • 31-may: Cierre Mayo · sueldos mensuales: $8.500k                │
│ • 5-jun: AFIP IIBB Mayo: $720k                                    │
│ • 10-jun: Alquileres: $2.100k                                     │
│ • 15-jun: Quincenas: $2.300k ⚠️ pico                              │
│                                                                   │
│ 💡 RECOMENDACIÓN                                                  │
│ Considerá transferir $2M de MP a Banco antes del 10-jun           │
│ para cubrir el pico del 15-jun sin tocar margen de seguridad.    │
└──────────────────────────────────────────────────────────────────┘
```

### 5.5. Menu Engineering Matrix

```
┌──────────────────────────────────────────────────────────────────┐
│ Menu Engineering — Mayo 2026                                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│              POPULARIDAD →                                        │
│              Baja              Alta                              │
│         ┌──────────────┬──────────────┐                          │
│  Alta   │ 🧩 PUZZLES   │ ⭐ STARS     │                          │
│         │ (5 items)    │ (8 items)    │                          │
│         │              │              │                          │
│ MARGEN  │ • Tartare    │ • Combo 18p ⭐│                          │
│   ↑     │ • Acevichada │ • Salmón Roll│                          │
│         │ • ...        │ • Burger Cl. │                          │
│         ├──────────────┼──────────────┤                          │
│  Baja   │ 🐕 DOGS      │ 🐎 PLOWHORSE │                          │
│         │ (3 items)    │ (12 items)   │                          │
│         │              │              │                          │
│         │ • Vegano X   │ • Coca 500ml │                          │
│         │ • Postre Y   │ • Cerveza .5L│                          │
│         └──────────────┴──────────────┘                          │
│                                                                   │
│ ACCIONES SUGERIDAS:                                               │
│ • 8 STARS → mantener, destacar visualmente                       │
│ • 5 PUZZLES → promover (combo, sugerencia mozo)                  │
│ • 12 PLOWHORSE → subir precio cuidadoso o bajar costo            │
│ • 3 DOGS → considerar sacar del menú                             │
└──────────────────────────────────────────────────────────────────┘
```

### 5.6. Bandeja de Anomalías

```
┌──────────────────────────────────────────────────────────────────┐
│ Anomalías detectadas (4)                                          │
├──────────────────────────────────────────────────────────────────┤
│ 🔴 CRÍTICA · hace 2h                                              │
│ Costo salmón fillet subió +18% (de $22k a $26k)                   │
│ Proveedor: Pescadería X · Factura 0001-00000567                   │
│ Impacto: 8 platos del menú aumentan costo $X                      │
│   [Revisar factura] [Investigar] [Descartar]                      │
├──────────────────────────────────────────────────────────────────┤
│ 🟡 WARNING · hace 6h                                              │
│ Ventas Devoto miércoles abajo del promedio (-22%)                 │
│ $185k vs $237k promedio mié                                       │
│ Posible causa: feriado puente lunes                               │
│   [Marcar revisada] [Descartar]                                   │
├──────────────────────────────────────────────────────────────────┤
│ 🟡 WARNING · ayer                                                 │
│ Diferencia caja Belgrano $1.200 (1.4%)                            │
│ Cajero: Pedro                                                     │
│   [Ver detalle] [OK acepto] [Investigar más]                      │
└──────────────────────────────────────────────────────────────────┘
```

### 5.7. Conciliación bancaria mejorada

```
┌──────────────────────────────────────────────────────────────────┐
│ Conciliación Banco — Galicia                                      │
│ [Importar extracto] [Reglas auto-match]                           │
├──────────────────────────────────────────────────────────────────┤
│ MOVIMIENTOS DEL BANCO: 87                                         │
│ • Conciliados auto: 62 (71%)                                      │
│ • Sugeridos para review: 18                                       │
│ • Huérfanos (no encontrados en PASE): 7 ⚠️                        │
│                                                                   │
│ SUGERIDOS PARA REVIEW (18)                                        │
│ ─────────────────────────────────────────────────────────────    │
│ 27-may · $147.250 · TRANSF PESCADERIA X                          │
│   → Sugerencia: pago factura 0001-00000567 ($147.250)            │
│     [Conciliar] [Buscar otra factura] [Skip]                     │
│                                                                   │
│ 27-may · $-89.000 · COMISIONES BANCARIAS                          │
│   → Sugerencia: crear movimiento "Comisiones banco" en PASE      │
│     [Crear y conciliar] [Skip]                                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Plan de despliegue

### Fase 0 — Schema en producción (1 día)
- 6 tablas nuevas
- 2 ALTERs (gastos, tenants)
- 7 RPCs nuevas + cron jobs
- Sembrar configuración default por tenant

### Fase 1 — UI nueva bajo feature flag `finanzas_v2` (2 semanas)
- Dashboard Finanzas con Prime Cost
- P&L detallado
- DSR mobile (cierre del día)
- Cash Flow Forecast
- Menu Engineering Matrix
- Bandeja Anomalías
- Conciliación bancaria mejorada

### Fase 2 — Cutover gradual (1 semana)
- Activar para Lucas + Anto
- Validar reportes semanales (lunes)
- Validar DSR diario por 1 semana
- Activar para todos los tenants

### Fase 3 — Cleanup (90 días)
- EERR antiguo coexiste con P&L nuevo (no deprecamos — sirve al contador)
- Conciliación vieja se reemplaza por la mejorada
- Documentar diferencias EERR vs P&L para usuarios

---

## 7. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Categorización de gastos errónea genera P&L incorrecto | Alta | Alto | UI clara para asignar tipo_gasto. Default OTROS_OP si no se sabe. |
| DSR no firmado diario (manager se olvida) | Alta | Bajo | Recordatorio push 23:30 + email lunes con DSRs sin firmar |
| Cash flow forecast subestima por estacionalidad | Media | Medio | Permitir ajuste manual mensual + alertar "los 14-feb las ventas suben 40%" |
| Anomalías generan demasiado ruido | Media | Bajo | Umbrales configurables + auto-dismiss de tipos descartados >3 veces seguidas |
| Menu engineering classifies mal items nuevos | Alta | Bajo | Excluir items con <X ventas del análisis |
| Conciliación bancaria auto-match incorrecto | Baja | Alto | Solo auto-match en condiciones MUY estrictas (monto exacto + descripción exacta). Todo lo demás es "sugerido" requiere review. |

---

## 8. Open questions

1. **EERR vs P&L coexisten o reemplazo**: el contador usa EERR (devengado base contable). El dueño usa P&L restaurantero. Recomendación: coexisten, no reemplazar.

2. **Multi-currency**: si Lucas factura en USD a algún partner (improbable), ¿soportamos? Recomendación: NO en v1.

3. **Comparativa con benchmark de industria**: ¿incluir "tu CMV 33% vs promedio gastronómico AR 32%"? Requiere data agregada anónima. Recomendación: v2 cuando haya múltiples tenants en PASE.

4. **Prime Cost por turno**: ¿calcular Prime Cost del turno almuerzo vs cena? Útil para entender qué turno es rentable. Recomendación: v2.

5. **Forecast con estacionalidad automática**: hoy es manual. ¿Algoritmo simple tipo media móvil ponderada con 12 meses? Recomendación: SÍ v1 si hay data, NO si tenant es nuevo (<6 meses).

6. **Integración AFIP F.931 + Libro Sueldos Digital**: sigue manual. ¿Auto-export? Recomendación: SÍ pero spec aparte (es complejidad propia).

7. **Email reporting**: ¿usamos SMTP propio o servicio (SendGrid, Resend)? Recomendación: Resend (más confiable, ya hay precedente en otros proyectos del repo).

---

## 9. Cosas que NO se hacen

- **Refactor de movimientos + saldos_caja** (ya están bien, deuda C4-F16 cerrada)
- **Refactor de EERR base devengada** (sigue vivo para contador)
- **Refactor de conciliación MP** (ya funciona con cron + release_report)
- **Refactor de POS COMANDA** → Spec #6
- **Permisos unificados** → Spec #7
- **Tienda online + delivery analytics** → Spec #8
- **Multi-currency**
- **AFIP F.931 / Libro Sueldos** (spec aparte)
- **Lectura cheques con OCR**

---

## 10. Aprobación y próximos pasos

**Estado actual:** SPEC ESCRITO — pendiente revisión Lucas.

**Próximos:**
1. Lucas revisa
2. Spec #6 (Ventas + POS COMANDA refinement)
3. Spec #7 (Permisos unificados PASE↔COMANDA)
4. Spec #8 (Tienda + Delivery, opcional)
5. Plan holístico con `writing-plans` — primera vez que tenemos VISTA COMPLETA

---

**Glosario:**
- **P&L** = Profit & Loss (Estado de Resultados)
- **Prime Cost** = CMV + Mano de Obra (KPI #1 de gastronomía)
- **DSR** = Daily Sales Report (reporte diario que firma el manager)
- **EBITDA** = Earnings Before Interest, Taxes, Depreciation, Amortization
- **Cash flow forecast** = proyección de movimientos de caja a futuro
- **Anomaly detection** = detección automática de patrones raros
- **Sales mix** = composición de ventas por categoría/horario/canal
- **Menu engineering** = clasificación de items por popularidad × rentabilidad
- **AAA format** = American Accounting Association — formato estándar gastronómico US
- **Roll-up** = consolidación de datos de varios locales en un total
