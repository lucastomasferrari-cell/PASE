# Análisis de lógica — RRHH / Equipo (PASE)

**Fecha:** 2026-06-11
**Tipo:** auditoría de arquitectura de producto (decisiones de diseño, no bugs)
**Alcance:** Empleados, Novedades/Sueldos (TabSueldos), Legajo, Adelantos, SAC/Aguinaldo, Vacaciones, Liquidación final, Planilla de sueldos base
**Archivos leídos:** `src/lib/calculos/rrhh.ts` (+ 118 tests), `src/pages/rrhh/TabSueldos.tsx`, `TabSueldosBase.tsx`, `TabEmpleados.tsx`, `helpers.ts`, `RRHH.tsx`, `RRHHLegajo.tsx`, `src/types/rrhh.ts`, migraciones `20260414_usuarios_rrhh`, `202605213200_novedades_quincenales`, `202605302330_adelantos_auto_aplicar`, `202606072100/202606072300_pagar_sueldo`, `202606092200_liquidacion_final_multi_cuenta`, `202605223600_pagar_aguinaldo_vacaciones`, `202605204100_empleados_multilocal`, `202605282000_v2_rrhh_eventos_calendars`, spec `2026-05-28-rrhh-rediseno-design.md`

---

## 1. Cómo funciona hoy (el mapa en 1 minuto)

El módulo gira alrededor de **un slot por empleado por mes**:

1. **Empleado** (`rrhh_empleados`): un solo número de sueldo (`sueldo_mensual`) del que deriva todo — día = sueldo/30, hora = sueldo/30/8, día de vacaciones = sueldo/25, quincena = sueldo/2. Modo de pago: MENSUAL, QUINCENAL o SEMANAL. Flag `registrado` (en blanco sí/no) que es **solo informativo** (chip + contador "X sin registrar"). Puede estar asignado a varios locales (tabla m:n con cesiones).
2. **Novedades** (`rrhh_novedades`): UNA fila por empleado × mes × cuota. El quincenal tiene 2 filas (Q1/Q2); el mensual 1. Ahí se cargan faltas, horas extra (pueden ser negativas), dobles, feriados, días de vacaciones, presentismo sí/no, otros descuentos, bono.
3. **Cálculo**: vive en `lib/calculos/rrhh.ts` — funciones puras (entrada → salida, sin tocar la base), **un solo lugar**, con 118 tests unitarios. La pantalla muestra el desglose en vivo con esas mismas funciones.
4. **Flujo de pago** (rediseñado 31-may/04-jun): editás novedades en pantalla (NO se guarda nada mientras tipeás — el autosave se eliminó el 03-jun por los races) → **Confirmar** persiste todo + el plan efectivo/MP → **Pagar** abre modal multi-cuenta (incluso multi-local: el sueldo del administrativo se reparte entre sucursales), con clave de idempotencia anti doble-click, aviso explícito si el pago es parcial, sobrepago permitido (redondeo). La RPC `pagar_sueldo` crea la liquidación + los movimientos de caja en una transacción.
5. **Adelantos** (`rrhh_adelantos`): saldo flotante. Se registran cuando salen de caja y quedan "pendientes" hasta que alguien los **tilda manualmente** en un sueldo. Nunca se pre-tildan ni se descuentan solos (decisión 31-may, después de 2 iteraciones que fallaron).
6. **Anular**: anula movimiento por movimiento (`anular_movimiento` revierte plata, re-habilita adelantos consumidos, baja el aguinaldo acumulado, marca la liquidación pendiente). Re-pagar una liquidación anulada la **revive** (fix 05-jun).
7. **SAC, vacaciones y liquidación final**: flows especiales desde el Legajo (`rrhh_pagos_especiales`). La liquidación final implementa la LCT (Art 245 antigüedad con fracción >3 meses, Art 232 preaviso, Art 233 integración, Art 155 vacaciones no gozadas, SAC sobre cada concepto, doble indemnización, 4 motivos de egreso) y **todas las líneas son editables** antes de pagar.

Y aparte, dormido en producción: el **schema v2 del rediseño** (`rrhh_eventos`, `rrhh_pay_calendars`, `rrhh_liquidaciones_v2`, migración 202605282000) está creado en la base **pero ninguna pantalla productiva lo usa** (cero referencias en `src/` y `api/`). Era para el playground v2 que quedó congelado por decisión del 28-may.

---

## 2. Veredicto por área

### 2.1 Modelo de liquidación (slot mensual por empleado) — ⚠️ Sirve hoy, tiene techo conocido y ya diagnosticado

**Lo que está bien:** para el caso real (mensuales + quincenales conviviendo) el modelo funciona sin hacks. La separación Q1/Q2 como filas independientes con liquidación propia es limpia: sin descuentos cruzados, presentismo diferido a Q2 (correcto: en Q1 todavía no sabés si lo perdió). El constraint de unicidad (empleado × mes × año × cuota) hace imposible duplicar un sueldo.

**Dónde está el techo:**
- **SEMANAL existe en el enum pero está degradado.** Los helpers viejos generaban 4 cuotas; la pantalla nueva (TabSueldos, la que se usa) genera **1 sola cuota** para semanales y los calcula como mensuales (`ct = QUINCENAL ? 2 : 1`; comentario en `helpers.ts:187`: *"no hay semanales hoy en Neko; tratado como mensual"*). Un cliente nuevo con personal semanal hoy no puede operar de verdad.
- **DIARIO no existe.** Ni en el enum ni en la UI. El jornalero (changas, extras de fin de semana, lavacopas por día) es figura común en gastronomía argentina y hoy la única forma de pagarle es un "gasto de empleado" suelto o meterlo como mensual ficticio.
- **El mes calendario es la unidad rígida.** Un período que cruza meses (semana del 29-jun al 5-jul, o quincena comercial 26-al-10) no se puede representar: el slot vive en `(mes, anio)`.
- **No hay fechas dentro del período.** "3 faltas en mayo" sin saber qué días. Para pagar alcanza; para disputar con un empleado, cruzar contra fichaje, o calcular feriados automáticos, no.

**El punto clave:** todo esto ya está diagnosticado en el spec del 28-may, que propone exactamente el modelo correcto (eventos con fecha + calendarios de pago + liquidación que consolida — el patrón de Tango/Gusto/Toast). El spec quedó ~95% sin implementar: solo se aplicó la Fase 0 (crear tablas vacías). **El modelo slot está 100% vivo y es el único real.**

### 2.2 Adelantos — ✅ Robusto por diseño manual (después de 3 iteraciones)

La historia es instructiva: primero se descontaban automático por rango de fechas (bug Anto 29-may: pagar abril restaba un adelanto de mayo), después se agregó el flag `auto_aplicar` (30-may), y finalmente se decidió **todo manual** (31-may): los adelantos pendientes aparecen como checkboxes en cada sueldo, con indicador de si caen dentro del período, y el humano decide cuál aplicar a cuál pago. Cross-quincena y cross-mes quedan resueltos **por diseño**, no por reglas frágiles de fechas — un adelanto de mayo se puede descontar en junio sin pelear con el sistema.

El doble conteo (el adelanto restado del total Y sumado como pago — caso Esteban) se cerró el 07-jun y quedó alineado con el trigger que re-deriva `pagos_realizados` desde los movimientos.

**Lo que falta (menor):** no hay alarma de adelantos viejos sin descontar. Si Anto se olvida de tildar, el adelanto queda flotando para siempre y nadie lo ve salvo que abra la card del empleado. Un contador "adelantos pendientes > 60 días" en el dashboard cierra el loop.

### 2.3 SAC / vacaciones / liquidación final — ⚠️ Cálculo centralizado y testeado (muy bien), pero con dos verdades de SAC y confianza ciega en el cliente

**Lo muy bueno:** toda la matemática vive en UN archivo de funciones puras con 118 tests. La liquidación final es de lo mejor del módulo: implementa la LCT con criterio (años indemnizatorios con fracción >3 meses, preaviso escalonado, integración del mes, SAC sobre cada concepto, mejor sueldo del semestre con historial Art 122), muestra el desglose línea por línea y **deja editar cada número** antes de pagar — eso es auditable: podés explicar de dónde salió cada peso y corregir lo que la realidad diga distinto.

**Los dos problemas de diseño:**

1. **El SAC tiene dos fuentes de verdad.** Existe la columna `aguinaldo_acumulado` (cada pago de sueldo le suma subtotal2/12, anular se lo resta, pagar aguinaldo la resetea a 0) **y** existe el cálculo teórico `calcularSACMejorSueldo` (mejor sueldo del semestre × meses trabajados), que es el que el Legajo muestra y usa como monto esperado. La columna acumulada **ya no se muestra en ninguna pantalla** pero se sigue manteniendo con lógica en 4+ RPCs — y esa lógica ya generó varios bugs (revert con código muerto, base neta vs bruta). Mantener actualizado un número que nadie mira es puro riesgo sin beneficio.

2. **El backend confía en el cálculo del frontend.** `pagar_sueldo` recibe `p_calc` (el desglose ya calculado) y lo guarda tal cual; `liquidacion_final_empleado` recibe `p_total` y registra el pago sin recalcular nada. Hoy, con un solo cliente confiable (Anto), funciona. Pero significa que: (a) un bug de JavaScript escribe números incorrectos en la base sin que nada lo frene, y (b) cualquier usuario autenticado puede llamar la RPC con números inventados. La base guarda el snapshot (auditable hacia atrás) pero **no puede re-derivar ni validar** el número. Los sistemas serios calculan server-side o al menos validan que el snapshot sea coherente con la novedad + el sueldo vigente.

**Matiz legal (consciente, OK):** las vacaciones se acumulan "por goteo mensual" (días/12 por mes trabajado). La LCT real otorga el derecho completo por año calendario con corte al 31-dic. Para gestión interna informal el goteo es más justo y más simple — decisión razonable, pero si algún día se emiten recibos legales hay que revisarlo.

### 2.4 Flujo Confirmar → Pagar → Anular → Revivir — ✅ Simple y honesto (2 pasos), con un estado que se deduce de 3 lugares

El flujo quedó bien después del refactor del 03-jun: editás (solo en pantalla) → Confirmar (guarda y bloquea, con plan efectivo/MP para saber cuánto separar) → Pagar (multi-cuenta, parcial con aviso, sobrepago permitido). Dos pasos, cada uno con un significado claro. Eliminar el autosave fue la decisión correcta: "se guarda cuando pongo confirmar" es un modelo mental que cualquier usuario entiende, y mató una familia entera de races.

El ciclo anular→editar→re-pagar también cierra bien: si tocás "Modificar" sobre un sueldo pagado, el sistema te frena y ofrece anular el pago primero (sprint anti-huérfanos 09-jun) — nunca quedan movimientos colgados.

**La grieta de diseño:** el "estado" de un sueldo no existe como dato único — se **deduce** combinando `rrhh_novedades.estado` (borrador/confirmado), `rrhh_liquidaciones.estado` (pendiente/pagado), `pagos_realizados > 0` y `anulado`. TabSueldos tiene 2.145 líneas y buena parte es lógica para reconciliar esas 3 fuentes (más los fixes de data-loss que esa complejidad generó en junio). El spec v2 ya proponía la solución: una máquina de estados explícita (ABIERTA → EN_REVISION → PAGADA → ANULADA) en una sola columna. Cada bug de "se borró lo que cargué" / "quedó trabada la quincena" de las últimas semanas es síntoma de esto.

### 2.5 Turnos, horarios y fichaje — 🔴 No existe nada, y el modelo actual NO lo puede absorber

No hay scheduling (quién trabaja qué día), no hay fichaje (a qué hora entró), no hay control de horas. El labor cost del EERR sale de sueldos pagados, no de horas trabajadas.

Esto importa por dos razones:
1. **Competitivamente**, el combo turnos+fichaje+nómina es el corazón de Deputy/7shifts/Toast: armás la grilla semanal, el empleado ficha, las horas caen solas a la liquidación. Para un gastronómico con 15+ empleados rotativos es el dolor #1, incluso antes que la liquidación.
2. **Arquitecturalmente**, el slot mensual no puede absorberlo: una fichada es un evento con fecha y hora, y el slot es una bolsa mensual sin días. El modelo de eventos del spec v2 **sí** lo absorbe (ya reserva `origen='FICHERO'` y `fichada_raw_id`). Conclusión: el fichaje no es una feature que se agrega encima del modelo actual — es LA razón para migrar de modelo.

### 2.6 Realidad argentina (informales, en blanco parcial, monotributistas) — ✅ Maneja lo informal con dignidad; ⚠️ no modela los matices

**Lo bueno:** el sistema asume sin vergüenza que se paga en mano. Todos los montos son "lo que recibe el empleado", el flag `registrado` da visibilidad ("8 de 14 sin registrar") sin bloquear nada ni juzgar, el recibo imprimible es interno y simple. Para el gastronómico promedio argentino esto es exactamente la herramienta que usa en la práctica (la planilla Excel, pero con caja integrada y auditoría). Mejor decisión imposible para esta etapa.

**Los matices que NO se pueden representar hoy:**
- **"Parte en blanco, parte en negro"** — el caso MÁS común en gastronomía AR (básico de convenio registrado + diferencia en mano). Hay UN solo `sueldo_mensual`. No se puede separar, así que recibo legal, SAC formal vs real, y costo laboral verdadero (cargas sobre la parte registrada) son imposibles de derivar.
- **Monotributista que factura** (el contador externo, el DJ, el delivery propio) — no existe como categoría. Hoy o es empleado ficticio o es un gasto suelto.
- **El costo del empleador no existe**: para un registrado, el costo real es sueldo + ~26-30% de cargas + ART. El EERR muestra sueldos pagados como labor cost, que para empleados en blanco subestima el costo real.

Con facturación ARCA volviéndose obligatoria (ago-2026, según el análisis de competencia), la presión de formalización sobre los clientes va a crecer — y la distinción registrado/informal va a pasar de chip informativo a requisito de cálculo.

---

## 3. Decisiones a cambiar AHORA (porque después salen caras)

Orden por urgencia:

**1. Resolver el limbo del schema v2 (decisión, no código).** Las tablas `rrhh_eventos`/`rrhh_pay_calendars`/`rrhh_liquidaciones_v2` están en producción vacías y sin uso. Cada feature nueva construida sobre el modelo slot (recibos, planes de pago, planilla, bonos — todo junio fue eso) agranda el costo del cutover futuro. Opciones: (a) comprometerse a ejecutar la Fase 1 del spec en el próximo trimestre, o (b) borrar las tablas v2 y aceptar el slot como modelo definitivo. Lo que no conviene es el medio: dos schemas, uno real y uno fantasma. **Mi lectura: si MESA y el piloto COMANDA vienen primero, elegir (a) pero con fecha; el fichaje y los semanales/diarios van a forzar la migración igual — cuanto más tarde, más datos y más features que migrar.**

**2. Validar el cálculo server-side antes de tener clientes externos.** Hoy `pagar_sueldo` y `liquidacion_final_empleado` guardan lo que el cliente manda. Mínimo viable barato: que la RPC recalcule el total desde la novedad + sueldo vigente y rechace si difiere en más de $1 del `p_calc` recibido (la fórmula ya existe, es portarla a SQL una vez). Esto convierte cada bug futuro de frontend en un error visible en vez de datos corruptos silenciosos. Con multi-tenant real es además una cuestión de seguridad.

**3. Matar la columna `aguinaldo_acumulado` (o convertirla en la única verdad).** Mantener un acumulador que nadie mira, con lógica de suma/resta/reset repartida en 4 RPCs que ya falló varias veces, es deuda pura. Si el SAC esperado se calcula teórico (como hoy en Legajo), la columna sobra: eliminarla simplifica `pagar_sueldo`, `anular_movimiento` y el revive.

**4. Separar el concepto "remuneración" antes de sumar clientes.** Aunque no se implemente la UI todavía, agregar `sueldo_registrado` / `sueldo_informal` (o una mini-tabla de componentes de sueldo) cuesta poco hoy y evita re-cablear el cálculo, el historial de sueldos, los recibos y el EERR cuando el primer cliente pida "el recibo legal por la parte en blanco". Es la diferencia entre PASE-para-Neko y PASE-vendible.

**5. Parametrizar lo que hoy es ley-hardcodeada.** Presentismo 5%, divisores /30, /25, escala de vacaciones 14/21/28/35: están en código. Para Neko da igual; para vender, cada CCT/acuerdo cambia los valores (gastronómicos UTHGRA vs comercio vs acuerdo de palabra). Una tabla `rrhh_parametros` por tenant con defaults actuales es barata ahora y carísima después (cada número hardcodeado se usa en cálculo + tests + recibos).

**Y una que NO cambiaría:** el flujo manual Confirmar→Pagar con adelantos a checkbox. Es menos "mágico" que el auto-descuento, pero después de 3 iteraciones quedó claro que en plata informal el humano tiene contexto que el sistema no tiene. No automatizar esto fue aprendizaje ganado, no falta de ambición.

---

## 4. Comparación con el estándar del mercado

| Dimensión | PASE hoy | Gusto (US) | Deputy / 7shifts | Toast Payroll | Tango/Bejerman (AR) |
|---|---|---|---|---|---|
| Unidad de liquidación | Slot mensual por empleado | Pay run por pay schedule (eventos) | n/a (turnos) | Pay run integrado al POS | Período + conceptos parametrizables |
| Frecuencias de pago | Mensual + quincenal reales; semanal degradado; diario no existe | Cualquiera, por empleado | n/a | Semanal/bisemanal nativas | Cualquiera |
| Dónde vive el cálculo | Frontend (funciones puras testeadas); backend confía | Server, con compliance automático | n/a | Server | Server (motor de fórmulas) |
| Turnos + fichaje | No existe | No (se integra) | **Es el producto** | Nativo (del POS) | Módulo aparte |
| Horas → liquidación | Manual (Anto tipea) | Importa de timesheets | Exporta a payroll | Automático | Importa de reloj |
| Informalidad AR | ✅ Primera clase (única de la tabla) | No aplica | No aplica | No aplica | Solo formal |
| Liquidación final LCT | ✅ Completa y editable | n/a | n/a | n/a | ✅ |
| Recibo legal / F.931 / libro sueldos | No (recibo interno) | Automático (US) | n/a | Automático (US) | ✅ Core |
| Auditoría del pago | ✅ Snapshot + movimientos + anular reversible | ✅ | n/a | ✅ | ✅ |

**Síntesis:** PASE está fuerte donde los demás no juegan (informalidad argentina, integración con caja propia, liquidación final LCT editable) y débil donde los demás son fuertes (frecuencias de pago flexibles, turnos+fichaje, cálculo server-side, parametrización por convenio). El spec del 28-may es precisamente el puente entre los dos mundos — está bien diseñado, solo está pausado.
