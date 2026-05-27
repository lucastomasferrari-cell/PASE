# Fase 7 — Deuda técnica + overengineering (consolidado)

**Estado:** ✅ Completa
**Fecha:** 2026-05-27
**Método:** 2 agentes en paralelo (F7A duplicación/overengineering · F7B schema/migrations).

## 📊 Resumen ejecutivo

**~40 findings**. **~10 críticos**.

Sub-reportes:
- [07a-duplicacion-overengineering.md](./07a-duplicacion-overengineering.md) — 6 críticos duplicación, ~970 LOC eliminables
- [07b-schema-y-migrations.md](./07b-schema-y-migrations.md) — 23 findings schema (4 críticos + 6 altos)

### ⚠️ Hallazgos confirmados

**F7A — Duplicación cross-paquete:**
1. **`@pase/shared` vacío** (scaffold con `export {}`) pero ya declarado como dep en `comanda/package.json`. El sprint dedicado nunca ocurrió y mientras tanto se sumaron admin-console + instagram-bot con copy-paste.
2. **6 duplicaciones críticas (~970 LOC eliminables):**
   - `features.ts` **byte-idéntico** (336 LOC) entre PASE y admin-console
   - `useRealtimeTable.ts` cuasi-idéntico PASE/COMANDA con defaults divergentes
   - `useDebouncedValue.ts` difiere solo en comillas
   - 3 implementaciones distintas de "formato $ argentino" (`fmt_$` PASE / `formatCurrency` PASE / `formatARS` COMANDA — la de COMANDA viola design system)
   - URL Supabase hardcodeada en 3 paquetes
   - IG bot: `_lib/db.js` ignorado por 5 de 7 endpoints
3. **3 sistemas de toast COMANDA:** `use-toast.ts` shadcn pattern (196 LOC dead code) + `useNotifier` custom + Sonner. Solo Sonner se usa (71 archivos). ~400 LOC eliminables sin riesgo.
4. **API límite Vercel Hobby:** 12 endpoints reales = límite duro. Próximo endpoint requiere consolidar con `?action=`.
5. **Tests:** PASE 86, COMANDA 41, **admin-console 0**, **instagram-bot 0** (este último recibe webhooks de Meta sin tests).

**F7B — Schema / migrations:**
6. **Cero retention** en `auditoria`, `ig_eventos`, `mp_movimientos`, `pedidos_externos_log`, `idempotency_keys`. Solo 1 cron activo (`reactivar-items-vencidos`). Las tablas crecen indefinidamente.
7. **Buckets `empleados` y `rrhh-documentos` con `public=true`** y datos sensibles (DNIs/contratos/recibos de sueldo).
8. **96 funciones SECURITY DEFINER sin check de auth detectado** (sub-conjunto a triagear, complementa F2B).
9. **5 tablas operativas con `tenant_id NULLABLE`** — `ig_eventos` (webhook sin tenant resuelto), `mp_webhooks_test`, `pedidos_externos_log`, `roles` (sistema), `usuarios` (superadmin) — los 3 primeros son deuda real.
10. **Tablas `*_history` COMANDA crecen sin techo**, sin retention, sin RLS, sin tenant_id.

**Otros (altos):**
- 68 columnas `numeric` sin precision/scale (todas plata)
- 53 tablas sin CHECK constraint (incluye `saldos_caja`, `movimientos`, `tenants`)
- 67 columnas text con valores enumerados sin CHECK ni ENUM
- 63 tablas sin `updated_at`
- 30 UNIQUE constraints sin tenant_id (mayoría OK)

---

## 🎯 Ranking de los 10 críticos

| # | Bug | Sub | Esfuerzo | Impacto |
|---|---|---|---|---|
| 1 | Buckets `empleados`/`rrhh-documentos` public=true (datos sensibles) | F7B-S2 | 30 min | Privacy leak: DNIs/contratos accesibles vía URL directa |
| 2 | Cero retention — tablas que crecen indefinidamente | F7B-S1 | 1h (cron jobs) | DB infla mes a mes; queries lentas a futuro |
| 3 | `*_history` COMANDA sin retention + sin tenant_id | F7B-S10 | 30 min | Mismo patrón, ya con F2A fix de policies |
| 4 | `@pase/shared` vacío + 970 LOC duplicados | F7A | sprint dedicado | Drift entre paquetes; ya divergen defaults |
| 5 | 3 sistemas toast COMANDA — `use-toast.ts` dead code | F7A | 15 min | DELETE 196 LOC |
| 6 | API límite 12 endpoints PASE (Hobby Vercel) | F7A | nota | Próximo endpoint requerirá refactor |
| 7 | C4-F13 Maxirest importer deja saldos inflados si falla mid-batch | F7A | 1h | Pérdida de plata real |
| 8 | 0 tests en `instagram-bot` y `admin-console` | F7A | sprint dedicado | Bot recibe webhooks reales de Meta sin coverage |
| 9 | 5 tablas operativas con tenant_id NULL (3 son deuda real) | F7B-S4 | decisión | webhooks sin tenant resuelto; cleanup job? |
| 10 | 96 SD funcs sin auth check detectado | F7B-S3 | triage | Complementa F2B; sub-conjunto a revisar |

### Decisiones pendientes

- **`@pase/shared` sprint:** ¿Hacerlo ahora o esperar? Lucas: estamos en F7 — decidir cuándo abordarlo.
- **Buckets privados:** ¿migrar URLs públicas actuales a signed URLs? Cambiará UX de visualizar PDF/JPG (la app necesita generar token).
- **API consolidación:** alcanzamos límite Hobby; ¿plan Pro o consolidar endpoints con `?action=`?
- **NUMERIC(15,2) en plata:** sprint dedicado, requiere migración data y refactor RPCs.

---

## Plan de ataque (este sprint)

**Auto-fixeables:**
1. F7B-S2: buckets a privados + policies + signed URLs en `useStorageSigned()` helper.
2. F7B-S1+S10: cron retention jobs para `auditoria` (>180d), `ig_eventos` (>90d), `pedidos_externos_log` (>30d), `idempotency_keys` (>7d), `*_history` (>180d).
3. F7A: DELETE `use-toast.ts` COMANDA (dead code, 196 LOC).

**Defer:**
- F7A `@pase/shared` sprint (970 LOC consolidación).
- F7A consolidación endpoints PASE (`?action=`).
- F7A tests bot IG + admin-console.
- F7B-S4 tenant_id NULL — 3 candidatos a fix requieren rediseño (webhooks pre-resolución de tenant).
- F7B-S3 triage 96 SD funcs.
- F7B-S5/S6/S7/S8 schema hardening (numeric precision, CHECKs, updated_at en falta).
- F7A C4-F13 Maxirest atomic batch.

---

## Cross-fase

1. **Health del schema:** sólido. La deuda principal es **retention + constraints**, no agujeros estructurales.
2. **Multi-tenant evolucionó correctamente** (F0/F2A/F2B/F7B coinciden).
3. **Repo limpio:** 5 TODOs reales en total, 0 FIXME/HACK. Esto es excepcional para 84K LOC.
4. **Adopción C1-C11:** real ~70%. La deuda más visible es C4 (10 disables documentados como `deuda C4-F{N}`), C6 (4 de 8 páginas).
5. **`eliminar_tenant_completo` redefinido 6 veces en 4 días, `pagar_sueldo` 3, `crear_gasto_empleado` 3** — hot-fix iterativo normal, candidato a baseline squash a futuro.

## Para la próxima fase (F8)

F8 es **consolidación ejecutiva**:
- Reporte ejecutivo top-down (qué encontramos, qué arreglamos, qué queda).
- Estimación de esfuerzo de lo pendiente.
- Recomendaciones de orden de ataque.
- Actualización del estado real al `MEMORY.md` de Lucas.
- Discusión final de los items que requieren decisión humana (acumulados en cada FN).
