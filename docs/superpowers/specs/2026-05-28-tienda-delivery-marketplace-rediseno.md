# Rediseño Tienda + Delivery + Marketplace — Design Document

**Fecha:** 2026-05-28
**Autor:** brainstorming session (Lucas + Claude — decisiones default profesionales)
**Estado:** 🟡 SPEC ESCRITO — pendiente revisión Lucas
**Approach:** Modelo unificado de pedidos (todos los canales en una tabla) + tienda propia consume catálogo PASE + integraciones bidireccionales con partners + delivery propio + bot WhatsApp con IA
**Depende de:** Specs #2 (catálogo en PASE), #3 (stock), #5 (sales mix events), #6 (POS con channel)
**Implementación:** ⏸️ DIFERIDA

---

## 1. Resumen ejecutivo

COMANDA ya tiene parcial: 25+ pantallas de tienda/delivery/marketplace fragmentadas (TiendaHome, MenuQrView, MarketplaceHome, PedidosHub, RiderPWA, DispatchMap, etc.). Funciona en partes pero **falta unificación arquitectónica**.

**El problema central**: cada canal de venta (salón, mostrador, tienda propia, Rappi, PedidosYa, WhatsApp, MenuQR) hoy se modela parecido pero no idéntico. Reportes mixtos, mantenimiento difícil, integraciones se duplican.

Este spec unifica:
1. **Tabla `pedidos` unificada** — todos los canales pasan por acá con `canal` discriminator
2. **State machine única**: PENDIENTE → CONFIRMADO → EN_COCINA → LISTO → ASIGNADO_RIDER → EN_CAMINO → ENTREGADO
3. **Tienda propia** como consumer del catálogo PASE (igual que COMANDA)
4. **Marketplace integrations** con webhook handler genérico (Rappi/PedidosYa/etc.)
5. **WhatsApp bot** reusa motor del bot IG (Claude + parsing)
6. **Delivery propio** con dispatch logic + rider app
7. **Pickup/take-away** como alternativa a delivery
8. **Fidelidad + cupones + reseñas** integrado

**Garantía:** las 25 pantallas existentes siguen vivas durante migration. Refactor gradual.

**Valor diferencial:** PASE+COMANDA puede competir con Toast Online Ordering / Square Online + Rappi/PedidosYa con una arquitectura más simple y un solo dashboard de "pedidos de todos los canales".

---

## 2. Modelo conceptual

### 2.1. Tabla `pedidos` unificada

```
Cualquier venta no-salón nace como un PEDIDO:

┌────────────────────────────────────────────────────┐
│  CANALES posibles:                                  │
│  • tienda_propia (tu sitio web)                    │
│  • menu_qr (cliente escanea QR en la mesa)         │
│  • rappi                                            │
│  • pedidosya                                        │
│  • whatsapp (bot)                                   │
│  • telefono (cargado manual por encargado)         │
│  • instagram_dm (futuro v2)                         │
└────────────────────────────────────────────────────┘
                       ↓
┌────────────────────────────────────────────────────┐
│  TABLA pedidos                                       │
│  • id, tenant_id, local_id, canal                   │
│  • cliente_id (FK clientes — opcional guest)         │
│  • items_jsonb (snapshot)                           │
│  • total, descuentos, propina                        │
│  • estado (state machine)                            │
│  • modo_entrega: DELIVERY / PICKUP / EN_LOCAL       │
│  • direccion_entrega (si DELIVERY)                  │
│  • timestamps por estado                             │
│  • venta_pos_id (link cuando se convierte en venta) │
└────────────────────────────────────────────────────┘
```

**Cuando el pedido se COBRA**, genera una `ventas_pos` (que es la fuente de verdad financiera). El pedido es la "captura del intento de compra"; la venta es el "registro fiscal de la transacción cerrada".

### 2.2. State machine del pedido

```
                   ┌─────────────┐
                   │  PENDIENTE  │ ← entrante de cualquier canal
                   └──────┬──────┘
                          │ confirmado por local (o auto si payment OK)
                          ▼
                   ┌─────────────┐
                   │ CONFIRMADO  │ ← envía a cocina
                   └──────┬──────┘
                          │
                          ▼
                   ┌─────────────┐
                   │  EN_COCINA  │ ← KDS lo recibe
                   └──────┬──────┘
                          │ todos los items marcados listos
                          ▼
                   ┌─────────────┐
                   │    LISTO    │
                   └─┬─────────┬─┘
            DELIVERY │         │ PICKUP / EN_LOCAL
                     ▼         ▼
        ┌──────────────────┐  ┌──────────────────┐
        │ ASIGNADO_RIDER   │  │ NOTIFICAR_CLIENTE│
        └────────┬─────────┘  └────────┬─────────┘
                 │                     │
                 ▼                     ▼
        ┌──────────────────┐  ┌──────────────────┐
        │   EN_CAMINO      │  │  ENTREGADO       │
        └────────┬─────────┘  └──────────────────┘
                 │
                 ▼
        ┌──────────────────┐
        │   ENTREGADO      │
        └──────────────────┘

  En cualquier estado puede ir a:
  ┌──────────────────┐
  │   CANCELADO      │ (con motivo)
  └──────────────────┘
```

### 2.3. Tienda online propia

**Stack**: SPA con Vite (mismo que COMANDA), responsive mobile-first.

**Páginas públicas**:
- `tienda.{tenant}.com.ar/` — Home con menú destacado
- `tienda.{tenant}.com.ar/menu` — Catálogo completo (consume `items` de PASE)
- `tienda.{tenant}.com.ar/item/{id}` — Detalle del item con modificadores
- `tienda.{tenant}.com.ar/carrito` — Carrito (cliente-side localStorage)
- `tienda.{tenant}.com.ar/checkout` — Datos cliente + pago
- `tienda.{tenant}.com.ar/confirmacion/{id}` — Order confirmation
- `tienda.{tenant}.com.ar/seguimiento/{id}` — Real-time tracking
- `tienda.{tenant}.com.ar/cuenta` — Customer login + historial (opcional)

**Sincronización en tiempo real**:
- Items disponibles (86 + stock_actual desde Spec #3)
- Precios por canal (`item_precios_canal` ya existe)
- Disponibilidad por local (algunos items solo en algunos locales)

**SEO básico**:
- Sitemap manual generado
- Meta tags por item
- Schema.org/Restaurant + MenuItem markup

**Domain**: configurable por tenant (default `tienda.{tenant}.com.ar` o custom domain).

### 2.4. Checkout flow

```
┌─────────────────────────────────────────────────┐
│  CARRITO                                          │
│  [Item1 con modificadores] $X                    │
│  [Item2 con modificadores] $Y                    │
│  Subtotal: $Z                                     │
│  + Envío (si DELIVERY): $W                       │
│  TOTAL: $Z+W                                      │
│  [Continuar →]                                    │
└──────────────┬──────────────────────────────────┘
               ↓
┌─────────────────────────────────────────────────┐
│  ¿Cómo querés recibirlo?                          │
│  ⚫ Delivery                                       │
│  ⚪ Pickup (vas a buscarlo al local)              │
└──────────────┬──────────────────────────────────┘
               ↓
┌─────────────────────────────────────────────────┐
│  Tus datos                                        │
│  Nombre: [____]                                   │
│  Teléfono: [____]                                 │
│  (Si delivery)                                    │
│  Dirección: [____]                                │
│  Referencias: [____]                              │
│  Selector local más cercano (auto-detect via GPS)│
└──────────────┬──────────────────────────────────┘
               ↓
┌─────────────────────────────────────────────────┐
│  Cupón (opcional)                                 │
│  [CODIGO____] [Aplicar]                           │
│  (Si tiene fidelity points)                       │
│  ☐ Usar mis 250 puntos ($X de descuento)          │
└──────────────┬──────────────────────────────────┘
               ↓
┌─────────────────────────────────────────────────┐
│  Forma de pago                                    │
│  ⚪ MercadoPago (online — Wallet/QR/tarjeta)      │
│  ⚪ Efectivo al recibir                            │
│  ⚪ Transferencia (alias provided)                 │
└──────────────┬──────────────────────────────────┘
               ↓
        [Confirmar pedido]
               ↓
   Si MP: redirect a MP Checkout Pro
   Si Efectivo/Transfer: pedido = CONFIRMADO
```

**Guest checkout** = no requiere login. Pedidos quedan asociados solo al teléfono (no se pueden ver desde otra session).

**Customer login** opcional (Google OAuth + email/password) para:
- Ver historial
- Repetir pedido anterior
- Direcciones guardadas
- Fidelity points

### 2.5. Marketplace integrations (Rappi, PedidosYa)

**Modelo unificado** vía webhooks:

```
Partner externo (Rappi)
   │
   │ POST /api/webhook/rappi (HMAC validation)
   ▼
┌──────────────────────────┐
│ webhooks_externos (log)   │ ← existe ya parcial
└──────┬───────────────────┘
       ▼
┌──────────────────────────┐
│ partner_orders_raw       │ ← nueva, payload crudo
└──────┬───────────────────┘
       ▼ (worker procesa)
┌──────────────────────────┐
│ pedidos (modelo unificado)│
│ canal = 'rappi'           │
└──────────────────────────┘
```

**Mapping items partner → PASE**:
- Tabla `partner_item_mapping` con (partner, codigo_partner, item_id_pase)
- Si llega item no mapeado → flag para admin (similar a Open Item)

**Sync de cambios PASE → partners**:
- 86 en PASE → desactivar en Rappi vía API
- Precio cambia en PASE → actualizar en Rappi
- Worker que polea/empuja según el partner soporte

**Acknowledgement bidireccional**:
- Cuando aceptás pedido Rappi en PASE/COMANDA → API call a Rappi
- Cuando marcás listo → idem
- Cuando rider lo retira → idem

### 2.6. WhatsApp ordering bot

**Reusa motor del bot IG existente** (`packages/instagram-bot/`):

```
Cliente: "Hola, quiero pedir 1 combinado de 18 piezas para Belgrano"
   │
   ▼
WhatsApp Business API → webhook PASE
   │
   ▼
Bot (Claude) parsea:
  - intent: ORDER
  - items: ["combinado_18p"]
  - local: belgrano
  - falta: dirección + forma de pago
   │
   ▼
Bot responde: "Perfecto. ¿Cuál es tu dirección?
              ¿Pagás efectivo al recibir o te mando link de MP?"
   │
   ▼ cliente completa info
   ▼
Bot crea pedido (canal=whatsapp) en estado PENDIENTE
   │
   ▼
Notif al local: "Nuevo pedido WhatsApp pendiente confirmar"
   │
   ▼
Local confirma → flow normal
```

**Escalada a humano**: si bot detecta query compleja (cambio de receta, queja, etc.) → escalada al admin como hace el bot IG.

### 2.7. Delivery propio

**Riders**: app `RiderPWA` (ya existe).

**Dispatch logic**:

```
Pedido marcado LISTO + modo=DELIVERY
   │
   ▼
Worker dispatch ejecuta:
  1. Filtrar riders activos en el local
  2. Por cada rider: calcular score:
     - Distancia al local actual (GPS rider opcional)
     - Carga actual (pedidos asignados sin entregar)
     - Zona geográfica de cobertura (si configurada)
  3. Asignar al rider con mejor score
   │
   ▼
Rider recibe push: "Nuevo pedido — recoger en Belgrano para Av. Cabildo 3245"
   │
   ▼ rider acepta (o rechaza, va al 2do)
   ▼
Estado: ASIGNADO_RIDER
   │
   ▼ rider llega al local + recoge
   ▼
Estado: EN_CAMINO (rider tap "Recogido")
   │
   ▼ rider llega a destino + entrega
   ▼
Estado: ENTREGADO (rider tap "Entregado" + opcional foto)
```

**Tracking real-time** (opcional, requiere GPS habilitado en rider app):
- Customer ve link de seguimiento con map
- Posición rider actualizada cada 30s
- ETA estimado

**Si rider cancela / no entrega**:
- Re-dispatch automático
- Si después de N rechazos → notif al admin para resolver manual

### 2.8. Pickup / Take-away

Alternativa más simple a delivery:

```
Cliente eligió PICKUP en checkout
   │
   ▼
Pedido sigue flow normal hasta LISTO
   │
   ▼
Notif al cliente: "Tu pedido está listo. Venilo a buscar a {local}"
   │
   ▼ cliente llega + identifica con código
   ▼
Estado: ENTREGADO (cajero marca "Entregado en local")
```

### 2.9. Fidelidad + cupones + reseñas

**Fidelidad** (existe parcial `FidelidadLista`):
- Sistema de puntos por compra (1 pt por cada $100 gastado, configurable)
- Canjes por descuentos en futuros pedidos
- Niveles (Bronze/Silver/Gold) con beneficios escalonados
- Cumpleaños: cupón automático

**Cupones** (existe parcial `CuponesAdmin`):
- Códigos promocionales (FIRST10, NEKO25, etc.)
- Reglas: monto mínimo, items específicos, canal específico
- Stackable o no (default: no)
- Límite de usos por cliente + total

**Reseñas** (existe parcial `ResenasAdmin`):
- Post-entrega (15 min después), cliente recibe link
- 1-5 estrellas + comentario opcional
- Foto opcional
- Score afecta:
  - Reporte de Menu Engineering (items con bajas reviews → flag)
  - Visibilidad del local en marketplace (futuro)
- Bandeja admin para responder

### 2.10. Reservas online (existe parcial)

`ReservasAdmin` ya existe. Refinement:
- Form público en tienda
- Cliente elige fecha + hora + cantidad de personas
- Sistema chequea disponibilidad contra mesas + horarios
- Confirma automática (si hay mesa) o manual (admin aprueba)
- Recordatorio 1h antes
- No-show tracking

---

## 3. Schema de datos

### 3.1. Tablas nuevas

#### `pedidos` (modelo unificado)

```sql
CREATE TABLE pedidos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),
  numero          text NOT NULL,                  -- visible al cliente (ORD-2026-001234)
  created_at      timestamptz NOT NULL DEFAULT now(),

  canal           text NOT NULL CHECK (canal IN (
                    'tienda_propia','menu_qr','rappi','pedidosya',
                    'whatsapp','telefono','instagram_dm','otro'
                  )),
  canal_external_id text,                          -- id del pedido en Rappi/PedidosYa

  cliente_id      bigint REFERENCES clientes(id),  -- null si guest
  cliente_nombre  text NOT NULL,
  cliente_telefono text NOT NULL,
  cliente_email   text,

  -- Items snapshot:
  items_jsonb     jsonb NOT NULL,                  -- [{item_id, cantidad, modificadores, precio, ...}]
  subtotal        numeric(15,2) NOT NULL,
  descuentos      numeric(15,2) DEFAULT 0,
  costo_envio     numeric(15,2) DEFAULT 0,
  propina         numeric(15,2) DEFAULT 0,
  total           numeric(15,2) NOT NULL,

  -- Modo entrega:
  modo_entrega    text NOT NULL CHECK (modo_entrega IN ('DELIVERY','PICKUP','EN_LOCAL')),
  direccion_entrega text,
  direccion_lat   numeric(9,6),
  direccion_lng   numeric(9,6),
  referencias_direccion text,

  -- Pago:
  metodo_pago     text NOT NULL CHECK (metodo_pago IN (
                    'mp_online','efectivo','transferencia','mp_pos','tarjeta'
                  )),
  mp_payment_id   text,
  pago_confirmado boolean NOT NULL DEFAULT false,
  pago_confirmado_at timestamptz,

  -- Cupones / fidelidad:
  cupon_id        bigint REFERENCES cupones(id),
  puntos_canjeados int DEFAULT 0,

  -- State machine:
  estado          text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN (
                    'PENDIENTE','CONFIRMADO','EN_COCINA','LISTO',
                    'ASIGNADO_RIDER','EN_CAMINO','ENTREGADO','CANCELADO'
                  )),
  cancelado_motivo text,

  -- Timestamps por estado:
  confirmado_at   timestamptz,
  en_cocina_at    timestamptz,
  listo_at        timestamptz,
  asignado_rider_at timestamptz,
  en_camino_at    timestamptz,
  entregado_at    timestamptz,
  cancelado_at    timestamptz,

  -- Rider asignado:
  rider_id        int REFERENCES comanda_usuarios(id),

  -- Link a venta_pos cuando se cierra:
  venta_pos_id    bigint REFERENCES ventas_pos(id),

  -- Notas:
  notas_cliente   text,
  notas_internas  text
);

CREATE INDEX ON pedidos(tenant_id, local_id, estado, created_at DESC);
CREATE INDEX ON pedidos(tenant_id, canal, created_at DESC);
CREATE INDEX ON pedidos(tenant_id, cliente_telefono);
CREATE INDEX ON pedidos(tenant_id, rider_id) WHERE rider_id IS NOT NULL;
CREATE INDEX ON pedidos(canal_external_id) WHERE canal_external_id IS NOT NULL;
```

#### `partner_orders_raw` (payload crudo de webhooks)

```sql
CREATE TABLE partner_orders_raw (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  partner         text NOT NULL CHECK (partner IN ('rappi','pedidosya','peya','otro')),
  webhook_id      text,
  payload_jsonb   jsonb NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),

  -- Status:
  procesado       boolean NOT NULL DEFAULT false,
  procesado_at    timestamptz,
  pedido_id       uuid REFERENCES pedidos(id),
  error_msg       text
);

CREATE INDEX ON partner_orders_raw(tenant_id, partner, procesado, received_at DESC);
```

#### `partner_item_mapping`

```sql
CREATE TABLE partner_item_mapping (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  partner         text NOT NULL,
  codigo_partner  text NOT NULL,
  item_id         int NOT NULL REFERENCES items(id),
  precio_partner  numeric(12,2),                  -- precio que enviamos al partner

  activo          boolean NOT NULL DEFAULT true,
  ultima_sync_at  timestamptz,

  UNIQUE (tenant_id, partner, codigo_partner)
);
```

#### `clientes` (refinement — puede existir parcial)

```sql
CREATE TABLE IF NOT EXISTS clientes (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Identificación (al menos uno requerido):
  email           text,
  telefono        text NOT NULL,
  nombre          text NOT NULL,

  -- Auth opcional (si hizo login):
  auth_user_id    uuid,                            -- FK a auth.users

  -- Fidelidad:
  puntos          int NOT NULL DEFAULT 0,
  nivel           text DEFAULT 'BRONZE' CHECK (nivel IN ('BRONZE','SILVER','GOLD','PLATINUM')),
  cumpleaños      date,

  -- Direcciones guardadas:
  direcciones_jsonb jsonb DEFAULT '[]'::jsonb,

  -- Métricas:
  total_pedidos   int NOT NULL DEFAULT 0,
  total_gastado   numeric(15,2) NOT NULL DEFAULT 0,
  ultimo_pedido_at timestamptz,

  -- Marketing:
  acepta_email    boolean DEFAULT true,
  acepta_whatsapp boolean DEFAULT true,

  UNIQUE (tenant_id, telefono)
);

CREATE INDEX ON clientes(tenant_id, telefono);
CREATE INDEX ON clientes(tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX ON clientes(tenant_id, auth_user_id) WHERE auth_user_id IS NOT NULL;
```

#### `cupones` (refinement)

```sql
CREATE TABLE IF NOT EXISTS cupones (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),

  codigo          text NOT NULL,
  descripcion     text,
  tipo_descuento  text NOT NULL CHECK (tipo_descuento IN ('PORCENTAJE','MONTO_FIJO')),
  valor           numeric(12,2) NOT NULL,

  -- Reglas:
  monto_minimo    numeric(12,2),
  items_aplicables_ids int[],
  canales_aplicables text[],
  validez_inicio  timestamptz,
  validez_fin     timestamptz,

  -- Límites:
  usos_max_total  int,
  usos_max_por_cliente int DEFAULT 1,
  usos_actuales   int NOT NULL DEFAULT 0,

  activo          boolean NOT NULL DEFAULT true,

  UNIQUE (tenant_id, codigo)
);
```

#### `cupones_usos`

```sql
CREATE TABLE cupones_usos (
  id              bigserial PRIMARY KEY,
  cupon_id        bigint NOT NULL REFERENCES cupones(id),
  cliente_id      bigint REFERENCES clientes(id),
  pedido_id       uuid NOT NULL REFERENCES pedidos(id),
  monto_descuento numeric(12,2) NOT NULL,
  used_at         timestamptz NOT NULL DEFAULT now()
);
```

#### `resenas`

```sql
CREATE TABLE resenas (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),
  cliente_id      bigint REFERENCES clientes(id),
  pedido_id       uuid REFERENCES pedidos(id),

  created_at      timestamptz NOT NULL DEFAULT now(),
  estrellas       int NOT NULL CHECK (estrellas BETWEEN 1 AND 5),
  comentario      text,
  foto_url        text,

  -- Por aspecto (opcional):
  estrellas_comida int CHECK (estrellas_comida BETWEEN 1 AND 5),
  estrellas_entrega int CHECK (estrellas_entrega BETWEEN 1 AND 5),

  -- Response del admin:
  respuesta_admin text,
  respondida_at   timestamptz,
  respondida_por  int REFERENCES usuarios(id),

  -- Visibilidad:
  publica         boolean NOT NULL DEFAULT true,
  moderada        text DEFAULT 'PENDIENTE' CHECK (moderada IN (
                    'PENDIENTE','APROBADA','RECHAZADA','SPAM'
                  ))
);

CREATE INDEX ON resenas(tenant_id, local_id, created_at DESC);
CREATE INDEX ON resenas(tenant_id, moderada, created_at DESC);
```

#### `reservas` (refinement)

```sql
CREATE TABLE IF NOT EXISTS reservas (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),
  cliente_id      bigint REFERENCES clientes(id),

  fecha           date NOT NULL,
  hora            time NOT NULL,
  cantidad_personas int NOT NULL,
  mesa_id         int REFERENCES mesas(id),         -- null si auto-asignación pendiente

  nombre_contacto text NOT NULL,
  telefono_contacto text NOT NULL,
  notas           text,

  estado          text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN (
                    'PENDIENTE','CONFIRMADA','CANCELADA','LLEGO','NO_SHOW'
                  )),

  created_at      timestamptz NOT NULL DEFAULT now(),
  canal           text DEFAULT 'tienda_propia'
);

CREATE INDEX ON reservas(tenant_id, local_id, fecha, hora);
```

#### `dispatch_assignments`

```sql
CREATE TABLE dispatch_assignments (
  id              bigserial PRIMARY KEY,
  pedido_id       uuid NOT NULL REFERENCES pedidos(id),
  rider_id        int NOT NULL REFERENCES comanda_usuarios(id),

  asignado_at     timestamptz NOT NULL DEFAULT now(),
  asignado_por    text NOT NULL CHECK (asignado_por IN ('AUTO','MANUAL')),
  asignado_por_user int REFERENCES usuarios(id),

  aceptado_at     timestamptz,
  rechazado_at    timestamptz,
  rechazado_motivo text,

  -- Para algoritmo:
  score_asignacion numeric(10,4),
  distancia_metros int
);
```

### 3.2. Tablas modificadas

#### `ventas_pos`

```sql
-- Cuando un pedido se cierra como venta, link explícito:
ALTER TABLE ventas_pos ADD COLUMN pedido_id uuid REFERENCES pedidos(id);
-- canal ya se agregó en Spec #6
```

#### `comanda_usuarios`

```sql
-- Para riders:
ALTER TABLE comanda_usuarios ADD COLUMN es_rider boolean NOT NULL DEFAULT false;
ALTER TABLE comanda_usuarios ADD COLUMN rider_zona_id int REFERENCES rider_zonas(id);
ALTER TABLE comanda_usuarios ADD COLUMN rider_vehiculo text;  -- 'moto','bici','auto','a_pie'
ALTER TABLE comanda_usuarios ADD COLUMN rider_activo boolean NOT NULL DEFAULT false;  -- en turno o no
```

#### `rider_zonas` (nuevo)

```sql
CREATE TABLE rider_zonas (
  id              serial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  local_id        int NOT NULL REFERENCES locales(id),
  nombre          text NOT NULL,
  poligono        text,                            -- WKT polygon
  activa          boolean NOT NULL DEFAULT true
);
```

### 3.3. RLS y permisos

Estándar tenant + local.

Permisos nuevos:
- `pedidos.ver` — ver bandeja de pedidos
- `pedidos.confirmar` — confirmar pedidos pendientes
- `pedidos.cancelar` — cancelar pedidos
- `tienda.gestionar` — configurar tienda propia
- `marketplace.gestionar` — configurar integraciones partner
- `dispatch.asignar` — asignar rider manualmente
- `clientes.ver` — ver lista clientes
- `clientes.editar` — modificar datos clientes
- `cupones.crear` / `cupones.gestionar`
- `resenas.responder` — responder reseñas
- `resenas.moderar` — aprobar/rechazar reseñas
- `reservas.gestionar` — gestionar reservas

---

## 4. RPCs y endpoints

### 4.1. Endpoints públicos (tienda)

```
GET  /api/tienda/{tenant}/menu              — catálogo público
GET  /api/tienda/{tenant}/item/{id}          — detalle item
POST /api/tienda/{tenant}/pedido             — crear pedido (guest o auth)
GET  /api/tienda/{tenant}/pedido/{id}/track  — tracking real-time
POST /api/tienda/{tenant}/cliente/auth       — login customer
POST /api/tienda/{tenant}/cupon/validar      — validar código cupón
```

### 4.2. Endpoints partner webhooks

```
POST /api/webhook/rappi                      — recibe pedido Rappi
POST /api/webhook/pedidosya                  — recibe pedido PedidosYa
POST /api/webhook/whatsapp                   — recibe mensaje WhatsApp
```

Cada uno valida HMAC, insert en `partner_orders_raw`, worker procesa.

### 4.3. Endpoints internos (PASE/COMANDA admin)

```
GET  /api/pedidos                            — bandeja con filtros
POST /api/pedidos/{id}/confirmar
POST /api/pedidos/{id}/cancelar
POST /api/pedidos/{id}/asignar-rider
GET  /api/dispatch/sugerencias/{pedido_id}   — algoritmo dispatch
```

### 4.4. RPCs SQL

#### `fn_crear_pedido`

```sql
CREATE OR REPLACE FUNCTION fn_crear_pedido(
  p_local_id int,
  p_canal text,
  p_cliente_data jsonb,
  p_items jsonb,
  p_modo_entrega text,
  p_direccion jsonb,
  p_metodo_pago text,
  p_cupon_codigo text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS uuid AS $$
BEGIN
  -- 1. Idempotency
  -- 2. Validar items existen + agotado=false
  -- 3. Calcular subtotal + envío + descuentos
  -- 4. Upsert cliente
  -- 5. Insert pedido estado=PENDIENTE
  -- 6. Si MP online: redirect a checkout MP
  -- 7. Si efectivo: directo CONFIRMADO
  -- 8. Notif al local
  -- 9. Retornar pedido_id
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

#### `fn_avanzar_pedido_estado`

```sql
CREATE OR REPLACE FUNCTION fn_avanzar_pedido_estado(
  p_pedido_id uuid,
  p_nuevo_estado text,
  p_data jsonb DEFAULT '{}'
) RETURNS void AS $$
BEGIN
  -- Validar transición permitida según state machine
  -- Update timestamp del nuevo estado
  -- Si LISTO + modo=DELIVERY: trigger fn_dispatch_pedido
  -- Si ENTREGADO: trigger fn_cerrar_pedido_a_venta
  -- Notif al cliente (push/email/WhatsApp)
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

#### `fn_dispatch_pedido` (algoritmo)

```sql
CREATE OR REPLACE FUNCTION fn_dispatch_pedido(p_pedido_id uuid) RETURNS int AS $$
DECLARE v_rider_id int;
BEGIN
  -- 1. Filtrar riders activos del local + zona coincide con destino
  -- 2. Por cada rider, calcular score (distancia + carga + zona)
  -- 3. Asignar al de mejor score
  -- 4. INSERT dispatch_assignments
  -- 5. Push al rider
  -- 6. Update pedido.rider_id + estado=ASIGNADO_RIDER
  RETURN v_rider_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

#### `fn_cerrar_pedido_a_venta`

```sql
CREATE OR REPLACE FUNCTION fn_cerrar_pedido_a_venta(p_pedido_id uuid) RETURNS bigint AS $$
DECLARE v_venta_id bigint;
BEGIN
  -- 1. Generar ventas_pos desde pedido data
  -- 2. Snapshot recetas + auto-depleción stock (Specs #2 + #3)
  -- 3. Emit sales_mix_event (Spec #5)
  -- 4. Update pedido.venta_pos_id
  -- 5. Otorgar fidelity points al cliente
  -- 6. Disparar reseña post-entrega (cron 15min después)
  RETURN v_venta_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

#### `fn_sync_a_partners` (cron periódico)

Por cada partner activo, sync:
- 86 changes
- Precios changes
- Items nuevos/baja

#### `fn_solicitar_resena_post_entrega` (cron 15min después de ENTREGADO)

Manda WhatsApp/email al cliente con link.

---

## 5. UX / Wireframes

### 5.1. Bandeja unificada de pedidos en PASE

```
┌──────────────────────────────────────────────────────────────────┐
│ Pedidos                              [Filtros] [+ Pedido manual] │
├──────────────────────────────────────────────────────────────────┤
│ KPIs hoy:                                                          │
│ ┌──────┬──────┬──────┬──────┬──────┬──────┐                     │
│ │ Total│ Pend │ Cocin│ Listo│ Cami │ Entr │                     │
│ │  47  │   3  │  12  │   5  │   8  │  19  │                     │
│ └──────┴──────┴──────┴──────┴──────┴──────┘                     │
│                                                                   │
│ Por canal:                                                        │
│ • Tienda propia: 12 · Rappi: 18 · PedidosYa: 9 · WhatsApp: 6     │
│ • MenuQR: 2                                                       │
├──────────────────────────────────────────────────────────────────┤
│ 🔔 PENDIENTES DE CONFIRMAR (3)                                    │
│                                                                   │
│ #ORD-001234 · WhatsApp · Belgrano · $4.500 · hace 2 min          │
│ Juan Pérez · Av. Cabildo 3245                                    │
│ 1x Combinado 18p + 1x Coca 500                                   │
│   [Ver detalle] [Confirmar] [Cancelar]                           │
│                                                                   │
│ #ORD-001233 · Rappi · Maneki · $7.200 · hace 5 min               │
│ Soledad Gomez · Honduras 5800                                    │
│   [Ver detalle] [Confirmar] [Cancelar]                           │
│                                                                   │
│ ─────────────────────────────────────────────────────────────    │
│                                                                   │
│ EN COCINA (12)                                                    │
│ ...                                                               │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2. Detalle de pedido

```
┌──────────────────────────────────────────────────────────────────┐
│ Pedido #ORD-001234                              [Estado: COCINA] │
├──────────────────────────────────────────────────────────────────┤
│ Cliente                          │ Items                          │
│ Juan Pérez                       │ 1x Combinado 18p   $14.500    │
│ +54 11 5555-1234                 │   • Wasabi extra ($300)        │
│ Av. Cabildo 3245                 │ 1x Coca 500ml      $1.800     │
│ "Timbre Pérez"                   │                                │
│                                  │ Subtotal:          $16.300    │
│ Local: Belgrano                  │ Envío:               $500     │
│ Canal: WhatsApp                  │ Cupón NEKO10:      -$1.630    │
│ Modo: DELIVERY                   │ TOTAL:             $15.170    │
│                                  │                                │
│ Pago: MP online ✓                │ Distancia: 1.2 km             │
│                                  │ ETA: 25 min                    │
│                                  │                                │
├──────────────────────────────────────────────────────────────────┤
│ TIMELINE                                                          │
│ ✓ 13:42 PENDIENTE (creado WhatsApp)                              │
│ ✓ 13:43 CONFIRMADO (auto-pago MP)                                 │
│ ✓ 13:44 EN_COCINA                                                 │
│ ⏳ ESPERANDO LISTO                                                │
├──────────────────────────────────────────────────────────────────┤
│ ACCIONES                                                          │
│ [Marcar listo] [Asignar rider manualmente] [Cancelar]            │
│ [Reimprimir] [Reenviar a WhatsApp cliente]                       │
└──────────────────────────────────────────────────────────────────┘
```

### 5.3. App del rider (RiderPWA refinement)

```
┌────────────────────────────────────┐
│ Rider · Pedro · ⚡ Activo          │
├────────────────────────────────────┤
│ TURNO                              │
│ Iniciado: 18:00 · 3h 24min         │
│ Pedidos completados: 8             │
│ Propinas: $4.500                   │
├────────────────────────────────────┤
│ PEDIDO ACTUAL                      │
│ #ORD-001234                        │
│ 📍 Recoger: Belgrano               │
│    Av. Cabildo 3000                │
│ 🏠 Entregar: Av. Cabildo 3245      │
│    Juan Pérez · +5411...1234       │
│ 💰 $15.170 (efectivo)              │
│                                    │
│ [Ver mapa]                         │
│ [Llamar al cliente]                │
│                                    │
│ Estado actual: EN_CAMINO           │
│ [✓ Marcar entregado]               │
├────────────────────────────────────┤
│ PRÓXIMOS (en queue)                │
│ #ORD-001235 · $8.300 · 800m        │
│ #ORD-001236 · $5.200 · 1.2km       │
└────────────────────────────────────┘
```

### 5.4. Tienda online (cliente)

```
┌──────────────────────────────────────────────────────────────────┐
│ neko sushi                                          🛒 (2) $14.500│
├──────────────────────────────────────────────────────────────────┤
│ MENÚ                                       [Filtrar: Categoría ▼]│
│                                                                   │
│ 🍣 SUSHI                                                          │
│ ┌──────────┬──────────┬──────────┬──────────┐                  │
│ │ [Foto]   │ [Foto]   │ [Foto]   │ [Foto]   │                  │
│ │ Combina- │ Salmón   │ Combina- │ Vegetar. │                  │
│ │ do 18p   │ Roll x6  │ do 30p   │ Roll x6  │                  │
│ │ $14.500  │ $5.800   │ $22.000  │ $4.200   │                  │
│ │ [+]      │ [+]      │ [+]      │ [+]      │                  │
│ └──────────┴──────────┴──────────┴──────────┘                  │
│                                                                   │
│ 🥢 PRINCIPALES                                                    │
│ ...                                                               │
└──────────────────────────────────────────────────────────────────┘
```

### 5.5. Configuración Partner Integration

```
┌──────────────────────────────────────────────────────────────────┐
│ Integraciones con Marketplaces                                    │
├──────────────────────────────────────────────────────────────────┤
│ 🚀 RAPPI                                          [● Conectado]   │
│   Store ID: 12345                                                 │
│   API Key: rappi_xxxx (last sync hace 12 min)                    │
│   Items sincronizados: 84/87                                      │
│   ⚠️ 3 items sin mapping — [Ver]                                  │
│   [Sync ahora] [Desactivar]                                       │
├──────────────────────────────────────────────────────────────────┤
│ 🛵 PEDIDOSYA                                      [● Conectado]   │
│   Restaurant ID: NEKO-belgrano                                    │
│   API Key: peya_xxxx (last sync hace 25 min)                     │
│   Items sincronizados: 87/87 ✓                                    │
│   [Sync ahora] [Desactivar]                                       │
├──────────────────────────────────────────────────────────────────┤
│ 💬 WHATSAPP                                       [● Conectado]   │
│   Bot activo desde el +54 11 5555-NEKO                            │
│   Pedidos vía bot este mes: 47                                    │
│   Escaladas a humano: 8                                           │
│   [Ver conversaciones]                                            │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Plan de despliegue

### Fase 0 — Schema en producción (1-2 días)
- 8 tablas nuevas (pedidos, partner_orders_raw, partner_item_mapping, clientes, cupones, cupones_usos, resenas, reservas, dispatch_assignments, rider_zonas)
- ALTERs a ventas_pos, comanda_usuarios
- ~10 RPCs nuevas

### Fase 1 — Bandeja unificada PASE (1 semana)
- UI "Pedidos" en PASE consolidando bandejas existentes
- State machine activa
- Notificaciones push
- Mantener tienda actual + integraciones partner como están

### Fase 2 — Tienda propia refinada (2 semanas)
- Refactor TiendaHome + TiendaCheckout + TiendaConfirmacion
- SEO básico (sitemap, meta tags)
- Custom domain configurable

### Fase 3 — Partner integrations bidireccionales (1-2 semanas)
- Refactor webhooks Rappi/PedidosYa con HMAC + worker
- Sync 86/precio inverso
- UI configuración

### Fase 4 — Delivery propio refinement (1 semana)
- RiderPWA con asignación automática
- DispatchMap mejorado
- Algoritmo dispatch

### Fase 5 — Fidelidad/Cupones/Reseñas (1 semana)
- Refactor consolidado de los módulos existentes

### Fase 6 — Cleanup (90 días)
- Deprecar UI fragmentadas
- COMANDA queda focused

---

## 7. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Webhooks partner caen | Alta | Alto | Logs en partner_orders_raw + retry + alertas |
| Pedido se crea pero pago MP falla | Media | Alto | Estado PENDIENTE no avanza hasta pago_confirmado. Auto-cancel tras 30 min sin pago. |
| Rider rechaza repetido | Media | Medio | Re-dispatch automático + alerta al admin tras N rechazos |
| Cliente reusa cupón fuera de límites | Media | Bajo | Validación atómica en RPC con lock |
| Bot WhatsApp toma pedido mal | Media | Bajo | Confirma con humano antes de cobrar |
| Tienda propia compite con Rappi (Rappi cobra comisión 25-30%) | Alta | Bajo | Pricing dinámico: precio tienda propia más bajo, precio Rappi compensa comisión |

---

## 8. Open questions

1. **Pricing dinámico por canal**: ¿precio tienda propia debe ser más bajo que Rappi para incentivar? Recomendación: SÍ — Rappi cobra 25-30% comisión, hay que compensarla.

2. **Reseñas públicas vs privadas**: ¿se muestran en la tienda propia o solo admin las ve? Recomendación: privadas v1, públicas v2 con moderation.

3. **Rider integrado o tercerizar**: ¿usar riders propios o partner (Uber Direct, etc.)? Recomendación: propios para tener data + control. Partner como fallback.

4. **WhatsApp bot escalation**: ¿el bot puede hacer 100% del flow o siempre escala a humano antes de cobrar? Recomendación: confirma con humano antes de cobrar en v1.

5. **Customer login**: ¿obligatorio o opcional? Recomendación: opcional (guest checkout permitido).

6. **SSR para tienda**: ¿vale Next.js / Astro para SEO mejor? Recomendación: Vite SPA v1, evaluar SSR v2.

---

## 9. Cosas que NO se hacen

- **Pricing dinámico con ML** → v2
- **Instagram Shopping integration** → v2
- **Recommendations engine** → v2
- **Multi-currency** → no aplica AR

---

## 10. Aprobación y próximos pasos

**Estado actual:** SPEC ESCRITO — pendiente revisión Lucas.

**Próximos:**
1. Lucas revisa
2. **¡COMPLETAMOS LOS 8 SPECS!**
3. Plan holístico con `writing-plans` con set completo

---

**Glosario:**
- **Pedido** = intento de compra (puede no concretarse aún)
- **Venta** = transacción cerrada y cobrada
- **Marketplace** = partner externo (Rappi, PedidosYa)
- **Dispatch** = asignación de rider a un pedido delivery
- **SLA** = tiempo máximo aceptado para una operación
- **86** = item agotado (jerga gastronómica)
- **MenuQR** = cliente escanea QR en la mesa para pedir desde su celu
- **Guest checkout** = compra sin login
- **HMAC** = validación criptográfica de origen del webhook
