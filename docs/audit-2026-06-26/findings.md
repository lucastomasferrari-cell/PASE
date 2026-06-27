# Auditoría intensiva 26-jun-2026 — Ecosistema PASE

> **Scope**: cambios del 25-26 jun (commits `0f5fcbd` → `1f9b0cf`). Foco en lo nuevo: hub de credenciales, Stripe billing, AFIP online, MP anti-fraud, bot IG caps, gating apps_permitidas, conciliación caja, descuentos marketplace.
> **Método**: 5 agentes Explore en paralelo + verificación manual independiente de los hallazgos críticos leyendo el código fuente. Cada CRIT/ALTO de este reporte fue chequeado contra el archivo real.

## Resumen ejecutivo

- **23 findings** totales: **5 críticos**, **8 altos**, **6 medios**, **4 bajos**
- **Top 3 que bloquean piloto a 3ros**:
  1. **CRIT-1**: cualquier dueño/admin de un tenant cualquiera puede modificar la suscripción Stripe de otro tenant (activarla gratis, cancelarla, marcarla `past_due`)
  2. **CRIT-2**: webhook MP de la tienda online no valida firma — cualquiera puede mandar webhooks falsos y simular cobros
  3. **CRIT-3**: endpoints públicos de Habitué (`email-send`, `whatsapp-send`) sin auth ni rate limit — un atacante puede mandar 100k emails o WhatsApps gratis a cualquier número, gastando los créditos de Resend/Meta del piloto
- **Top 3 para no avergonzarte si esto explota mañana**:
  4. **CRIT-4**: si AFIP falla después del cobro online, la venta queda cobrada sin factura → incumplimiento fiscal
  5. **CRIT-5**: cross-tenant data leak en tabla `marketing_inversiones` — dueño de Tenant B ve y escribe la pauta publicitaria de Tenant A
  6. **ALTO-1**: usuarios con sesión activa siguen entrando a MESA/Habitué/Accesos aunque les hayan quitado el permiso (el gating solo se chequea en login, no en restore de sesión)

> Fecha base de referencia: commits hasta `1f9b0cf` (1f9b0cf feat: descuentos marketplace + warning Resend + validaciones varias). Auditoría de mayo: `docs/audit-2026-05/`.

---

## 🔴 CRÍTICOS

### CRIT-1: Stripe-webhook bypaseable — cualquier dueño/admin modifica suscripciones ajenas
- **Archivo**: [`packages/pase/api/auth-admin.js:450-487`](packages/pase/api/auth-admin.js)
- **Severidad**: CRÍTICO
- **Categoría**: Auth bypass / Cross-tenant tampering
- **Descripción**: La acción `stripe-webhook` está dentro del multi-action `auth-admin.js`. El handler corre `checkUserAuth` arriba de todo (línea 46) y solo deja pasar roles `superadmin/dueno/admin`. Esto significa dos cosas malas a la vez:
  1. **Stripe real NO puede llegar acá** (Stripe no manda JWT del caller), entonces los webhooks de billing nunca van a ejecutarse en producción.
  2. **Cualquier dueño o admin autenticado** puede invocar `action=stripe-webhook` con un payload arbitrario. El handler toma `event.data.object.metadata.tenant_id` (línea 461) y `UPDATE tenant_subscriptions ... WHERE tenant_id = <ese-id>` (línea 470) **sin verificar que ese tenant_id sea el del caller**.

  Además **no valida firma Stripe** (`Stripe-Signature` header) — el comentario en líneas 451-454 admite "en prod conviene tener endpoint dedicado con verificación", pero ese endpoint dedicado no existe.

- **Repro** (atacante: dueño legítimo del Tenant B):
  1. POST a `https://pase-yndx.vercel.app/api/auth-admin` con su JWT, body:
     ```json
     {
       "action": "stripe-webhook",
       "type": "checkout.session.completed",
       "data": {
         "object": {
           "subscription": "fake_sub_id",
           "metadata": { "tenant_id": "<uuid-tenant-A>", "plan_id": "<plan-premium>" }
         }
       }
     }
     ```
  2. El handler ejecuta `UPDATE tenant_subscriptions SET estado='active', plan_id='<plan-premium>', stripe_subscription_id='fake_sub_id' WHERE tenant_id='<uuid-tenant-A>'`.
  3. Tenant A queda con plan premium gratis. O peor: el mismo atacante manda `customer.subscription.deleted` con el `sub.id` real de Tenant A y se lo cancela.
- **Impacto $**: incalculable. Activación falsa del plan más caro de la competencia, o sabotaje a otro tenant cancelándole la suscripción.
- **Fix sugerido**:
  - Mover `stripe-webhook` a un endpoint dedicado `/api/stripe-webhook.js` (puede contar como function #N — verificar el cupo de 12 en Vercel Hobby; si llega al límite, agrupar con otro existente).
  - En ese endpoint NO correr `checkUserAuth` — sí validar `Stripe-Signature` con HMAC contra el `webhook_secret` (que ya se guarda en `integraciones.config`).
  - Mientras tanto: en la acción actual, agregar al menos `if (event.data?.object?.metadata?.tenant_id !== auth.row.tenant_id && auth.row.rol !== 'superadmin') return 403`.
- **Confianza**: 99% — verificado leyendo `auth-admin.js` líneas 39-52, 384-487.

---

### CRIT-2: MP webhook tienda online sin verificación de firma
- **Archivo**: [`packages/pase/api/tienda-mp.js:381-389`](packages/pase/api/tienda-mp.js)
- **Severidad**: CRÍTICO
- **Categoría**: Auth bypass / Webhook spoofing
- **Descripción**: El handler `handleWebhook` recibe la notificación de MercadoPago y la procesa. El bloque de validación de firma es literalmente:
  ```js
  // Validar firma x-signature (formato MP webhook signing)
  // TODO completo: implementar verificación HMAC. Por ahora confiamos en
  // que el endpoint es público + validamos contra MP API antes de marcar.
  ```
  Hay defensas posteriores:
  1. Consulta `/v1/payments/{id}` a MP con token del tenant — si el `paymentId` no existe, no hay match.
  2. Compara `payment.transaction_amount` contra `ventas_pos.total` (línea 494-507).
  3. Usa `idempotency_key` en `fn_cobrar_venta_comanda` (línea 511-521).

  **Pero el atacante no necesita inventar un paymentId**: puede leer la red del marketplace de un local público para conseguir paymentIds reales, o simplemente mandar 1000 webhooks con paymentIds secuenciales hasta encontrar uno válido. Si encuentra uno, el endpoint marca la venta como cobrada aunque MP no haya pagado nada todavía (race posible con el cron de MP).

  El mayor riesgo concreto: **denial-of-service silencioso** mandando 1000 webhooks/seg con paymentIds inventados — cada uno itera `mp_credenciales.activa=true` y llama a la API de MP (línea 433-447), consumiendo cupo de MP y posiblemente bloqueando la cuenta del tenant por rate limit.
- **Repro**:
  1. Atacante manda `POST https://pase-yndx.vercel.app/api/tienda-mp?action=webhook` con body `{ "type": "payment", "data": { "id": "<paymentId-random>" } }`.
  2. El servidor itera `mp_credenciales` activos, consulta MP por cada uno → consume rate limit del tenant víctima.
  3. Si por mala suerte un paymentId aleatorio matchea con un payment real `approved`, marca la venta como cobrada (con la mitigación del `monto_match` después).
- **Impacto $**: rate-limit MP que tira la facturación legítima; spam de log forensics; en el caso peor, doble registro de ventas legítimas que el cliente no terminó de pagar.
- **Fix sugerido**: Implementar verificación HMAC del header `x-signature` con `x-request-id` y el `webhook_secret` de cada credencial MP (Mercado Pago docs: https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks). Si la firma no matchea, devolver 401 sin tocar nada. Sin esto, el TODO sigue siendo un bug crítico explotable.
- **Confianza**: 95% — confirmado leyendo `tienda-mp.js:381-389`.

---

### CRIT-3: Endpoints públicos de Habitué sin auth (email-send, whatsapp-send)
- **Archivos**:
  - [`packages/habitue/api/email-send.js`](packages/habitue/api/email-send.js) (43 líneas, todo el archivo)
  - [`packages/habitue/api/whatsapp-send.js`](packages/habitue/api/whatsapp-send.js) (69 líneas, todo el archivo)
  - Probable: `packages/habitue/api/google-reviews.js`, `meta-ads-insights.js`, `integraciones-health.js` (mismo patrón)
- **Severidad**: CRÍTICO
- **Categoría**: Auth ausente / Abuso de credenciales
- **Descripción**: Estos endpoints serverless de Habitué usan tokens del tenant (`RESEND_API_KEY`, `WHATSAPP_TOKEN`) guardados como env vars del proyecto Vercel. **NO validan JWT del caller, NO chequean CORS de origin, NO tienen rate limit por IP ni por tenant**. La única "defensa" es que si las env vars no están seteadas, devuelve `{ ok: false, configured: false }` sin enviar.

  En cuanto Lucas (o cualquier tenant del piloto) configure `RESEND_API_KEY`, **cualquier persona en internet** puede:
  - `POST https://habitue.vercel.app/api/email-send` con `{ to: ["spam@cualquier.com", ...], asunto: "...", html: "..." }` → manda hasta 50 emails por request, sin cupo.
  - `POST https://habitue.vercel.app/api/whatsapp-send` con `{ to: "<numero>", texto: "..." }` → manda WhatsApp arbitrario, sin cupo.
- **Repro**:
  ```bash
  curl -X POST https://habitue.vercel.app/api/email-send \
    -H "Content-Type: application/json" \
    -d '{"to":["spam@example.com"],"asunto":"hola","texto":"hola"}'
  # → envía email usando RESEND_API_KEY del tenant.
  ```
- **Impacto $**: Resend cobra por email; WhatsApp Business cobra por conversación. Un atacante puede agotar el cupo mensual en minutos. Peor: si la cuenta Resend/Meta es flageada por spam, el tenant pierde el ability de mandar emails/WAs legítimos.
- **Fix sugerido**: validar JWT del caller con `checkUserAuth` o equivalente. Verificar que el tenant del JWT matchea (multitenant). Agregar rate limit (50 requests/min por tenant). Mientras tanto: NO configurar las env vars en producción de Habitué, o bloquear el endpoint con basic auth temporal.
- **Confianza**: 100% — leí los archivos completos. No hay ningún auth check.

> Nota: `automations-tick.js` SÍ tiene un check de `CRON_SECRET` (línea 19-22), pero es condicional (`if (secret && ...)`). Si Lucas olvida setear `CRON_SECRET` en Vercel, cualquiera puede triggerar el cron. Eso lo cubre **ALTO-7** abajo.

---

### CRIT-4: AFIP best-effort post-cobro deja ventas cobradas sin factura
- **Archivo**: [`packages/pase/api/tienda-mp.js:511-542`](packages/pase/api/tienda-mp.js)
- **Severidad**: CRÍTICO
- **Categoría**: Lógica fiscal / Integridad transaccional
- **Descripción**: El webhook MP, después de validar monto, llama `fn_cobrar_venta_comanda` (línea 511) que marca la venta como `cobrada` en una transacción. Inmediatamente después (línea 530-540) intenta emitir la factura AFIP con `emitirFacturaPostCobroOnline` **en un try/catch que solo loguea el error**:
  ```js
  let afip_factura = null;
  try {
    afip_factura = await emitirFacturaPostCobroOnline(supabase, ventaId, paymentId);
  } catch (e) {
    console.error('[tienda-mp webhook] emitir AFIP falló (no bloquea cobro)', ventaId, e?.message);
  }
  res.status(200).json({ ok: true, ... });
  ```
  Si AFIP falla (cert vencido, WSAA timeout, cuota superada, número de comprobante conflict), la venta queda `estado='cobrada'` en DB **sin CAE válido**. El cliente final no recibe factura electrónica — y emitir factura electrónica para ventas a consumidor final es **obligatorio en Argentina** (Ley 27.349 + RG 4291).
- **Repro**:
  1. AFIP en mantenimiento o cert del tenant vencido.
  2. Cliente paga $15.000 en la tienda online.
  3. Webhook MP llega: `fn_cobrar_venta_comanda` ejecuta OK, MP acredita la plata.
  4. `emitirFacturaPostCobroOnline` tira `TIMEOUT` o `WSAA_AUTH_ERROR`.
  5. Logo del catch lo come. Webhook devuelve 200 OK a MP.
  6. Venta queda `cobrada` en DB, sin CAE. Cliente no tiene factura. Tampoco hay alerta para que el operador la emita manual.
- **Impacto $**: penalidad fiscal por venta sin factura (en general multa fija + intereses si lo descubre AFIP). Peor: si la frecuencia de fallos AFIP es alta, el tenant acumula ventas "fantasma" que no pueden conciliarse con AFIP nunca más.
- **Fix sugerido**: dos opciones:
  - **A) Reintento explícito**: si AFIP falla, agendar un cron que reintente cada 15 min hasta que emita. El registro en `afip_facturas` ya debe quedar con `estado='pendiente_emision'` (no `rechazada` — eso es terminal).
  - **B) Alertar al operador**: si AFIP falla, marcar la venta como `cobrada_sin_factura` (campo nuevo) y mostrarlo destacado en COMANDA/POS para emisión manual desde el back-office.
- **Confianza**: 95% — verificado en `tienda-mp.js:511-542`. El comportamiento es intencional ("best-effort") pero las consecuencias fiscales lo hacen un bug por diseño.

---

### CRIT-5: Cross-tenant data leak en `marketing_inversiones`
- **Archivo**: [`packages/pase/supabase/migrations/202606250500_marketing_inversiones.sql:27-30`](packages/pase/supabase/migrations/202606250500_marketing_inversiones.sql)
- **Severidad**: CRÍTICO
- **Categoría**: Multi-tenant isolation rota / RLS incompleta
- **Descripción**: La policy de la tabla nueva es:
  ```sql
  CREATE POLICY "inversiones_by_local" ON marketing_inversiones
    FOR ALL TO authenticated
    USING  (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL)
    WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL);
  ```
  Esta tabla tiene `tenant_id` (línea 12) pero **la policy nunca lo chequea**. Resultado:
  - Cualquier dueño/admin de cualquier tenant ve y modifica TODAS las filas con `local_id IS NULL` (que es el caso típico: pauta "a nivel marca").
  - Un dueño puede insertar filas con `tenant_id` ajeno y la RLS las acepta (porque la única condición es ser `dueno_o_admin`).

  El patrón correcto (que la mayoría del proyecto usa, incluyendo `accesos_audit` en la misma migración) es:
  ```sql
  USING (tenant_id = auth_tenant_id()::text AND (auth_es_dueno_o_admin() OR ...))
  ```
- **Repro**:
  1. Dueño de Tenant B: `SELECT * FROM marketing_inversiones WHERE local_id IS NULL` → ve toda la pauta de marca de TODOS los tenants.
  2. Dueño de Tenant B: `INSERT INTO marketing_inversiones (tenant_id, local_id, monto, ...) VALUES ('<tenant-A-uuid>', NULL, 99999, ...)` → ensucia la KPI de Tenant A.
- **Impacto**: leak de info competitiva (cuánto gasta cada tenant en ads), tampering directo de la métrica de CAC del competidor.
- **Fix sugerido**:
  ```sql
  DROP POLICY "inversiones_by_local" ON marketing_inversiones;
  CREATE POLICY "inversiones_by_local" ON marketing_inversiones
    FOR ALL TO authenticated
    USING  (
      tenant_id = auth_tenant_id()::text
      AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL)
    )
    WITH CHECK (
      tenant_id = auth_tenant_id()::text
      AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL)
    );
  ```
- **Confianza**: 98% — confirmado leyendo la migración completa.

---

## 🟠 ALTOS

### ALTO-1: `restore()` de sesión no re-chequea `apps_permitidas` (MESA/Habitué/Accesos)
- **Archivos**:
  - [`packages/mesa/src/pages/AdminHome.tsx:39-46`](packages/mesa/src/pages/AdminHome.tsx)
  - [`packages/habitue/src/pages/AdminHome.tsx`](packages/habitue/src/pages/AdminHome.tsx) (mismo patrón ~líneas 39-46)
  - [`packages/accesos/src/pages/AdminHome.tsx`](packages/accesos/src/pages/AdminHome.tsx) (mismo patrón ~líneas 39-46)
- **Severidad**: ALTO
- **Categoría**: Auth/gating bypass UX
- **Descripción**: El chequeo `apps_permitidas.includes('mesa')` se ejecuta SOLO en `entrar()` (línea 90-99) — el flujo de login con email/password. El `useEffect` inicial que restaura la sesión existente (línea 39-46) solo hace `db().auth.getSession()` y setea `sesion = { email }`. **No vuelve a leer `usuarios.apps_permitidas`**.
- **Repro**:
  1. User1 está logueado en MESA en una pestaña.
  2. Dueño abre Accesos en otra pestaña, le saca el toggle `mesa` a User1.
  3. User1 refresca la página de MESA.
  4. El `useEffect` inicial detecta sesión existente, setea `sesion = { email }`, sigue funcionando como si nada.
  5. User1 sigue operando MESA aunque ya no debería.
- **Impacto**: la "expulsión" de un usuario de una app requiere `auth.signOut()` manual o esperar a que la sesión expire (~1h por default Supabase). Para revocaciones rápidas, no funciona.
- **Mitigación parcial**: RLS sigue protegiendo cross-tenant a nivel datos. El bypass es "sigue viendo MESA y operando dentro de su propio tenant" — no es brecha de seguridad cross-tenant, pero rompe la promesa del feature.
- **Fix sugerido**: en el `useEffect` inicial, después de `getSession()`, hacer el mismo SELECT a `usuarios.apps_permitidas` y `signOut()` si falta el slug.
- **Confianza**: 95% — verificado en `mesa/AdminHome.tsx:39-46`.

---

### ALTO-2: Race condition en cap diario USD del bot IG
- **Archivo**: [`packages/instagram-bot/api/webhook.js:386-409`](packages/instagram-bot/api/webhook.js)
- **Severidad**: ALTO
- **Categoría**: Lógica de plata / Race condition
- **Descripción**: El webhook lee `SUM(llm_cost_usd)` del día con un `SELECT` simple y compara con `cap_diario_usd`. Si dos mensajes llegan en la misma ventana de ms:
  ```
  T0:   req A: SUM=4.99 → pasa check (< 5.0)
  T0:   req B: SUM=4.99 → pasa check (< 5.0)
  T0+150ms: req A llama Claude → cuesta $1.00 → SUM real=5.99
  T0+200ms: req B llama Claude → cuesta $1.00 → SUM real=6.99
  ```
  El cap se excede en ~$2 antes de que la siguiente request lo detecte.
- **Mitigación parcial**: el rate limit por cantidad de mensajes (líneas 414-424) corta el caudal antes de que el sobrepaso sea grande. En la práctica, el sobrepaso es 1-2 USD/día, no $100. Pero si Lucas baja el cap a $1 para un piloto chico, el porcentaje de sobrepaso es del 100%.
- **Impacto $**: chico ($1-2 USD/día por tenant en el peor caso), pero acumulado en muchos tenants es perceptible.
- **Fix sugerido**: usar una RPC `fn_check_and_lock_cap_diario(tenant_id, cap)` que haga `SELECT ... FOR UPDATE` sobre `ig_config`, calcule el SUM, y retorne `true/false` atómicamente. Alternativa: agregar un counter `gasto_hoy_usd_acumulado` en `ig_config` actualizado por trigger en `ig_mensajes` y leerlo en el webhook.
- **Confianza**: 95% — confirmado leyendo el webhook.

---

### ALTO-3: `fn_cuadre_caja` lee `movimientos_caja` sin lock
- **Archivo**: [`packages/pase/supabase/migrations/202606260300_cuadre_caja_y_stripe.sql:63-91`](packages/pase/supabase/migrations/202606260300_cuadre_caja_y_stripe.sql)
- **Severidad**: ALTO
- **Categoría**: Race condition / Lógica de plata
- **Descripción**: La RPC calcula `v_sistema = SUM(monto) FROM movimientos_caja WHERE turno_id = X AND metodo_cobro='efectivo'` sin `FOR UPDATE`. Si un cajero está cargando un movimiento mientras otro hace el cuadre, la diferencia queda calculada con un SUM stale.
- **Repro**:
  1. Cajero A: hace clic en "Cuadrar caja" con declarado=$1000.
  2. RPC lee `SUM = 950` (faltan $50 → diferencia $50).
  3. Mientras tanto, Cajero B carga un cobro efectivo de $50 (que va al mismo turno).
  4. RPC escribe `diferencia=$50, sistema=$950` en `partes_operativos`. Pero la realidad es $1000 sistema, diferencia 0.
- **Impacto**: cuadre incorrecto → auditoría reporta sobrante/faltante ficticio → el dueño investiga algo que nunca pasó.
- **Fix sugerido**: agregar `FOR UPDATE` a los SELECT de `turnos_caja` y `partes_operativos`, o serializar el cuadre con `pg_advisory_xact_lock(p_turno_id)` al inicio de la función.
- **Confianza**: 85% — verificado leyendo la migración.

---

### ALTO-4: `stripe-checkout` no inserta row en primer checkout → session_id perdido
- **Archivo**: [`packages/pase/api/auth-admin.js:401-446`](packages/pase/api/auth-admin.js)
- **Severidad**: ALTO
- **Categoría**: Lógica billing / Inconsistencia
- **Descripción**: Si un tenant nunca tuvo suscripción Stripe (primer checkout), no existe row en `tenant_subscriptions`. El handler:
  1. `SELECT` retorna `null` para `sub` (línea 401-403).
  2. El bloque "si no hay customerId, crear customer" entra (407-418). Si `sub` es null, **NO se inserta row** (línea 415 hace `if (sub) update`); solo se crea el customer en Stripe pero no en DB.
  3. El UPDATE final (línea 443-446) hace `WHERE tenant_id = X` → **cero filas afectadas** porque no hay row.
  4. El `session_id` no queda guardado en DB.
- **Impacto**: si el webhook de Stripe (cuando esté arreglado por CRIT-1) llega antes de que Lucas haga reconciliación manual, no hay forma de linkear el checkout al tenant. Para tenants nuevos = primer pago perdido en auditoría.
- **Fix sugerido**: cambiar el UPDATE a UPSERT (`onConflict: 'tenant_id'`). También insertar row en `tenant_subscriptions` apenas se crea el customer Stripe.
- **Confianza**: 95% — confirmado leyendo el flujo completo de stripe-checkout.

---

### ALTO-5: stripe-webhook: eventos `subscription.deleted` fuera de orden no se aplican
- **Archivo**: [`packages/pase/api/auth-admin.js:472-477`](packages/pase/api/auth-admin.js)
- **Severidad**: ALTO (asumiendo se arregle CRIT-1 antes)
- **Categoría**: Eventos out-of-order / Estado inconsistente
- **Descripción**: El handler `customer.subscription.deleted` matchea por `stripe_subscription_id`, pero ese campo SOLO se setea en `checkout.session.completed`. Stripe no garantiza orden de entrega. Si el evento `deleted` llega antes que el `completed`, el UPDATE no toca nada y el estado queda inconsistente (Stripe dice cancelled, DB dice active).
- **Fix sugerido**: matchear por `stripe_customer_id` como fallback. Idealmente: usar un endpoint dedicado `/api/stripe-webhook` con idempotency en cada evento por `event.id` (Stripe los manda).
- **Confianza**: 80%.

---

### ALTO-6: Popup `window.open` antes del await en confirmar reserva (MESA)
- **Archivo**: [`packages/mesa/src/pages/AdminReservas.tsx:274-295`](packages/mesa/src/pages/AdminReservas.tsx)
- **Severidad**: ALTO (UX, no security)
- **Categoría**: Race condition UI / UX rota
- **Descripción**: El handler de "Confirmar" abre `window.open('about:blank', '_blank')` ANTES de empezar el await de `cambiarEstadoReserva` y `enviarOFallback`. Si el segundo tarda >5s (caso típico cuando WhatsApp Cloud API está lento), el staff ve un popup en blanco indefinido. Si lo cierra a mano y después `wa.fallbackUrl` resuelve, el código intenta `popup.location.href = ...` sobre un popup ya cerrado (silencioso pero con warning).
- **Repro**:
  1. Staff confirma reserva con teléfono.
  2. Popup abre instantáneo en blanco.
  3. `/api/auth-admin?action=wa-send` tarda 10s (network slow).
  4. Staff piensa "se rompió", cierra el popup.
  5. Cuando wa termina, el `.then` intenta tocar el popup cerrado.
- **Fix sugerido**: abrir el popup DESPUÉS del await del cambio de estado y solo si `enviarOFallback` devuelve `fallbackUrl`. Si manda directo por API, no abrir nada.
- **Confianza**: 90%.

---

### ALTO-7: `automations-tick.js` el chequeo CRON_SECRET es condicional
- **Archivo**: [`packages/habitue/api/automations-tick.js:19-22`](packages/habitue/api/automations-tick.js)
- **Severidad**: ALTO
- **Categoría**: Auth ausente cuando env var falta
- **Descripción**: El código actual es:
  ```js
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (secret && auth !== `Bearer ${secret}`) return res.status(401).json({ ... });
  ```
  Si `CRON_SECRET` no está seteada en Vercel (olvido, deploy nuevo, error de configuración), el check se salta y cualquiera puede triggerar el cron de automatizaciones para todos los tenants.
- **Fix sugerido**:
  ```js
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET no configurado' });
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ ... });
  ```
- **Confianza**: 90%.

---

### ALTO-8: `enviarOFallback` (MESA WhatsApp) sin AbortController/timeout
- **Archivo**: [`packages/mesa/src/lib/whatsapp.ts:75-103`](packages/mesa/src/lib/whatsapp.ts)
- **Severidad**: ALTO (UX)
- **Categoría**: Sin timeout en fetch
- **Descripción**: El `fetch` a `/api/auth-admin?action=wa-send` no tiene timeout. Si el endpoint cuelga, el await espera el default del browser (~30s). Combinado con ALTO-6, el staff queda con popup vacío + UI bloqueada.
- **Fix sugerido**: `AbortController` con timeout de 5s. Si expira, devolver `{ sent: false, fallbackUrl: 'wa.me/...' }`.
- **Confianza**: 88%.

---

## 🟡 MEDIOS

### MED-1: Vista `v_ig_costo_diario_tenant` con GRANT a `authenticated` (intent contradictorio con comentario)
- **Archivo**: [`packages/pase/supabase/migrations/202606260100_ig_costo_diario_view.sql:36-37`](packages/pase/supabase/migrations/202606260100_ig_costo_diario_view.sql)
- **Severidad**: MEDIO
- **Descripción**: El comentario dice "Solo superadmin lee la vista" pero el GRANT es a `authenticated`. En Postgres 15+ las vistas son `security_invoker` por default → la RLS de `ig_config`/`ig_mensajes` aplica → cada user solo ve su tenant. **No hay leak real** (asumiendo Supabase corre PG 15+, que es el default desde 2023). PERO si en algún momento se hace `ALTER VIEW ... SET (security_invoker = false)` por error, el GRANT actual permite el leak.
- **Fix sugerido**: revocar a `authenticated` y dejar solo a `service_role`. Si admin-console necesita acceso desde frontend, exponerlo via RPC con auth check.
- **Confianza**: 70% — la mitigación PG 15+ es real, pero el patrón es frágil.

---

### MED-2: Race condition giftcard — UX permite múltiples clicks de validación
- **Archivo**: [`packages/comanda/src/components/dialogs/GiftcardRedimirDialog.tsx:39-49`](packages/comanda/src/components/dialogs/GiftcardRedimirDialog.tsx)
- **Severidad**: MEDIO
- **Descripción**: El RPC `fn_canjear_giftcard` tiene `FOR UPDATE` (correctamente). Pero la UI permite múltiples clicks rápidos de "Validar" mientras está en flight → varias transacciones en cola que compiten por el lock. La protección server-side funciona; la UX es confusa.
- **Fix sugerido**: deshabilitar el botón Y el input mientras `validando=true`. Spinner visible. Si la respuesta es `GIFTCARD_YA_CANJEADA`, mostrar mensaje claro.
- **Confianza**: 75%.

---

### MED-3: Stripe checkout permite race entre planes en TenantBilling
- **Archivo**: [`packages/admin-console/src/pages/TenantBilling.tsx:74-89, 163-170`](packages/admin-console/src/pages/TenantBilling.tsx)
- **Severidad**: MEDIO
- **Descripción**: El botón se deshabilita con `disabled={creandoCheckout !== null}`, pero `setCreandoCheckout(planId)` permite que llamadas concurrentes pisen el estado. Doble click rápido en planes distintos abre dos popups Stripe.
- **Fix sugerido**: guard `if (creandoCheckout) return;` al inicio de `iniciarCheckout`.
- **Confianza**: 85%.

---

### MED-4: CHECK constraint en `integraciones.provider` con valores fijos
- **Archivo**: [`packages/pase/supabase/migrations/202606260200_integraciones_credenciales_hub.sql:28-32`](packages/pase/supabase/migrations/202606260200_integraciones_credenciales_hub.sql)
- **Severidad**: MEDIO (deuda)
- **Descripción**: Lista hardcoded de providers: `whatsapp_api, email, meta_ads, google_ads, search_console, instagram, google_maps, stripe, mp_point`. Agregar uno nuevo requiere DROP+ADD constraint. No es bug funcional pero es deuda evitable.
- **Fix sugerido**: dejar el CHECK pero documentar el proceso en CONTEXTO.md.
- **Confianza**: 60%.

---

### MED-5: `credencial-set` sin límite de tamaño del JSON config
- **Archivo**: [`packages/pase/api/auth-admin.js:340-371`](packages/pase/api/auth-admin.js)
- **Severidad**: MEDIO
- **Descripción**: Valida `typeof config === 'object'` pero acepta cualquier tamaño/keys. Admin malicioso (o frontend con bug) puede llenar `integraciones.config` con MB de datos.
- **Fix sugerido**: `if (JSON.stringify(config).length > 10*1024) return 400`. Validar keys conocidas por provider.
- **Confianza**: 70%.

---

### MED-6: Borrar clientes demo con `ILIKE '%@example.com'` — riesgo bajo de falso positivo
- **Archivo**: [`packages/pase/supabase/migrations/202606250400_limpiar_demo_clientes.sql:9-20`](packages/pase/supabase/migrations/202606250400_limpiar_demo_clientes.sql)
- **Severidad**: MEDIO
- **Descripción**: `ILIKE '%@example.com'` también matchea `usuario@example.com.ar` (subdomain). No es catastrófico (es soft-delete), pero podría afectar datos no-demo.
- **Fix sugerido (preventivo)**: agregar un `RAISE NOTICE` con el conteo previo, o restringir con `email ~ '@example\.com$'`.
- **Confianza**: 50% — `example.com` es IANA-reserved, el riesgo real es mínimo, pero el patrón es laxo.

---

## 🟢 BAJOS

### BAJO-1: Posible leak de API key Claude en logs/eventos
- **Archivo**: [`packages/instagram-bot/api/webhook.js:494-500`](packages/instagram-bot/api/webhook.js)
- **Severidad**: BAJO
- **Descripción**: `error_message: Claude API: ${String(e?.message || e)}` se inserta en `ig_eventos`. Si el SDK de Anthropic incluye la API key en el mensaje de error (algunas SDKs lo hacen), queda en DB y logs.
- **Fix**: sanitizar `e.message` con regex `/sk-ant-[a-zA-Z0-9]{40,}/g → '[REDACTED]'`.
- **Confianza**: 60% — teórico, depende de Anthropic SDK.

---

### BAJO-2: Cast `as string` en `config_preview` puede generar UI rota con valores numéricos
- **Archivo**: [`packages/comanda/src/pages/Settings/SettingsIntegraciones.tsx:~185`](packages/comanda/src/pages/Settings/SettingsIntegraciones.tsx)
- **Severidad**: BAJO
- **Descripción**: `preview as string | undefined` puede ser un número (ej. `phone_number_id`). El `.slice(-4)` falla silently. UI muestra `({123})` en vez de `(...123)`.
- **Fix**: `typeof preview === 'string' ? '...' + preview.slice(-4) : String(preview)`.
- **Confianza**: 60%.

---

### BAJO-3: `VITE_PASE_API_BASE` default con `|| fallback` no captura `null`
- **Archivo**: [`packages/comanda/src/lib/integracionesService.ts:10`](packages/comanda/src/lib/integracionesService.ts), [`packages/mesa/src/lib/whatsapp.ts:8`](packages/mesa/src/lib/whatsapp.ts)
- **Severidad**: BAJO
- **Descripción**: Si `import.meta.env.VITE_PASE_API_BASE` es `null` (caso raro pero posible en algunos setups Vite), el `|| fallback` SÍ captura (porque null es falsy), pero el TypeScript cast `as string | undefined` puede esconder otros bugs.
- **Fix**: `String(import.meta.env.VITE_PASE_API_BASE || 'https://...')`. Riesgo real bajo.
- **Confianza**: 40%.

---

### BAJO-4: `stripe-checkout` no valida límite/formato de plan_id antes de armar form
- **Archivo**: [`packages/pase/api/auth-admin.js:388-434`](packages/pase/api/auth-admin.js)
- **Severidad**: BAJO
- **Descripción**: Si `plan_id` viene como string raro (espacios, símbolos), va directo a `form.append('metadata[plan_id]', plan_id)`. Stripe lo acepta pero queda data sucia.
- **Confianza**: 40%.

---

## Falsos positivos descartados durante la auditoría

Estos parecían bugs en una primera lectura pero verificación independiente los descartó:

1. **CORS allow-list ampliada con wildcard `*.vercel.app`** — el regex en `_cors.js` es tight (requiere exactamente `lucastomasferrari-cells-projects`). No es wildcard laxo.
2. **`credencial-list` devuelve secretos en plaintext** — verificado en `auth-admin.js:321-338`: redacta correctamente con `'...' + v.slice(-4)` y elimina el `config` original. No hay leak.
3. **Webhook IG `hub.verify_token` no se valida** — verificado en `instagram-bot/webhook.js:47-56`: compara contra `META_VERIFY_TOKEN`. OK.
4. **`fn_descuentos_publicos_tienda` es SECURITY DEFINER sin auth check** — es por diseño (RPC pública para la tienda online sin login). El comentario en regla C11 dice "el linter de Supabase la flagea correctamente" pero en este caso es falso positivo conocido del linter — la función filtra todo por `p_local_slug` y solo retorna info pública.
5. **`apps_permitidas = NULL` para users pre-migración** — la migración usa `NOT NULL DEFAULT ARRAY['pase']` en ALTER COLUMN: Postgres llena las filas existentes con el default. Todos los users tienen `['pase']` después de aplicar.
6. **Override de tenant (`?override_tenant=`) sin token** — sí, no hay endpoint con JWT, pero `applyLogin` borra el override si el rol no es `superadmin`. La auth_tenant_id() server-side se lee del JWT, no del frontend, así que un atacante setteando el override en sessionStorage no consigue nada. Mitigación existe; la feature es debt técnico pero no bug explotable.
7. **Drift entre `MIGRACIONES_25_JUN_LISTAS.sql` y migraciones individuales** — el archivo combinado es por conveniencia para correr una vez (usa `IF NOT EXISTS`); las migraciones individuales son la fuente oficial. No es bug, es por diseño.
8. **`reset_password` / `create_user` sin auth admin** — verificado en `auth-admin.js:46-52`: requiere rol `superadmin/dueno/admin`. OK.

---

## Áreas que NO audité (y por qué)

- **`fn_canjear_giftcard` SQL** — sólo verificé el dialog UI. El backend RPC parece bien (otros agentes confirmaron `FOR UPDATE`), pero no leí la migración completa.
- **`packages/equipo/*`** (renombrado a `accesos`) — el rename estaba completo en main. No hay riesgo de drift.
- **Bot IG `_lib/claude.js`** — no leí completo. Reportaron BAJO-1 (leak teórico de API key), pero no confirmé en código.
- **`packages/admin-console`** completo — solo TenantBilling.tsx. El handler de override-tenant en `pase/src/App.tsx` lo confirmé como falso positivo.
- **`packages/instagram-bot/api/webhook.js`** flujo completo de procesamiento de mensajes — solo el bloque del cap diario.
- **`packages/habitue/api/google-reviews.js`, `meta-ads-insights.js`, `integraciones-health.js`** — no leí directamente, pero asumo mismo patrón que `email-send.js`/`whatsapp-send.js` (CRIT-3). **Lucas debería verificarlos si planea exponer Habitué a 3ros.**
- **Test E2E full** (`packages/pase/tests/e2e-full/`) — no verifiqué si los cambios del 25-26 jun tienen su contraparte en la suite. Es probable que falte cobertura para los flujos nuevos (Stripe, AFIP online, MP webhook, hub credenciales).
- **CI/CD secrets** — no audité `.github/workflows/`. Si Stripe webhook tiene secret nuevo, debería ir como GitHub secret + Vercel env var, no hardcoded.

---

## Cruzas vs auditoría de mayo (`docs/audit-2026-05/`)

No tuve tiempo de cruzar línea a línea contra los findings de mayo. **Recomendación**: pasar `grep -l "CRIT\|ALTO" docs/audit-2026-05/*.md` y verificar si alguno de los siguientes patrones aparece como regresión:
- Endpoints serverless sin auth (los 6 endpoints nuevos de Habitué siguen el patrón que en mayo se reportó como crítico para Telegram webhook).
- RLS sin `tenant_id` check en tablas nuevas — el patrón se repite en `marketing_inversiones`.
- Webhook MP sin firma — si esto ya estaba reportado en mayo y no se fixeó, es regresión NO atendida.

---

## Top 3 fixes para priorizar el lunes

1. **CRIT-1 (Stripe-webhook bypaseable)**: bloquear inmediatamente. Opciones:
   - Comentar la action `stripe-webhook` en `auth-admin.js` mientras se hace el endpoint dedicado.
   - O en 5 minutos: agregar `if (event.data?.object?.metadata?.tenant_id !== auth.row.tenant_id && auth.row.rol !== 'superadmin') return 403;` al inicio del bloque.
   - **Plan B**: hacer el endpoint dedicado `/api/stripe-webhook.js` con HMAC. ~30 min de trabajo.
2. **CRIT-3 (endpoints Habitué sin auth)**: antes de configurar `RESEND_API_KEY` o `WHATSAPP_TOKEN` en el Vercel de Habitué, agregar `checkUserAuth` o `CRON_SECRET` a TODOS los endpoints serverless de `packages/habitue/api/`. Si las env vars NO están seteadas, el riesgo es teórico — pero apenas se configuren, es spam abierto al mundo.
3. **CRIT-5 (marketing_inversiones cross-tenant)**: una migración de 5 líneas que reescribe la policy. Bajísimo riesgo, alto impacto. Aplicar antes de mostrar Habitué a un tercer tenant.

Si querés que arregle alguno de estos directamente, decímelo y armo el plan en español simple antes de tocar nada.
