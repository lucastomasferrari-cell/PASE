# Rediseño Ventas + POS COMANDA — Design Document

**Fecha:** 2026-05-28
**Autor:** brainstorming session (Lucas + Claude — decisiones default profesionales)
**Estado:** 🟡 SPEC ESCRITO — pendiente revisión Lucas
**Approach:** COMANDA queda como POS puro (vende, cobra, KDS) consumiendo PASE como source of truth + sales mix events para alimentar reportes financieros
**Depende de:** Specs #2 (catálogo movido a PASE), #3 (auto-depleción stock), #5 (eventos sales mix)
**Implementación:** ⏸️ DIFERIDA

---

## 1. Resumen ejecutivo

Después de los specs #1-#5, **COMANDA queda mucho más liviana**: pierde el catálogo, recetas, insumos, CMV, reportes financieros (todo movido a PASE). Lo que QUEDA es el POS puro: venta, cobro, KDS, salón, caja del turno, mostrador/handheld.

Este spec **NO es un rediseño total** (ya están la mayoría de los cambios en otros specs). Es **refinamiento**:

1. **Refactor VentaScreen** post-catálogo-en-PASE — consumer puro con cache local (offline-first)
2. **86 (agotado) real-time sync** vía Supabase Realtime cross-app
3. **Open Item flow completo** end-to-end (cajero cobra → bandeja PASE → formalización)
4. **Sales mix events** disparados en cada venta (alimentan DSR + Menu Engineering)
5. **KDS optimizations** — routing por estación + coursing + tiempos meta
6. **Mostrador + Handheld** UX refinements
7. **Limpieza pantallas duplicadas** en COMANDA (10 que ahora viven en PASE)
8. **Manager Override** integrado con sistema Solicitudes (existe)
9. **Tickets impresos** templates configurables + impresión múltiple
10. **Estaciones de cocina** (sushi/wok/parrilla/bar) con coursing inteligente

**Garantía:** COMANDA sigue operando exactamente igual durante toda la transición. Las features son additivas.

**Lo que NO se hace:**
- Refactor del modelo de mesas/salón (funciona bien)
- Refactor de KDS-app standalone (sigue como está)
- Cualquier feature de delivery → Spec #8
- Cualquier feature de tienda online → Spec #8

---

## 2. Modelo conceptual

### 2.1. COMANDA después de los specs #1-#5

```
┌─────────────────────────────────────────────────────────────┐
│  COMANDA — POS frontline puro                                │
├─────────────────────────────────────────────────────────────┤
│  Pantallas restantes:                                        │
│                                                              │
│  💰 VENTA & COBRO                                            │
│  • VentaScreen (vendedor agrega items + cobra)              │
│  • MostradorView (POS de mostrador, no mesas)               │
│  • HandheldView (mozo en handheld, optimizado táctil chico) │
│  • PinDialog/PinPad (auth rápido turno)                      │
│                                                              │
│  🍳 KDS                                                       │
│  • KdsView (cocina ve pedidos en tiempo real)               │
│                                                              │
│  🪑 SALÓN                                                     │
│  • SalonView (mapa de mesas + estado)                       │
│  • SalonLayoutEditor (config layout — admin)                │
│                                                              │
│  💵 CAJA DEL TURNO                                            │
│  • CajaAbrir / CajaCerrar / CajaEstado / CajaHistorico      │
│  • CajaChica (gastos chicos del turno)                       │
│  • ConciliacionMpView (vista del cajero, no admin)          │
│  • MiCierre (cajero ve su turno)                             │
│                                                              │
│  📲 ACCIONES FRONTLINE                                        │
│  • MermasOneTap (Spec #3 — carga rápida desde celu)         │
│  • InventarioConteo (Spec #3 — conteo móvil)                │
│                                                              │
│  ⚙️ SETTINGS POR LOCAL                                        │
│  • SettingsLocal, SettingsKds, SettingsMesas,               │
│    SettingsMetodosCobro, SettingsRecibos, SettingsEstaciones│
│  • HardwareImpresoras / HardwareAgentes                      │
│                                                              │
│  📋 EXTRAS                                                    │
│  • EmpleadosTrabajando (quién está en turno)                │
│  • Logbook (notas del turno)                                 │
│  • PropinasReparto (reparto al final del turno)              │
└─────────────────────────────────────────────────────────────┘

❌ ELIMINADOS (movidos a PASE):
   ItemsTab, ItemForm, ModificadoresTab, GruposTab,
   CombosLista, ListaPreciosTab, RecetasLista, RecetasImportar,
   InsumosLista, MateriasPrimasLista, AlertasMargenLista, ReporteCMV

❌ Otros que también se evalúan eliminar:
   ReporteCanales (puede vivir en PASE), ReporteMenuEngineering (en PASE),
   ReportePerformanceEmpleados (en PASE), ReporteProductos (en PASE),
   ReporteTiempos (queda en COMANDA, es operativo), ReporteVentas (en PASE)
```

### 2.2. Catálogo consumed real-time

VentaScreen lee el catálogo PASE-administered. Patrón:

```
┌─────────────────────────────────────┐
│  PASE (admin del catálogo)           │
│  • Edit item → Update items table    │
└──────────────┬───────────────────────┘
               │ Supabase Realtime
               ▼
┌─────────────────────────────────────┐
│  COMANDA frontend                    │
│  • Suscripto a items, modifiers,     │
│    combos, item_precios_canal        │
│  • Cache local (IndexedDB) para      │
│    funcionar offline                 │
│  • Si pierde Realtime, sigue con cache│
│  • Reconnect → sync delta            │
└─────────────────────────────────────┘
```

**Performance**: catálogo de 500+ items se carga al login + se mantiene en cache. Cambios via Realtime son delta solamente.

**Offline behavior**:
- Si COMANDA pierde Internet, sigue cobrando con cache local
- Las ventas se guardan localmente con flag `pending_sync`
- Al reconectar, sync push de ventas + sync delta de catálogo

### 2.3. 86 (agotado) real-time sync

Cualquier cajero/manager con permiso puede marcar 86 desde COMANDA:

```
Cajero ve "ya no hay salmón" → toca icono 🚫 en el item
   ↓
COMANDA → UPDATE items SET agotado=true, agotado_at=now(), agotado_por=...
   ↓
Trigger emite evento Realtime
   ↓
Todos los COMANDAs del local lo reciben en <2 segundos
Catálogo en PASE también lo refleja
Tienda online (Spec #8) deja de mostrarlo
```

**Auto-unset**: opcional configurable:
- Al final del día calendario
- Cuando entra una compra del insumo principal (Spec #3 lo sabe)
- Manual (desde COMANDA o PASE)

**Permisos**:
- Por default: cualquier rol POS con permiso `comanda.marcar_86`
- Configurable: solo manager/admin (más restrictivo)

### 2.4. Open Item flow completo

```
1. Cajero en VentaScreen toca "+ Otros"
   ↓
2. Modal Open Item:
   - Descripción: "Pancho con queso del kiosco"
   - Precio: $1.500
   - Cantidad: 2
   - Categoría sugerida: "Otros"
   - Motivo opcional: "Cliente lo pidió, no estaba en menú"
   ↓
3. Cobra normal (efectivo/transferencia/etc.)
   ↓
4. Insert en ventas_no_catalogadas (Spec #2 ya definió esta tabla)
   ↓
5. Notificación a PASE: "Hay 1 venta no catalogada nueva"
   ↓
6. Admin en PASE entra a bandeja "No catalogados pendientes":
   - Ve descripción + precio + frecuencia ("este item se repite 5 veces este mes")
   - Decide: [Formalizar como item nuevo] [Ignorar (caso único)]
   ↓
7a. Si formaliza:
    - Modal "Crear item": nombre, grupo, precio, receta (opcional)
    - Item creado, link al venta_no_catalogada (audit)
    - Reporte mensual de "items que se hicieron Open Item pero ahora están catalogados"
   ↓
7b. Si ignora:
    - Marca como IGNORADO con motivo
    - No vuelve a aparecer
```

### 2.5. Sales mix events

Cada venta cobrada dispara evento que alimenta los reportes del Spec #5:

```
Cuando se confirma venta:
  INSERT en sales_mix_events (
    venta_pos_id,
    local_id,
    fecha_hora,
    canal,                  -- 'salon' / 'mostrador' / 'delivery' / 'rappi' / etc
    turno,                  -- 'almuerzo' / 'tarde' / 'cena' / 'noche'
    items,                  -- jsonb con detalle
    total,
    medio_pago,
    cubiertos,
    server_id,              -- mozo que atendió
    table_id,               -- si aplica
    descuentos,
    propina
  );
```

Este event es lo que alimenta:
- Sales Mix avanzado (Spec #5)
- Menu Engineering (Spec #5)
- DSR (Spec #5)
- AvT (Spec #3) — porque triggea auto-depleción

### 2.6. KDS con coursing inteligente

El KDS actual muestra pedidos. Optimizaciones:

**Routing por estación**:
- Cada item tiene `estacion_id` (sushi, wok, parrilla, bar, etc.)
- KDS por estación filtra solo lo suyo
- Item con múltiples estaciones (ej: combo que va parte a sushi parte a wok) aparece en ambos

**Coursing inteligente**:
```
Mozo carga pedido:
  Curso 1: 1 ceviche, 1 tartare (entradas)
  Curso 2: 1 combinado 18p, 1 pad thai
  Curso 3: 1 cheesecake, 1 helado

KDS automáticamente:
  - Manda CURSO 1 a las estaciones correspondientes
  - CURSO 2 queda en queue NO visible
  - Cuando todos los items del curso 1 están marcados "listo":
    → CURSO 2 aparece automáticamente en estaciones
  - Idem curso 3

Beneficio: el cliente no recibe el principal mientras come la entrada
```

**Tiempos meta vs reales**:
- Cada item tiene `tiempo_preparacion_min` configurable
- KDS calcula tiempo desde que se mandó hasta que se marcó listo
- Si supera meta, alerta rojo

**Bumping**:
- Cocinero tap en item para marcar listo
- Si todos los items del pedido están listos, pedido entero pasa a "para servir"
- Mozo ve notificación en HandheldView

### 2.7. Mostrador + Handheld UX

**MostradorView** (POS tablet/PC en mostrador):
- Layout amplio
- Catálogo visible a la izquierda
- Pedido en construcción a la derecha
- Botones grandes para cobrar rápido (típico delivery/takeaway)

**HandheldView** (mozo con celu o handheld 4"):
- Layout vertical compacto
- Catálogo en cards más chicas
- Selector de mesa primero, después items
- Modificadores en bottom sheet
- "Mandar a cocina" en CTA grande

**Compartido**:
- Mismo backend, misma DB
- Optimization por device class (CSS responsive + algunos UX patterns distintos)

### 2.8. Manager Override integrado

El sistema Solicitudes ya existe (manager_solicitudes table). Integrar en COMANDA:

**Triggers desde POS** que requieren Manager Override:
- Descuento sobre venta > X% (configurable por local, default 15%)
- Anular venta (siempre)
- Cortesía (siempre)
- Cambio precio item específico
- Devolución dinero al cliente
- Reabrir venta cerrada
- Modificar comanda enviada a cocina

**Flow**:
```
Cajero hace acción que requiere override
  ↓
COMANDA crea manager_solicitud(tipo, datos, urgencia)
  ↓
Sistema busca managers disponibles del local:
  - Manager presente físicamente: notif local en su tablet
  - Manager remoto: push al celu
  ↓
Manager aprueba:
  - Si está físicamente: pin numérico en COMANDA
  - Si remoto: tap en push notification → app abre con detalle → aprueba
  ↓
COMANDA recibe approval via Realtime → procede con la acción
```

**Timeout**: si nadie aprueba en X minutos, cajero ve "aprobación pendiente, mostrale al manager".

### 2.9. Tickets impresos

**Templates configurables** por tenant/local:
- Logo
- Slogan
- Info del local (dirección, CUIT, teléfono)
- Items con cantidad + precio
- Subtotal, descuentos, total
- Forma de pago
- QR para reseña / fidelidad / WhatsApp

**Tipos de ticket**:
- **Ticket cliente** (después de cobrar)
- **Ticket cocina** (orden por estación)
- **Comanda interna** (resumen para mozo)
- **Pre-cuenta** (antes de cobrar, mesa pide la cuenta)
- **Re-impresión** (cualquier ticket histórico)

**Driver impresora**:
- ESC/POS estándar (compatible con cualquier térmica)
- Soporte USB / Network / Bluetooth
- HardwareAgentes.tsx ya existe — refinement de UX

### 2.10. Estaciones de cocina

`estaciones_cocina` tabla nueva:

```
id, local_id, nombre, color, orden_ui
```

Ejemplos típicos:
- Sushi (verde)
- Wok (rojo)
- Parrilla (naranja)
- Bar (azul)
- Plancha (amarillo)
- Postres (rosa)

**Items se asignan a estaciones** (campo nuevo en items o item_estaciones para multi-estación).

**KDS filtra por estación** — el cocinero ve solo SU estación.

**Coursing por estación**: el item del curso N no aparece hasta que los items del curso N-1 fueron marcados listos en TODAS las estaciones que participan.

---

## 3. Schema de datos

### 3.1. Tablas modificadas

#### `items`

```sql
ALTER TABLE items ADD COLUMN agotado boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN agotado_at timestamptz;
ALTER TABLE items ADD COLUMN agotado_por int REFERENCES usuarios(id);
ALTER TABLE items ADD COLUMN auto_unset_agotado_diario boolean NOT NULL DEFAULT true;
ALTER TABLE items ADD COLUMN tiempo_preparacion_min int DEFAULT 5;
```

#### `item_estaciones` (M:N items ↔ estaciones)

```sql
CREATE TABLE item_estaciones (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  item_id         int NOT NULL REFERENCES items(id),
  estacion_id     int NOT NULL REFERENCES estaciones_cocina(id),
  rol             text DEFAULT 'PRINCIPAL' CHECK (rol IN ('PRINCIPAL','SECUNDARIA')),
  -- PRINCIPAL: la estación responsable del coursing
  -- SECUNDARIA: prepara una parte pero no bloquea el coursing
  UNIQUE (item_id, estacion_id)
);
```

#### `ventas_pos`

```sql
ALTER TABLE ventas_pos ADD COLUMN canal text DEFAULT 'salon'
  CHECK (canal IN ('salon','mostrador','delivery_propio','rappi','pedidosya','menuqr','whatsapp','otro'));
ALTER TABLE ventas_pos ADD COLUMN cubiertos int DEFAULT 1;
ALTER TABLE ventas_pos ADD COLUMN server_id int REFERENCES comanda_usuarios(id);
```

#### `ventas_pos_items`

```sql
ALTER TABLE ventas_pos_items ADD COLUMN curso int DEFAULT 1;
ALTER TABLE ventas_pos_items ADD COLUMN enviado_a_cocina_at timestamptz;
ALTER TABLE ventas_pos_items ADD COLUMN listo_at timestamptz;
ALTER TABLE ventas_pos_items ADD COLUMN servido_at timestamptz;
```

### 3.2. Tablas nuevas

#### `estaciones_cocina`

```sql
CREATE TABLE estaciones_cocina (
  id              serial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),

  nombre          text NOT NULL,           -- "Sushi", "Wok", "Parrilla"
  color           text,                    -- hex para UI
  orden_ui        int NOT NULL DEFAULT 0,
  activa          boolean NOT NULL DEFAULT true,

  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, local_id, nombre)
);
```

#### `sales_mix_events`

```sql
CREATE TABLE sales_mix_events (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),
  venta_pos_id    bigint NOT NULL REFERENCES ventas_pos(id),
  fecha_hora      timestamptz NOT NULL,
  fecha           date GENERATED ALWAYS AS (fecha_hora::date) STORED,
  hora            int GENERATED ALWAYS AS (EXTRACT(HOUR FROM fecha_hora)::int) STORED,
  dia_semana      int GENERATED ALWAYS AS (EXTRACT(DOW FROM fecha_hora)::int) STORED,

  canal           text NOT NULL,
  turno           text,                    -- 'almuerzo','tarde','cena','noche'
  table_id        int,
  server_id       int REFERENCES comanda_usuarios(id),

  -- Snapshots para reportes (no requiere join):
  ventas_brutas   numeric(15,2) NOT NULL,
  descuentos      numeric(15,2) NOT NULL DEFAULT 0,
  ventas_netas    numeric(15,2) NOT NULL,
  cubiertos       int NOT NULL DEFAULT 1,
  ticket_promedio numeric(15,2) GENERATED ALWAYS AS (ventas_netas / NULLIF(cubiertos, 0)) STORED,

  medio_pago      text,
  items_jsonb     jsonb,                   -- detalle de items para drill-down

  propina         numeric(15,2) DEFAULT 0
);

CREATE INDEX ON sales_mix_events(tenant_id, local_id, fecha DESC);
CREATE INDEX ON sales_mix_events(tenant_id, local_id, fecha, hora);
CREATE INDEX ON sales_mix_events(tenant_id, local_id, canal, fecha DESC);
CREATE INDEX ON sales_mix_events(tenant_id, server_id, fecha DESC);
```

#### `ticket_templates`

```sql
CREATE TABLE ticket_templates (
  id              serial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int REFERENCES locales(id),   -- null = template tenant-wide

  tipo            text NOT NULL CHECK (tipo IN (
                    'CLIENTE','COCINA','COMANDA_INTERNA','PRECUENTA'
                  )),
  nombre          text NOT NULL,

  template_jsonb  jsonb NOT NULL,
  -- Ejemplo:
  -- {
  --   "header": ["{{logo}}", "{{slogan}}", "{{local.nombre}}"],
  --   "items_format": "  {{cantidad}}x {{nombre}} ${{precio}}",
  --   "footer": ["Gracias por venir!", "{{qr_resenas}}"]
  -- }

  activo          boolean NOT NULL DEFAULT true
);
```

#### `pos_offline_queue` (para offline-first)

```sql
CREATE TABLE pos_offline_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),
  created_at_client timestamptz NOT NULL,  -- timestamp del cliente cuando ocurrió
  created_at_server timestamptz DEFAULT now(),  -- cuando llegó al server

  tipo_operacion  text NOT NULL CHECK (tipo_operacion IN (
                    'CREAR_VENTA','COBRAR_VENTA','MARCAR_86','MERMA','ABRIR_CAJA','CERRAR_CAJA','OTRO'
                  )),
  payload         jsonb NOT NULL,

  estado          text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN (
                    'PENDIENTE','PROCESANDO','PROCESADO','ERROR'
                  )),
  error_msg       text,
  procesado_at    timestamptz
);

CREATE INDEX ON pos_offline_queue(tenant_id, estado, created_at_client);
```

### 3.3. RLS policies

Estándar tenant + local.

Permisos nuevos:
- `comanda.marcar_86` — marcar items agotados
- `comanda.open_item` — crear ventas no catalogadas
- `comanda.manager_override` — aprobar overrides (rol manager)
- `comanda.imprimir_tickets` — imprimir/reimprimir
- `comanda.kds_marcar_listo` — bumping en KDS
- `comanda.configurar_estaciones` — admin only

---

## 4. RPCs y endpoints

### 4.1. `fn_marcar_item_86` / `fn_desmarcar_item_86`

```sql
CREATE OR REPLACE FUNCTION fn_marcar_item_86(
  p_item_id int,
  p_motivo text
) RETURNS void AS $$
BEGIN
  UPDATE items SET agotado=true, agotado_at=now(), agotado_por=auth.uid()::int
  WHERE id = p_item_id AND tenant_id = auth_tenant_id();
  -- Realtime publica el cambio automáticamente
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.2. `fn_crear_open_item`

```sql
CREATE OR REPLACE FUNCTION fn_crear_open_item(
  p_venta_pos_id bigint,
  p_descripcion text,
  p_precio numeric,
  p_cantidad int,
  p_motivo text
) RETURNS bigint AS $$
BEGIN
  -- 1. Insert ventas_no_catalogadas (tabla del Spec #2)
  -- 2. Insert ventas_pos_items con item_id=null, descripcion + precio
  -- 3. Notif a admin de PASE
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.3. `fn_formalizar_no_catalogado`

```sql
CREATE OR REPLACE FUNCTION fn_formalizar_no_catalogado(
  p_no_catalogado_id bigint,
  p_nombre text,
  p_grupo_id int,
  p_precio numeric,
  p_crear_receta boolean
) RETURNS int AS $$
DECLARE v_item_id int;
BEGIN
  -- 1. Insert items con datos
  -- 2. Update ventas_no_catalogadas SET estado='FORMALIZADO', item_creado_id
  -- 3. Si p_crear_receta, abrir flow del Spec #2 para receta nueva
  RETURN v_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.4. `fn_emit_sales_mix_event`

Llamada después de cada `fn_cobrar_venta_comanda` exitosa:

```sql
CREATE OR REPLACE FUNCTION fn_emit_sales_mix_event(p_venta_pos_id bigint) RETURNS void AS $$
BEGIN
  -- Calcular turno según hora_actual
  -- Insertar sales_mix_events con todos los snapshots
END;
$$ LANGUAGE plpgsql;
```

### 4.5. `fn_kds_avanzar_curso`

```sql
CREATE OR REPLACE FUNCTION fn_kds_avanzar_curso(p_venta_pos_id bigint, p_curso_actual int) RETURNS boolean AS $$
DECLARE v_todos_listos boolean;
BEGIN
  -- Chequear si todos los items del curso actual están listo_at NOT NULL
  -- Si sí, marcar items del próximo curso como enviado_a_cocina_at=now()
  -- Retornar si se avanzó o no
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.6. `fn_marcar_item_listo`

```sql
CREATE OR REPLACE FUNCTION fn_marcar_item_listo(p_venta_pos_item_id bigint) RETURNS void AS $$
BEGIN
  -- Update listo_at=now()
  -- Trigger fn_kds_avanzar_curso si corresponde
  -- Trigger notif al mozo si todos los items del pedido están listos
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.7. `fn_solicitar_manager_override` (existe parcial, refinement)

Trigger desde COMANDA cuando se necesita approval:

```sql
CREATE OR REPLACE FUNCTION fn_solicitar_manager_override(
  p_tipo text,                              -- 'DESCUENTO_MAYOR_X','ANULAR_VENTA','CORTESIA',...
  p_payload jsonb,
  p_urgencia text DEFAULT 'NORMAL'
) RETURNS uuid AS $$
BEGIN
  -- Insert en manager_solicitudes (existe)
  -- Push a managers disponibles del local
  -- Retornar solicitud_id (cajero polea o recibe via Realtime)
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.8. Endpoint `/api/imprimir-ticket`

Recibe `(venta_id, tipo_ticket, impresora_id?)` → renderiza template con datos → manda a impresora vía HardwareAgentes (existe).

### 4.9. Endpoint `/api/sync-offline-queue`

Procesa `pos_offline_queue` en batch:
- Por cada operación pendiente
- Ejecutar la RPC correspondiente
- Marcar PROCESADO o ERROR
- Retornar resumen al cliente

---

## 5. UX / Wireframes

### 5.1. VentaScreen refactor (la mayoría del cambio es BACKEND, UI similar)

```
┌────────────────────────────────────────────────────────────────────┐
│ Mesa 5 · Mozo Pedro · ⏰ 14:32 · 🌐 Online                          │
├────────────────────────────────────────────────────────────────────┤
│ CATÁLOGO                          │  PEDIDO                        │
│ ┌──────┬──────┬──────┬──────┐    │ ┌────────────────────────────┐│
│ │Combi-│Salm. │Pad   │Cevi- │    │ │ 1x Combo 18p   $14.500     ││
│ │nado  │Roll  │Thai  │che   │    │ │ 1x Pad Thai     $8.900     ││
│ │ 14k  │5.8k  │8.9k  │7.5k  │    │ │ 2x Coca 350     $3.600     ││
│ ├──────┼──────┼──────┼──────┤    │ │                            ││
│ │Burger│Vegano│Coca  │Cerv. │    │ │ Subtotal:      $27.000     ││
│ │ 7.5k │ 6.5k │1.8k  │3.5k  │    │ │ Cubierto:        $400      ││
│ │      │ 🚫   │      │      │    │ │ TOTAL:         $27.400     ││
│ └──────┴──────┴──────┴──────┘    │ └────────────────────────────┘│
│                                    │                                │
│ [Categorías ▼] [Buscar 🔍]        │ [+ Open Item] [Descuento]      │
│                                    │ [Mandar a cocina] [COBRAR]    │
└────────────────────────────────────────────────────────────────────┘
```

**Cambios sutiles**:
- Items con 🚫 = agotados (sync real-time desde otros COMANDAs o PASE)
- Indicador "🌐 Online" — si pierde conexión muestra "🔌 Offline (3 ventas pendientes sync)"
- Cache local — sigue funcionando offline
- **Sin pestaña Catálogo** (movida a PASE)

### 5.2. Modal Open Item

```
┌────────────────────────────────────┐
│ Vender ítem no catalogado         ×│
├────────────────────────────────────┤
│ Descripción:                       │
│ [Pancho con queso del kiosco     ] │
│                                    │
│ Precio: $ [1500   ]                │
│ Cantidad: [1]                      │
│                                    │
│ Categoría sugerida: [Otros ▼]     │
│                                    │
│ Motivo (opcional):                 │
│ [Cliente lo pidió, no está en menú]│
│                                    │
│ ℹ️ Esto se cobra ahora. Anto lo    │
│   verá en PASE para decidir si     │
│   formalizar como item permanente. │
├────────────────────────────────────┤
│       [Cancelar]  [+ Agregar]      │
└────────────────────────────────────┘
```

### 5.3. KDS con coursing

```
┌──────────────────────────────────────────────────────────────┐
│ KDS — Estación SUSHI                       [Auto-coursing ✓] │
├──────────────────────────────────────────────────────────────┤
│ Mesa 5 — Pedro — 14:32                                        │
│ ⏱️ 4 min · 🟡 cerca del límite                                │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ CURSO 1 — En preparación                                 │ │
│ │ ▶ 1x Combinado 18 piezas        [Listo ✓]                │ │
│ │ ▶ 1x Tartare de atún            [Listo ✓]                │ │
│ │ ┌── Curso 2 en queue (aparece cuando curso 1 todo ✓) ─┐ │ │
│ │ │ ⏸ 1x Pad Thai                                       │ │ │
│ │ │ ⏸ 1x Roll arcoíris                                  │ │ │
│ │ └────────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ Mesa 7 — Sofia — 14:35                                        │
│ ⏱️ 1 min                                                       │
│ ▶ 1x Combinado 30 piezas                                      │
└──────────────────────────────────────────────────────────────┘
```

### 5.4. Manager Override mobile (manager remoto)

```
┌────────────────────────────────────┐
│ Solicitud de aprobación  · push   │
├────────────────────────────────────┤
│ Cajero: Camilo (Belgrano)          │
│ Hace 30 segundos                   │
│                                    │
│ TIPO: Descuento 25% sobre venta    │
│                                    │
│ Venta: Mesa 5                      │
│ Total: $27.400                     │
│ Descuento solicitado: $6.850       │
│ Total final: $20.550               │
│                                    │
│ Motivo del cajero:                 │
│ "Cliente esperó 35min su comida"   │
│                                    │
│ ✏️ Tu comentario (opcional):       │
│ [______________]                   │
├────────────────────────────────────┤
│   [Rechazar]   [Aprobar 25%]      │
└────────────────────────────────────┘
```

### 5.5. Bandeja "No catalogados" en PASE

```
┌──────────────────────────────────────────────────────────────────┐
│ Ventas no catalogadas — pendientes review (5)                    │
├──────────────────────────────────────────────────────────────────┤
│ 🔁 RECURRENTE (5 ocurrencias en 30d):                             │
│ "Pancho con queso del kiosco" $1.500                              │
│ Cajeros: Camilo (3x), Sofía (2x) — todos Belgrano                │
│ Total facturado: $7.500                                           │
│   [Formalizar como item nuevo] [Marcar como "no formalizar"]      │
├──────────────────────────────────────────────────────────────────┤
│ Hace 2h · Maneki · Pedro                                          │
│ "Postre especial del día" $3.500 × 1                              │
│ Motivo: chef preparó algo especial                                │
│   [Formalizar como item nuevo] [Ignorar]                          │
├──────────────────────────────────────────────────────────────────┤
│ Ayer · Devoto · Marina                                            │
│ "Ron añejo doble" $1.200 × 2                                      │
│   [Formalizar como item nuevo] [Ignorar]                          │
└──────────────────────────────────────────────────────────────────┘
```

### 5.6. Configuración de estaciones (PASE)

```
┌──────────────────────────────────────────────────────────────────┐
│ Estaciones de cocina — Belgrano               [+ Nueva estación] │
├──────────────────────────────────────────────────────────────────┤
│ 🍣 Sushi (verde) · 3 cocineros · 124 items asignados              │
│ 🥢 Wok (rojo) · 2 cocineros · 47 items asignados                  │
│ 🥩 Parrilla (naranja) · 1 cocinero · 18 items asignados           │
│ 🍹 Bar (azul) · 1 bartender · 38 items asignados                  │
│ 🍰 Postres (rosa) · sin asignar · 12 items asignados              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Plan de despliegue

### Fase 0 — Schema en producción (1 día)
- 4 tablas nuevas (estaciones_cocina, item_estaciones, sales_mix_events, ticket_templates, pos_offline_queue)
- 5 ALTERs (items, ventas_pos, ventas_pos_items)
- 9 RPCs nuevas
- Sembrar estaciones default por local (basado en items existentes)

### Fase 1 — UI nueva bajo feature flag `pos_v2` (2 semanas)
- VentaScreen refactor (cache offline + Realtime)
- 86 button + sync visual
- Modal Open Item
- Sales mix event emission
- KDS con coursing
- Manager Override mobile
- Bandeja "No catalogados" en PASE
- Configuración estaciones

### Fase 2 — Cutover gradual (1 semana)
- Activar `pos_v2` en 1 local (Maneki)
- Validar 1 semana en producción
- Activar para todos

### Fase 3 — Cleanup (90 días)
- Eliminar 10 pantallas viejas de COMANDA (movidas a PASE)
- Update sidebar COMANDA (más focused)

---

## 7. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Cache local desync con catálogo PASE | Media | Medio | Heartbeat cada 30s + full resync si delta > 5min |
| Offline-first introduce bugs raros | Media | Alto | Tests exhaustivos + flag para deshabilitar offline mode |
| 86 sync delay >5s = cliente pide algo agotado | Baja | Bajo | Si hay venta de item agotado dentro de ventana, cajero ve modal "este item recién se agotó, ¿igual cobramos?" |
| Manager remoto no aprueba a tiempo | Alta | Bajo | Timeout 5min, cajero ve "mostrar al manager presente" |
| Coursing inteligente confunde a cocineros | Media | Medio | Toggle "auto-coursing ON/OFF" por local, default ON |
| Open Item abusado para evitar registrar cosas | Media | Medio | Reporte semanal automático + permiso por usuario |
| Tickets impresos templates rompen al cambiar versión | Baja | Bajo | Templates versionados, rollback rápido |

---

## 8. Open questions

1. **Cuánto offline mode**: ¿COMANDA debe soportar offline >1 hora o solo "perder Internet por 5 min"? Recomendación: >1 hora con cache full + queue robusto.

2. **86 desde PASE vs solo COMANDA**: ¿admin en PASE puede también marcar 86 (centralizado)? Recomendación: SÍ. PASE > COMANDA, ambos pueden.

3. **Open Item con receta**: cuando cajero crea Open Item, ¿se le pide receta? Recomendación: NO. Si después se formaliza, ahí se asigna receta.

4. **Coursing en mostrador/delivery**: el coursing inteligente sirve para mesas. ¿Aplicar a mostrador/delivery también? Recomendación: NO automático, default cursar 1 (todo a la vez).

5. **Recibo digital opcional**: en vez de imprimir, mandar PDF/WhatsApp al cliente. ¿Vale la pena? Recomendación: SÍ v1 (suma poco código, ahorra papel).

6. **Tip distribution**: el reparto de propinas ya existe en COMANDA. ¿Mover a PASE? Recomendación: NO, es operativo del turno, queda en COMANDA.

---

## 9. Cosas que NO se hacen

- **Refactor del modelo de mesas/salón** (funciona bien)
- **Refactor KDS standalone** (sigue como está, solo agregamos coursing inteligente)
- **Delivery + Tienda online + Marketplace** → Spec #8
- **Permisos unificados** → Spec #7
- **Multi-currency en POS** (no aplica gastronomía AR)

---

## 10. Aprobación y próximos pasos

**Estado actual:** SPEC ESCRITO — pendiente revisión Lucas.

**Próximos:**
1. Lucas revisa
2. Spec #7 (Permisos unificados PASE↔COMANDA) — chico
3. Spec #8 (Tienda + Delivery) — opcional final
4. Plan holístico con `writing-plans` con TODOS los specs

---

**Glosario:**
- **86** = jerga universal para "no hay más, marcar agotado"
- **Open Item** = vender algo no catalogado con precio libre
- **Coursing** = entregar pedido en cursos (entradas → principales → postres)
- **Bumping** = en KDS, tap para marcar item listo
- **Sales mix** = composición de ventas por categoría/canal/turno
- **Manager Override** = aprobación de manager para acción no permitida al cajero
- **ESC/POS** = estándar de comandos para impresoras térmicas
- **KDS** = Kitchen Display System (pantalla de cocina)
- **HandheldView** = vista POS para celu/handheld pequeño
- **MostradorView** = vista POS para tablet/PC en mostrador
