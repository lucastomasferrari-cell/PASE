# MESA Módulo #4 — Página pública del local (perfil completo + eventos + giftcards)

**Fecha:** 09-jun-2026 · **Estado:** diseño aprobado por Lucas (opción B: cobro online MP desde v1)

## 1. Qué es

La página pública de cada local deja de ser "un form de reserva" y pasa a ser un
**perfil de restaurante completo**, mezclando lo mejor de las referencias que eligió
Lucas (Blackbird/The Eighty Six, Tock/Shota, Meitre/Neko):

| Sección | Fuente de datos | Estado |
|---|---|---|
| Galería de fotos (header) | Fotos del local + catálogo COMANDA | front (próx. sprint) |
| Widget reserva ("Configurá tu reserva") | `fn_check_disponibilidad_reserva` | ✅ ya existe |
| **"¿Hay mesa ahora?"** | v1 capacidad config / v2 motor vivo (mód. #2) | v1 ya existe |
| Platos recomendados ("Qué pedir") | `fn_get_populares_tienda_comanda` (ventas REALES) | ✅ ya existe |
| Reseñas | Reviews propias multi-aspecto verificadas por consumo | ✅ ya existe |
| Descripción / vibra / "sobre nosotros" | Texto del dueño (config local) | front |
| Info local (dirección, tel, horarios, IG, mapa) | Config COMANDA | ✅ ya existe |
| "Más locales del grupo" | Locales del tenant (cross-promo automática) | front |
| **Eventos** (cena aniversario, omakase especial — estilo Tock) | NUEVO: `eventos` + inscripción con **prepago MP** | este spec |
| **Giftcards** ("Dinner Card para 2" — estilo Meitre) | NUEVO: `giftcards` + compra con **pago MP** + canje en POS | este spec |

**El diferencial**: casi todo se AUTO-LLENA del ecosistema (los competidores cargan
todo a mano). Y el prepago de eventos mata el no-show.

## 2. Decisión B — Cobro online desde v1

- Se REUSA la infraestructura MP existente de la tienda: `mp_credenciales` por local
  (token encriptado), `api/tienda-mp.js?action=preference|webhook` (Checkout Pro +
  validación del payment contra la API de MP antes de confirmar).
- **Cero setup nuevo para Neko**: los locales ya tienen credenciales activas para la
  tienda → eventos/giftcards cobran con las mismas. Para tenants nuevos: la pantalla
  de credenciales MP existente.
- Vercel Hobby está en el límite de 12 functions → NO se crean endpoints nuevos;
  se agregan **actions** a `tienda-mp.js`: `evento-preference`, `giftcard-preference`,
  y el webhook rutea por prefijo de `external_reference` (`evento:<id>` / `gift:<id>`;
  numérico = venta tienda, comportamiento actual intacto).

## 3. Modelo de datos (nuevo)

- **`eventos`**: tenant, local, titulo, descripcion, foto_url, fecha_inicio/fin,
  precio_por_persona, cupos_total/cupos_vendidos, estado
  (borrador→publicado→agotado/finalizado/cancelado).
- **`evento_inscripciones`**: evento, datos del cliente, cantidad, monto_total
  (calculado SERVER-side), estado (pendiente_pago→pagada / cancelada / reembolsada),
  mp_payment_id, mp_preference_id, idempotency.
- **`giftcards`** (catálogo): tenant, local (NULL = todo el grupo), nombre,
  descripcion, foto_url, precio, activa.
- **`giftcard_compras`**: giftcard, comprador (nombre/email/tel), para_nombre,
  mensaje, **codigo único** (se genera AL CONFIRMARSE el pago), monto, estado
  (pendiente_pago→pagada→canjeada / cancelada), mp_*, canjeada_venta_id.

RLS dual estándar (tenant + local). Escritura de inscripciones/compras SOLO por
RPC/webhook (regla C4). Público accede vía RPCs SECURITY DEFINER filtradas por slug.

## 4. Flujos de plata

**Evento**: público elige evento publicado → `fn_inscribir_evento_publico` (valida
cupos disponibles contra total − vendidos − pendientes <30min, precio server-side)
→ inscripción `pendiente_pago` → front pide `?action=evento-preference` → Checkout
MP → webhook `approved` (validado contra API MP + monto) → inscripción `pagada` +
`cupos_vendidos += cantidad` (idempotente por payment id).

**Giftcard**: ídem con `fn_comprar_giftcard_publica` → webhook genera el **código**
único al confirmar. **Canje en POS**: `fn_canjear_giftcard(codigo)` (staff) valida
`pagada` → `canjeada` + opcional vincular venta. El staff la aplica como
descuento/cortesía con manager (v1; medio de pago dedicado en v2).

## 5. Fases

1. **Backend (este sprint)**: migración (tablas+RLS+RPCs) + actions MP + webhook
   routing + mutante.
2. **Admin (próximo)**: pantallas crear/editar eventos y giftcards + validar/canjear
   giftcard + perfil del local (descripción, fotos).
3. **Página pública (próximo, sprint visual)**: el perfil completo del local con el
   mix de referencias — UX/UI "maravilloso" (palabras de Lucas), mobile-first.

## 6. Fuera de alcance v1

Reembolsos automáticos MP (manual por ahora), emails transaccionales (módulo #6),
giftcard como medio de pago nativo del POS, multi-fecha por evento (un evento = una
fecha; se duplica si hay varias).
