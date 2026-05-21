# @pase/instagram-bot

Bot de Instagram para PASE — atiende DMs con Claude + memoria total +
tools (acciones reales sobre la DB de PASE).

## Arquitectura

```
Cliente envía DM en Instagram
    ↓
Meta Webhook POST → /api/webhook
    ↓
Verifica signature, guarda mensaje en ig_mensajes
    ↓
Arma contexto (últimos N mensajes del thread + datos del cliente)
    ↓
Claude API (Haiku) con system prompt del tenant + tools disponibles
    ↓
Si Claude llama un tool → ejecutamos, devolvemos resultado
    ↓
Loop hasta que Claude tiene respuesta final
    ↓
Send via Graph API → cliente recibe DM
    ↓
Guardamos mensaje out + tools_llamadas + costo en DB
```

## Variables de entorno (Vercel)

| Variable | Para qué |
|---|---|
| `SUPABASE_URL` | Conexión a la DB (compartida con PASE) |
| `SUPABASE_SERVICE_KEY` | Bypassa RLS — el bot opera con privilegios elevados |
| `ANTHROPIC_API_KEY` | Para llamar Claude |
| `META_VERIFY_TOKEN` | String random que vos inventás; Meta lo manda en el handshake del webhook para validar que el endpoint es tuyo |
| `META_APP_SECRET` | Para validar la firma `X-Hub-Signature-256` de cada webhook (anti-spoofing) |

El **PAGE_ACCESS_TOKEN** y el **IG_ACCOUNT_ID** viven en `ig_config` por
tenant (no en env), así el sistema soporta múltiples cuentas IG en
distintos tenants.

## Deploy

1. En Vercel: New Project → Import del repo PASE
2. **Root Directory**: `packages/instagram-bot`
3. **Framework Preset**: Other
4. **Install Command**: dejar default (lee de vercel.json)
5. Variables de entorno: pegar las 5 de arriba
6. Deploy

## Configurar webhook en Meta

Una vez que tengas la URL del deploy (ej. `https://pase-instagram-bot.vercel.app`):

1. Meta for Developers → tu app → Instagram Messaging → Configurar webhooks
2. **Callback URL**: `https://pase-instagram-bot.vercel.app/api/webhook`
3. **Verify Token**: el mismo que pusiste en `META_VERIFY_TOKEN`
4. Suscribirse a los eventos: `messages`, `messaging_postbacks`

## Onboarding de un tenant

Para que el bot atienda un IG, hay que insertar una row en `ig_config`:

```sql
INSERT INTO ig_config (
  tenant_id, ig_account_id, ig_username, page_access_token, bot_activo
) VALUES (
  '<tenant uuid>',
  '<ig_account_id de Meta>',
  'neko_sushi',
  '<page_access_token>',  -- TODO encriptar
  TRUE
);
```

(Después armamos una UI en PASE para esto — sprint D)
