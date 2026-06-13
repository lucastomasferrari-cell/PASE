# Divergencias online vs offline en los 3 wrappers Tipo 1 (COMANDA)

**Fecha:** 2026-06-13
**Estado:** deuda DOCUMENTADA + blindada con test de caracterización. Unificación PAUSADA (decisión Lucas 13-jun: riesgo alto / beneficio latente / pre-piloto).
**Origen:** diff exacto online vs offline de los 3 wrappers "duplicadores" (Tipo 1) hecho al planear la unificación estructural del Tier 2.

---

## Contexto

COMANDA tiene 13 wrappers `fn_*_comanda_offline`. 10 son "delegadores" finos (resuelven UUID + llaman a la canónica; ya cuidados por el test de contrato #43). **3 son "duplicadores": tienen un cuerpo COMPLETO separado del online**, y al diffearlos se descubrió que **divergieron en ~6 comportamientos reales**, no solo en idempotencia. Online y offline NO hacen lo mismo.

**Dato tranquilizador (prod, 60 días):** el camino offline casi no se usa todavía — **5 ventas offline vs 168 online, 0 cobradas offline, 0 reservas huérfanas**. Las divergencias son **latentes** (no rompen plata/datos HOY) porque COMANDA aún no está en uso real de POS. Se vuelven bugs activos **el día que el offline-first se use en serio**.

Los 3 pares:
| Online (canónica) | Offline (wrapper) |
|---|---|
| `fn_abrir_venta_comanda` (vigente en 202606130100) | `fn_abrir_venta_comanda_offline` (202606021200) |
| `fn_agregar_item_comanda` (202605051800) | `fn_agregar_item_comanda_offline` (202605161400) |
| `fn_mandar_curso_comanda` (202605161200) | `fn_mandar_curso_comanda_offline` (202605161400) |

---

## Las divergencias (catalogadas por severidad)

### 🔴 D1 — Venta offline NO se engancha al turno de caja
`fn_abrir_venta_comanda` busca el turno abierto del local y lo setea en `ventas_pos.turno_caja_id` (y RAISE si no hay turno y es POS). `fn_abrir_venta_comanda_offline` **omite `turno_caja_id`** (queda NULL). Como `fn_agregar_pago_venta_comanda` solo registra en `movimientos_caja` **si `turno_caja_id IS NOT NULL`**, **un cobro sobre una venta creada offline NO impacta el arqueo de caja**. Es el landmine #1: el día que se cobre offline de verdad, esas ventas no aparecen en la caja. (Hoy: 0 ventas offline cobradas, por eso no explotó.)

### 🔴 D2 — Item offline confía en el precio del cliente
`fn_agregar_item_comanda` busca el precio server-side en `item_precios_canal` (con fallback a `precio_madre`) y suma los modificadores. `fn_agregar_item_comanda_offline` **usa el `p_precio_unitario` que manda el cliente**. Es inherente al offline (no podés consultar server-side sin conexión, el cliente usa el catálogo cacheado), PERO: (a) ignora la lógica de precio por canal del server, (b) es manipulable por un cliente trucado, (c) puede divergir del precio canónico si el catálogo cacheado quedó viejo.

### 🟠 D3 — Item offline no valida el estado de la venta
`fn_agregar_item_comanda` rechaza con `VENTA_NO_EDITABLE` si la venta está `cobrada`/`anulada`. El offline **no valida** → puede agregar ítems a una venta ya cerrada.

### 🟠 D4 — Venta offline no ocupa la mesa
`fn_abrir_venta_comanda` hace `UPDATE mesas SET estado='ocupada'` al abrir con mesa. El offline **no toca `mesas`** → la mesa queda 'libre' server-side aunque haya una venta abierta. (El estado de mesa local del cliente puede taparlo, pero el server miente — relevante para MESA módulo #2 / disponibilidad en vivo.)

### 🟠 D5 — Venta offline no hace el link reserva→venta (MESA v3)
`fn_abrir_venta_comanda` linkea la reserva sentada de esa mesa con la venta (`reservas.venta_id`, agregado en MESA v3 el 12-jun). El offline **no lo hace** → reservas sentadas no se enganchan a ventas creadas offline (rompería el CRM 360° y el auto-finalizar al cobrar para esos casos).

### 🟡 D6 — Los 3 offline NO chequean permisos
Las 3 canónicas chequean `comanda.ventas.abrir`/`comanda.ventas.cobrar`. Los 3 wrappers offline **no chequean permisos** (confían en que el cliente ya validó). Defense-in-depth perdida. Mitigado en parte: los wrappers tienen `REVOKE FROM PUBLIC, anon` (solo authenticated los llama).

### Diferencia menor (no es bug)
- Numeración de ticket: online usa `fn_next_ticket_number_comanda`, offline usa `MAX(numero_local)+1`. Mismo resultado en el caso normal; podría divergir si la función canónica tiene lógica especial (gaps).

---

## Por qué se pausó la unificación

Mergear los 3 cuerpos en una sola canónica que acepte `p_idempotency_uuid` NO es mecánico: cada divergencia necesita una decisión de cuál comportamiento es el correcto (ej. ¿el offline debe buscar turno? ¿cómo, si está offline? → el cliente tendría que pasar el turno_caja_id local). Son las RPCs más editadas del sistema (máxima exposición a la "trampa de versiones" que ya mordió 5 veces en junio) y el beneficio hoy es latente. Hacerlo justo antes del piloto es mal trade-off.

## Cuándo retomar / qué hacer antes de que el offline-first se use en serio

ANTES de habilitar offline-first en un local real (piloto con cortes de internet), arreglar al menos D1 (turno de caja) y D3 (validar estado). D2 (precio) es aceptable para offline pero conviene validar el precio contra el catálogo al sincronizar. D4/D5 importan cuando MESA módulo #2 (disponibilidad en vivo) esté en juego.

La unificación completa (un cuerpo + alias) sigue siendo el norte correcto, pero como sprint dedicado POST-piloto, con diff exhaustivo y test de paridad estricto.

## Blindaje actual

- Este documento (catálogo de divergencias).
- Test de caracterización `packages/pase/tests/wrappers_tipo1_paridad_mutante.spec.ts`: corre online vs offline con los mismos inputs y asserta las divergencias D1/D2/D4 conocidas. Si una divergencia CAMBIA (aparece una nueva, o se arregla una), el test falla y obliga a actualizar este doc conscientemente → caza el drift en cualquier dirección.
- El test de contrato #43 sigue cuidando que los wrappers existan y lleguen a lógica de negocio.
