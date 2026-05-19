# COMANDA Marketplace — Activación + Deploy (Gap #5)

Pasos manuales pendientes para que el marketplace quede 100% productivo.
Todo lo demás (Gaps #1-#4) ya está mergeado y deployado.

---

## Estado actual (resumen)

Mergeado y deployado en `main`:

| Gap | Qué hace | Commit |
|---|---|---|
| #1 | Geolocalización (orden por cercanía, filtro radio, "Cerca de mí") | (ya estaba) |
| #2 | Programar pedido a futuro (15min–14d) | `af52aa3` |
| #3 | Reviews/ratings con moderación admin | `6b5ff95` |
| #4 | Emails al cliente: pedido recibido, listo, entregado (calificá), cancelado | `47eed05` |
| #5 | Domain + activación a locales — **PENDIENTE TUYO** | — |

DB ya tiene aplicadas las migrations:
- `202605202300_pedido_publico_programada.sql`
- `202605202400_pedido_publico_unify.sql`
- `202605202500_marketplace_reviews.sql`
- `202605202600_ventas_pos_notif_email_extra.sql`

---

## 1. Configurar Resend (emails al cliente)

Sin esto, los emails de Gap #4 se loguean `[email] RESEND_API_KEY o RESEND_FROM
no configurado — email NO enviado` y NO se mandan (no rompe el flow, solo
skip).

### 1.1. Cuenta gratuita

1. Ir a [resend.com](https://resend.com) → Sign up con tu mail.
2. Plan **Free**: 100 emails/día, 3.000/mes. Sobra para arrancar.
3. **Dashboard → API Keys → Create API Key** → copiar.

### 1.2. Dominio verificado

Mientras no verifiques un dominio, podés probar con
`onboarding@resend.dev` (solo testing — Resend lo limita a tu cuenta).

Para producción real:
1. **Domains → Add Domain** → poné `neko.com.ar` (o el que vayas a usar).
2. Resend te tira 3 registros DNS (SPF, DKIM, DMARC) → cargarlos donde
   tengas el dominio (Cloudflare, NIC.ar, etc.).
3. Click **Verify** — tarda entre 5min y 24h.

### 1.3. Cargar env vars en Vercel

**Proyecto `pase-yndx`** (donde está `/api/tienda-mp`):

```
Settings → Environment Variables → Add

RESEND_API_KEY   = re_XXXXXXXXXXXXXXXXXXX
RESEND_FROM      = "Neko <pedidos@neko.com.ar>"
                   (o "Onboarding <onboarding@resend.dev>" para test)
```

Aplicar a **Production + Preview**. Redeploy o esperá al próximo push.

---

## 2. Activar el marketplace a locales reales

Hoy hay un local de seed (`pizzeria-don-luigi` o similar). Para que un
local real aparezca en `/marketplace`:

```sql
-- En Supabase SQL Editor con el local_id que querés activar:
UPDATE comanda_local_settings
SET tienda_activa = TRUE,
    visible_marketplace = TRUE,
    slug = 'mi-local'  -- URL-friendly, ej. neko-cocina
WHERE local_id = <ID>;
```

Mínimo para que la card del marketplace se vea decente:
- `comanda_local_settings.slug` (obligatorio — la URL)
- `comanda_local_settings.nombre` (cae a `locales.nombre` si null)
- `comanda_local_settings.direccion`
- `comanda_local_settings.telefono`
- `comanda_local_settings.provincia` y `localidad` (para filtros geo)
- `comanda_local_settings.lat` y `lon` (para distancia y "cercanos")
- `comanda_local_settings.radio_delivery_km` (NULL = sin límite)
- `comanda_local_settings.tiempo_retiro_min` / `tiempo_delivery_min`
- `comanda_local_settings.acepta_delivery` (boolean)

Mejor: el dueño/admin del local entra a **Configuración → Local** en
COMANDA y completa todo desde la UI. La pantalla `SettingsLocal.tsx`
ya tiene los campos.

---

## 3. Dominio del marketplace (decisión tuya)

Hoy `comanda` deploya en `comanda-xxx.vercel.app` y el marketplace vive
en `/marketplace` y `/tienda/:slug`. Cuando decidas:

- **Opción A**: subdominio del dominio que ya tenés. Ej.
  `pedi.neko.com.ar` apuntando al deploy de COMANDA.
- **Opción B**: dominio nuevo (`pedineko.com.ar` por ejemplo) — más
  trabajo pero queda independiente.

En cualquier caso:
1. Vercel proyecto COMANDA → **Settings → Domains → Add**.
2. Cargar el dominio.
3. Vercel te tira un CNAME → cargarlo en el DNS del dominio.
4. Esperá 5min–1h, click **Verify**.

Una vez con dominio, el link de los emails de Gap #4 va a usar
`req.headers.origin` automáticamente — no hay que tocar nada del código.

---

## 4. Smoke test post-activación

Una vez configurado todo lo anterior, hacer este recorrido cliente real:

1. Abrir `https://<dominio>/marketplace` desde un celu (no incógnito) →
   permitir geolocalización → debería ordenar por cercanía.
2. Click en una card → ver catálogo + sección "Popular" si hay ventas.
3. Carrito → checkout → completar nombre, tel, email → "Programar para
   más tarde" (probar con +30min).
4. Confirmar → debería redirigir a `/confirmacion/:ventaId` con
   timeline. **Revisar mail**: debería llegar "Recibimos tu pedido".
5. Como dueño del local en COMANDA: aprobar el pedido → marcar listo →
   marcar entregado. **Revisar mail** en cada paso: "Salió tu pedido"
   y "¿Cómo estuvo? Calificá".
6. Click en el link "Calificar" del email → completar review (rating +
   comentario) → submit.
7. Como dueño en COMANDA: **Clientes → Reseñas** → la review aparece
   pendiente → click **Publicar**.
8. Volver al marketplace → la card del local debería mostrar las
   estrellas y la review en `/tienda/:slug`.

---

## 5. Otras decisiones pendientes (no bloqueantes)

- **WhatsApp confirmación**: Resend solo manda email. Si querés
  WhatsApp/SMS también, hay que sumar Twilio o un BSP de WhatsApp. No
  está implementado.
- **Aviso al comerciante**: cuando entra un pedido nuevo, el dueño se
  entera solo si tiene COMANDA abierta (realtime). Para push notif
  hay deuda en `admin_push_subscriptions` (existe la tabla pero no la
  pantalla de subs end-to-end).
- **Pago online**: hoy solo "Pago al retirar / al recibir". MP
  Checkout vive en `tienda-mp.js` pero el flow no lo dispara desde la
  tienda nueva. Sprint dedicado cuando quieras activarlo.

---

**Pateame si algo falla en el smoke test y lo arreglamos.**
