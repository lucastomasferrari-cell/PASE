# Back-office gastronómico profesional: lógica de funcionamiento de los líderes

**Investigación: junio 2026.** Sistemas analizados: Restaurant365 (R365), MarketMan, MarginEdge, Apicbase, xtraCHEF/Toast, con referencias a Crunchtime y meez donde aportan lógica. Foco: NO features ni precios — **cómo modelan los datos y los workflows que hacen que funcionen (o fracasen) en la operación real**.

---

## 1. El flujo invoice → inventory → recipe cost → COGS

### 1.1 El modelo de unidades: el corazón (y el talón de Aquiles) de todos

Todos los líderes convergen en el mismo modelo de **3-4 unidades por ítem**:

| Unidad | Para qué | Ejemplo |
|---|---|---|
| **Purchase UoM** | Cómo lo entrega el proveedor | Caja de 6 botellas |
| **Inventory/Count UoM** | Cómo se cuenta en el conteo (puede haber varias: caja + botella suelta) | Botella, caja |
| **Recipe UoM** | Cómo se usa en la receta | Onza / ml / gramo |
| **Reporting UoM** | Unidad estándar para comparar entre locales (R365) | Libra / kg |

**R365** lo modela con rigor de ERP: cada Purchased Item recibe un **Measure Type inmutable** al crearse (Weight / Volume / Each), y los selectores de unidad quedan **bloqueados a ese Measure Type** salvo que se definan "Measurement Conversions" explícitas por ítem (ej.: 1 balde de 5 galones = 20 libras = 80 pepinos). Sin conversión definida, no podés asignar una unidad de peso a un ítem de volumen — el sistema lo prohíbe ([R365 docs — Unit of Measure Conversions](https://docs.restaurant365.com/docs/unit-of-measure-conversions), [R365 — Unit of Measure](https://docs.restaurant365.com/docs/unit-of-measure)).

**Dónde se quejan los usuarios** (patrón transversal):
- El conflicto clásico EACH vs OUNCE: el ingrediente está en onzas pero el proveedor factura "EACH" y el sistema no puede convertir sin que alguien defina la equivalencia a mano ([Bar & Restaurant — problem units](https://www.barandrestaurant.com/operations/how-deal-problem-units-food-inventory-control)).
- El caso documentado por R365 en su propia guía de troubleshooting: una factura de mozzarella cargada como "41.25 CASES" cuando debía ser libras **distorsionó costo unitario Y cantidad de uso** hasta que alguien la corrigió — un solo error de UoM contamina el AvT entero ([R365 docs — AvT Troubleshooting](https://docs.restaurant365.com/docs/actual-vs-theoretical-analysis-troubleshooting-variances)).
- Consejo de consultores: para ítems de peso variable (cajón de pollo), fijar un **peso promedio típico** y ajustarlo periódicamente, en vez de convertir en cada factura; y normalizar todo a UNA unidad base en el backend del reporting ([Bar & Restaurant](https://www.barandrestaurant.com/operations/how-deal-problem-units-food-inventory-control)).

**MarginEdge** toma el camino opuesto al rigor: "contá en la unidad que quieras, nosotros hacemos la matemática de conversión" — el staff cuenta en múltiples unidades y el sistema resuelve ([MarginEdge — Onboarding Inventory](https://www.marginedge.com/ob-inventory)). Menos control, mucha menos fricción.

### 1.2 Yield / rendimiento: AP vs EP + pérdida de cocción

La matemática estándar de la industria (enseñada por el CIA y usada por todos):

- **AP (As Purchased)** = peso/costo tal como llega del proveedor. **EP (Edible Portion)** = peso después de limpiar/deshuesar/pelar.
- **Yield % = EP ÷ AP × 100** (ej. lomo de res: 94.7 ÷ 129 = 73.4%).
- **El costo que va a la receta es el EP cost: EP Cost = AP Cost ÷ Yield %** ([Recipe Costing — What is Yield](https://www.recipe-costing.com/blog/what-is-yield-and-how-to-calculate-it/), [CIA — Kitchen Calculations](https://www.ciachef.edu/wp-content/uploads/2024/07/kitchen-calculations.pdf), [meez — never assume 100% yield](https://www.getmeez.com/blog/never-assume-100-ingredient-yield)).
- La **pérdida de cocción es un segundo yield separado** del trim: ocurre después de limpiar, al aplicar calor (merma de humedad) ([meez — yield in cooking](https://www.getmeez.com/blog/the-benefits-of-yield-testing-in-cooking)).

**Apicbase** lo modela como yield % por ingrediente dentro de la receta: costo = (cantidad usada × precio unitario) ÷ yield %, sumado por ingrediente y dividido por porciones ([Apicbase — Recipe Costing](https://get.apicbase.com/recipe-costing/)). Para el precio usa por defecto **el paquete más barato entre proveedores**, configurable a "último paquete pedido" por outlet ([Apicbase support — food cost calculation](https://support.apicbase.com/help/food-cost-calculation)).

**El problema real según meez**: la mayoría de las operaciones "adivinan los yields, usan el default que el software populó hace años, o directamente no los cargan" → **el costo teórico queda sistemáticamente subestimado** y el operador cree que su variancia es peor de lo que es (o al revés) ([meez — recipe costing guide](https://www.getmeez.com/blog/a-chefs-guide-to-accurate-recipe-costing)).

### 1.3 El flujo completo factura → COGS

El pipeline canónico que comparten todos:

1. **Factura entra** (foto/email/EDI) → OCR+IA (y en MarginEdge, humanos) extrae líneas.
2. Cada línea se **mapea a un ítem del catálogo** (la primera vez es manual; después el sistema recuerda el mapeo proveedor+SKU→ítem).
3. El precio de la línea **actualiza el último costo** del ítem → **cascada a todas las recetas** que lo usan (recosteo automático).
4. La cantidad recibida **suma al inventario teórico** (ledger).
5. La venta en el POS **descuenta inventario teórico** vía receta (depletion).
6. El conteo físico fija el inventario real → **COGS real = inicial + compras − final**.

xtraCHEF reporta 90-95% de precisión de OCR que mejora a medida que aprende los vendors, y trackea **price trends por ingrediente con alertas cuando un proveedor sube precios sobre un umbral** ([Toast — xtraCHEF](https://pos.toasttab.com/products/xtrachef)). MarginEdge hace lo mismo con revisión humana en 24-48h ([MarginEdge — How it works](https://www.marginedge.com/how-it-works)).

---

## 2. Actual vs Theoretical (AvT): la matemática, la cadencia y por qué se abandona

### 2.1 La matemática exacta

- **Actual usage** ($ por ítem y total): `Inventario inicial + Compras − Inventario final` (por ítem, valorizado al costo vigente) ([MarginEdge — operator's guide to AvT](https://www.marginedge.com/blog/a-restaurant-operators-guide-to-actual-vs-theoretical-food-costs-and-usage)).
- **Theoretical usage**: `Σ (unidades vendidas por ítem de menú × cantidad de cada ingrediente según receta)`, valorizado — asume porciones perfectas, cero desperdicio, cero robo ([R365 — Closing the gap](https://www.restaurant365.com/blog/closing-the-gap-between-actual-and-theoretical-food-costs/)).
- **Variancia = Actual − Theoretical**, expresada en **$ y en puntos de % sobre ventas**. Ejemplo Crunchtime: actual 32.1% − teórico 29.5% = 2.6 pts de variancia ([Crunchtime — Explaining AvT](https://www.crunchtime.com/blog/blog/explaining-actual-vs-theoretical-food-cost-variance)).
- **Detalle de diseño de R365 que vale copiar**: dos columnas — **"Variance"** (antes de descontar waste registrado) y **"Unexplained Variance"** (después de restar los waste logs). Lo que queda sin explicar es lo accionable ([R365 docs — AvT Troubleshooting](https://docs.restaurant365.com/docs/actual-vs-theoretical-analysis-troubleshooting-variances)).

### 2.2 Umbrales y cadencia

- **R365: target de variancia total de Food entre 1.5% y 2.5%** ([R365 — Food Cost Guide](https://www.restaurant365.com/blog/food-cost-guide/)).
- Consultores multi-unidad: **0-2% = control fino, 2-4% = atención, 4%+ = intervención inmediata** ([Over Easy Office — AvT](https://www.overeasyoffice.com/blog/actual-vs-theoretical-food-cost-where-margins-really-disappear)).
- Guías operativas: mantener **±1-2%**, revisar **semanal** con la misma fecha de cierre de semana siempre; "los picos semanales señalan dónde auditar, no dónde entrar en pánico" ([Restaurant Profit Systems — AvT guide](https://www.restaurantsprofitsystems.com/guides/actual-vs-theoretical-food-cost.html)).
- Mnemónico de causas (R365): **WEPT** — Waste, Errors (recepción/conteo/POS), Portioning, Theft ([R365 — Waste and Variance Reporting](https://www.restaurant365.com/blog/restaurant-waste-and-variance-reporting/)).

### 2.3 Cómo se presenta el reporte (workflow R365, 7 pasos)

El troubleshooting oficial de R365 es un embudo: (1) correr AvT **subtotalizado por categoría** para ver dónde está la variancia grande → (2) filtrar la categoría y **ordenar ítems por % de variancia** → (3) expandir la columna Actual Usage para ver la descomposición → (4) drill-down a las facturas → (5) corregir UoM/costo en la factura aprobada → (6) si el actual está bien, validar el lado teórico (recetas incompletas: las alitas estaban en 1 ítem de menú cuando debían estar en 2) → (7) cruzar contra waste logs ([R365 docs](https://docs.restaurant365.com/docs/actual-vs-theoretical-analysis-troubleshooting-variances)). Crunchtime recomienda priorizar **por $ de variancia, no por %** — el ítem con más plata fugada primero ([Crunchtime](https://www.crunchtime.com/blog/blog/explaining-actual-vs-theoretical-food-cost-variance)).

### 2.4 Por qué MUCHOS abandonan el AvT

Esto es lo más valioso de la investigación — las causas raíz documentadas:

1. **El mantenimiento de recetas/precios/pack sizes nunca termina**: "no porque las recetas cambien seguido, sino porque los costos y el packaging de las materias primas pueden cambiar cualquier día" — para muchas cadenas **el esfuerzo supera el beneficio y migran a controles más baratos aunque menos precisos** (conteos de key items) ([Mirus — Food Cost Controls](https://blog.mirus.com/restaurant-food-cost-controls)).
2. **Recipe drift silencioso**: caso documentado — un local de Atlanta usaba una receta de queso distinta a la del libro durante **18 meses** sin que nadie lo notara, porque el primer GM entrenó diferente ([meez — food cost creeping up](https://www.getmeez.com/blog/why-food-cost-is-creeping-up)).
3. **Pérdida de confianza en el dato**: errores de conteo + precios desactualizados + falta de verificación → reportes de variancia no confiables → **el liderazgo deja de mirarlos** ([Over Easy Office](https://www.overeasyoffice.com/blog/actual-vs-theoretical-food-cost-where-margins-really-disappear)).
4. **Falsos positivos por errores de datos** (UoM de factura, receta incompleta, conteo en unidad equivocada): el AvT acusa "robo" cuando en realidad alguien cargó cajas como libras → frustración y abandono ([R365 docs](https://docs.restaurant365.com/docs/actual-vs-theoretical-analysis-troubleshooting-variances)).
5. **Yields no cargados** → teórico sistemáticamente mal ([meez](https://www.getmeez.com/blog/a-chefs-guide-to-accurate-recipe-costing)).

**Conclusión estructural**: el AvT es una cadena con 5 eslabones (facturas al día, catálogo limpio, recetas completas y mapeadas al 100% del POS, conteos disciplinados, waste logs). Si UN eslabón falla, el reporte miente, y un reporte que miente se abandona. Los sistemas que sobreviven son los que **automatizan los eslabones 1-2** (facturas y precios) y **reducen la exigencia de los demás** (key items, no todo el catálogo).

---

## 3. Conteo de inventario: lo que sostiene (o mata) la disciplina

### 3.1 El método profesional

- **Shelf-to-sheet, nunca sheet-to-shelf**: se recorre la estantería y se busca el ítem en la planilla — la dirección inversa garantiza saltearse lo que está en el estante pero no en la lista ([Chefs Resources](https://www.chefs-resources.com/kitchen-management-tools/restaurant-inventory-control/taking-food-inventory/), [Toast — shelf-to-sheet](https://pos.toasttab.com/blog/on-the-line/shelf-to-sheet-inventory-counts)).
- **Planillas por zona física** (cámara de carnes, cámara de lácteos, verduras, seco, prep, freezer, barra), en el **orden físico real del local**, siguiendo siempre el mismo patrón (arriba-abajo, izquierda-derecha) ([Chefs Resources](https://www.chefs-resources.com/kitchen-management-tools/restaurant-inventory-control/taking-food-inventory/)).
- **De a dos**: uno cuenta/pesa, el otro anota en la app; el contador canta producto y cantidad, el anotador repite ([Chefs Resources](https://www.chefs-resources.com/kitchen-management-tools/restaurant-inventory-control/taking-food-inventory/)).
- **Proteínas y caros SIEMPRE por peso**, nunca "por pieza" (las piezas varían: prime ribs de 10-12 lb) ([Chefs Resources](https://www.chefs-resources.com/kitchen-management-tools/restaurant-inventory-control/taking-food-inventory/)).
- **Nunca durante el servicio**: el stock no puede moverse mientras se cuenta ([Chefs Resources](https://www.chefs-resources.com/kitchen-management-tools/restaurant-inventory-control/taking-food-inventory/)).
- **Checklist post-conteo**: verificar que los ceros son ceros reales, spot-check de unidades, revisar cantidades anormalmente grandes, confirmar que las compras nuevas del período se contaron.

### 3.2 Blind vs visible

El blind count (sin mostrar la cantidad teórica esperada) **previene que el empleado "dibuje" el número** y detecta pérdidas reales; el costo es que consume más tiempo y es más tedioso en catálogos grandes ([Megaventory — Blind Count](https://blog.megaventory.com/blind-count-definition-pros-cons-examples/)). Revel lo vende explícitamente como anti-fraude ("prevents employees from fudging the numbers"). En la práctica de los líderes, el blind es el estándar para el conteo formal de cierre de período, y los spot-checks diarios de key items pueden ser visibles.

### 3.3 Frecuencia y partial counts (el patrón de dos niveles)

El consenso de la industria es un **sistema de dos velas**:
- **Diario/por orden**: spot-check de los **5-10 key items más caros** (proteínas, mariscos, top-shelf) — "es más fácil agarrar a alguien de un día para el otro que en una semana entera" ([Supy — Stock Counts 101](https://supy.io/blog/restaurant-inventory-count-accuracy-tips), [MarginEdge — inventory tips](https://www.marginedge.com/blog/top-restaurant-inventory-best-practices)).
- **Semanal**: cycle counts rotando categorías de alto valor (proteínas+lácteos una semana, secos la otra).
- **Mensual**: conteo completo de todo, que es el que valoriza el COGS contable ([Supy](https://supy.io/blog/restaurant-inventory-management-complete-guide), [TouchBistro](https://www.touchbistro.com/blog/restaurant-inventory-best-practices-101/)).

### 3.4 Qué hace que el conteo se sostenga vs se abandone

Se sostiene cuando: la planilla refleja el layout físico real (mantenida al día — MarginEdge agrega ítems nuevos a la planilla **automáticamente** al procesar la factura, eliminando el "write-in" perdido) ([MarginEdge — How it works](https://www.marginedge.com/how-it-works)); el conteo arranca chico (MarginEdge onboardea con **~20 ítems de alto impacto**, no el catálogo entero) ([MarginEdge — Onboarding Inventory](https://www.marginedge.com/ob-inventory)); toma <1 hora; y alguien MIRA el reporte resultante (si el usage report no se usa, el conteo muere). Se abandona cuando: el catálogo tiene duplicados/ítems muertos que ensucian la planilla, las unidades de conteo no coinciden con cómo está el producto en el estante, y los resultados dan variancias absurdas por errores de datos (pérdida de confianza).

---

## 4. Por qué MarketMan tarda 6-12 semanas (y cómo hacer setup en días)

### 4.1 Las causas raíz del setup eterno

MarketMan vende 2-4 semanas para un local; la realidad reportada por usuarios es **6-12 semanas**, y Toast documenta 4-6 ([CheckThat — MarketMan reviews](https://checkthat.ai/brands/marketman/reviews), [Toast — MarketMan integration](https://support.toasttab.com/en/article/Get-Started-with-the-MarketMan-Integration)). Reviews en Capterra califican la carga inicial de "tediosa y abrumadora"; usuarios de Reddit reportan **cientos de horas de carga manual** para menús complejos ([Capterra — MarketMan](https://www.capterra.com/p/136439/Marketman-Restaurant-Inventory/reviews/), [Food AI Daily — MarketMan vs MarginEdge](https://foodaidaily.com/blog/marketman-vs-marginedge-restaurant-inventory-software/)). Las causas raíz, en orden:

1. **Carga del catálogo de ítems por proveedor** (cada ítem: nombre, pack size, unidades, precio) — el grueso de las horas.
2. **Construcción de recetas desde cero** mapeando cada ingrediente al catálogo.
3. **Mapeo POS**: cada botón del POS → receta (sin esto no hay depletion ni teórico).
4. **Configuración de conversiones de unidades** ítem por ítem.
5. **Troubleshooting de integraciones** + entrenamiento del staff.

Agravante: el escaneo de facturas de MarketMan "no funcionaba el 50% de las veces" según un reviewer de G2, con soporte que tardaba días — o sea que la herramienta que debía mantener el catálogo actualizado post-setup tampoco aliviaba ([Food AI Daily](https://foodaidaily.com/blog/marketman-vs-marginedge-restaurant-inventory-software/)). No hay cifras públicas de churn de MarketMan; el proxy son las quejas recurrentes de "cancellation friction" y setup abandonado en reviews ([CheckThat](https://checkthat.ai/brands/marketman/reviews)).

### 4.2 Cómo se logra setup en días: el modelo MarginEdge

MarginEdge invirtió la secuencia y es la prueba de que se puede:

- **El catálogo NO se carga: se construye solo desde las facturas.** Las primeras 2-3 semanas de facturas fotografiadas crean los productos, los pack sizes y los precios automáticamente ("Products and prices update automatically as invoices are processed") ([MarginEdge — Onboarding Inventory](https://www.marginedge.com/ob-inventory)).
- **Valor desde el día 1 sin recetas ni conteos**: con solo mandar facturas ya tenés categorización de gastos, price alerts y P&L diario. Recetas e inventario son capas opcionales que se agregan después.
- **Inventario incremental**: primer conteo con ~20 ítems clave, segundo conteo una semana-mes después, y recién ahí aparece el usage report ([MarginEdge — Onboarding Inventory](https://www.marginedge.com/ob-inventory)).
- **El teórico es lo último**: requiere recetas + mapeo POS + **dos inventarios cerrados** antes de mostrar nada; MarginEdge incluso lo vende como servicio de setup aparte ([MarginEdge help — Theoretical Usage](https://help.marginedge.com/hc/en-us/articles/360015329433-Getting-Started-with-Theoretical-Usage-Reporting), [Theoretical Reporting Setup Service](https://help.marginedge.com/hc/en-us/articles/31704357075091-Theoretical-Reporting-Setup-Service)).

**La lección estructural**: el setup de semanas viene de exigir el catálogo/recetas COMO PRERREQUISITO para obtener cualquier valor. El setup de días viene de un **value ladder**: facturas (día 1) → spend visibility (semana 1) → conteo de 20 ítems (semana 2) → usage real (semana 3-4) → recetas/teórico (mes 2+, opcional). MarketMan agregó después IA que matchea ingredientes de recetas contra el catálogo de compras y detecta duplicados — confirmando que el mapeo era SU cuello de botella ([MarketMan — AI recipe management](https://www.marketman.com/platform/ai-powered-recipe-management)).

---

## 5. MarginEdge: el loop completo y qué pierde vs R365

### 5.1 El loop

Foto/email/EDI de factura → **IA + equipo humano de revisión** (gente con experiencia gastronómica real) procesa **todas las líneas en 24-48h, incluso garabatos a mano** → se actualizan: precios de productos, historial de precios por SKU cross-vendor, categorías de presupuesto, planillas de conteo (ítems nuevos se agregan solos), costos de recetas → de noche entra venta y labor del POS → a la mañana el operador ve el **P&L diario de controlables** (food %, labor %, presupuestos por categoría contra % de ventas o $ fijos) → la factura sigue a bill pay y se exporta a QuickBooks/contabilidad con el plan de cuentas del cliente ([MarginEdge — How it works](https://www.marginedge.com/how-it-works), [Automated invoice](https://www.marginedge.com/automated-invoice)).

**Por qué lo aman** (G2 4.6/5, 80% de 5 estrellas): el humano en el loop atrapa errores que el OCR puro no (cantidades mal tipeadas, unidades equivocadas); pricing plano sin sorpresas; soporte que responde; valor inmediato sin proyecto de implementación; recetas con costos siempre actualizados "de regalo" ([Food AI Daily](https://foodaidaily.com/blog/marketman-vs-marginedge-restaurant-inventory-software/), [G2 — MarginEdge](https://www.g2.com/products/marginedge/reviews)).

### 5.2 Qué pierde vs R365

- **No es un sistema contable**: no tiene GL propio, ni payroll, ni scheduling, ni consolidación franquicias — exporta a la contabilidad de otro. R365 ES la contabilidad (GL nativo donde POS, AP, inventario y payroll postean directo) ([MarginEdge vs R365](https://www.marginedge.com/blog/marginedge-vs-restaurant365-for-independent-restaurant-operators)).
- **Sin automatización de compras**: no hay POs automáticas ni par-level triggering (sí tiene ordering básico) ([Food AI Daily](https://foodaidaily.com/blog/marketman-vs-marginedge-restaurant-inventory-software/)).
- **El dato tiene 24-48h de lag** (el costo del humano en el loop) y el theoretical on-hand siempre calcula "hasta ayer" ([MarginEdge help — Theoretical On-Hand](https://help.marginedge.com/hc/en-us/articles/4402612228499-Theoretical-On-Hand-Report)).
- **AvT menos profundo que R365**: sin las dos columnas variance/unexplained-variance ni el embudo de troubleshooting; el teórico se rompe con ventas no mapeadas (ej. "open bar" de eventos) ([MarginEdge help](https://help.marginedge.com/hc/en-us/articles/360015245314-How-do-I-see-my-Theoretical-Usage)).
- Trade-off de fondo: MarginEdge optimiza **visibilidad financiera rápida para independientes**; R365 optimiza **control total para grupos** — a cambio de implementaciones largas (un usuario: 2 años y $14K en Pro Services usando solo funciones básicas) ([Capterra — R365](https://www.capterra.com/p/139768/Restaurant365/reviews/)).

---

## 6. El P&L restaurantero: formato, períodos y los KPIs semanales

### 6.1 Formato estándar

```
Ventas (Food / Bebida / Otros)
− COGS (por categoría: Food, LBW — liquor/beer/wine)
= Margen bruto
− Labor (sueldos + cargas + beneficios)
   [COGS + Labor = PRIME COST — la línea que define el negocio]
− Gastos operativos controlables (descartables, limpieza, marketing, repairs)
− Occupancy (alquiler, expensas, seguros — no controlable)
= EBITDA / Resultado operativo
```

- **Prime cost = COGS + Labor total**; benchmark: **QSR 55-60% de ventas, full-service 60-65%, regla general ~60%** ([R365 — Prime Cost](https://www.restaurant365.com/blog/how-to-calculate-prime-cost-in-a-restaurant/)).
- La distinción **controlable vs no controlable** es central: al gerente de local se lo mide por el "controllable profit", no por el EBITDA (no maneja el alquiler) ([R365 — How to read a P&L](https://www.restaurant365.com/blog/how-to-read-a-restaurant-pl-statement-and-other-essential-data-for-store-level-managers/)).

### 6.2 Period reporting: 4-4-5 / 13×4 vs mensual

Los restaurantes serios NO usan meses calendario: usan **13 períodos de 4 semanas o 4-4-5**, porque el negocio es semanal (un mes con 5 viernes vs 4 distorsiona toda comparación). Beneficios documentados: comparaciones período-a-período consistentes, las semanas fiscales caen alineadas a los períodos, y se eliminan asientos de devengamiento de labor partida entre meses ([R365 — Modern Restaurant Accounting](https://www.restaurant365.com/blog/the-essential-guide-to-modern-restaurant-accounting/)).

### 6.3 Cómo R365 une POS + contabilidad

El POS postea ventas diarias al GL automáticamente (asiento diario por local), las facturas aprobadas postean a AP, el inventario valorizado postea COGS, y payroll postea labor → el P&L "sale solo" sin cierre manual. Sobre eso, el **flash report semanal**: ventas vs forecast, prime cost de la semana, comparado contra presupuesto y mismo período del año anterior ([R365 — P&L statement](https://www.restaurant365.com/blog/restaurant-pl-statement/)).

### 6.4 Lo que el operador mira CADA SEMANA

1. **Prime cost %** (la métrica #1 — R365 insiste: calcularlo mensual "es una foto, no la película") ([R365 — Prime Cost](https://www.restaurant365.com/blog/how-to-calculate-prime-cost-in-a-restaurant/))
2. Food cost % y AvT variance (en $, por categoría)
3. Labor % y horas vs forecast (antes de que se acumulen horas extra)
4. Ventas vs forecast y vs año anterior (mismo día de semana)
5. P&L diario de controlables vs presupuesto (modelo MarginEdge)

---

## 7. Order suggestions / par levels / 3-way match

### 7.1 Las dos lógicas de compra sugerida

**Fill-to-par (estática)**: `Cantidad a pedir = Par − Stock a mano − Ya pedido (on order)`, redondeado a pack size del proveedor. El par se calcula como `(uso semanal + stock de seguridad) ÷ entregas por semana` ([MarketMan — par levels](https://www.marketman.com/blog/how-to-calculate-par-level-in-a-restaurant), [Altametrics — par levels](https://altametrics.com/blog/guide-to-restaurant-par-levels-and-reordering.html)). Restar lo ya pedido es clave para no comprar doble.

**Forecast-based (dinámica, el estado del arte — Crunchtime y R365)**: el par deja de ser fijo — se deriva de **consumo histórico × forecast de ventas** de los días que cubre el pedido. Crunchtime: stock a mano − par dinámico (de patrones de consumo + forecast) comparado contra fechas de entrega → cantidad óptima para no quebrar stock antes de la próxima entrega ([Crunchtime — recommended orders](https://www.crunchtime.com/blog/benefits-of-recommended-orders)). R365: el botón "Suggest Qty" usa el forecast de ventas de todos los días de consumo/buffer de la semana del pedido ([R365 docs — Forecasting](https://docs.restaurant365.com/docs/forecasting)). En ambos, el manager **revisa y ajusta** antes de aprobar — sugerido, no automático.

### 7.2 3-way match (OC ↔ remito ↔ factura)

Verificación de que coinciden tres documentos antes de pagar: lo pedido (OC), lo recibido (remito/receiving doc) y lo facturado. Flujo: factura entra → se compara con OC → se verifica contra el receiving → discrepancias se resuelven (crédito por faltante, nota por sustitución) → aprobación → pago → asiento ([R365 — 3-way matching](https://www.restaurant365.com/blog/3-way-invoice-matching/)). La recepción es el eslabón crítico: checklist de cantidad vs factura vs orden, calidad/temperatura, sustituciones y faltantes anotados, créditos documentados — "la recepción es donde se gana o pierde la precisión del inventario" ([Stampli — PO matching](https://www.stampli.com/blog/all/po-matching-invoice/)). En la práctica gastronómica el match estricto de 3 vías solo se usa en ítems caros; para el resto, 2 vías (remito vs factura) con tolerancias.

---

## 8. Lo que los usuarios AMAN y ODIAN (síntesis de reviews)

| Sistema | Aman | Odian |
|---|---|---|
| **R365** | Todo-en-uno real: contabilidad+inventario+scheduling integrados; AvT profundo; reportes período | Curva de aprendizaje brutal; implementaciones de meses/años ($14K en Pro Services y 2 años usando lo básico); inventario lento de cargar; módulos que "nunca pudieron hacer andar juntos"; soporte lento ([Capterra](https://www.capterra.com/p/139768/Restaurant365/reviews/), [G2](https://www.g2.com/products/restaurant365/reviews)) |
| **MarketMan** | Automatización de compras/POs por par; control granular de inventario | Setup tedioso y abrumador (cientos de horas); escaneo de facturas falla 50% según reviews; fricción para cancelar; soporte tarda días ([CheckThat](https://checkthat.ai/brands/marketman/reviews), [Capterra](https://www.capterra.com/p/136439/Marketman-Restaurant-Inventory/reviews/)) |
| **MarginEdge** | Foto-y-listo con humanos verificando; P&L diario; pricing plano; soporte empático; recetas auto-costeadas; modo español para cocina | Lag 24-48h; sin PO automation/pars; app mobile limitada; UI mejorable; configuración de alertas de a una ([G2](https://www.g2.com/products/marginedge/reviews), [SoftwareAdvice](https://www.softwareadvice.com/retail/marginedge-profile/)) |
| **Apicbase** | Recipe management de nivel chef (yields, alérgenos, multi-outlet); soporte 4.9/5 | Bugs y datos corruptos en reportes; lentitud con usuarios concurrentes; menos fuerte en el lado financiero/contable ([Capterra](https://www.capterra.com/p/171584/Apicbase-Restaurant-Management/reviews/)) |
| **xtraCHEF/Toast** | Barato como add-on de Toast; price trends + alertas; elimina 5-10 h/semana de data entry | Escaneo inexacto que "genera más problemas de los que resuelve" para algunos; soporte pobre; solo tiene sentido dentro del ecosistema Toast ([G2](https://www.g2.com/products/xtrachef/reviews), [restaurantpeers](https://restaurantpeers.com/inventory-management-software/xtrachef-by-toast-reviews/)) |

---

## 9. Lecciones para PASE

### 9.1 Lógicas que PASE ya tiene BIEN (validadas contra los líderes)

- **Lector IA de facturas como puerta de entrada** = exactamente la apuesta ganadora de MarginEdge/xtraCHEF. Es EL diferenciador de adopción.
- **Recetas con sub-recetas anidadas + costeo en cascada** (`fn_recalc_costo_item` + trigger por insumo) = el modelo Apicbase/meez. La cascada automática al cambiar el precio del insumo es justo lo que Mirus identifica como la razón #1 de abandono cuando es manual.
- **Ledger de movimientos + conteo ciego + mermas** = blind count es el estándar anti-fraude de los líderes (Revel lo vende así), y el waste log separado es prerequisito para la "unexplained variance" de R365.
- **Modelo 3 conceptos (Materia Prima → Insumo con rendimiento → Receta)** = mapea 1:1 con AP → EP (yield) → recipe unit del estándar CIA/R365. La decisión de contar stock as-bought con el rendimiento en la línea de receta es coherente con la práctica profesional.
- **Bandeja de conciliación con memoria de mapeos** (`compras_mapeo` + auto-match) = la misma jugada del AI-matching que MarketMan tuvo que agregar para sobrevivir a su propio setup.

### 9.2 Qué validar / cambiar en nuestras lógicas

1. **AvT con dos columnas**: separar "variancia" (antes de mermas registradas) de "**variancia no explicada**" (después de mermas). Lo accionable es lo segundo. Y permitir drill-down: categoría → ítem → transacciones (el embudo de 7 pasos de R365), priorizado **por $ y no por %**.
2. **Umbral accionable en el UI**: variancia food total 1.5-2.5% = OK (R365); pintar 0-2% verde / 2-4% amarillo / 4%+ rojo. Mostrar siempre los **$ recuperables**, que es lo que mueve al dueño.
3. **Cadencia semanal con fecha fija**: el AvT mensual no sirve para corregir; el reporte debe asumir ciclo semanal con el mismo día de cierre. Prime cost también semanal (flash report), no solo el EERR mensual.
4. **Defensa contra falsos positivos de UoM**: el caso "41.25 cajas vs libras" de R365. El lector IA debería **alertar cuando el precio unitario implícito de una línea se desvía fuerte del histórico del ítem** (proxy barato de error de unidad/pack size) antes de dejar que contamine costos y AvT. Esto es matar la causa #1 de pérdida de confianza.
5. **Dos yields, no uno**: trim/limpieza (AP→EP) y cocción son pérdidas distintas. Hoy PASE pone el rendimiento en la línea de receta — verificar que se pueda expresar también la merma de cocción en sub-recetas (un braseado que reduce 40%) sin hacks.
6. **Conteo de dos niveles**: el conteo completo mensual + **key items (5-10 más caros) semanal o diario**. PASE tiene conteo ciego completo; falta el concepto de "conteo parcial de key items" liviano y frecuente — es lo que hace que la disciplina sobreviva. Las planillas deben seguir **zonas físicas del local** en orden shelf-to-sheet, y los insumos nuevos (de facturas conciliadas) deben **agregarse solos a la planilla** como hace MarginEdge.
7. **Par dinámico, no solo fijo**: si hacemos compras sugeridas, la fórmula mínima es `par − stock − pedido en tránsito` redondeado a pack del proveedor; la versión pro deriva el par del consumo histórico + forecast de ventas (Crunchtime/R365). Siempre **sugerido con revisión humana**, nunca auto-enviado.
8. **EERR con prime cost explícito y controlable vs no controlable**: la línea COGS+Labor como métrica destacada con benchmark (~60%), y separar gastos controlables (lo que el encargado maneja) de occupancy. Evaluar ofrecer calendario 4-4-5/13×4 como opción de período además del mes calendario.
9. **Recepción como evento de primera clase**: lo que mata la precisión es recibir sin registrar faltantes/sustituciones. Un flujo de recepción liviano (remito vs factura, 2-way con tolerancia; 3-way solo en ítems caros) con créditos documentados.

### 9.3 Cómo lograr setup en días, no semanas (el playbook anti-MarketMan)

La causa raíz del setup de 6-12 semanas es **exigir catálogo+recetas como prerrequisito del valor**. La inversión de MarginEdge es replicable y PASE ya tiene las piezas:

1. **Día 1 — solo facturas**: el lector IA + bandeja de conciliación construyen el catálogo SOLO, factura a factura. Nunca pedir "cargá tus insumos" como paso previo. Valor inmediato sin nada más: gasto por categoría, historial de precios por insumo, alertas de aumento de precio.
2. **Semana 1-2 — conteo de 20 key items**: no el catálogo entero. Dos conteos cerrados → primer usage report real. (Patrón exacto del onboarding de MarginEdge.)
3. **Semana 3-4 — recetas de los 20 platos más vendidos** (Pareto del sales mix del POS — COMANDA ya lo tiene), no las ~34+ completas. El AvT con 80% del volumen mapeado ya es accionable.
4. **Mes 2+ — teórico completo**: solo cuando facturas+conteos+recetas core ya andan. Nunca antes.
5. **Ventaja estructural de PASE que ninguno tiene**: COMANDA es nuestro — el mapeo botón-POS→receta (el paso que en MarketMan/MarginEdge es manual y frágil) puede ser **automático y sin drift**, porque el catálogo vive en PASE y COMANDA solo consume. Ese es el eslabón que les rompe el AvT a todos los demás.
6. **Medir el time-to-first-value como KPI del producto**: días hasta el primer insight accionable (primer price alert, primer usage report), no "% del setup completado".

---

## Fuentes principales

- R365 docs: [AvT Troubleshooting](https://docs.restaurant365.com/docs/actual-vs-theoretical-analysis-troubleshooting-variances) · [UoM Conversions](https://docs.restaurant365.com/docs/unit-of-measure-conversions) · [Forecasting](https://docs.restaurant365.com/docs/forecasting) · [AvT Analysis](https://docs.restaurant365.com/doc/docs/actual-vs-theoretical-analysis)
- R365 blog: [Closing the AvT gap](https://www.restaurant365.com/blog/closing-the-gap-between-actual-and-theoretical-food-costs/) · [Food Cost Guide](https://www.restaurant365.com/blog/food-cost-guide/) · [Prime Cost](https://www.restaurant365.com/blog/how-to-calculate-prime-cost-in-a-restaurant/) · [Modern Accounting / 4-4-5](https://www.restaurant365.com/blog/the-essential-guide-to-modern-restaurant-accounting/) · [3-way match](https://www.restaurant365.com/blog/3-way-invoice-matching/) · [Waste & Variance](https://www.restaurant365.com/blog/restaurant-waste-and-variance-reporting/)
- MarginEdge: [How it works](https://www.marginedge.com/how-it-works) · [Onboarding Inventory](https://www.marginedge.com/ob-inventory) · [Operator's guide to AvT](https://www.marginedge.com/blog/a-restaurant-operators-guide-to-actual-vs-theoretical-food-costs-and-usage) · [vs R365](https://www.marginedge.com/blog/marginedge-vs-restaurant365-for-independent-restaurant-operators) · [help: Theoretical Usage](https://help.marginedge.com/hc/en-us/articles/360015329433-Getting-Started-with-Theoretical-Usage-Reporting) · [help: Theoretical On-Hand](https://help.marginedge.com/hc/en-us/articles/4402612228499-Theoretical-On-Hand-Report)
- Apicbase: [Recipe Costing](https://get.apicbase.com/recipe-costing/) · [support: food cost calculation](https://support.apicbase.com/help/food-cost-calculation) · [Capterra reviews](https://www.capterra.com/p/171584/Apicbase-Restaurant-Management/reviews/)
- MarketMan: [Capterra reviews](https://www.capterra.com/p/136439/Marketman-Restaurant-Inventory/reviews/) · [CheckThat review synthesis](https://checkthat.ai/brands/marketman/reviews) · [par levels](https://www.marketman.com/blog/how-to-calculate-par-level-in-a-restaurant) · [Toast integration docs](https://support.toasttab.com/en/article/Get-Started-with-the-MarketMan-Integration)
- xtraCHEF/Toast: [producto](https://pos.toasttab.com/products/xtrachef) · [G2 reviews](https://www.g2.com/products/xtrachef/reviews)
- Crunchtime: [Explaining AvT](https://www.crunchtime.com/blog/blog/explaining-actual-vs-theoretical-food-cost-variance) · [Recommended Orders](https://www.crunchtime.com/blog/benefits-of-recommended-orders)
- Consultores/educación: [Chefs Resources — Taking Food Inventory](https://www.chefs-resources.com/kitchen-management-tools/restaurant-inventory-control/taking-food-inventory/) · [Mirus — Food Cost Controls](https://blog.mirus.com/restaurant-food-cost-controls) · [Over Easy Office — AvT multi-unit](https://www.overeasyoffice.com/blog/actual-vs-theoretical-food-cost-where-margins-really-disappear) · [meez — recipe costing](https://www.getmeez.com/blog/a-chefs-guide-to-accurate-recipe-costing) · [meez — yields](https://www.getmeez.com/blog/never-assume-100-ingredient-yield) · [Restaurant Profit Systems — AvT guide](https://www.restaurantsprofitsystems.com/guides/actual-vs-theoretical-food-cost.html) · [CIA — Kitchen Calculations](https://www.ciachef.edu/wp-content/uploads/2024/07/kitchen-calculations.pdf) · [Supy — Stock Counts 101](https://supy.io/blog/restaurant-inventory-count-accuracy-tips) · [Megaventory — Blind Count](https://blog.megaventory.com/blind-count-definition-pros-cons-examples/) · [Food AI Daily — MarketMan vs MarginEdge](https://foodaidaily.com/blog/marketman-vs-marginedge-restaurant-inventory-software/) · [Bar & Restaurant — problem units](https://www.barandrestaurant.com/operations/how-deal-problem-units-food-inventory-control)
