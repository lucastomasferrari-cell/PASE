# Fase 5 — COMANDA completo (consolidado)

**Estado:** ✅ Completa
**Fecha:** 2026-05-27
**Método:** 3 agentes en paralelo (F5A páginas/servicios · F5B sync engine offline · F5C integraciones AFIP/delivery/MP/KDS/print).

## 📊 Resumen ejecutivo

**~80 findings totales**. **14 críticos**.

Sub-reportes:
- [05a-comanda-paginas-servicios.md](./05a-comanda-paginas-servicios.md) — 27 findings (5 CR + 6 AL + 10 MED + 6 BAJO)
- [05b-comanda-sync-offline.md](./05b-comanda-sync-offline.md) — 15 findings (4 CR + 5 AL)
- [05c-comanda-integraciones.md](./05c-comanda-integraciones.md) — 27 findings (5 CR + 11 AL)

### ⚠️ Hallazgos confirmados — los más peligrosos

1. **F5B#2 — Logout y cambio de tenant NO limpian IndexedDB.** `resetDb()` y `cacheClear()` existen pero ningún módulo de auth los llama. Ops del user A se sincronizan con JWT del user B. **Riesgo: corrupción cross-tenant real.**
2. **F5B#3 — `pullVentasAbiertas` borra ventas dirty no-sincronizadas.** PoC: cobrar venta offline → otro cajero se loguea → la venta cobrada local desaparece y el server nunca recibe el cobro. Pérdida de plata real.
3. **F5C#1 — Firma HMAC delivery desconectada.** Los helpers `verifyRappiWebhookSignature` están escritos pero terminan con `void verifyRappiWebhookSignature;` al final del archivo. **Cualquiera con la URL del webhook inyecta pedidos.**
4. **F5C#2 — AFIP recovery roto.** Si INSERT a `afip_facturas` falla post-CAE, queda CAE huérfano en AFIP que no existe en DB. Próxima retry pide CAE nuevo → factura duplicada en AFIP. **Riesgo fiscal AR real.**
5. **F5A#2 — `pullVentasItemsIncremental` no filtra por `local_id`** → race al cambiar de local, pierde deltas.
6. **F5B#1 — `markFailed`/`markSyncing` sin reset al boot + falta de lock cross-tab.** Ops huérfanas en estado "syncing" permanente.
7. **F5B#4 — `runFullCycle` aborta entero si pull falla.** Push queue no corre nunca para recovery offline → ops nunca llegan al server.
8. **F5C#3 — Webhook partner sin chequeo de idempotency.** Existe UNIQUE index pero el handler no chequea antes de INSERT → reenvíos generan 500 → reintento infinito.
9. **F5C#4 — MP webhook itera TODOS los tenants** para resolver `external_reference` (N/2 calls a MP). Leak cross-tenant + risk de throttling de tenants ajenos.
10. **F5C#5 — Print server local sin auth.** `http://127.0.0.1:9100` acepta `/print`, `DELETE /printers/{id}` sin token. Malware local puede imprimir o borrar config.

**Hallazgo meta crítico:** **0 tests del orquestador `syncEngine`/`pushQueue`/`pullIncremental`** en código que mueve plata. Viola regla C2 y C10.

---

## 🎯 Ranking de los 14 críticos

| # | Bug | Sub | Esfuerzo | Impacto |
|---|---|---|---|---|
| 1 | Logout/cambio tenant no limpia IndexedDB | F5B | 15 min | Corrupción cross-tenant |
| 2 | `pullVentasAbiertas` borra dirty no-sincronizadas | F5B | 30 min | Pérdida de plata real |
| 3 | Firma HMAC delivery desconectada (`void verify*`) | F5C | 30 min | Inyección unauth de pedidos |
| 4 | AFIP recovery roto (CAE huérfano) | F5C | 1h | Riesgo fiscal AR |
| 5 | `pullVentasItemsIncremental` sin filtro local_id | F5A | 15 min | Pierde deltas al cambiar local |
| 6 | `markFailed`/`markSyncing` sin reset al boot + cross-tab lock | F5B | 30 min | Ops syncing permanente |
| 7 | `runFullCycle` aborta entero si pull falla | F5B | 15 min | Push queue sin recovery |
| 8 | Webhook partner sin idempotency check | F5C | 30 min | Reintento infinito |
| 9 | MP webhook itera todos los tenants | F5C | 1h | Leak + throttling cross-tenant |
| 10 | Print server local sin auth | F5C | 1h | Malware local impacta impresión |
| 11 | Sync engine puede no estar montado si flag off | F5A | nota docs | Bug fantasma "venta encolada pero nunca sale" |
| 12 | Idempotency keys window 5s frágil para retries cross-boundary | F5A | 1h refactor | Duplicación de pagos en retry largo |
| 13 | `_tempIdCounter` reinicia al refresh | F5A | 30 min (persistir) | Colisión tempIds entre sesiones |
| 14 | VentaScreen god-object 1378 LOC | F5A | sprint dedicado | Re-render cascada + bug-prone |

### Decisiones pendientes

- **AFIP recovery:** ¿pedir CAE PRIMERO + INSERT después (con rollback if INSERT falla)? ¿o store request_uuid antes de pedir CAE (idempotency local)?
- **MP webhook tenant resolution:** ¿modificar el flow de checkout para que la `preference` MP lleve `metadata.mp_credencial_id` y el webhook lo lea? Requiere coordinar con frontend.
- **Print server auth:** ¿bearer en cada request? ¿client cert? ¿O confiar en `127.0.0.1` y deshabilitar CORS?
- **VentaScreen split:** rediseño grande — requiere planificación.
- **Tests del orquestador:** sprint dedicado de tests E2E para sync (no se puede improvisar).

---

## Plan de ataque (este sprint)

**Auto-fixeables ya (atacar):**
1. F5B#2 — invocar `resetDb()` en logout COMANDA.
2. F5B#3 — `pullVentasAbiertas` preservar rows dirty.
3. F5B#4 — `runFullCycle` separate try/catch para que push corra aunque pull falle.
4. F5B#1 — reset state `syncing` al boot del syncEngine.
5. F5A#2 — `pullVentasItemsIncremental` agregar filter `local_id`.
6. F5C#1 — wire HMAC delivery (los helpers existen, solo conectar).
7. F5C#3 — webhook check duplicate antes de INSERT.

**Defer (decisiones / refactors):**
- F5C#2 AFIP recovery (necesita decisión flow)
- F5C#4 MP webhook tenant (coordinar frontend)
- F5C#5 Print server auth (decisión mecanismo)
- F5A#11 montaje sync engine (validar primero si feature flag default on)
- F5A#12 idempotency keys window (refactor)
- F5A#13 `_tempIdCounter` persistir (refactor)
- F5A#14 VentaScreen split (sprint dedicado)
- **Tests E2E sync engine** (sprint dedicado, alta prioridad)

---

## Cross-fase

1. **COMANDA es WIP** — más deuda esperada que PASE. Confirmado: ~30% más críticos por LOC.
2. **Sync engine es el corazón del POS** y NO tiene tests. Esto es la deuda más urgente operativamente.
3. **No hay logs unificados tipo `ig_eventos` en COMANDA** — errors se pierden o quedan solo en DevTools.
4. **El flag `offlineFirstVentas` está ON por default** según F5B (`featureFlags.ts:34`), contradiciendo el comment de `syncEngine.ts:16-18` que dice "no se monta automáticamente". Lucas ya está testeando offline-first en prod sin saberlo del todo.
5. **AFIP regulado en AR** — los bugs F5C#2 + altos relacionados (IVA hardcoded 21%, CUIT no validado para Factura A, cert vencimiento sin alerta) son riesgo legal-fiscal. Atacar antes de habilitar AFIP a más tenants.

## Para la próxima fase (F6)

F5 atacó COMANDA. F6 audita bot IG + admin-console (paquetes más chicos pero con superficie distinta). Atacar:
- Bot IG: webhook Meta, Claude prompt injection, costo por tenant.
- Admin-console: superadmin powers, tenant management UIs.
