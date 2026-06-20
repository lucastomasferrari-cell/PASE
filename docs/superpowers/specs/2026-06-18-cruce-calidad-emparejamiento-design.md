# Calidad del cruce de conciliación — identificación de proveedor + fechas

**Fecha:** 2026-06-18
**Estado:** Diseño aprobado (Lucas), pendiente de implementar por partes
**Área:** Conciliación MP (`fn_cruzar_extracto_mp`, `conciliacion_alias`, `ConciliacionExtracto.tsx`) — zona de plata

## Problema

El cruce empareja las transferencias del extracto MP con los pagos cargados en PASE. Hoy empareja **principalmente por monto**, y eso produce errores reales (caso SAN JOSE, 18-jun):

1. **El banco nombra al proveedor por el titular de la cuenta** ("Sucesion De Jose German", "Jorge Sorribas"), que muchas veces **no comparte ni una palabra** con el nombre en PASE ("SAN JOSE (MUZZA)"). Ningún string-matching puede conectarlos: la única vía es un **alias** aprendido.
2. **Empareja por monto, ignorando el proveedor** → cuando dos transferencias valen lo mismo (una a SAN JOSE, otra a Sorribas), agarra cualquiera. Le robó el pago de SAN JOSE a la transferencia equivocada.
3. **La lógica de fechas es por ventana fija** (R1 = período estricto; R3 combos = ±4 días; alertas = ±10 días fuera) y no rankea por cercanía → empareja con la fecha "que cae primero", no con la más próxima.
4. **Transferencias devueltas** (envío + devolución, mismo `referencia_externa`, signo opuesto) se tratan como un egreso real porque el cruce trabaja solo con egresos y no ve la devolución → roban matches (caso Sorribas: se mandó y volvió, pero igual matcheó).
5. Los aliases se guardan **por local** (7 filas para el mismo proveedor) y se aprenden recién al cerrar → trabajo manual repetido.

## Objetivo

Maximizar la calidad del emparejamiento: que el cruce elija **el candidato correcto** (proveedor + fecha), ignore lo que se devolvió, y aprenda/sugiera los nombres del banco una sola vez.

## Diseño — 4 mejoras, 3 piezas

### Pieza 1 — Emparejamiento por proveedor + fecha (el núcleo)
En la selección de candidatos del cruce (R1/R2/R3 de `fn_cruzar_extracto_mp`), reemplazar el "primer único por monto" por un **ranking de candidatos**:

1. **Mismo proveedor primero**: si la línea del extracto tiene `alias_prov` (proveedor conocido por alias) y un candidato-mov es de ese proveedor (`prov_id` derivado de factura/remito), ese candidato gana.
2. **Fecha más cercana**: entre los que quedan, preferir el de menor `ABS(mov.fecha - transferencia.fecha)`.
3. Si tras el ranking hay **un claro ganador** → verde. Si hay empate real (mismo proveedor, misma cercanía, varios) → amarillo (el usuario elige).

Es **preferencia/desempate, no requisito**: si no hay alias, sigue emparejando por monto+fecha como hoy (no rompe los casos sin alias). La proximidad de fecha NO ensancha la ventana a ciegas (lo que Lucas descartó) — es criterio de orden dentro de los candidatos. El caso "pago cargado en otro mes" sigue resolviéndose con el botón **"Traer a este mes"** ya existente (confirmación manual).

### Pieza 2 — Sugerir y recordar aliases (por tenant)
1. **Aliases por tenant, no por local**: un solo `Sucesion De Jose German → SAN JOSE (MUZZA)` sirve para todos los locales. Migrar `conciliacion_alias` a `local_id` opcional (NULL = todos) o deduplicar; el lookup usa el del tenant.
2. **Sugerencia proactiva**: cuando una transferencia queda `rojo_falta` pero su monto coincide con el pago de **un único** proveedor en el período, el cruce devuelve esa sugerencia. La UI muestra "¿'Sucesion De Jose German' es SAN JOSE (MUZZA)?" → un click crea el alias (tenant-wide) y re-cruza.

### Pieza 3 — Ignorar transferencias devueltas
Detectar el par **envío + devolución** (mismo `referencia_externa`, montos opuestos) en el archivo subido → neto cero → **sacar el egreso del pool de matching** y marcarlo como "devuelta — ignorada" (informativo, no es falta ni sobra). Requiere que el cruce (o el front antes de llamarlo) **vea también los ingresos** (devoluciones), no solo los egresos.

## Orden de construcción (cada pieza: plan + test mutante/verificación antes-después)
1. **Pieza 3** (devueltas) — la más acotada, arregla el caso Sorribas de raíz, bajo riesgo.
2. **Pieza 1** (proveedor + fecha) — el núcleo del emparejamiento.
3. **Pieza 2** (aliases tenant-wide + sugerencia) — saca el trabajo manual; potencia a la Pieza 1.

## Riesgos y mitigaciones
- Es la función de cruce (compleja, ya parchada varias veces el 18-jun). Cada pieza se aplica con **verificación antes/después** reproduciendo el cruce real desde el borrador guardado (`conciliacion_borradores`) — sin tocar producción hasta confirmar.
- El cruce es de **solo lectura** (no mueve plata; calcula matches). La plata se mueve al aplicar/cerrar — fuera de scope de estas piezas.
- Pieza 2 cambia el esquema de `conciliacion_alias` (local_id → opcional): migración con cuidado de no romper los aliases existentes.

## Fuera de scope
- El emparejamiento muchos-a-uno por proveedor (per-factura vs transferencia agregada) — ya se maneja con bloques; no se rediseña acá.
- La limpieza de datos viejos (doble pagos, sobre-pagos) — caso por caso, manual.
- El "Traer a este mes" — ya existe; solo se beneficia del ranking por fecha.

## Verificación de éxito
- Caso SAN JOSE: el pago de $119.569,54 matchea con la transferencia de **SAN JOSE** (no con Sorribas); la de Sorribas aparece "devuelta — ignorada". El $212.193,83 doble queda como diferencia real (1 transferencia sin factura).
- Reproducir el cruce desde el borrador de Rene Cantina y confirmar el cambio de estados antes/después.
