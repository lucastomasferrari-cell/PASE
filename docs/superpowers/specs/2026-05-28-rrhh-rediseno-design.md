# Rediseño RRHH/Equipo — Design Document

**Fecha:** 2026-05-28
**Autor:** brainstorming session (Lucas + Claude)
**Estado:** 🟡 SPEC APROBADO — pendiente plan de implementación
**Approach elegido:** A — Rediseño total con migration completa (sin pérdida de datos)
**Implementación:** ⏸️ DIFERIDA — primero completar specs de otras áreas del sistema, después hacer todo de una

---

## 1. Resumen ejecutivo

El módulo RRHH actual de PASE modela las novedades como una **tabla mensual con slot por empleado** (1 slot si MENSUAL, 2 si QUINCENAL, 4 si SEMANAL). Este modelo es incompatible con cómo lo resuelven todos los sistemas profesionales del mercado (Tango, Bejerman, Gusto, Toast, Nominapp, Buk, Worky), genera fricción operativa (la auditoría visual identificó 6 puntos concretos) y no escala bien para el caso real de Neko (~14 empleados activos × 4 locales × 4 modalidades de pago coexistiendo).

El **rediseño** reemplaza el modelo de slots mensuales por **eventos discretos con fecha** que el sistema consolida automáticamente cuando se abre una liquidación. Esto:

- Elimina la duplicación de slots para empleados QUINCENAL/SEMANAL
- Permite que múltiples actores (Anto batch quincenal hoy, encargados diariamente en futuro cercano, fichero biométrico en futuro lejano) carguen eventos sin cambiar el modelo
- Unifica las 4 modalidades de pago (DIARIO/SEMANAL/QUINCENAL/MENSUAL) bajo un solo flow conceptual
- Permite agregar más modalidades sin cambios estructurales
- Habilita la integración con fichero biométrico sin rehacer el modelo

**Garantía no negociable:** la migration **no pierde un solo peso** de las liquidaciones históricas. Los pagos ya realizados quedan inmutables como histórico congelado; solo se re-modelan las novedades pendientes (no pagadas).

---

## 2. Modelo conceptual

### 2.1. El cambio fundamental

| Aspecto | Modelo actual | Modelo nuevo |
|---|---|---|
| Unidad atómica | Novedad (mes × empleado × cuota) | Evento (empleado × fecha × tipo) |
| Granularidad | 1 row con N campos sumados | N rows con cantidad individual |
| Período | Mes calendario fijo | Período de pago configurable |
| Origen | Solo manual (Anto) | Manual / Calendario / Fichero |
| Estado | Borrador / Confirmada | (eventos no tienen estado — son hechos) |
| Cierre del período | Confirmar novedad genera liquidación | Abrir liquidación consolida eventos del rango |

### 2.2. Cómo se usa en la práctica

**Antes (modelo actual):**
1. Anto entra a Novedades → elige mes y local
2. El sistema le muestra N slots vacíos (1 por empleado MENSUAL, 2 por QUINCENAL, 4 por SEMANAL)
3. Anto rellena cada slot manualmente: inasistencias, dobles, feriados, presentismo
4. Confirma cada slot → genera la liquidación
5. Va al tab Pagos para pagar cada liquidación una por una

**Después (modelo nuevo):**
1. Durante el período (cualquier momento), Anto/encargado/fichero registran eventos:
   - "Luis faltó 2026-06-07"
   - "Pedro hizo doble 2026-06-13"
   - "Camilo cobró $50.000 de adelanto 2026-06-05"
2. Cuando llega el día de pago (día 16 del mes o 1-5 del siguiente), el sistema le muestra a Anto un Dashboard con las liquidaciones listas para cerrar
3. Anto entra a una liquidación específica → ya consolidada con eventos del rango → REVISA (no carga desde cero) → confirma
4. Paga desde la misma pantalla

### 2.3. Modalidades de pago soportadas

Todas a **período vencido** (confirmado por Lucas):

| Modalidad | Período | Cierra | Paga |
|---|---|---|---|
| **DIARIO** | 1 día | Final del día | Día siguiente |
| **SEMANAL** | Lun-Dom | Domingo | Lunes |
| **QUINCENAL** | 1-15 / 16-fin | Día 15 / fin de mes | Día 16 / Día 1 |
| **MENSUAL** | Mes calendario | Último día del mes | Entre el 1 y el 5 del siguiente |

El sistema debe soportar las 4 modalidades **conviviendo en el mismo tenant** y permitir cambiar la modalidad de un empleado sin perder histórico.

---

## 3. Schema de datos

### 3.1. Tablas nuevas

#### `rrhh_pay_calendars`

Define los calendarios de pago disponibles por tenant. Centraliza las fechas de cutoff.

```sql
CREATE TABLE rrhh_pay_calendars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  nombre          text NOT NULL,                  -- "Mensual estándar", "Quincenal Neko"
  frecuencia      text NOT NULL CHECK (frecuencia IN ('DIARIO','SEMANAL','QUINCENAL','MENSUAL')),
  -- Reglas de cutoff y pago (JSON para flexibilidad):
  -- SEMANAL: { dia_cierre: 0=domingo, dia_pago: 1=lunes }
  -- QUINCENAL: { dias_cierre: [15, -1], dias_pago: [16, 1] }  (-1 = último día)
  -- MENSUAL: { dia_cierre: -1, dia_pago_min: 1, dia_pago_max: 5 }
  reglas          jsonb NOT NULL,
  activo          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON rrhh_pay_calendars(tenant_id, activo);
```

**Reglas por defecto que se siembran al crear tenant:**
- "Mensual estándar" (`MENSUAL`, cierre día -1, pago entre 1-5)
- "Quincenal estándar" (`QUINCENAL`, cierre días 15+-1, pago días 16+1)
- "Semanal estándar" (`SEMANAL`, cierre domingo, pago lunes)
- "Diario estándar" (`DIARIO`)

#### `rrhh_eventos`

La tabla central nueva. **Reemplaza** `rrhh_novedades` para los eventos pendientes (las novedades históricas quedan en su tabla como histórico).

```sql
CREATE TABLE rrhh_eventos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  empleado_id        uuid NOT NULL REFERENCES rrhh_empleados(id),
  fecha              date NOT NULL,                                          -- día calendario al que pertenece
  tipo               text NOT NULL CHECK (tipo IN (
                       'AUSENCIA','DOBLE','FERIADO','HORAS_EXTRA',
                       'VACACION_DIA','ADELANTO','OTRO_DESCUENTO','BONO'
                     )),
  cantidad           numeric(10,2) NOT NULL,                                 -- días (1.0), horas (3.5), o $ ($50000)
  comentario         text,
  -- Origen del evento (clave para el futuro fichero):
  origen             text NOT NULL DEFAULT 'MANUAL' CHECK (origen IN (
                       'MANUAL','CALENDARIO','FICHERO','SISTEMA'
                     )),
  -- Trazabilidad:
  cargado_por        uuid REFERENCES usuarios(id),
  cargado_at         timestamptz NOT NULL DEFAULT now(),
  -- Si vino del fichero, link al punch original:
  fichada_raw_id     uuid,                                                    -- FK opcional, agregar cuando exista la tabla
  -- Si vino del fichero pero fue corregido a mano:
  corregido_por      uuid REFERENCES usuarios(id),
  corregido_at       timestamptz,
  -- Para vincular un evento a una liquidación cerrada (snapshot histórico):
  liquidacion_id     uuid REFERENCES rrhh_liquidaciones(id) ON DELETE SET NULL
);

CREATE INDEX ON rrhh_eventos(tenant_id, empleado_id, fecha);
CREATE INDEX ON rrhh_eventos(tenant_id, fecha) WHERE liquidacion_id IS NULL;
CREATE INDEX ON rrhh_eventos(liquidacion_id) WHERE liquidacion_id IS NOT NULL;
```

**Notas de diseño:**
- Un mismo empleado puede tener múltiples eventos del mismo tipo el mismo día (ej: 2 dobles distintos). Esto era imposible en el modelo de slots.
- `liquidacion_id` se setea cuando la liquidación que consolida ese evento queda PAGADA, "congelándolo" como histórico.
- `cantidad` es genérica: días para AUSENCIA/DOBLE/FERIADO/VACACION_DIA, horas para HORAS_EXTRA, pesos para ADELANTO/OTRO_DESCUENTO/BONO.

#### `rrhh_liquidaciones` (rediseñada — reemplaza la actual)

State machine explícito + período configurable.

```sql
CREATE TABLE rrhh_liquidaciones_v2 (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  empleado_id         uuid NOT NULL REFERENCES rrhh_empleados(id),
  pay_calendar_id     uuid NOT NULL REFERENCES rrhh_pay_calendars(id),

  periodo_inicio      date NOT NULL,
  periodo_fin         date NOT NULL,
  fecha_pago_planeada date NOT NULL,                                          -- Calculado al abrir

  estado              text NOT NULL DEFAULT 'ABIERTA' CHECK (estado IN (
                        'ABIERTA',        -- Acepta más eventos al rango
                        'EN_REVISION',    -- Calculada, Anto revisando antes de pagar
                        'PAGADA',         -- Pagada (todos los eventos congelados)
                        'ANULADA'         -- Eliminada con motivo (auditoría)
                      )),

  -- Snapshot del cálculo (se actualiza mientras está ABIERTA, se congela en EN_REVISION):
  sueldo_base                numeric(15,2),
  descuento_ausencias        numeric(15,2) DEFAULT 0,
  plus_dobles                numeric(15,2) DEFAULT 0,
  plus_feriados              numeric(15,2) DEFAULT 0,
  plus_horas_extras          numeric(15,2) DEFAULT 0,
  plus_vacaciones            numeric(15,2) DEFAULT 0,
  presentismo                numeric(15,2) DEFAULT 0,                          -- 5% CCT
  bonos                      numeric(15,2) DEFAULT 0,
  subtotal                   numeric(15,2),
  total_bruto                numeric(15,2),
  adelantos_descontados      numeric(15,2) DEFAULT 0,
  otros_descuentos           numeric(15,2) DEFAULT 0,
  total_neto                 numeric(15,2),

  -- Snapshot del empleado al momento del cálculo (preserva histórico ante cambios):
  empleado_snapshot          jsonb,                                             -- {nombre, puesto, sueldo_mensual, modo_pago}

  -- Pago real:
  pagado_at                  timestamptz,
  pagado_por                 uuid REFERENCES usuarios(id),
  movimiento_id              uuid REFERENCES movimientos(id),                   -- Link al mov de caja
  notas                      text,

  -- Auditoría:
  abierta_at                 timestamptz NOT NULL DEFAULT now(),
  abierta_por                uuid REFERENCES usuarios(id),
  anulada_at                 timestamptz,
  anulada_por                uuid REFERENCES usuarios(id),
  anulada_motivo             text,

  -- Bloqueo lógico para evitar pagos duplicados:
  UNIQUE (empleado_id, periodo_inicio, periodo_fin, estado) WHERE estado != 'ANULADA'
);

CREATE INDEX ON rrhh_liquidaciones_v2(tenant_id, fecha_pago_planeada) WHERE estado IN ('ABIERTA','EN_REVISION');
CREATE INDEX ON rrhh_liquidaciones_v2(empleado_id, periodo_inicio);
```

#### Tablas reservadas para fichero futuro (no se crean ahora)

Quedan documentadas para que cuando llegue el fichero no rehagamos nada:

```sql
-- FUTURO — NO CREAR AHORA
CREATE TABLE rrhh_relojes (
  id, tenant_id, local_id, modelo, ip_local, api_key, ...
);

CREATE TABLE rrhh_fichadas_raw (
  id, tenant_id, reloj_id, empleado_externo_id, fecha_hora, tipo, procesada, ...
);

CREATE TABLE rrhh_empleados_reloj (
  id, tenant_id, empleado_id, reloj_id, empleado_externo_id
);
```

Cuando se sumen, `rrhh_eventos.fichada_raw_id` se convertirá en FK a `rrhh_fichadas_raw(id)`. La columna ya existe nullable desde día 1.

### 3.2. Tablas modificadas

#### `rrhh_empleados` — agregar FK a calendario

```sql
ALTER TABLE rrhh_empleados ADD COLUMN pay_calendar_id uuid REFERENCES rrhh_pay_calendars(id);

-- Backfill:
-- Empleados con modo_pago='MENSUAL' → calendario "Mensual estándar"
-- Empleados con modo_pago='QUINCENAL' → calendario "Quincenal estándar"
-- Empleados con modo_pago='SEMANAL' → calendario "Semanal estándar"
UPDATE rrhh_empleados
SET pay_calendar_id = (SELECT id FROM rrhh_pay_calendars WHERE tenant_id = rrhh_empleados.tenant_id AND frecuencia = rrhh_empleados.modo_pago LIMIT 1);

ALTER TABLE rrhh_empleados ALTER COLUMN pay_calendar_id SET NOT NULL;

-- Modo_pago queda como columna deprecada (se calcula desde pay_calendar.frecuencia). NO borrar todavía — varios sitios lo leen.
COMMENT ON COLUMN rrhh_empleados.modo_pago IS 'DEPRECATED: usar pay_calendar.frecuencia. Mantenido para compatibilidad backward durante la transición.';
```

### 3.3. Tablas deprecadas (no se borran — quedan congeladas)

- `rrhh_novedades` → queda viva, las novedades históricas (cuyas liquidaciones están pagadas) permanecen como histórico
- `rrhh_liquidaciones` (la actual) → queda viva, las liquidaciones pagadas quedan inmutables

**Decisión clave:** las liquidaciones ya pagadas **no se migran** al nuevo schema. Son histórico congelado y se consultan desde el viejo schema vía una vista de compatibilidad:

```sql
CREATE VIEW v_rrhh_liquidaciones_historico AS
  SELECT ... FROM rrhh_liquidaciones WHERE estado = 'pagado'
  UNION ALL
  SELECT ... FROM rrhh_liquidaciones_v2 WHERE estado = 'PAGADA';
```

Esto garantiza:
- ✅ Cero riesgo de romper auditorías históricas (recibos, libro de sueldos pasados)
- ✅ Migration mucho más simple (solo lo pendiente se re-modela)
- ✅ Rollback posible si el nuevo schema tiene un bug en producción

### 3.4. RLS policies

Todas las tablas nuevas tienen RLS multi-tenant idéntico al patrón actual de PASE:

```sql
ALTER TABLE rrhh_eventos ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON rrhh_eventos
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE POLICY insert_own_tenant ON rrhh_eventos FOR INSERT
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- (idem para rrhh_pay_calendars, rrhh_liquidaciones_v2)
```

**Permisos por slug:** se reutilizan los slugs existentes (`rrhh.gestionar`, `rrhh.ver`) más uno nuevo:
- `rrhh.cargar_eventos` — para encargados/cajeros que en el futuro carguen desde la app diaria

---

## 4. Migration de datos existentes

### 4.1. Principios

1. **Cero pérdida de datos financieros.** Una liquidación pagada hoy debe poder consultarse mañana sin diferencias.
2. **Reversible durante 30 días.** Si descubrimos un bug post-cutover, podemos volver al schema viejo sin perder eventos cargados en el nuevo.
3. **No-downtime.** El sistema sigue operando durante toda la migration.

### 4.2. Mapeo viejo → nuevo

#### Novedades NO confirmadas (estado=`borrador`)

→ Se **eliminan**. Eran inputs sin valor (Anto los llenó y nunca confirmó). No representan eventos reales del empleado.

#### Novedades CONFIRMADAS pero NO pagadas

→ Se **convierten a eventos individuales** en `rrhh_eventos`:
- Una novedad con `inasistencias=2, dobles=1, feriados=0` genera 3 eventos:
  - `tipo=AUSENCIA, fecha=<inicio_periodo>, cantidad=1, comentario='Migrado de novedad N'`
  - `tipo=AUSENCIA, fecha=<inicio_periodo+1>, cantidad=1, comentario='Migrado de novedad N'`
  - `tipo=DOBLE, fecha=<inicio_periodo+7>, cantidad=1, comentario='Migrado de novedad N'`
- La novedad se marca con flag `migrada_a_eventos=true`

**Limitación:** las fechas exactas no las sabemos (la novedad agregaba). Asumimos distribución uniforme. Para casos donde Anto necesita corregir la fecha exacta, lo hace post-migration desde el calendario.

#### Novedades CONFIRMADAS Y PAGADAS

→ Quedan **congeladas** en `rrhh_novedades` y `rrhh_liquidaciones` (schema viejo). NO se tocan.

Para mostrarlas en el Historial de pagos del UI nuevo, se usa la vista `v_rrhh_liquidaciones_historico`.

#### Adelantos

→ La tabla `rrhh_adelantos` queda igual. Por cada adelanto pendiente (no descontado), se genera un evento espejo:
```sql
INSERT INTO rrhh_eventos (empleado_id, fecha, tipo, cantidad, comentario, origen)
SELECT empleado_id, fecha, 'ADELANTO', monto, 'Migrado de adelanto pendiente', 'SISTEMA'
FROM rrhh_adelantos WHERE descontado = false;
```

Esto permite que el nuevo flow descuente adelantos por el mismo mecanismo de eventos.

#### Pagos especiales (aguinaldo, vacaciones, liquidación final)

→ Quedan en `rrhh_pagos_especiales` como están. Son flows aparte (no son liquidaciones mensuales).

### 4.3. Procedimiento step-by-step

1. Crear tablas nuevas vacías en producción (`rrhh_pay_calendars`, `rrhh_eventos`, `rrhh_liquidaciones_v2`)
2. Sembrar calendarios estándar por tenant
3. Backfill `rrhh_empleados.pay_calendar_id`
4. Eliminar novedades en estado `borrador`
5. Convertir novedades confirmadas no pagadas → eventos (script idempotente)
6. Crear eventos espejo de adelantos pendientes
7. Crear vista de histórico unificado
8. (No deploy de UI nueva todavía — esto es solo schema)

### 4.4. Verificación post-migration

Asserts que deben pasar después de la migration:

```sql
-- 1. Cada empleado tiene calendario asignado
SELECT count(*) FROM rrhh_empleados WHERE pay_calendar_id IS NULL;
-- Debe ser 0

-- 2. Todas las novedades confirmadas no pagadas están convertidas
SELECT count(*) FROM rrhh_novedades
WHERE estado = 'confirmada' AND migrada_a_eventos = false
AND NOT EXISTS (SELECT 1 FROM rrhh_liquidaciones l WHERE l.novedad_id = rrhh_novedades.id AND l.estado = 'pagado');
-- Debe ser 0

-- 3. Suma de adelantos pendientes = suma de eventos ADELANTO
SELECT (SELECT sum(monto) FROM rrhh_adelantos WHERE descontado = false)
     = (SELECT sum(cantidad) FROM rrhh_eventos WHERE tipo = 'ADELANTO' AND liquidacion_id IS NULL);
-- Debe ser true

-- 4. El histórico unificado tiene la misma cantidad de filas que el viejo
SELECT count(*) FROM rrhh_liquidaciones WHERE estado = 'pagado'
     = (SELECT count(*) FROM v_rrhh_liquidaciones_historico WHERE estado = 'PAGADA');
-- Debe ser true
```

---

## 5. UX / Wireframes

### 5.1. Dashboard (nuevo)

**Ruta:** `/equipo` (reemplaza el actual)

**Contenido principal:**
- KPI cards: liquidaciones a cerrar HOY, total a pagar HOY, eventos cargados este mes, próximo SAC
- Lista de **"Para cerrar hoy"** ordenada por urgencia (vence hoy, vence mañana, etc)
- Lista de **"Próximas"** colapsable
- Botones de navegación: Vista calendario, Empleados, Configuración, Historial

**Comportamiento:** el sistema calcula qué liquidaciones tienen `fecha_pago_planeada <= hoy AND estado IN ('ABIERTA','EN_REVISION')` y las muestra arriba con CTA "Cerrar y pagar →".

### 5.2. Pay Run (nuevo)

**Ruta:** `/equipo/liquidacion/:id`

**Estructura:**
- Header: nombre empleado · período · pago planeado
- Pre-flight checklist: alertas bloqueantes y warnings
- Desglose detallado: sueldo base, descuento ausencias, plus dobles/feriados, presentismo 5%, adelantos descontados, total neto
- Tabla de eventos consolidados (lectura, con link a calendario para editar)
- Botones: editar eventos, cancelar, pagar

**Comportamiento:** al cargar, el endpoint calcula la liquidación on-the-fly desde los eventos del rango. Si el estado es `ABIERTA`, recalcula cada vez. Si es `EN_REVISION` o `PAGADA`, muestra el snapshot congelado.

### 5.3. Calendario diario (nuevo)

**Ruta:** `/equipo/calendario`

**3 vistas alternativas:**

#### Vista Mes (web, default para Anto)
Grid 7×N con días del mes. Cada celda muestra hasta 4 eventos con icono y nombre del empleado. Click en día → modal con TODOS los empleados del local + botones rápidos por empleado (❌ ⭐ 🎉 🏖️ ＋).

#### Vista Por Empleado (timesheet-style)
Grilla horizontal: filas = empleados, columnas = días. Iconos en celdas según eventos. Click en celda = carga rápida pre-rellenada.

#### Vista Hoy Mobile (para encargados, futuro cercano)
Pantalla optimizada para celular. Lista de empleados del local con 4 botones grandes (Vino OK / Faltó / Doble / Vacación) por cada uno. Botón principal "Cerrar día sin novedades" para el caso 90%.

Las 3 vistas trabajan sobre la **misma tabla `rrhh_eventos`**. Cambiar de vista no requiere recargar datos.

### 5.4. Vista Empleados (refactor mínimo)

Se mantiene casi igual. Cambios:
- Campo `modo_pago` ahora muestra el **nombre del calendario** asignado, con selector que lista calendarios activos del tenant
- Agregar columna "Eventos del mes" para visibilidad rápida
- Botón "Cargar evento rápido" por cada empleado (atajo al modal de evento)

**Default al crear empleado:** el formulario pre-selecciona el calendario "Mensual estándar" del tenant. Si el tenant no tiene ese calendario activo (caso raro de tenant que solo opera con diario), se selecciona el primero disponible alfabéticamente. Nunca queda un empleado sin calendario asignado.

### 5.5. Vista Configuración (nueva sub-pantalla)

**Ruta:** `/equipo/configuracion`

- **Calendarios de pago** — CRUD de calendarios. Por tenant. Se pueden crear customizados (ej: "Quincenal Neko que paga lunes en vez de día 16").
- **Reglas de auto-cálculo** — tolerancia entrada tarde, horas para considerar doble, etc.
- **Plantillas de eventos** — atajos (ej: "Feriado del día completo a todos los empleados del local")
- **(Futuro) Configuración de fichero** — placeholder vacío que diga "Próximamente: integración con reloj biométrico"

### 5.6. Historial (refactor)

Combina el viejo histórico (de `rrhh_liquidaciones`) con el nuevo (de `rrhh_liquidaciones_v2` en estado PAGADA) vía la vista unificada. Filtros por empleado, local, período, tipo de pago.

---

## 6. API contracts

### 6.1. Endpoints nuevos

#### `GET /api/rrhh/dashboard`
Devuelve liquidaciones a cerrar hoy + próximas + KPIs.

```typescript
type DashboardResponse = {
  liquidaciones_hoy: Liquidacion[];
  liquidaciones_proximas: Liquidacion[];
  kpis: {
    total_a_pagar_hoy: number;
    eventos_mes: number;
    proximo_sac_dias: number;
  };
};
```

#### `POST /api/rrhh/eventos`
Crea un evento manual. Usado por la UI del calendario y por el formulario de carga rápida.

```typescript
type CrearEventoBody = {
  empleado_id: string;
  fecha: string;          // ISO date
  tipo: 'AUSENCIA' | 'DOBLE' | 'FERIADO' | 'HORAS_EXTRA' | 'VACACION_DIA' | 'ADELANTO' | 'OTRO_DESCUENTO' | 'BONO';
  cantidad: number;
  comentario?: string;
};

type CrearEventoResponse = { evento_id: string };
```

#### `DELETE /api/rrhh/eventos/:id`
Borra un evento. Solo permitido si la liquidación que lo consolidaría aún está ABIERTA (o si no hay liquidación abierta para ese rango).

#### `POST /api/rrhh/liquidaciones`
Abre una liquidación para un empleado y período. Consolida automáticamente eventos del rango.

```typescript
type AbrirLiquidacionBody = {
  empleado_id: string;
  pay_calendar_id: string;
  periodo_inicio: string;
  periodo_fin: string;
};
```

#### `POST /api/rrhh/liquidaciones/:id/calcular`
Recalcula la liquidación on-the-fly desde los eventos. Devuelve preview sin persistir.

#### `POST /api/rrhh/liquidaciones/:id/pagar`
Confirma el pago. Transiciona estado a PAGADA, congela eventos (setea `liquidacion_id`), crea movimiento en caja.

```typescript
type PagarLiquidacionBody = {
  forma_pago: 'efectivo' | 'transferencia';
  cuenta: string;
  notificar_whatsapp?: boolean;
  notas?: string;
};
```

#### `POST /api/rrhh/liquidaciones/:id/anular`
Anula una liquidación pagada (genera contra-movimiento). Requiere motivo + 2FA del dueño.

### 6.2. Endpoints futuros (NO ahora, documentados para fichero)

```
POST /api/fichero/webhook              ← reloj biométrico postea fichadas
GET  /api/fichero/relojes              ← list de relojes configurados
POST /api/fichero/relojes/:id/sync     ← trigger manual de pull
```

### 6.3. Endpoints deprecados

- `POST /api/rrhh/novedades` → deprecar gradualmente. Mantener funcional 90 días post-cutover por si hay clientes externos.

---

## 7. Reservas para fichero futuro

Resumen del checklist que asegura que cuando se sume el reloj NO haya que rehacer el modelo:

| Reserva | Estado |
|---|---|
| `rrhh_eventos.origen` con enum incluye 'FICHERO' | ✅ Incluido en este spec |
| `rrhh_eventos.fichada_raw_id` columna nullable | ✅ Incluido (sin FK por ahora) |
| `rrhh_eventos.corregido_por` para trazar overrides manuales | ✅ Incluido |
| Vista calendario muestra icono distinto por origen | ✅ Documentado en UX |
| Endpoint `POST /api/eventos` agnóstico de origen | ✅ Incluido |
| Pantalla "Configuración → Fichero" placeholder | ✅ Documentado en UX |

---

## 8. Plan de despliegue por fases

### Fase 0 — Schema en producción (sin tocar UI)
**Duración estimada:** 1 día
- Aplicar migrations
- Sembrar calendarios estándar por tenant
- Backfill empleados → calendarios
- Convertir novedades pendientes → eventos
- Crear vista de histórico unificado
- Verificar asserts post-migration

**Garantía:** la UI vieja sigue funcionando exactamente igual.

### Fase 1 — UI nueva detrás de feature flag
**Duración estimada:** 1-2 semanas
- Implementar Dashboard nuevo, Pay Run, Calendario en feature flag `equipo_v2`
- Activado solo para Lucas + Anto inicialmente (testing en producción con data real)
- UI vieja sigue siendo la default

### Fase 2 — Cutover gradual
**Duración estimada:** 1 semana
- Activar `equipo_v2` para los 4 locales Neko
- Anto opera con la UI nueva durante 1 ciclo completo de pagos
- Si todo OK → cutover global (activar para todos los tenants)

### Fase 3 — Cleanup (90 días post-cutover)
- Deprecar endpoints viejos
- Marcar `rrhh_novedades` como read-only
- Mantener vista de histórico unificado indefinidamente

### Rollback plan
Si algo falla en Fase 1 o 2:
1. Desactivar feature flag → UI vieja vuelve
2. Eventos creados en el nuevo schema se preservan (no se pierden)
3. Liquidaciones nuevas se reabren manualmente en el sistema viejo si llegaron a abrirse
4. La data financiera histórica NO se ve afectada porque nunca se tocó

---

## 9. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Fechas exactas perdidas en migration de novedades | Alta | Bajo | Asumir distribución uniforme + permitir corrección post-migration desde calendario |
| Anto se confunde con el flow nuevo | Media | Medio | Sesión de demo 1:1 antes del cutover + docs nuevas + período de overlap con UI vieja |
| Cálculo de liquidación no coincide con el viejo | Baja | Alto | Suite de tests E2E que compara liquidación vieja vs nueva para los mismos inputs |
| Eventos huérfanos sin liquidación se acumulan | Media | Bajo | Cron de housekeeping mensual + alerta si hay eventos > 90 días sin liquidación |
| Sistema demasiado complejo para empleados sin AFIP | Baja | Bajo | Las features nuevas son opt-in. El flow básico (DIARIO/MENSUAL) sigue siendo simple. |

---

## 10. Open questions (a resolver durante implementación)

1. **Liquidaciones DIARIO**: ¿se generan automáticamente al final del día (cron) o el manager las abre explícitamente? Recomendación: cron al cierre del día calendario, en estado `ABIERTA`.

2. **Cambio de modalidad de pago mid-período**: ej. Luis pasa de QUINCENAL a MENSUAL el 20-jun. ¿Cómo se cierran las quincenas pendientes? Recomendación: cerrar y pagar la última quincena bajo el modo viejo antes del cambio.

3. **Eventos en períodos pasados** (post-cierre): ¿se permite agregar un evento del 15-may si la quincena ya fue pagada? Recomendación: NO. Si Anto descubre un evento perdido, debe generar un pago especial (bono/descuento) en la liquidación actual.

4. **Eventos en períodos futuros**: ¿se permite cargar "Luis va a estar de vacaciones del 1 al 10 de julio" hoy? Recomendación: SÍ. Esto es justamente la utilidad del calendario diario para encargados.

5. **CCT auto-update**: las paritarias gastronómicas cambian los valores trimestralmente. ¿Cómo se actualiza el presentismo 5% o el valor del feriado? Para esta primera versión: hardcoded. Versión futura: tabla `rrhh_cct_escalas` con vigencia desde/hasta.

6. **Liquidación final / Egreso**: ¿se sigue manejando con el flow especial actual (`rrhh_pagos_especiales`)? Recomendación: SÍ. Es un caso suficientemente distinto (proporcional, vacaciones acumuladas, indemnización, preaviso, SAC) que no vale la pena unificar con liquidaciones regulares.

---

## 11. Cosas que NO se hacen en este rediseño

Para mantener el scope acotado, **no** se incluye:

- Integración con AFIP / SIRADIG / F.931 (queda para spec aparte)
- Importación de CCT precargados (paritarias UTHGRA)
- Cálculo automático de SAC histórico (se sigue usando el flow especial actual)
- App nativa para empleados (la vista mobile es una PWA dentro de PASE)
- Disputes bidireccionales empleado ↔ manager (queda para una versión posterior)
- Pre-flight checklist con AI / anomaly detection (versión inicial usa reglas determinísticas)

---

## 12. Aprobación y próximos pasos

**Estado actual:** SPEC ESCRITO — pendiente revisión del usuario.

**Próximos pasos:**
1. Lucas revisa este spec y aprueba o pide cambios
2. ⏸️ **Pausa intencional** — antes de pasar a writing-plans, hacer brainstorming + specs de OTRAS áreas del sistema (Caja, Compras, Ventas, etc.)
3. Cuando estén todos los specs listos → invocar `writing-plans` para armar plan de implementación holístico
4. Ejecutar implementación en orden definido por interdependencias

---

**Glosario rápido para no-coders:**
- **Schema** = estructura de las tablas en la base de datos
- **Migration** = script que cambia el schema sin romper datos
- **RLS (Row Level Security)** = regla que garantiza que cada tenant solo ve sus propios datos
- **Endpoint / API** = URL que el frontend usa para pedir/enviar datos al servidor
- **Cutover** = momento donde se hace el cambio del sistema viejo al nuevo
- **Feature flag** = switch para activar/desactivar una feature sin redeploy
- **JSONB** = tipo de columna que guarda JSON estructurado (flexible)
- **FK (Foreign Key)** = referencia desde una tabla a otra (ej: evento → empleado)
