# Análisis de lógica — Finanzas, Caja y EERR (PASE)

**Fecha:** 2026-06-11
**Tipo:** auditoría de arquitectura de producto (decisiones de diseño, no bugs)
**Alcance:** Caja/Tesorería, Gastos, Ventas (carga diaria), EERR/Reportes, Conciliación MP, pantalla Negocio
**Archivos leídos:** `CONTEXTO.md`, `Caja.tsx`, `Gastos.tsx`, `Ventas.tsx`, `EERR.tsx`, `Negocio.tsx`, `ConciliacionMP.tsx`, `Compras.tsx`, `PuntoEquilibrioWidget.tsx`, migración `202605234500_trigger_sync_saldos_caja.sql`, spec `2026-05-28-caja-finanzas-pl-rediseno.md`

---

## 1. Cómo funciona hoy (el mapa en 1 minuto)

PASE tiene **dos miradas sobre la plata**, bien separadas:

1. **La plata que tenés (percibido)** → tabla `movimientos` (el "libro diario": cada entrada/salida de cada cuenta) + `saldos_caja` (el saldo de cada cuenta, que desde el 23-may se calcula **automáticamente** sumando los movimientos — un trigger en la base lo mantiene siempre sincronizado). Pantalla: **Caja**.
2. **La plata que ganaste (devengado)** → tablas `ventas` + `facturas` + `gastos` + `rrhh_liquidaciones`, leídas por fecha del hecho económico (cuándo vendiste/compraste, no cuándo cobraste/pagaste). Pantalla: **Reportes (EERR)**.

El flujo diario del dueño:
- **Ventas**: carga el cierre del día/turno con el desglose por forma de cobro. Solo el efectivo genera movimiento automático en Caja (a Caja Chica). Las tarjetas/MP/Rappi se reflejan en Caja recién cuando el usuario carga a mano el ingreso "Liquidación Rappi/MP/..." al cobrarlas.
- **Gastos**: 1 modal, ~6 campos (fecha, local, tipo, categoría, monto, cuenta). RPC atómica `crear_gasto` inserta el gasto + el movimiento + actualiza saldo, todo o nada.
- **Compras**: facturas (con IVA, ítems, estado pendiente/pagada) y remitos (mercadería que llega sin factura, se paga o se vincula después). Pagar genera movimiento.
- **Conciliación MP**: sync automático cada 30 min; cada movimiento de MP se "justifica" contra una factura/gasto/movimiento (comisiones, retiros, multi-factura).
- **EERR**: Ventas − CMV = Utilidad Bruta − (fijos, variables, sueldos, publicidad, comisiones, impuestos) = Utilidad Neta. Todo con % sobre ventas, KPIs de CMV y Labor Cost arriba, comparación entre meses, retiros de socios mostrados DESPUÉS de la utilidad (correcto: son distribución, no gasto).
- **Negocio**: vista de dirección honesta a mitad de mes (ventas 7 días, objetivo, punto de equilibrio, tendencia, ranking sucursales). Deliberadamente NO muestra margen mid-month porque los fijos caen los primeros 15 días y distorsionan. Buena decisión.

---

## 2. Veredicto por área

### 2.1 Ledger `movimientos` + cache `saldos_caja` — ✅ El patrón correcto

Es exactamente lo que hacen Square, Toast y QuickBooks: el libro diario es la autoridad, el saldo es un número derivado que se recalcula solo. Desde la migración del 23-may, **cualquier** escritura sobre `movimientos` (incluso un script o SQL a mano) re-sincroniza el saldo — ya no puede desfasarse en silencio como pasó antes (9 desfases por ~$54M acumulados pre-fix).

Bien resuelto además: anular no borra (marca `anulado` + motivo), editar deja auditoría con "antes/después + justificativo", cada movimiento generado por RPC guarda el vínculo duro a su factura/gasto/liquidación (`fact_id`, `gasto_id_ref`, etc.), y hay idempotency keys contra el doble click.

**Lo que queda flojo (menor):**
- En `Ventas.tsx`, editar fecha/turno/medio/local de una venta es un UPDATE directo (deuda C4 documentada). El monto va por RPC, pero si movés una venta de local con el UPDATE directo, el movimiento de efectivo asociado **no se mueve con ella** → la venta queda en un local y su plata en otro. Es un caso raro pero es la única puerta que quedó abierta.
- El chequeo `SALDO_INSUFICIENTE` quedó como validación a posteriori (el trigger ya aplicó el cambio cuando se chequea). Para gastronomía está bien permitir saldo negativo (la realidad manda), pero es bueno saber que el "tope" es blando por diseño.

### 2.2 Devengado (EERR) vs percibido (Caja) — ⚠️ Conceptualmente limpio, operativamente exigente

La separación es **correcta y es la que usan los sistemas pro**: Toast/R365 reportan el P&L en base devengada y la caja por separado; nadie mezcla. Y es explicable en una frase: *"Reportes te dice si el negocio gana plata; Caja te dice cuánta plata tenés hoy. No coinciden día a día porque Rappi te paga a los 10 días."* Eso un dueño lo entiende.

El problema no es el concepto, es **dónde cae el trabajo**:
- Cada liquidación de Rappi/MP/Peya/tarjetas hay que cargarla **a mano** en Caja con la categoría correcta. Eso es tarea de contador interno, no de dueño de restaurante. Si se olvida, la Caja queda incompleta; si la carga mal (como venta en vez de "Liquidación"), **cuenta la venta dos veces en el EERR**. Hoy la única defensa contra ese doble conteo es un tooltip y la documentación. Los sistemas pro generan el "por cobrar" automáticamente desde la venta (vendiste $100k con tarjeta → el sistema ya sabe que te deben $100k y solo te pide confirmar cuando llega el depósito). PASE tuvo ese panel ("Por cobrar" del Cashflow) y se eliminó en mayo — la conciliación MP cubre solo MP.
- El mismo nombre "Ingresos" significa cosas distintas en las dos pantallas. Para Lucas hoy está internalizado; para un cliente nuevo el día 1, no.

**Veredicto:** la arquitectura contable es sana. Falta la capa que haga el trabajo repetitivo por el usuario.

### 2.3 Ventas PASE vs ventas COMANDA — 🔴 Doble fuente de verdad sin puente

Este es el hallazgo más importante del informe.

- La tabla `ventas` de PASE son **totales de cierre cargados a mano** (o importados de Maxirest).
- COMANDA escribe sus ventas reales, línea por línea, en `ventas_pos`.
- **PASE no lee `ventas_pos` en ningún lado** (verificado: cero referencias en `packages/pase/src`). El EERR, el BEP, los widgets de Negocio, los objetivos — todo lee `ventas`.

Consecuencia: el día que un cliente use COMANDA como POS (el piloto está cerca), tiene dos opciones igual de malas: re-tipear el cierre en PASE todas las noches (doble carga, números que divergen, el bloqueo anti-duplicados de Ventas se lo va a complicar), o no cargar nada y que el EERR muestre ventas en cero. El diseño actual **no contempla la transición** — está anotada como pendiente en memoria, pero no hay ni un esqueleto de puente.

Esto es exactamente lo que Toast resuelve por definición (el POS *es* la fuente de ventas del P&L) y lo que R365/MarginEdge resuelven con integración POS automática el día 1. Es además **el diferencial que ustedes mismos declararon** para MESA y para los widgets pendientes.

**Por qué cambiarlo AHORA:** cada semana que COMANDA opere sin puente genera datos duplicados o huecos que después hay que migrar/reconciliar a mano. El fix es barato hoy: una proyección automática (trigger o job al cierre de turno) que materialice los totales de `ventas_pos` como filas en `ventas` con `origen='comanda'`, reusando el campo `origen` que ya existe (Maxirest ya usa ese patrón). La carga manual queda como fallback para locales sin COMANDA. Costo estimado: días. Costo en 6 meses: migración de histórico + clientes confundidos.

### 2.4 Gastos vs Facturas vs Remitos — ⚠️ Modelo correcto, puerta de entrada confusa

El modelo de 3 conceptos es el estándar de cuentas a pagar (R365/MarketMan tienen lo mismo: expense / invoice / receiving). No sobra ninguno. Pero el día 1, un dueño con un ticket de la verdulería en la mano enfrenta la pregunta *"¿esto va en Gastos o en Compras?"* y el sistema no lo guía: son dos pantallas distintas del menú, sin una regla visible tipo **"¿te dieron factura de proveedor? → Compras. ¿Es un gasto del local (luz, sueldo de la señora de la limpieza, nafta)? → Gastos"**.

- Registrar una compra simple por Gastos: 1 modal, ~6 campos, RPC atómica. **Bien** — está dentro del estándar.
- Pero el modal pide **tipo Y categoría**, cuando el tipo se deriva de la categoría (la RPC ya lo hace server-side — `CONTEXTO.md` lo documenta). Es un campo redundante que además permite inconsistencias (elegir tipo "fijo" con una categoría variable).
- La factura completa pide más (proveedor, nro, neto/IVA, ítems opcionales) — correcto para lo que es, y el lector IA + la bandeja de conciliación (Pieza A) ya amortiguan la carga.

### 2.5 Plan de cuentas implícito (`config_categorias`) — ✅ genérico / ⚠️ impuestos AR superficial

Los grupos (CMV / Fijos / Variables / Publicidad / Comisiones / Impuestos / Juicios / Retiros / INGRESOS) son un plan de cuentas gastronómico razonable y **genérico**: le sirve a cualquier restaurante sin tocar nada, y las categorías dentro de cada grupo son editables por tenant. Decisiones finas que están bien tomadas: comisiones separadas de variables (Rappi/MP son el gasto que más crece), retiros de socios fuera del resultado operativo, juicios como grupo propio.

Lo flojo para AR:
- "Impuestos" es una bolsa única: mezcla IIBB (que sí es un costo) con conceptos tipo IVA (que es un crédito/débito fiscal, no un gasto). Para el dueño da igual; para el contador y para la facturación ARCA obligatoria de agosto 2026, no.
- No hay modelo de **percepciones/retenciones** (SICORE, IIBB multi-jurisdicción, percepciones de proveedores en factura). Las facturas guardan neto/iva21/iva105/iibb pero no hay Libro IVA ni posición fiscal. Hoy no duele; cuando vendan a un cliente con contador exigente, sí. No hace falta construirlo ya — hace falta **no cerrarse la puerta**: que las facturas sigan guardando el desglose fiscal completo (lo hacen) y que "Impuestos" del EERR no sea la única clasificación fiscal posible.

### 2.6 Formato del EERR — ✅ ya es restaurantero / ⚠️ con dos sesgos de lógica

Buena noticia: el EERR actual **no es un balance de contador**. Es Ventas → CMV → Utilidad Bruta → gastos por bucket → Utilidad Neta, todo con % sobre ventas, KPIs de CMV% y Labor Cost% arriba de todo, desglose por forma de cobro y comparación entre meses. Eso es el 80% del P&L restaurantero del spec del 28-may. Lo que falta del spec es la capa analítica (ver §4).

Lo que falta y es **una línea de código**: el KPI **Prime Cost (CMV + Sueldos)**, el número #1 de la industria (target <60%). Ya están las dos sumas en pantalla; falta sumarlas y pintarle un semáforo.

Los dos sesgos de lógica (estos sí son decisiones de diseño cuestionables):

1. **Sueldos por `calculado_at`, no por período trabajado.** El EERR filtra liquidaciones por la fecha en que se *calcularon*. Si los sueldos de mayo se liquidan el 4 de junio (lo normal), caen en el EERR de **junio**. El sistema dice "devengado" pero acá usa fecha de carga. La tabla `rrhh_novedades` ya tiene `mes`/`anio` — el dato correcto existe, solo no se usa para esto. Resultado: todos los meses arrastran el labor cost corrido un mes, y un mes con dos quincenas calculadas adentro muestra labor doble.
2. **"CMV" en realidad es "Compras del mes".** El EERR suma facturas de mercadería por fecha de factura, sin ajustar por inventario (stock inicial + compras − stock final). Un mes donde stockeaste freezer parece desastroso; el siguiente parece gloria. MarginEdge y R365 hacen el CMV ajustado por conteos — y PASE **ya tiene los conteos ciegos** (Pieza C del circuito, Stock.tsx). Mientras no se conecte, la etiqueta honesta sería "Compras de mercadería", no "CMV".

### 2.7 Multi-local y consolidación — ⚠️ suma bien, con dos agujeros conocibles

- La vista consolidada (sin local activo) suma todos los locales; las **transferencias cross-local** existen como RPC desde el 22-may y generan los 2 movimientos espejo → en el consolidado netean a cero. Correcto.
- **Agujero 1 — gastos compartidos:** un gasto con `local_id NULL` ("de todos") **desaparece de la vista por-local** del EERR (el filtro hace `eq(local_id, X)` y NULL no matchea). No existe mecanismo de prorrateo (el spec del 28-may lo lista como pendiente: "distribución de gastos compartidos"). Hoy el contador de Lucas lo sabe; un cliente con 2 locales va a comparar sucursales con números que no incluyen la publicidad central ni el software, y la comparativa miente a favor de todos.
- **Agujero 2 — empleados multi-local:** el labor cost del EERR atribuye cada liquidación al `local_id` del empleado. Con las cesiones entre locales que ya existen en RRHH, un empleado que trabajó medio mes prestado a otra sucursal carga el 100% de su sueldo a su local principal.

### 2.8 Spec 28-may (Prime Cost / DSR / P&L): qué existe vs qué sigue pendiente

| Pieza del spec | Estado real hoy |
|---|---|
| P&L con % sobre ventas y comparativo de meses | ✅ existe (EERR.tsx, formato ya restaurantero) |
| Prime Cost KPI | ❌ no existe (las 2 sumas sí; falta la línea) |
| DSR (cierre de día firmado) | ❌ no existe en PASE (COMANDA tiene cierre de turno; no se consolida como reporte firmable) |
| Cash flow forecast 30 días | ❌ no existe |
| Anomaly detection | ❌ no existe (hay alertas puntuales en Rentabilidad/TabAlertas) |
| Menu engineering | ❌ no existe (los datos — costo por receta + ventas por ítem — ya existen desde Piezas B/C) |
| Conciliación bancaria con auto-match | ⚠️ parcial (ConciliacionBancaria/Extracto manuales; MP sí tiene flujo maduro con justificativos) |
| Conteo ciego de caja | ✅ existe para stock (Stock.tsx); el de efectivo vive en cierre de turno COMANDA |
| Multi-local roll-up comparativo | ⚠️ parcial (ranking de sucursales en Negocio; sin Prime Cost por local) |
| Gastos recurrentes marcados | ⚠️ parcial (existen plantillas de gastos; no flag `recurrente` para forecast) |

---

## 3. Decisiones a cambiar AHORA (porque después son caras)

Ordenadas por costo-de-esperar:

1. **Puente COMANDA → `ventas` (la #1, lejos).** Proyección automática de `ventas_pos` a filas `ventas` con `origen='comanda'` al cierre de turno. Sin esto, el piloto de COMANDA genera doble carga o EERR en cero, y cada semana de datos divergentes encarece la migración. Todo lo demás del sistema financiero (EERR, BEP, objetivos, Negocio) sigue funcionando sin tocarse porque lee `ventas`.
2. **Sueldos del EERR por período trabajado** (`mes`/`anio` de la novedad), no por `calculado_at`. Es un WHERE distinto. Cuanto más histórico se acumule con el criterio actual, más raro va a ser el salto el día que se corrija.
3. **Decidir la semántica de gastos compartidos multi-local** antes de vender a un cliente con 2+ locales: o se prohíbe `local_id NULL` en gastos (forzar elegir local), o se agrega prorrateo simple (% fijo por local). Lo barato hoy es al menos **mostrarlos** en la vista por-local como línea "Gastos centrales (sin asignar)".
4. **Renombrar "CMV" → "Compras de mercadería"** en el EERR hasta que se conecte el ajuste por inventario (los conteos ya existen). Mentirle al usuario con la palabra CMV es deuda de confianza; el día que el CMV real difiera de "compras", nadie va a entender cuál creer.
5. **Cerrar la edición de ventas con RPC completa** (`editar_venta_completa` que mueva también el movimiento de efectivo al cambiar local/fecha). Es la última escritura directa del circuito de plata.

## 4. Pasos a ahorrar (fricción del día a día)

- **Sacar el dropdown "Tipo" del modal de Gastos** — derivarlo de la categoría (la RPC ya lo hace). Un campo menos, una inconsistencia imposible.
- **Generar el "por cobrar" automático**: al cargar venta con medio no-efectivo, crear la expectativa de cobro; cuando llega la liquidación, el usuario **confirma** en vez de acordarse de cargar. Mata el riesgo de doble conteo del §2.2 y devuelve (mejor) lo que el Cashflow eliminado hacía.
- **Prime Cost en el EERR y en Negocio**: una suma + un semáforo. Máximo retorno por línea de código de todo este informe.
- **Guía de 1 línea en la UI**: "¿Factura de proveedor? → Compras · ¿Gasto del local? → Gastos" en ambas pantallas.

## 5. Comparación con el estándar (R365 / Toast / MarginEdge)

| Dimensión | Estándar pro | PASE hoy |
|---|---|---|
| Ledger inmutable + saldo derivado | Square/Toast/QuickBooks | ✅ igual (desde 23-may) |
| Ventas al P&L | El POS alimenta solo (Toast) o integración día 1 (R365/MarginEdge) | 🔴 carga manual; COMANDA no conectado |
| P&L devengado separado de caja | Sí, siempre | ✅ igual, bien documentado |
| Prime Cost como KPI #1 | Toast/R365/MarginEdge lo ponen primero | ❌ falta (trivial de agregar) |
| CMV ajustado por inventario | MarginEdge/R365 (conteos → COGS real) | ⚠️ CMV = compras; conteos ya existen sin conectar |
| Captura de facturas → categorías | MarginEdge (foto → línea → categoría con memoria) | ✅ equivalente (lector IA + bandeja conciliación con memoria) |
| Conciliación de plataformas | Auto-match de depósitos | ⚠️ MP maduro; resto manual |
| Multi-local con gastos centrales prorrateados | R365 (allocations) | ❌ gastos NULL invisibles por-local |
| Caja multi-cuenta con auditoría de ediciones | Pocos lo tienen tan fino | ✅ por encima del estándar |

**Síntesis:** la fundación contable de PASE (ledger, atomicidad, devengado/percibido, auditoría) está al nivel — o por encima — de lo que un gastronómico consigue con herramientas pro. Los gaps no son de plomería sino de **tres decisiones de producto**: conectar el POS propio a su propio P&L, dejar de pedirle al dueño trabajo de contador (liquidaciones a mano, tipo+categoría), y que los dos números que definen el negocio (labor y CMV) midan lo que dicen medir.
