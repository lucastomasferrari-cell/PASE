# Auditoría completa del monorepo — 2026-05-26

Análisis profundo de PASE + COMANDA + bot IG + admin-console.
Pedido por Lucas, ejecutado en 9 fases.

**Design:** [docs/superpowers/specs/2026-05-26-auditoria-completa-monorepo-design.md](../superpowers/specs/2026-05-26-auditoria-completa-monorepo-design.md)
**Log de auto-fixes:** [FIXES.md](./FIXES.md)

## 📊 Métricas iniciales del monorepo

| Paquete | LOC | Archivos |
|---|---|---|
| `pase` | 22.852 | 573 |
| `comanda` | 55.304 | 338 |
| `instagram-bot` | 1.921 | 13 |
| `admin-console` | 4.075 | 28 |
| **TOTAL** | **84.152** | **952** |

**Migrations SQL:** 287 archivos en `packages/pase/supabase/migrations/`

## 📋 Estado de las fases

| # | Fase | Estado | Reporte |
|---|------|--------|---------|
| 0 | Reconocimiento | ✅ Completa | [00-reconocimiento.md](./00-reconocimiento.md) |
| 1 | 💰 Bugs financieros | ✅ Completa | [01-bugs-financieros.md](./01-bugs-financieros.md) — **52 findings, 15 CRÍTICOS** |
| F1🔧 | Fix sprint F1 críticos | ✅ Completa | **13 fixes aplicados** ([FIXES.md](./FIXES.md)) — 2 quedan para decisión humana (#3 pagar_remito, #6 sobrepago) |
| 2 | 🔐 Seguridad multi-tenant | ✅ Completa | [02-seguridad-multi-tenant.md](./02-seguridad-multi-tenant.md) — **130 findings, 32 CRÍTICOS** (8 RLS + 17 SD + 4 frontend + 3 auth) |
| F2🔧 | Fix sprint F2 críticos | ✅ Completa | **26 fixes aplicados** ([FIXES.md](./FIXES.md)) — 6 quedan (1 rediseño checkout + cleanup legacy SHA + drop col plana IG) |
| 3 | ⚡ Performance | ✅ Completa | [03-performance.md](./03-performance.md) — **71 findings, 15 críticos/altos** (Realtime 7h CPU/día, COMANDA bundle 765KB, N+1, índices) |
| F3🔧 | Fix sprint F3 críticos | ✅ Completa | **10 fixes aplicados** ([FIXES.md](./FIXES.md)) — 5 quedan (refactors arquitectónicos: Caja unificar, useBandejaEntrada, catálogos on-focus) |
| 4 | 🎨 Frontend PASE | ⚪ Pendiente | — |
| 5 | 📱 COMANDA completo | ⚪ Pendiente | — |
| 6 | 🤖 Bot IG + admin-console | ⚪ Pendiente | — |
| 7 | 🧹 Deuda + overengineering | ⚪ Pendiente | — |
| 8 | 📊 Consolidación ejecutiva | ⚪ Pendiente | — |

## 🔧 Convenciones

- **🔴 Crítico** — pérdida de plata, leak entre tenants, vulnerabilidad explotable
- **🟠 Alto** — bug en flow visible, performance >5s, datos inconsistentes
- **🟡 Medio** — bug en flow secundario, deuda técnica, código difícil de mantener
- **🟢 Bajo** — nice-to-have, naming, docs faltantes

**Estados:** ⚪ Pendiente · 🟡 En progreso · ✅ Completo

## ⚙️ Cómo retomar esta auditoría en otra sesión

1. Leer este INDEX para ver qué fases están completas.
2. Leer el reporte de la última fase completa para entender el contexto.
3. Si estás en una nueva fase, leer las notas de la sección "Para la próxima fase" del reporte anterior.
4. Auto-fixes commiteados se registran en FIXES.md.
