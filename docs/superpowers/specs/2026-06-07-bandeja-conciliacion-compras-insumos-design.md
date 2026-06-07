# Pieza A — Bandeja conciliadora Compras → Insumos — Design Document

**Fecha:** 2026-06-07
**Autor:** brainstorming session (Lucas + Claude)
**Estado:** 🟡 SPEC ESCRITO — pendiente revisión Lucas
**Approach:** Reutilizar el cableado existente (factura_items + materias_primas con factor+merma + trigger compras→stock) y construir una **bandeja de conciliación** que acumula los renglones de mercadería sin mapear (manual + IA) y los resuelve una sola vez, con memoria.
**Parte de:** el roadmap "encender circuito Compras→Insumos→Stock→CMV". Es la Pieza A (desbloqueante). Le siguen B (Recetas), C (Stock), D (CMV/AvT), E (mudanza PASE/COMANDA).

---

## 1. Resumen ejecutivo

Hoy, que una factura se convierta en stock/costo depende de vincular a mano cada renglón a una materia prima en el modal manual de Compras. **El Lector IA no vincula nada.** No hay un lugar que acumule los pendientes.

Esta pieza agrega una **bandeja conciliadora**: toda factura (manual o IA) se guarda al toque; los renglones de **mercadería** que el sistema no pudo reconocer solos caen en la bandeja; los resolvés en un lugar (auto-sugerencia + crear insumo/materia prima en un paso + descartar). **Una vez mapeado un producto, queda en memoria** y la próxima factura con ese producto se auto-vincula — la bandeja se vacía con el tiempo.

**Lo que NO se hace acá:** el editor de recetas/sub-recetas y el % de rendimiento del insumo (Pieza B), el dashboard de stock/CMV/AvT (Piezas C/D), la mudanza de pantallas PASE/COMANDA (Pieza E).

---

## 2. Modelo de datos — fundamento (3 conceptos)

Decisión bloqueada (07-jun). Estándar R365 / MarketMan / Apicbase, simplificado a 3 conceptos:

| Concepto | Qué es | Equivalente pro |
|---|---|---|
| **Materia Prima** | Lo que comprás, por proveedor. Entra por factura. Ej: "Trucha entera · Pescadería X · caja 10kg". **No** va en recetas. | Purchased/Vendor Item (R365, MarketMan) |
| **Insumo** | Lo que va en las recetas, listo para usar. Ej: "Trucha fileteada (g)". Tiene un **rendimiento** desde su materia prima (entera→fileteada 60%). | Inventory Item + waste% (Apicbase) |
| **Receta / Sub-receta** | Misma entidad, anidada. Una receta usa insumos y/o sub-recetas. Cada una tiene su "rinde X". | Recipe / Prep Recipe (todos) |

### 2.1. Reconciliación con el esquema REAL (clave: ya está casi todo)

Verificado en prod el 07-jun:

- ✅ `insumos` existe → la lista que ve la receta.
- ✅ `materias_primas` existe con `insumo_id` (→ a qué insumo abastece), `factor_conversion` (empaque: caja→kg), **`merma_pct`** (rendimiento entera→fileteada) y `precio_actual`. **El puente Materia Prima → Insumo con rendimiento YA existe.**
- ✅ `factura_items` tiene `materia_prima_id` (nullable).
- ✅ `crear_factura_completa` ya inserta los renglones en `factura_items` (manual **y** IA) — la IA los deja con `materia_prima_id = NULL`.
- ✅ Trigger `trg_factura_item_entrada_stock`: cuando un `factura_item` tiene `materia_prima_id`, suma stock al insumo aplicando `factor_conversion` (y debería aplicar `merma_pct`, ver §6).
- ✅ Venta cobrada → descuenta insumos por receta (probado).

**Conclusión:** la bandeja es mayormente **frontend + lógica de auto-match + una tabla de memoria de mapeo**. No hay que rehacer el modelo.

### 2.2. Aclaración semántica (no es cambio de schema, es de uso)

Bajo el modelo, el **insumo es el ítem ya procesado/listo** (trucha fileteada), y la **materia prima carga el rendimiento** hacia él (`merma_pct`). Los insumos que no se procesan (vinagre, mayonesa) = materia prima con `merma_pct = 0` (rendimiento 100%). Un insumo puede recibir de **varias** materias primas (multi-proveedor) → su costo es el promedio ponderado.

---

## 3. La bandeja conciliadora

### 3.1. Qué entra

Un renglón de factura va a la bandeja si:
1. La factura es de una **categoría de mercadería** (bucket `cat_compra` / CMV), **y**
2. El renglón **no tiene** `materia_prima_id`, **y**
3. El auto-match (§4) **no** lo pudo vincular solo, **y**
4. No fue **descartado** antes (§3.4).

Servicios, alquiler, impuestos, etc. **no** entran (no son mercadería).

### 3.2. Dos vistas (decisión: ambas, con toggle)

- **Por factura**: "Factura Distribuidora A · 07/06 · 3 productos sin vincular". Para cerrar una compra puntual.
- **Por producto** (dedupeado): junta todas las facturas y muestra "8 productos nuevos para mapear". Mapeás cada uno **una vez** y se auto-vinculan todas las facturas que lo usan.

### 3.3. Resolución (decisión: tabla rápida + panel guiado al tocar)

- **Tabla rápida**: todos los pendientes en una planilla; por fila elegís/creás la materia prima, decís cómo viene (empaque + cantidad) y guardás todo junto. Ideal para la carga inicial de 30+ productos.
- **Panel guiado** (al tocar una fila, sobre todo nueva): en lenguaje natural — "este producto es la materia prima [Trucha entera], viene en [caja] de [10] [kg]". El sistema arma la materia prima sola. Para productos sin procesar, ofrece crear el **insumo** 1:1 en el mismo paso (rendimiento 100%).
- El usuario **nunca crea dos cosas a mano**: la pantalla encadena materia prima (+ insumo opcional) en un flujo.

### 3.4. Descartar ("no es un insumo")

Botón para marcar un renglón como **no-stockeable** (propina, flete, redondeo). Queda registrado y **no vuelve** a la bandeja. Reversible desde un filtro "descartados".

---

## 4. Auto-match (la "memoria")

Cuando entra un renglón (manual o IA), antes de mandarlo a la bandeja el sistema intenta reconocerlo:

1. **Memoria exacta**: tabla nueva `compras_mapeo` con `(tenant_id, proveedor_id, texto_producto_normalizado) → materia_prima_id`. Si el mismo proveedor ya facturó ese texto, **auto-vincula** (no pasa por la bandeja).
2. **Fuzzy / alias**: si no hay match exacto pero hay uno muy parecido (nombre del producto vs nombre de materia prima / alias), **sugiere** "¿es la misma X?" para confirmar con un toque (y guarda el nuevo alias en `compras_mapeo`).
3. Si no hay nada → a la bandeja.

Cada resolución en la bandeja **escribe en `compras_mapeo`**, así el aprendizaje es permanente. La bandeja se vacía a medida que se mapean los productos habituales.

---

## 5. Flujo IA + manual (unificado)

```
Cargás factura (manual)  ─┐
Lector IA lee factura     ─┴─► crear_factura_completa (guarda factura + factura_items)
                                        │
                                        ▼
                          auto-match por renglón (§4)
                            ├─ reconocido → set materia_prima_id → trigger stock+costo
                            └─ nuevo → queda en la bandeja (materia_prima_id NULL, mercadería)
                                        │  (resolvés cuando querés)
                                        ▼
                          resolver en bandeja → set materia_prima_id (+ crea MP/insumo/mapeo)
                                        │
                                        ▼
                          trigger trg_factura_item_entrada_stock → stock + costo
```

- El **modal manual** sigue teniendo su auto-sugerencia inline (ya existe); lo que NO se resuelva ahí cae igual en la bandeja (no se pierde).
- El **Lector IA** no cambia su guardado; solo se le corre el auto-match y sus renglones nuevos aparecen en la bandeja.

---

## 6. Qué pasa al resolver

1. Se setea `materia_prima_id` en el/los `factura_items`.
2. El trigger existente suma stock al insumo aplicando **`factor_conversion`** (empaque: caja→kg). **El rendimiento (`merma_pct`) NO se aplica en esta pieza**: que la merma vaya al entrar (stock = fileteada) o al consumir (stock = entera) es la misma decisión de "dónde se cuenta el stock físico" que está diferida a la **Pieza C**. Para la Pieza A el trigger queda como está (solo empaque).
3. El **costo** del insumo se actualiza (promedio ponderado de sus materias primas activas; `materias_primas.precio_actual` = último precio de factura).
4. El movimiento de stock se fecha con la **fecha de la factura** (retroactivo) para que el histórico/AvT quede bien.
5. Se escribe `compras_mapeo` (memoria).

---

## 7. Cambios de schema (mínimos)

```sql
-- Memoria de mapeo proveedor+producto → materia prima (auto-match + aprendizaje)
CREATE TABLE compras_mapeo (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  proveedor_id    int REFERENCES proveedores(id),       -- NULL = match global
  texto_norm      text NOT NULL,                          -- producto normalizado (lower, sin acentos, trim)
  materia_prima_id int NOT NULL REFERENCES materias_primas(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      int REFERENCES usuarios(id),
  UNIQUE (tenant_id, proveedor_id, texto_norm)
);
-- RLS dual estándar (tenant_id = auth_tenant_id()).

-- Marcar un renglón como "no es insumo" (no vuelve a la bandeja)
ALTER TABLE factura_items ADD COLUMN descartado_conciliacion boolean NOT NULL DEFAULT false;
```

(No se crean tablas de stock ni de recetas — son de otras piezas.)

---

## 8. Backend / RPCs

- **`fn_compras_automatch(p_factura_item_id)`** (o trigger AFTER INSERT en `factura_items`): aplica §4. Si encuentra match, setea `materia_prima_id`. SECURITY DEFINER con check de tenant.
- **`fn_conciliar_producto(...)`**: resuelve uno o varios renglones — crea/vincula materia prima (+ insumo opcional con su empaque/rendimiento), escribe `compras_mapeo`, setea `materia_prima_id` en TODOS los `factura_items` del mismo (proveedor, texto) pendientes. Atómica + idempotency_key.
- **`fn_descartar_renglon(p_factura_item_id, p_motivo)`**: marca `descartado_conciliacion=true`.
- **Vista `v_bandeja_conciliacion`**: renglones pendientes (mercadería, sin MP, no descartados) con datos de factura + proveedor + sugerencia de match, lista para las dos vistas.
- Reutiliza: `crear_factura_completa`, `trg_factura_item_entrada_stock`, `materias_primas` CRUD.

Códigos de error UPPER_SNAKE mapeados en `errors.ts`.

---

## 9. UX / pantallas (en PASE)

- Nueva pantalla **Conciliación de compras** dentro de Compras/Recetario (sidebar PASE).
- Header con contador (badge de pendientes) + toggle **Por factura / Por producto**.
- Tabla rápida editable + panel guiado lateral al tocar una fila.
- Botón "Descartar" por fila. Filtro "ver descartados".
- Badge de pendientes visible desde el menú Compras (para que no se olvide).

---

## 10. Permisos

- `compras.conciliar` — ver y resolver la bandeja (rol compras/admin/dueño).
- Vive en **PASE** (tarea de administración/compras, no de cocina).

---

## 11. Plan de fases

- **Fase 0 — Schema** (chico): `compras_mapeo` + columna `descartado_conciliacion` + RLS. (El trigger NO se toca — la merma es de Pieza C.)
- **Fase 1 — Backend**: `fn_compras_automatch`, `fn_conciliar_producto`, `fn_descartar_renglon`, vista `v_bandeja_conciliacion`.
- **Fase 2 — Frontend**: pantalla Conciliación (dos vistas + tabla + panel), badge en menú, wiring con el modal manual y el Lector IA.
- **Fase 3 — Pulido**: aprendizaje de alias fuzzy + filtro descartados + contadores.

Cada fase con su commit + verificación. Neko sigue operando (la bandeja no rompe nada existente; solo agrega).

---

## 12. Testing

- **Mutante** (`tests/*_mutante.spec.ts`): cargar factura con renglón de mercadería → cae en bandeja → `fn_conciliar_producto` → `materia_prima_id` seteado + stock sumado con `factor`+`merma` + `compras_mapeo` escrito + segunda factura con mismo producto **auto-vincula** (no entra a bandeja).
- **Mutante**: `fn_descartar_renglon` → no aparece en `v_bandeja_conciliacion`.
- **e2e-full**: agregar operación "cargar factura mercadería → conciliar → stock impacta" + invariante.
- Unit: normalización de texto (lower/acentos/trim) del auto-match.

---

## 13. Diferido / open questions

1. **Dónde se cuenta el stock físico** (raw vs prepped, flag stockeable) → **Pieza C (Stock)**. Incluye **cuándo se aplica el rendimiento (`merma_pct`)**: al entrar la compra (stock = fileteada) o al consumir en la venta (stock = entera). No bloquea la Pieza A.
2. **Costo del insumo**: promedio ponderado de materias primas activas, ventana de últimas N compras → afinar en Pieza B/C. Default: promedio simple de MPs activas.
3. **Match global vs por proveedor**: `compras_mapeo` soporta ambos (proveedor_id NULL = global). Default: por proveedor; permitir marcar "este mapeo vale para cualquier proveedor".
4. **Mermas de almacenamiento** (no de procesamiento) → Pieza C.

---

**Glosario:**
- **Materia prima** = producto de compra (por proveedor).
- **Insumo** = ingrediente listo para usar (con rendimiento desde su materia prima).
- **Conciliar** = mapear un producto de factura a su materia prima (una vez, queda en memoria).
- **Auto-match** = reconocer solo un producto ya mapeado.
- **Rendimiento / merma** = % que sobrevive al procesar (trucha entera 60% → fileteada).
