# Investigación TASK 0.12 — Borrado de cierre deja movimiento huérfano

**Estado:** investigación read-only. Sin cambios todavía.
**Fecha:** 2026-04-27.

---

## 1. Estado actual del flow de borrado

### Entry points en frontend

Solo **un archivo** tiene rutas de borrado para `ventas`: `Ventas.tsx`.
Confirmado con grep `(\.delete\(|rpc\(.eliminar_venta)` sobre todo `packages/pase/src/`.

| Acción usuario | Función | Ubicación | Llama a |
|---|---|---|---|
| ✕ en línea de detalle | `eliminarLinea(id)` | Ventas.tsx:136-148 | `eliminar_venta` RPC |
| Botón "Eliminar cierre" en modal detalle | `eliminarBloque(grupo)` | Ventas.tsx:150-160 | `eliminar_venta` RPC en loop |

### Código de `eliminarBloque` (Ventas.tsx:150-160)

```ts
const eliminarBloque=async(grupo)=>{
  if(!confirm(`¿Eliminar el cierre completo del ${fmt_d(grupo.fecha)} ${grupo.turno}?`))return;
  // RPC en serie por venta — cada call ajusta su movimiento + saldo.
  // No usamos Promise.all para que las restas de saldo sean
  // determinísticas y los errores se vean uno a uno.
  for(const v of grupo.items){
    const {error}=await db.rpc("eliminar_venta",{p_venta_id:v.id});
    if(error){alert("Error eliminando venta "+v.id+": "+(error.message||""));return;}
  }
  setDetalleModal(null);load();
};
```

**Observaciones:**
- Loop secuencial, await por venta — correcto para determinismo.
- En error: `alert + return`. Las ventas YA borradas quedan borradas — **sin rollback transaccional a nivel cierre completo**.
- Si el cierre tiene 5 ventas y falla en la 3ª: las 2 primeras se borraron (con sus movs ajustados). La 3-4-5 quedan sin tocar.

---

## 2. Rutas que evitan `eliminar_venta` RPC

### Frontend
**Cero rutas detectadas.**

Grep `\.delete\(` sobre `packages/pase/src/`:
- `Recetas.tsx:55` — `receta_items.delete()` (otra tabla).
- `RRHH.tsx:472` — `rrhh_liquidaciones.delete()` (otra tabla).
- `RRHHLegajo.tsx:272` — `rrhh_documentos.delete()` (otra tabla).
- `Usuarios.tsx:128, 137` — `usuario_permisos/locales.delete()` (otras tablas).

**Ninguna sobre `ventas`.** ✓

### Otras pages que tocan `ventas`
Solo lectura (verificado con grep `from\(.ventas.\)`):
- `Cashflow.tsx:58`, `Cierre.tsx:27`, `Contador.tsx:18`, `Dashboard.tsx:31,37`, `EERR.tsx:28` — todos `select()`.
- `Ventas.tsx:37,69,121` — select, insert, **update directo** (ver siguiente).
- `ImportarMaxirest.tsx:138,148` — select (verificación duplicado) e insert.

### ⚠ Riesgo lateral detectado: `editar_venta` no cubre todos los campos

`Ventas.tsx:121-126` hace **update directo** (sin RPC) sobre `fecha/turno/medio/local_id`:

```ts
await db.from("ventas").update({
  fecha:editModal.fecha,
  turno:editModal.turno,
  medio:editModal.medio,
  local_id:parseInt(editModal.local_id),
}).eq("id",id);
```

El RPC `editar_venta` solo recalcula sobre cambios en `monto`. Si Lucas cambia `medio` (ej: EFECTIVO SALON → MercadoPago Online), el movimiento sigue en la cuenta vieja → descuadre.

Comentario en código lo reconoce (L116-120): *"Cambiar estos puede descuadrar el saldo en casos raros... La UI debería desactivar esos campos en un sprint futuro."*

**No es el bug del task 0.12, pero es el mismo patrón.** Probablemente vale la pena tratarlo después.

### ⚠ Riesgo lateral 2: insert de movimiento de Maxirest "no crítico"

`ImportarMaxirest.tsx:178`:
```ts
if(movErr) console.error("[maxirest] movimiento error (no crítico):",movErr.message);
```

Si el insert de la venta succede pero el del movimiento falla, el cierre queda **sin movimiento desde el momento cero**. Eliminar luego ese cierre con `eliminar_venta` borrará la venta pero no encontrará movimiento que ajustar. Saldo de Caja Chica: nunca se sumó, nunca se resta — coherente. **No es el bug reportado**, pero es otra fuente de "huérfanos invisibles".

---

## 3. Backwards compat — cierres legacy sin `venta_ids[]`

El RPC `eliminar_venta` (migration `202604271522_ventas_rpcs_atomicas.sql`) lo maneja **explícitamente**:

```sql
-- L67-69
SELECT * INTO v_mov FROM movimientos
WHERE venta_ids @> ARRAY[p_venta_id]::text[]
LIMIT 1;

-- L71-94: si encuentra mov, ajusta importe + saldo
IF v_mov.id IS NOT NULL THEN
  ...
END IF;

-- L95-97: si NO encuentra (legacy), pasa derecho al delete de venta
DELETE FROM ventas WHERE id = p_venta_id;
```

**Comportamiento con cierre legacy:**
- Borra la fila de `ventas`.
- **NO toca el movimiento** (no lo encuentra por venta_ids).
- **NO ajusta `saldos_caja`**.
- Audita con `mov_id: NULL, mov_borrado: false`.

**Comentario del migration (L18-20) explícito:**
> Backwards compat: para ventas legacy cuyos movimientos no tienen venta_ids match, las RPCs operan SOLO sobre la fila de ventas. Los movs viejos son inmutables (ya están corregidos manualmente).

---

## 4. Hipótesis sobre el bug reportado

> Lucas: "cuando se borra un cierre de turno (o una venta del cierre),
> el movimiento asociado en Caja Chica NO se borra. Queda huérfano y
> descuadra el saldo."

### H1 (más probable) — el cierre borrado era LEGACY
Pre-commit `4bccd8b` (RPCs ventas atómicas), todos los cierres se cargaban con un `INSERT` directo a movimientos sin `venta_ids`. Cuando Lucas borra hoy uno de esos cierres:
- `eliminar_venta` no encuentra el mov → no lo borra (comportamiento esperado del RPC, documentado).
- Saldo descuadrado por el monto del cierre.

**Cómo verificar:** SQL diag (ver sección 6).

### H2 — flow de Maxirest insertó el mov pero el insert falló silenciosamente
`ImportarMaxirest.tsx:178` traga el error del insert de movimientos como "no crítico". Si pasó eso en algún cierre nuevo, el mov nunca existió → al borrar la venta no hay nada que ajustar. **Saldo coherente** (nunca se sumó, nunca se resta). **No es el bug reportado.**

### H3 (poco probable) — race condition
Si Lucas hace doble click en "Eliminar cierre" durante el loop secuencial, podría haber re-entradas. `eliminarBloque` no tiene guard `setDeleting(true)`. Puede quedar mid-state. **No es el bug, pero es otro frente débil.**

### H4 (descartada) — error en RPC
La lógica de `eliminar_venta` está OK. Auditoría incluida (L99-110), error handling (L52, 57, 63), atomicidad por RPC. No hay path donde la venta se borre y el mov no, si `venta_ids` está bien seteado.

---

## 5. Plan de fix propuesto

### Paso 1 (diagnóstico antes de tocar código) — confirmar H1

Script SQL **read-only** para correr una vez. Cuenta:
- Cuántos cierres en prod tienen movimientos con `venta_ids` populated vs NULL.
- Cuántos movimientos `tipo = 'Ingreso Venta'` tienen `venta_ids IS NULL` (huérfanos potenciales).
- Cuántas ventas existen sin movimiento que las linkee (huérfanas inversas — ventas sin caja).

```sql
-- A. Movimientos de venta con/sin venta_ids
SELECT
  COUNT(*) FILTER (WHERE venta_ids IS NULL OR cardinality(venta_ids) = 0) AS sin_link,
  COUNT(*) FILTER (WHERE venta_ids IS NOT NULL AND cardinality(venta_ids) > 0) AS con_link
FROM movimientos
WHERE tipo = 'Ingreso Venta';

-- B. Distribución por fecha de los huérfanos
SELECT date_trunc('week', fecha)::date AS semana, COUNT(*)
FROM movimientos
WHERE tipo = 'Ingreso Venta' AND (venta_ids IS NULL OR cardinality(venta_ids) = 0)
GROUP BY 1 ORDER BY 1;

-- C. Ventas sin movimiento (cierres que nunca impactaron Caja Chica)
SELECT v.id, v.fecha, v.turno, v.medio, v.monto
FROM ventas v
LEFT JOIN movimientos m ON v.id = ANY(m.venta_ids)
WHERE m.id IS NULL
  AND v.fecha >= '2026-04-26'  -- post-deploy de RPCs
LIMIT 20;
```

**Decisión post-diag:**
- Si A muestra **muchos** huérfanos legacy → confirmamos H1, el RPC se está comportando bien y solo falta UX feedback (paso 2).
- Si C muestra ventas nuevas sin mov → confirmamos H2, hay que arreglar Maxirest insert.
- Si todo se ve limpio pero Lucas sigue viendo el bug → necesitamos el `id` de un cierre concreto para reproducir.

### Paso 2 — UX: hacer visible el caso legacy

El RPC ya devuelve `mov_borrado: boolean` y `mov_id: text|null` en su respuesta JSON. El frontend lo ignora.

**Cambio mínimo en Ventas.tsx:**

```diff
  const eliminarBloque=async(grupo)=>{
    if(!confirm(`¿Eliminar el cierre completo del ${fmt_d(grupo.fecha)} ${grupo.turno}?`))return;
+   const huerfanos = [];
    for(const v of grupo.items){
-     const {error}=await db.rpc("eliminar_venta",{p_venta_id:v.id});
+     const {data,error}=await db.rpc("eliminar_venta",{p_venta_id:v.id});
      if(error){alert("Error eliminando venta "+v.id+": "+(error.message||""));return;}
+     if(data && data.mov_borrado === false && !data.mov_id){
+       huerfanos.push(v);
+     }
    }
+   if(huerfanos.length > 0){
+     const total = huerfanos.reduce((s,v)=>s+(v.monto||0),0);
+     alert(`⚠ Cierre legacy: ${huerfanos.length} venta(s) por ${fmt_$(total)} se borraron pero sus movimientos de Caja Chica del ${fmt_d(grupo.fecha)} no estaban linkeados (cierre cargado pre-2026-04-27). Verificá manualmente en Caja Chica si hay un movimiento con ese monto en esa fecha y borralo si corresponde.`);
+   }
    setDetalleModal(null);load();
  };
```

Mismo cambio en `eliminarLinea` (versión single-venta).

**Por qué este cambio:**
- Cierres legacy: Lucas se entera y arregla a mano (búsqueda en Caja Chica → borrar movimiento huérfano).
- Cierres nuevos: el alert no aparece nunca, UX no cambia.
- Sin cambios en RPC ni BD.

### Paso 3 (opcional, posterior) — wrapper RPC atómico para cierre completo

Si Lucas quiere atomicidad de cierre completo (no que se quede a mitad si falla la 3ª venta), agregar:

```sql
CREATE OR REPLACE FUNCTION public.eliminar_cierre(p_fecha date, p_turno text, p_local_id int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_venta RECORD;
  v_count int := 0;
  v_huerfanos int := 0;
BEGIN
  -- Auth — mismo patrón que eliminar_venta
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  FOR v_venta IN
    SELECT id FROM ventas
    WHERE fecha = p_fecha AND turno = p_turno AND local_id = p_local_id
  LOOP
    PERFORM eliminar_venta(v_venta.id);
    v_count := v_count + 1;
  END LOOP;

  -- Auditoría top-level del cierre completo
  PERFORM _auditar('ventas', 'ELIMINAR_CIERRE', jsonb_build_object(...));

  RETURN jsonb_build_object('ventas_borradas', v_count);
END; $$;
```

Frontend reemplaza el loop por una sola call. Si una venta falla, **toda la transacción rollbackea** (PG transaction implícita en función plpgsql). **No urgente** — el flow actual funciona. Hacer si Lucas pide atomicidad.

### Paso 4 (no hacer) — match heurístico de movimientos legacy
**Descartado por instrucción del user.** No intentar matchear por fecha+monto+cuenta — riesgo de falsos positivos.

### Paso 5 (recomendado, después) — desactivar campos no soportados en `editar_venta`
La UI permite cambiar `medio`/`local_id` con update directo (Ventas.tsx:121). Si lo hacés, el mov queda apuntando a la cuenta/local viejo. Mismo patrón de bug. Ver "Riesgo lateral 1" arriba. **Fuera de scope del task 0.12** pero del mismo árbol.

---

## 6. Riesgos del fix

### Riesgo 1 (mínimo) — alert de "cierre legacy" se dispara en falso
Si por algún edge case un cierre nuevo NO tiene `venta_ids` poblado (ej: venta cargada con un script manual que olvidó linkear), Lucas recibe el alert y va a Caja Chica. **No daño** — solo verificación extra. Lucas decide.

### Riesgo 2 (bajo) — Lucas ignora el alert
Si lo recibe y no actúa, el saldo queda descuadrado. Mitigación: el alert es bloqueante (`alert()`), pero Lucas puede cerrar y olvidarse. Mejora futura: registrar la "deuda de limpieza" en una tabla `mantenimiento_pendiente` para auditoría.

### Riesgo 3 (bajo) — el `data` del RPC podría no tener `mov_borrado` por algún proxy/error
La RPC define `RETURN jsonb_build_object(...)` con esos campos. Supabase los pasa tal cual. Si no llegan, el `if(data && data.mov_borrado === false ...)` simplemente es `false` y el alert no se dispara. **Sin crash.**

---

## Resumen ejecutivo

**Bug real reportado:** ambiguo entre "cierre legacy" (H1, comportamiento del RPC documentado) y "cierre nuevo con problema" (H2/H3, requeriría reproducir).

**Estado del código actual:**
- `eliminarLinea` y `eliminarBloque` usan `eliminar_venta` RPC. ✓
- Cero rutas que eviten el RPC. ✓
- RPC maneja cierres legacy correctamente — los borra **sin tocar** movimientos huérfanos. ✓ (por diseño documentado)

**Próximos pasos propuestos en orden:**
1. Correr el diag SQL (sección 5, paso 1) para clasificar el bug.
2. Aplicar UX feedback (paso 2) — único cambio de código, mínimo, ~10 líneas en Ventas.tsx.
3. Si Lucas quiere atomicidad: paso 3 (wrapper RPC `eliminar_cierre`).
4. Pendiente futuro: paso 5 (reforzar `editar_venta`).

**Pendiente decidir antes de ejecutar:**
- A) ¿Corremos el diag SQL primero, o ya pasás directo al fix (paso 2)?
- B) ¿Querés también el wrapper `eliminar_cierre` atómico (paso 3) o lo dejamos para después?
- C) ¿Movs huérfanos legacy: los listamos y los limpiamos manualmente, o los dejamos como están?
