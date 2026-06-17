# Plan — Coherencia de conceptos (taxonomía + fuente única) — 2026-06-16

Disparado por Lucas: "tiene que haber una base sólida por defecto, y la lógica de los
módulos tiene que tomar la info siempre de un solo lugar (catálogo o Equipo); y los
conceptos tienen que tener una línea coherente, no inventada — comparado con otros sistemas".

## 1. Auditoría "una sola fuente de verdad" (código)

| Lista | Fuente única | Estado |
|---|---|---|
| Categorías (gastos/compras/ingresos) | `config_categorias` → `useCategorias()` | ✅ todos los consumidores leen del hook (0 hardcode) |
| Medios de cobro | `medios_cobro` → `useMediosCobro()` | ✅ |
| Puestos del equipo | `rrhh_puestos` → `usePuestosRRHH()` | ✅ |
| **Cuentas / cajas** | **ninguna** | ❌ hardcodeada en 3 lados (`constants.ts CUENTAS`, `rrhh/helpers.ts CUENTAS_PAGO`, `RRHHLegajo.tsx CUENTAS_LIQ`) + literales sueltos, con **órdenes distintos**; sin tabla, sin hook, sin Ajustes |

## 2. Estándar de la industria (USALI / Restaurant365 / Toast)

Ventas → **CMV (solo mercadería)** → Ganancia Bruta → **Mano de Obra** (sueldos + cargas
+ beneficios) → **Prime Cost** (CMV+MO, ideal ≤60-65%) → **Gastos Operativos**
(Ocupación, Marketing, Mantenimiento, Servicios, Administrativos) → **Impuestos** →
Ganancia Neta. Aparte (debajo de la neta): **Retiros de socios** (NO es gasto).

CMV = SOLO comida/bebida/packaging. La mano de obra es su propio bloque (no se mezcla
con CMV ni con gastos varios).

## 3. Problemas en el catálogo actual + impacto en plata (tenant Neko/Maneki/Rene, histórico no anulado)

🔴 **`retiro_socio` contaminado — $49M que NO son retiros de socios:**
- `retiro_socio | RETIRO EFECTIVO` → **9 movs, $39.240.000**. "Retiro efectivo" = movimiento
  interno de caja, NO distribución a socios (regla establecida). Infla enormemente los retiros
  y distorsiona el análisis de reparto/utilidades (conecta con la duda "siento que repartimos menos").
- `retiro_socio | COMPRA ONLINE` → **46 movs, $10.237.766**. Son COMPRAS, no retiros.
- (`retiro_socio | COMPRA MERCADO LIBRE` inactiva.)

🔴 **Mano de obra escondida en "Gastos Variables" (~$11.3M) — subcuenta el Costo Laboral:**
- REPARTIDORES 108x $6.295.600 · SUELDO DIA 49x $2.525.100 · Sueldo evento 31x $2.022.702 · PERSONAL 6x $428.000.
- Hoy caen en Variables; deberían ser Costo Laboral (tipo `empleado`, que el EERR ya suma a Sueldos).

🟡 **Propinas como gasto variable** — PROPINA 127x $2.481.856 (tipo variable) + categoría PROPINAS en CMV.
   Las propinas suelen ser pass-through (entran y salen). Definir tratamiento con Lucas.

🟡 **CMV contaminado en el catálogo** (dropdown), aunque el histórico de gastos casi no lo usó:
   SUELDOS, PUBLICIDAD, PROPINAS, CONTADOR, EXPENSAS están como `cat_compra`. (CONTADOR/EXPENSAS
   reales se cargaron como `fijo` — bien; el problema es el catálogo/dropdown.)

🟡 **Duplicados de nombre en >1 tipo** (el sistema elige al azar cuál): BEBIDAS (×2 en cat_compra),
   CONTADOR, EXPENSAS, EQUIPAMIENTO, HIELO, LIMPIEZA, PACKAGING, SUPERMERCADO, PANADERÍA, VERDULERIA BARRIO.

🟡 **Columna `grupo` vestigial** — la app clasifica por `tipo`, no por `grupo`; la mitad están en null.
   Decidir: eliminar la columna o sincronizarla con tipo.

## 4. Decisiones de negocio pendientes (Lucas) — bloquean la restatement de histórico

1. **RETIRO EFECTIVO ($39M)**: ¿son retiros reales de los socios, o movimientos internos de caja?
2. **COMPRA ONLINE ($10M)** bajo retiros: reclasificar a Compras / Gasto Variable.
3. **Sueldos en Variables (~$11M)**: mover a Costo Laboral (tipo empleado).
4. **Propinas ($2.5M)**: gasto real / pass-through (neteo) / sacar.

## 5. Plan por etapas (cada una shippable + confirmable)

- **Etapa 0 — Hygiene de catálogo (sin tocar histórico):** deduplicar, sincronizar/sacar `grupo`,
  mover en el catálogo los conceptos mal puestos (afecta dropdowns + gastos NUEVOS, no la historia).
- **Etapa 1 — Restatement de histórico (con OK de Lucas, preview antes/después):** re-tipar los
  gastos viejos según las decisiones de §4. Cambia números del EERR (para mejor). Backup previo.
- **Etapa 2 — Base sólida por defecto:** reescribir `fn_seed_catalogo_tenant` con la taxonomía
  estándar (CMV solo mercadería, Mano de Obra, Ocupación, Marketing, Mant., Servicios, Admin,
  Impuestos, Ingresos) → tenants nuevos arrancan bien sin tocar nada.
- **Etapa 3 — Cuentas como fuente única:** tabla `config_cuentas` + hook `useCuentas()` + sección
  Ajustes; reemplazar los 3 arrays hardcodeados. (Aditivo, no toca plata histórica.)
- **Etapa 4 — Blindaje:** regla ESLint contra arrays hardcodeados de cuentas/categorías; doc en CLAUDE.md;
  tests mutante/e2e de los re-tipados.

## 6. Reglas de coherencia (objetivo final)
- Todo dropdown/lista de conceptos lee de `useCategorias` / `useMediosCobro` / `usePuestosRRHH` / `useCuentas`.
- Editar en Ajustes (o Equipo) = se refleja en todos los módulos (ya pasa por realtime + cache).
- CMV = solo mercadería. Mano de obra = su bloque. Retiros = debajo de la neta, sólo distribuciones reales.
