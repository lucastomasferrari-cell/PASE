# Fase 6 — Bot IG + admin-console (consolidado)

**Estado:** ✅ Completa
**Fecha:** 2026-05-27
**Método:** 2 agentes en paralelo (F6A bot IG · F6B admin-console).

## 📊 Resumen ejecutivo

**~45 findings**. **5 críticos**.

Sub-reportes:
- [06a-instagram-bot.md](./06a-instagram-bot.md) — 18 findings (4 CR + 6 AL)
- [06b-admin-console.md](./06b-admin-console.md) — 27 findings (1 CR + 7 AL)

### ⚠️ Hallazgos confirmados

1. **F6A#1 — Upsert `ig_conversaciones` resetea `estado='bot'` cada DM.** La feature "tomar conversación como humano" no funciona: el próximo DM del cliente reactiva el bot. **Bug funcional grave** + potencial loop "bot dice algo malo → dueño toma manual → cliente escribe → bot vuelve".
2. **F6A#2 — Sin rate limit per-cliente ni per-tenant en el bot.** Las columnas `ig_config.rate_limit_msgs`/`rate_limit_minutos` existen pero NUNCA se leen. Exploit: 5000 DMs en 30s ≈ $150 USD en Claude sin tope.
3. **F6A#3 — CORS `Access-Control-Allow-Origin: *` global en `vercel.json:26-33`** anula el allow-list de `_lib/cors.js`. Defense-in-depth roto.
4. **F6A#4 — `max_tokens`/`system_prompt`/`contexto_mensajes` sin validar server-side.** Slider UI limitado 256-2048, RLS permite UPDATE sin CHECK. Setear `max_tokens=200000` → ~$3 USD por mensaje.
5. **F6B#1 — Botón "Ver como tenant" roto silenciosamente.** Abre URL con `?as=<uuid>` que PASE **nunca lee** (verificado con grep). Lucas clickea y sigue viendo Neko.

### Otros hallazgos notables

- **F2D #27 está a medias**: la migration F2 agregó columna encrypted pero **dejó la TEXT plain viva** y `webhook.js` tiene fallback explícito. Falta drop + eliminar fallback.
- **Sin prompt caching en `_lib/claude.js`** del bot (5x más caro de lo necesario) — `/api/claude` de PASE sí usa `cache_control`.
- **`/api/claude` proxy crudo (F2D #9.1)**: cualquier authenticated lo usa como API gateway Anthropic gratuito.
- **Multi-account OAuth roto** (`oauth-callback.js`): vincular 2da cuenta IG sobre tenant conectado corrompe combinación token/account_id.
- **CHECK constraint `ig_mensajes.tipo` no cubre `file/template/fallback`** que Meta envía — INSERT falla silencioso, mensaje perdido.
- **`diagnostic.js`** sigue exponiendo first4+last4 de secrets (F2D MED no fixed).
- **Admin: cero tests** + `toggleActivo` tenant sin audit + falta UI eliminar/restaurar tenant + métricas trae todos los tickets para contar.

---

## 🎯 Ranking de los 5 críticos

| # | Bug | Sub | Esfuerzo | Impacto |
|---|---|---|---|---|
| 1 | Upsert resetea `estado='bot'` cada DM (humano toma → bot vuelve) | F6A | 5 min | Feature "tomar manual" rota |
| 2 | Sin rate limit per-tenant en bot — cost runaway trivial | F6A | 30 min | $150 USD en 30s posible |
| 3 | CORS `*` global anula allow-list | F6A | 2 min | Defense-in-depth roto |
| 4 | `max_tokens`/`system_prompt` sin CHECK server-side | F6A | 10 min (migration) | `max_tokens=200k` → $3/mensaje |
| 5 | "Ver como tenant" botón roto silenciosamente | F6B | 5 min (esconder hasta implementar) | Lucas no puede impersonar para debug |

### Decisiones pendientes

- F2D #27 fase 2: drop columna `page_access_token` plana (verificar primero que el encrypted funciona OK 24-48hs).
- F6A#5 prompt caching en bot (decisión: replicar patrón de `/api/claude`, ahorra ~5x en costo Claude).
- F6A#6 `/api/claude` rate limit + cap max_tokens.
- F6B `toggleActivo` con audit (RPC nueva `fn_set_tenant_activo`).
- F6B UI eliminar/restaurar tenant (Lucas hoy usa scripts a mano).

---

## Plan de ataque (este sprint)

**Auto-fixeables:**
1. F6A#1 — upsert no resetear `estado` si ya existe.
2. F6A#2 — rate limit por tenant (leer cfg.rate_limit_msgs).
3. F6A#3 — eliminar header CORS `*` de vercel.json.
4. F6A#4 — migration CHECK constraint en `ig_config` + drop columna plana IG (F2D #27 fase 2).
5. F6B#1 — esconder o disabled el botón "Ver como tenant" hasta implementar.

**Defer:**
- F6A#5 prompt caching (decisión costo/UX).
- F6A#6 rate limit `/api/claude`.
- F6A#7 fix multi-account OAuth.
- F6A#8 CHECK constraint `ig_mensajes.tipo` para cubrir file/template/fallback (sin perder mensajes).
- F6A#9 implementación de tests del bot.
- F6B `toggleActivo` con audit (sprint dedicado).
- F6B UI eliminar/restaurar tenant (sprint dedicado).

---

## Cross-fase

1. **Bot IG es el módulo con menos tests** (0 tests en 1945 LOC con 7 endpoints que manejan dinero — Claude API costs).
2. **Admin-console está mejor que pantalla vieja de PASE** pero también sin tests.
3. **Patrón cost-runaway** repetido (bot, /api/claude, auto-fix agent en /api/agent). Lucas paga por uso de Anthropic — sin rate limit, un user / un cliente DM puede generar facturas grandes.
4. **`diagnostic.js`** sigue siendo info-disclosure (F2D MED). Vale la pena cerrar.

## Para la próxima fase (F7)

F6 cerró bot + admin. F7 audita **deuda técnica + overengineering** — auditoría meta del codebase entero. Atacar:
- Código duplicado entre PASE / COMANDA / admin-console (oportunidades para `@pase/shared`).
- Patrones overengineered (abstracciones prematuras, hooks innecesarios).
- Migrations ESQL acumuladas (287 archivos) — ¿se pueden consolidar legacy en una baseline?
- TODOs / FIXMEs en código.
- Dependencias sin usar (`pnpm depcheck`).
- Convenciones C1-C11 — adopción real vs nominal.
