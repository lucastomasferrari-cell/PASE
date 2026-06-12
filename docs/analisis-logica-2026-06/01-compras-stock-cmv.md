# Análisis de lógica — Circuito Compras → Stock → CMV

**Fecha:** 2026-06-11
**Tipo:** auditoría de arquitectura de producto (decisiones de diseño, no bugs puntuales)
**Alcance:** Compras / Materias Primas / Insumos / Recetas / Stock / CMV-AvT en PASE + el descuento de stock desde COMANDA.
**Fuentes leídas:** migraciones `202605151500` → `202606071900`, pantallas `Conciliacion/Stock/Recetario/Rentabilidad`, specs de rediseño del 28-may y spec de la bandeja del 07-jun.

---

## 1. Cómo funciona hoy (el flujo real, de punta a punta)

```
FACTURA (manual o Lector IA)
  └─ se guardan los renglones en factura_items
       └─ auto-match: ¿este texto de producto ya lo conozco? (tabla compras_mapeo)
            ├─ SÍ → se vincula solo a su Materia Prima
            └─ NO → queda en la BANDEJA de conciliación (lo resolvés una vez, queda en memoria)
                 └─ al vincular (automático o manual):
                      1. el PRECIO de la Materia Prima se actualiza al de la factura (trigger)
                      2. el COSTO del Insumo se recalcula (promedio de sus materias primas)
                      3. ese costo CASCADEA a todos los items/recetas que lo usan (recursivo)
                      4. entra STOCK al insumo (cantidad × factor de empaque, ej: 5 cajas × 10kg)

VENTA EN COMANDA (al cobrar)
  └─ trigger: por cada item vendido busca su receta activa
       └─ descuenta insumos recursivamente (sub-recetas incluidas)
            └─ cada descuento es una fila en insumo_movimientos (libro mayor de stock)

CONTROL
  ├─ Conteo ciego: cargás lo que contaste sin ver el teórico → al cerrar aparece la diferencia
  ├─ Mermas con motivo de catálogo (vencimiento, error de cocina, robo con TOTP, etc.)
  └─ CMV: Real = Stock inicial + Compras − Stock final − Mermas  vs  Teórico = lo que dicen las recetas
```

**Las tres piezas del modelo de datos:**

| Concepto | Qué es | Tabla |
|---|---|---|
| **Materia Prima** | Lo que te vende el proveedor, con su empaque y su precio. "Trucha entera Pescadería X, caja 10kg". | `materias_primas` |
| **Insumo** | Lo que usa la cocina en las recetas. "Trucha (kg)". Su costo sale de sus materias primas. | `insumos` |
| **Receta / Sub-receta** | Misma entidad anidada: una receta puede usar insumos y/o otras recetas (el caldo dentro del ramen). | `recetas` + `receta_insumos` |

El stock se lleva con un **libro mayor** (`insumo_movimientos`: cada entrada/salida es una fila que nunca se pisa) y un **cache** (`insumos.stock_actual`: el número que ves, mantenido por trigger y recalculable desde el libro).

---

## 2. Veredicto por área

### 2.1. Modelo de 3 conceptos (Materia Prima → Insumo → Receta anidada) — ✅ sólido

Es exactamente el modelo de R365 / MarketMan / Apicbase, simplificado bien. Sirve igual para un café (insumos 1:1, sin procesamiento), una parrilla (media res → cortes con rendimiento), fast food y dark kitchen. Las sub-recetas anidadas (hasta 10 niveles, con guarda anti-ciclo) cubren el caso "el caldo se usa en 5 ramenes y cambiar el precio del cerdo recalcula los 5". **Esta base NO hay que tocarla.**

Dos topes reales dentro del modelo:

1. **🔴 Modificadores y combos no tienen receta.** Si un cliente de fast food vende "hamburguesa + agregá cheddar + agregá bacon", el cheddar y el bacon del modificador **no descuentan stock ni suman al costo del plato**. Para café/sushi casi no importa; para fast food y pizzerías (donde el 30-50% del ticket son modificadores) el CMV teórico queda sistemáticamente bajo y el AvT da "fuga" que no es fuga. El spec del 28-may ya lo había marcado como v2 (decisión #5). No es urgente hoy, pero es **el primer tope que va a aparecer al vender a un cliente de fast food**.
2. **⚠️ La merma/rendimiento vive en 3 lugares** y nadie valida que no se sume dos veces:
   - `materias_primas.merma_pct` (rendimiento entera→fileteada) — afecta el **costo** del insumo: `precio / (factor × (1−merma))`.
   - `receta_insumos.merma_pct` (merma de la línea de receta) — afecta costo **y** descuento de stock.
   - La decisión operativa acordada ("stock se cuenta as-bought, el rendimiento va en la merma de línea de receta") dice usá la segunda… pero la primera sigue activa en la fórmula de costo. Si un usuario carga 35% en la materia prima **y** 35% en la línea de receta, el costo del plato queda inflado ~2x sin que nada avise. Para un producto vendible a terceros, esto necesita una sola casa y una validación.

### 2.2. Loop compra → precio → costo → CMV — ✅ cerrado (con 3 asteriscos)

La parte más valiosa del circuito **ya está cerrada y es automática**: cargar una factura actualiza precio → costo de insumo → costo de cada receta que lo usa → costo de las recetas padre, todo por triggers en cadena, sin ningún paso manual. La bandeja + memoria (`compras_mapeo`) hace que el costo de mapear tienda a cero con el uso. Esto es nivel R365 y es el diferencial del producto.

Los asteriscos:

1. **⚠️ La fecha del movimiento de stock es la fecha de carga, no la de la factura.** El spec de la bandeja (§6.4) decía explícitamente "el movimiento se fecha con la fecha de la factura (retroactivo) para que el histórico/AvT quede bien" — y el trigger implementado usa `now()`. Consecuencia: si Anto carga el lunes las facturas de la semana pasada, las compras caen en el período equivocado y el CMV mensual queda sucio. **Esto se pudre con el tiempo** porque el histórico no se corrige retroactivamente.
2. **⚠️ El stock entra solo con la factura, no con la recepción.** En gastronomía argentina la mercadería llega con remito y la factura viene días después. Los remitos hoy son solo encabezado (la tabla `remito_items` se eliminó en la migración F1.1), así que **no hay forma de que el stock suba cuando la mercadería físicamente entra**. Entre la entrega y la carga de la factura, el stock real y el del sistema divergen — y cualquier conteo en ese intervalo "encuentra" mercadería de más. El spec de Compras del 28-may resolvía esto con OC + recepción de remito + 3-way match; nada de eso se implementó (no existe `ordenes_compra` en el schema).
3. **⚠️ El costo del insumo es promedio SIMPLE de las materias primas activas, no ponderado.** Si comprás 100kg/mes al proveedor barato y 5kg/mes al caro de emergencia, ambos pesan igual en el costo. El spec decía ponderado por volumen de compra. Con un solo proveedor por insumo no se nota; con dos, el costo de las recetas miente.

Detalle silencioso a vigilar: la bandeja solo muestra renglones de facturas cuya **categoría pertenece al grupo CMV**. Si el usuario carga la factura de la pescadería con categoría equivocada, los renglones no aparecen en ningún lado y nadie avisa.

### 2.3. Stock — ⚠️ el patrón es correcto, 🔴 pero el stock por local no existe de verdad

**Lo bueno:** `insumo_movimientos` es un libro mayor append-only con tipo, costo snapshot, fuente (factura/venta/conteo), snapshot de stock antes/después, y existe `fn_recalcular_stock_insumo` para reconstruir el cache desde cero. Reversos por anulación de venta/factura son movimientos opuestos idempotentes (nunca se borra historia). El descuento por venta es **robusto offline**: corre server-side cuando la venta cobrada llega a la DB, con idempotencia por ítem de venta (`NOT EXISTS` por `venta_pos_item`), así que la cola offline de COMANDA puede reintentar sin duplicar. Esto está bien hecho.

**El tope grande:** los movimientos tienen `local_id`, pero el cache es **UNA columna por insumo** (`insumos.stock_actual`), global al tenant. O sea:

- Cada local NO tiene su número de stock. El número que ves es la suma de todos los locales.
- Las transferencias entre locales (`fn_transferir_stock_local`) crean los dos asientos (−origen, +destino) pero **el número global no cambia** — el propio código lo admite en un comentario: *"Para inventario multi-local hace falta una tabla insumo_stock_por_local. Como simplificación de fase 1, asumimos que el stock_actual representa el total entre locales"*.
- Los conteos son por local, pero la columna "teórico" que se snapshotea es el stock **global** → en cuanto haya 2 locales, todo conteo va a dar diferencias falsas.
- El spec del 28-may tenía esto resuelto (`stock_actual` con clave `(insumo, local)`); la implementación de junio tomó el atajo. Con 1 local andás perfecto. **Con el segundo local, el módulo Stock entero deja de decir la verdad.** Y Neko (cocina central + satélites) y MESA apuntan exactamente ahí.

Otros dos puntos:

- **⚠️ Marcar `deleted_at` en un movimiento NO recalcula el cache** (está documentado en el comment de la tabla, pero es una trampa esperando a alguien que borre un movimiento "para corregir" y deje el número desincronizado hasta que alguien corra el recalc).
- **⚠️ Bug de UX real:** la pantalla Stock filtra `stock_disponible = true`, y el trigger fuerza `stock_disponible = false` cuando el stock llega a 0 (auto-86). Resultado: **los insumos agotados desaparecen de la lista de stock** — justo los que más necesitás ver.

### 2.4. Bandeja de conciliación (`compras_mapeo`) — ✅ escala bien

La lógica de memoria es la correcta: match **exacto sobre texto normalizado** (minúsculas, sin acentos, espacios colapsados), con índice por `(tenant, texto)`, prioridad proveedor-específico sobre global, y dedupe por producto en la UI (mapeás "TRUCHA X 10KG" una vez y se vinculan las 8 facturas que lo traen). Miles de renglones no son problema: el índice parcial sobre pendientes y el lookup indexado aguantan sin despeinarse. La curva es la que importa: la bandeja es grande el primer mes y tiende a vacía.

Lo mejorable es de fricción, no de escala:

- **No hay fuzzy matching** (era la Fase 3 del spec, no se hizo). Si el proveedor factura "TRUCHA ARCO IRIS X 10 KG" un mes y "TRUCHA ARCOIRIS 10KG" el siguiente, son dos mapeos distintos. Con lector IA esto va a pasar seguido. Una sugerencia por similitud (trigram de Postgres, ya casi gratis) bajaría mucho el re-trabajo.
- **Descartar un grupo hace N llamadas** al servidor (una por renglón, en loop desde el frontend). Con un grupo de 40 renglones son 40 round-trips. Trivial de convertir en una sola RPC batch.

### 2.5. CMV / AvT — ⚠️ la fórmula es correcta, los insumos de la fórmula no siempre

`Consumo Real = Stock Inicial + Compras − Stock Final − Mermas declaradas`, comparado contra el teórico de recetas, con eficiencia % y "insumos con fuga". La matemática contable está bien y es el estándar. Pero:

1. **🔴 El cálculo per-local usa snapshots globales.** `fn_cmv_real` filtra movimientos por local, pero el stock inicial/final que toma son los `stock_antes/stock_despues` de los movimientos — que son fotos del **cache global**. Con 1 local coincide; con 2+, el CMV por local da números sin sentido. Es la misma raíz que §2.3.
2. **⚠️ Las transferencias entre locales no entran en la fórmula.** No cuentan como "compra" en el destino ni como "salida" en el origen, pero sí mueven los stocks → el consumo real del destino queda subestimado y el del origen inflado. Para cocina central esto es exactamente el caso de uso principal.
3. **⚠️ Períodos históricos sin movimientos caen al stock actual** como stock inicial/final (en vez del stock a esa fecha) → consultar "CMV de marzo" en junio puede dar cualquier cosa para insumos quietos.
4. **⚠️ Hay DOS "CMV" distintos en el producto y no se explican entre sí:** el EERR usa **compras del período** (facturas, base devengada) como CMV, y Rentabilidad usa **consumo** (la fórmula de arriba). Ambos son legítimos (uno contable, otro operativo) pero el dueño ve dos números con el mismo nombre que no coinciden. Falta una línea de UI que diga cuál es cuál y por qué difieren (la diferencia entre ambos ES la variación de inventario — mostrarla sería un feature, no un parche).
5. **Producción de preps no existe** (`fn_producir_prep` del spec no se implementó). Hoy las sub-recetas se "desarman" al momento de la venta (vendés el roll → descuenta el arroz crudo del shari). Es un v1 razonable y evita data entry, pero significa que **el yield real nunca se mide** (no sabés si la tanda de teriyaki rindió 2L o 1.7L) y que el stock del prep como tal no existe — otra pieza que la cocina central va a pedir.

### 2.6. Pasos y clics de las operaciones frecuentes

| Operación | Pasos hoy | Veredicto |
|---|---|---|
| Cargar factura con IA | foto → preview editable → confirmar (≈3 acciones) | ✅ excelente, mejor que el estándar |
| Conciliar producto nuevo | abrir bandeja → Resolver → completar modal (nombre/insumo/empaque/precio) → confirmar | ✅ una sola vez por producto; el quick-create de insumo encadenado evita ir a otra pantalla |
| Conciliar producto conocido | **0 pasos** (auto-match) | ✅ este es el diseño correcto |
| Cargar merma | Stock → Mermas → modal (insumo, cantidad, motivo) | ✅ ok; falta el "one-tap top 10" (la vista `v_mermas_top10` existe en la DB pero la UI no la usa) |
| Conteo ciego | iniciar → cargar líneas → finalizar → ver diferencias | ✅ correcto; conteo parcial por categoría no existe (es todo o nada — con 200 insumos nadie va a hacer el conteo completo) |
| Crear receta | Recetario → Recetas → editor con sub-recetas | ✅ ok |

Pasos que se pueden eliminar:
- **Crear insumo 1:1 en la conciliación**: para productos sin procesamiento (latas, botellas), un checkbox "crear insumo igual a la materia prima" ahorraría el sub-modal entero (el spec §3.3 lo describía así).
- **Pre-llenar el empaque parseando el texto**: "TRUCHA X 10KG" ya dice unidad y factor; hoy se tipean a mano.
- **Conteo parcial** ("hoy cuento solo heladera/carnes") — sin esto, el conteo real va a ocurrir una vez y nunca más.

---

## 3. Decisiones a cambiar AHORA (porque después son caras de migrar)

Ordenadas por costo-de-postergación:

1. **Stock por (insumo, local) — la más cara de postergar.** Crear la tabla cache `insumo_stock_local (tenant, insumo, local) → cantidad` y que el trigger del libro mayor la mantenga (el libro YA tiene `local_id`, así que se puede **backfillear desde el histórico existente** — hoy es barato; cada mes que pasa hay más pantallas, conteos y reportes construidos sobre el número global). Arregla de un saque: conteos por local, transferencias, CMV per-local y la promesa multi-local del producto. El spec del 28-may ya lo tenía diseñado.
2. **Fechar las entradas de compra con la fecha de la factura.** Cambio chico en el trigger (`created_at` ← `facturas.fecha`) + decidir si se corrigen las filas viejas. Cada semana sin esto ensucia el CMV histórico de forma irreversible.
3. **Una sola casa para el rendimiento/merma.** Decidir: el rendimiento vive en la línea de receta (decisión operativa ya tomada) → entonces deprecar/ocultar `materias_primas.merma_pct` de la UI, o al menos avisar cuando ambos están seteados. Mientras existan los dos, cada cliente nuevo es una oportunidad de doble conteo.
4. **Costo ponderado del insumo** (por volumen de compras recientes, ej. últimas N compras o 90 días) en `fn_recalc_costo_insumo`. Cambio localizado en una función; cuanto más histórico de compras haya, más raro va a ser el salto del número el día que se corrija.
5. **Entrada de stock en la recepción (remito con renglones).** No hace falta el 3-way match completo del spec; alcanza con que el remito tenga renglones que generen `entrada_compra` y que la factura posterior solo ajuste precio. Hoy el modelo de remitos (sin items) está en el medio del camino.
6. **Arreglar la pantalla Stock que oculta los agotados** (sacar el filtro `stock_disponible=true`). Es un fix de una línea pero distorsiona la confianza en todo el módulo.

**Lo que NO hay que cambiar:** el modelo de 3 conceptos, el libro mayor de movimientos, la cadena de triggers de costos, la bandeja con memoria, el descuento recursivo al cobrar. Todo eso es la decisión correcta y está alineado al estándar.

---

## 4. Comparación con el estándar mundial

| Capacidad | R365 / MarketMan | Toast (inventario básico) | PASE hoy |
|---|---|---|---|
| Modelo Vendor Item → Inventory Item → Recipe anidada | ✅ | parcial | ✅ **igual al estándar** |
| Precio se actualiza solo al cargar factura | ✅ | ✅ | ✅ |
| Cascada de costos automática a recetas | ✅ | parcial | ✅ |
| OCR/IA de facturas | ✅ (add-on pago) | ❌ | ✅ **integrado y gratis** |
| Memoria de mapeo proveedor→producto | ✅ | — | ✅ |
| Fuzzy matching de productos | ✅ | — | ❌ (solo exacto) |
| Auto-depleción por venta con sub-recetas | ✅ | ✅ | ✅ |
| Modificadores descuentan stock | ✅ | ✅ | ❌ (v2) |
| Stock por ubicación/local | ✅ | ✅ | 🔴 global (el tope #1) |
| Órdenes de compra + 3-way match | ✅ | ❌ | ❌ (spec escrito, sin implementar) |
| Recepción por remito sube stock | ✅ | — | ❌ (solo factura) |
| Producción de preps con yield real | ✅ | ❌ | ❌ (se desarma al vender) |
| Conteo ciego | ✅ | ❌ | ✅ **mejor que Toast** |
| Conteo parcial por categoría | ✅ | — | ❌ |
| Mermas con motivo de catálogo | ✅ | parcial | ✅ |
| AvT / eficiencia teórico vs real | ✅ | ❌ | ✅ (con los asteriscos de §2.5) |
| Par levels + compras sugeridas | ✅ | ❌ | ✅ |

**Lectura honesta:** para un cliente de **un solo local** (café, parrilla, dark kitchen mono-local), PASE ya está al nivel funcional de MarketMan en el circuito compras→CMV, con mejor UX de carga (IA integrada + bandeja con memoria) y conteo ciego que Toast ni ofrece. Las tres distancias reales contra los grandes son: **multi-local de verdad** (stock por local + transferencias + producción central), **modificadores con receta**, y **recepción por remito**. Las tres están diseñadas en los specs del 28-may; lo implementado en junio fue conscientemente la versión simple, y eso estuvo bien para encender el circuito — pero la primera (stock por local) conviene pagarla ya, porque su costo de migración crece con cada fila de datos y cada cliente nuevo.
