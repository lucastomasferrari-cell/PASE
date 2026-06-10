# MESA — sistema de reservas

Tercer producto del ecosistema (PASE back-office · COMANDA POS · **MESA reservas**).
App independiente con su propio deploy, compartiendo la MISMA base Supabase —
por eso los tres se inter-relacionan: MESA lee las mesas del POS en vivo,
COMANDA ve las reservas del día, PASE ve la plata de eventos/giftcards.

## Rutas

| Ruta | Qué es |
|---|---|
| `/` | Landing del producto |
| `/:slug` | Página pública del local (perfil + reservas + eventos + giftcards) |
| `/admin` | Panel del restaurante (auth Supabase compartida con PASE/COMANDA) |

## Dev

```bash
pnpm --filter mesa dev        # http://localhost:5175
pnpm --filter mesa typecheck
pnpm --filter mesa test
```

Crear `packages/mesa/.env.local` con:
```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```
(mismos valores que PASE/COMANDA — es la misma base.)

## Deploy (Vercel)

Proyecto Vercel propio con **Root Directory = `packages/mesa`**, framework Vite.
Env vars: `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`. El `vercel.json`
rebota `/api/*` al proyecto de PASE (ahí viven las serverless functions,
incluido el checkout MP de eventos/giftcards).

## Estado (09-jun-2026)

- ✅ Backend módulo #1 (núcleo reservas, máquina de estados) y módulo #4 fase 1-2
  (eventos prepago MP + giftcards) — migraciones en `packages/pase/supabase/migrations/`.
- ✅ Scaffold de la app (este paquete): landing, perfil público mínimo (ya consume
  `fn_get_reservas_info_publico`), login admin.
- ⏳ Próximo: portar Agenda/Eventos/Giftcards desde COMANDA + sprint visual de la
  página pública (spec: `docs/superpowers/specs/2026-06-09-mesa-modulo-4-pagina-publica-design.md`).
