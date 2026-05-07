# Investigación BUG 3 — Pérdida de decimales al cargar facturas

**Estado:** investigación read-only. Sin cambios en código todavía.
**Fecha:** 2026-04-26.

---

## 1. Archivos involucrados

### Frontend — flow manual
- `packages/pase/src/pages/Compras.tsx`
  - **L57** `emptyForm` con todos los campos monto inicializados como `""` (string vacío).
  - **L62-69** `calcTotal()` usa `parseFloat()` directo sobre cada campo.
  - **L178** `nueva = { ...form, neto: parseFloat(form.neto), iva21: parseFloat(form.iva21) || 0, iva105: …, iibb: …, perc_iva: …, otros_cargos: …, descuentos: …, total }` ← **insert payload**.
  - **L179** `db.from("facturas").insert([nueva])`.
  - **L183** items: `cantidad: parseFloat(it.cantidad) || 0, precio_unitario: parseFloat(it.precio_unitario) || 0`.
  - **L189** `proveedores.update({ saldo: Math.max(0, (prov.saldo || 0) + saldoDelta) })`.
  - **L205** `pagar`: `monto = parseFloat(pagoForm.monto) || f.total`.
  - **L384, 387-394** inputs `type="number"` (sin `step`).
  - **L411, 413** ítems: inputs `type="number"` (sin `step`).
  - **L501** modal Pagar: input `type="number"` (sin `step`).

### Frontend — flow IA
- `packages/pase/src/pages/LectorFacturasIA.tsx`
  - **L16** `useState({ …, neto:0, iva21:0, iva105:0, iibb:0, total:0 … })` — campos monto como `number`.
  - **L44-96** POST a `/api/claude` con prompt que pide JSON con punto decimal.
  - **L101** `parsed = JSON.parse(clean)` — la IA devuelve numbers nativos JS.
  - **L110-131** validación de magnitud (10M cap), coherencia items, coherencia desglose.
  - **L146-158** `setForm` con `neto: parseMonto(parsed.neto_gravado)`, etc.
  - **L174** `totalForm = parseMonto(form.total)` para detectar duplicados.
  - **L217** `db.from("facturas").insert([{ ...form, …, neto:parseMonto(form.neto), iva21:parseMonto(form.iva21), iva105:…, iibb:…, total:parseMonto(form.total), … }])` ← **insert payload**.
  - **L227** `proveedores.update({ saldo: (prov.saldo||0) + parseMonto(form.total) })`.
  - **L364, 370** inputs `type="number" step="0.01"`.

### Helper de parsing (correcto)
- `packages/pase/src/lib/utils.ts`
  - **L10-29** `parseMonto(v)` — maneja: number passthrough, AR coma decimal, miles con punto/coma, fallback a 0. **Es el helper correcto.**
  - **L38** `fmt_$()` con `minimumFractionDigits:2` — el display NUNCA trunca a entero. Bug NO está acá.

### Proxy IA
- `packages/pase/api/claude.js`
  - 14 líneas. Reenvía `req.body` literal a `https://api.anthropic.com/v1/messages`. **Es transparente** — no parsea ni transforma respuesta.

### BD — funciones tocadas en pago
- `pagar_factura(p_factura_id, p_monto, p_cuenta, p_fecha, p_detalle)` RPC.
- `anular_factura(p_factura_id, p_motivo)` RPC.
- (Diag confirmó: NO usan `ROUND/FLOOR/TRUNC/CEIL` en su body. NO hay triggers en `facturas`.)

### Diag temporal (read-only, sin commitear)
- `packages/pase/diag_facturas.cjs` — script Node que loguea schema, sample, agregados, RPCs, triggers. **Borrar al cerrar la investigación.**

---

## 2. Schema BD

### Tabla `facturas`
Columnas relevantes (todas `numeric` sin precision/scale → arbitraria):
- `neto numeric`
- `iva21 numeric`
- `iva105 numeric`
- `iibb numeric`
- `perc_iva numeric`
- `otros_cargos numeric`
- `descuentos numeric`
- `total numeric`

> Postgres `numeric` sin parámetros = hasta 131,072 dígitos antes del punto, 16,383 después. **NO trunca decimales. La BD no es la causa del bug.**

### Tabla `factura_items`
- `cantidad numeric`
- `precio_unitario numeric`
- `subtotal numeric`

### Tabla `factura_items_stock`
(análogo, sin precision constraints).

### Sample de facturas (de diag)
23/29 facturas tienen decimales no-cero almacenados (`total - FLOOR(total) > 0`).
6/29 tienen total entero exacto. Pueden ser:
- (a) facturas genuinamente redondas (1.000,00 ARS, vale).
- (b) carga vieja con decimales perdidos por el bug.
**Sin diferenciar (a) vs (b) sin examinar cada caso individual.**

### RPCs relevantes en pg_proc (filtro `proname ILIKE '%factura%'`)
- `pagar_factura(p_factura_id, p_monto, p_cuenta, p_fecha, p_detalle)`
- `anular_factura(p_factura_id, p_motivo)`
- (otras posibles según output del diag — el diag las lista todas).

**Bodies:** ninguno tiene `ROUND/FLOOR/TRUNC/CEIL` (verificado en diag).

### Triggers en `facturas`
Ninguno (verificado en diag).

---

## 3. Diagrama de flow

### Flow manual (Compras.tsx)

```
[USER] tipea "1234,56" en <input type="number" /> (sin step)
   │
   ▼
[BROWSER] type="number" intenta normalizar.
   │  · Chrome es-AR: usualmente convierte "," → "." y deja value="1234.56"
   │  · Otros: pueden devolver value="1234,56" raw, o "" si rechaza
   │  · Puede que step implícito=1 marque .56 como stepMismatch (NO bloquea el value)
   ▼
[REACT] e.target.value → setForm({ neto: e.target.value })
   │  form.neto es siempre STRING desde el input
   ▼
[CALC] calcTotal() = parseFloat(form.neto) + parseFloat(form.iva21) + ...
   │  ⚠ parseFloat("1234,56") = 1234  (¡pierde decimal!)
   │  ⚠ parseFloat("1234.56") = 1234.56  ✓
   ▼
[GUARDAR] nueva = { ...form, neto: parseFloat(form.neto), iva21: parseFloat(...) || 0, ... }
   │  ⚠ parseFloat aplicado a CADA monto. Mismo riesgo si llegó coma.
   ▼
[INSERT] db.from("facturas").insert([nueva])  →  Postgres numeric column  →  guarda lo recibido
                                                                              (si recibió 1234, guarda 1234.00)
```

### Flow IA (LectorFacturasIA.tsx)

```
[USER] sube archivo (PDF/JPG/PNG)
   │
   ▼
[CLAUDE API via /api/claude] devuelve JSON con números nativos JS
   │  Prompt instruye: "usá punto decimal: 166876.67. NUNCA elimines la coma decimal"
   │  Defensa en profundidad: validación magnitud (>10M), coherencia items, coherencia desglose
   ▼
[REACT setForm] form.neto = parseMonto(parsed.neto_gravado)
   │  parseMonto(166876.67) = 166876.67  ✓ (passthrough number)
   │  form.* queda como NUMBER nativo
   ▼
[USER] (opcional) edita un input type="number" step="0.01"
   │  e.target.value → string, p.ej. "166876.67"
   │  form.* queda como STRING
   ▼
[GUARDAR] insert([{ ...form, neto: parseMonto(form.neto), iva21: parseMonto(...), ... }])
   │  parseMonto(number) = passthrough  ✓
   │  parseMonto(string AR/intl) = normaliza correctamente  ✓
   ▼
[INSERT] Postgres numeric  →  guarda con decimales correctos  ✓
```

**Observación:** el flow IA es robusto end-to-end gracias a `parseMonto`. Si Lucas reporta pérdida de decimales en este flow, hay que verificar:
1. ¿Está editando algún campo manualmente? (Si edita y el browser no normaliza coma→punto, podría haber un caso, aunque parseMonto debería capturarlo bien.)
2. ¿La IA está devolviendo JSON con números correctos? (El prompt es claro pero LLMs pueden alucinar — la validación L110 detecta magnitudes >10M pero NO detecta `100` cuando debió ser `100.50`.)
3. ¿Hay alguna factura concreta donde se vea el bug? Para reproducir.

---

## 4. Hipótesis confirmadas

### H1 (alta confianza) — `parseFloat` en `Compras.tsx` no soporta coma decimal AR

**Evidencia:**
- Compras.tsx:178 hace `parseFloat(form.neto)` directo, idem para todos los montos (L62-69 calcTotal, L183 items, L205 monto pago).
- `parseFloat("1234,56") === 1234` — pierde el `,56` silenciosamente.
- `parseFloat("1.234,56") === 1.234` — interpreta el `.` como decimal y trunca después de la coma.
- BD acepta sin truncar (numeric ilimitado).
- Existe `parseMonto()` en utils.ts que SÍ maneja AR/intl pero **NO se usa en Compras.tsx**.

**Cuándo se manifiesta:**
- Si el browser no normaliza el comma del input `type="number"` (varía por versión/locale/keyboard layout).
- Si el campo se popula via copy-paste con formato AR (`"1.234,56"` queda en el value).
- Si el campo se popula programáticamente desde algún lugar que use string AR.

### H2 (media confianza) — pérdida silenciosa de centavos en sumas/restas

**Evidencia:**
- En Compras.tsx, `calcTotal()` suma 7 parseFloat. Si CUALQUIERA pierde centavos, el `total` calculado queda truncado.
- El `total` calculado se inserta directo (L178 `total` viene de `calcTotal()` via L142 `totalAbs`).
- Si neto = 1234 (debió ser 1234.56) e iva21 = 259 (debió ser 259.26), total = 1493 en lugar de 1493.82.

### H3 (baja confianza) — flow IA: posible pérdida en suma `iibb + perc_iva`

**Evidencia:**
- LectorFacturasIA L155: `iibb: parseMonto(parsed.percepciones_iibb) + parseMonto(parsed.percepciones_iva)`.
- JS floating-point: `0.1 + 0.2 = 0.30000000000000004`. Sumas en JS pueden tener artefactos.
- **No es "pérdida" sino "ruido" en último decimal.** Probablemente irrelevante para gastronomía.
- **Estructural, no es la causa principal del bug reportado.**

### H4 (descartada) — BD trunca decimales

**Evidencia contra:**
- Schema verificado: todas las columnas `numeric` SIN precision constraint.
- 23/29 facturas tienen decimales no-cero almacenados.
- RPCs `pagar_factura`/`anular_factura` no tienen `ROUND/FLOOR/TRUNC`.
- Sin triggers en `facturas`.
**→ La BD no es la causa.**

### H5 (descartada) — Display redondea

**Evidencia contra:**
- `fmt_$` usa `minimumFractionDigits:2, maximumFractionDigits:2`. Siempre 2 decimales en pantalla.
**→ El display no es la causa.**

---

## 5. Plan de fix propuesto (cambios mínimos)

### Cambio principal — Compras.tsx
Reemplazar **TODOS** los `parseFloat()` sobre montos por `parseMonto()`. Importar el helper que ya existe.

**Diff conceptual:**

```diff
  import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";
+ import { toISO, today, fmt_d, fmt_$, genId, parseMonto } from "../lib/utils";

  const calcTotal = () =>
-   (parseFloat(form.neto) || 0) +
-   (parseFloat(form.iva21) || 0) +
-   (parseFloat(form.iva105) || 0) +
-   (parseFloat(form.iibb) || 0) +
-   (parseFloat(form.perc_iva) || 0) +
-   (parseFloat(form.otros_cargos) || 0) -
-   (parseFloat(form.descuentos) || 0);
+   parseMonto(form.neto) +
+   parseMonto(form.iva21) +
+   parseMonto(form.iva105) +
+   parseMonto(form.iibb) +
+   parseMonto(form.perc_iva) +
+   parseMonto(form.otros_cargos) -
+   parseMonto(form.descuentos);

  // L178 (insert payload):
- neto: parseFloat(form.neto),
- iva21: parseFloat(form.iva21) || 0,
- iva105: parseFloat(form.iva105) || 0,
- iibb: parseFloat(form.iibb) || 0,
- perc_iva: parseFloat(form.perc_iva) || 0,
- otros_cargos: parseFloat(form.otros_cargos) || 0,
- descuentos: parseFloat(form.descuentos) || 0,
+ neto: parseMonto(form.neto),
+ iva21: parseMonto(form.iva21),
+ iva105: parseMonto(form.iva105),
+ iibb: parseMonto(form.iibb),
+ perc_iva: parseMonto(form.perc_iva),
+ otros_cargos: parseMonto(form.otros_cargos),
+ descuentos: parseMonto(form.descuentos),

  // L183 (items):
- cantidad: parseFloat(it.cantidad) || 0,
- precio_unitario: parseFloat(it.precio_unitario) || 0,
+ cantidad: parseMonto(it.cantidad),
+ precio_unitario: parseMonto(it.precio_unitario),

  // L127-128 (updateItem subtotal):
- const q = parseFloat(field === "cantidad" ? val : newItems[i].cantidad) || 0;
- const p = parseFloat(field === "precio_unitario" ? val : newItems[i].precio_unitario) || 0;
+ const q = parseMonto(field === "cantidad" ? val : newItems[i].cantidad);
+ const p = parseMonto(field === "precio_unitario" ? val : newItems[i].precio_unitario);

  // L205 (pagar monto):
- const monto = parseFloat(pagoForm.monto) || f.total;
+ const monto = parseMonto(pagoForm.monto) || f.total;
```

**Notas:**
- `parseMonto` ya devuelve `0` para vacío/NaN, así que el `|| 0` es redundante. Mantener `|| f.total` en pagar (fallback distinto de 0).
- Cambios en **un solo archivo**, aproximadamente 14 líneas.
- No tocar inputs HTML (`type="number"` se mantiene — el cambio es solo en el parsing).

### Cambio opcional — agregar `step="0.01"` a inputs montos en Compras.tsx
Para mejorar UX (Compras.tsx no tiene step, pero LectorFacturasIA sí).
- Sin step, el browser puede mostrar warning "stepMismatch" cuando el value tiene decimales.
- No bloquea el value, pero ensucia la UX.

```diff
- <input type="number" value={form.neto} … />
+ <input type="number" step="0.01" value={form.neto} … />
```

(Aplicar a 7 inputs: neto, iva21, iva105, iibb, perc_iva, otros_cargos, descuentos. Y los 2 de items: cantidad, precio_unitario. Y el de pagar: monto.)

### NO se necesita migración de datos
- BD ya guarda decimales correctos (23/29 con decimales).
- Las 6/29 con total entero: hay que decidir caso por caso si son legítimas o data corrupta.
- **Recomendación: no migrar automáticamente.** Si Lucas detecta una factura con decimales perdidos, corregirla manualmente con UPDATE puntual.

---

## 6. Riesgos del fix

### Riesgo 1 (bajo) — facturas legacy con totales enteros
- 6/29 facturas tienen `total` sin decimales.
- Algunas pueden ser legítimas (`$1.000,00` literal); otras pueden ser víctimas del bug histórico.
- **El fix no las arregla retroactivamente.** Quedan como están.
- **Mitigación:** auditoría manual de las 6 facturas. Si Lucas confirma cuáles son corruptas, UPDATE puntual al `total` correcto.

### Riesgo 2 (muy bajo) — `calcTotal()` cambia comportamiento si había coma
- ANTES: `parseFloat("1234,56") = 1234`, total subestimado.
- DESPUÉS: `parseMonto("1234,56") = 1234.56`, total correcto.
- **Esto es exactamente el fix.** No es un riesgo, es lo deseado.
- Pero si Lucas tiene flow donde "ya se acostumbró" al total truncado, el cambio será notable. (Improbable — la queja es la opuesta.)

### Riesgo 3 (bajo) — proveedor.saldo recalculado
- Compras.tsx L189 usa `prov.saldo + saldoDelta`. saldoDelta viene del `total` correcto.
- Después del fix, los saldos NUEVOS se calculan con decimales correctos.
- **Saldos LEGACY no cambian** — siguen reflejando lo histórico.
- Puede haber drift visual entre "saldo prov" y "suma facturas pendientes" si conviven facturas pre/post fix.
- **Mitigación:** ya hay un panel "deuda pendiente" (Compras.tsx L260-289) que recalcula desde `facturas` directamente. La verdad última está ahí.

### Riesgo 4 (muy bajo) — flow IA no necesita cambio
- LectorFacturasIA ya usa `parseMonto`. **No tocar.**
- Si Lucas reporta que también pierde decimales ahí, hay que reproducir con un caso concreto. La hipótesis fuerte es: Claude devolvió un número alucinado/redondeado en JSON. Eso lo cubre la validación L110 parcialmente, pero no detecta truncamiento sin signal de magnitud.
- **Acción si pasa:** revisar payload guardado contra factura física, ajustar prompt si es alucinación recurrente.

### Riesgo 5 (mínimo) — items en factura_items
- L183 hace `parseFloat(it.cantidad) || 0` y `parseFloat(it.precio_unitario) || 0`.
- Si Lucas tipea cantidades con coma ("1,5 kg"), el subtotal se calcula mal.
- Mismo fix aplica acá. Riesgo: ninguno — es la misma corrección.

---

## Resumen ejecutivo

**Bug real:** `Compras.tsx` usa `parseFloat()` directo en 14 lugares, lo que pierde decimales si el browser deja pasar la coma AR. `parseMonto()` ya existe en utils.ts y maneja todos los formatos correctamente, pero solo se usa en `LectorFacturasIA.tsx`.

**BD:** correcta (numeric sin precision, sin triggers, RPCs sin ROUND).

**Fix:** reemplazar 14 `parseFloat` por `parseMonto` en `Compras.tsx`. ~1 archivo, sin migración de datos, sin tocar BD.

**Riesgo:** mínimo. Las facturas existentes no se modifican; solo los nuevos inserts se hacen correctamente.

**Pendiente decidir antes de ejecutar:**
1. ¿Querés que haga el fix solo o esperás más diagnóstico?
2. ¿Querés que también agregue `step="0.01"` a los inputs (cambio cosmético, mejora UX)?
3. ¿Auditamos las 6/29 facturas con total entero para detectar legacy corruptas?
