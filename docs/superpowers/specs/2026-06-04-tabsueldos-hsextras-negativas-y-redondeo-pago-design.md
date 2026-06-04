# TabSueldos — Hs extras negativas + pagar de más (redondeo)

**Fecha:** 2026-06-04
**Autor:** Lucas (dirigiendo) + Claude
**Pantalla:** `packages/pase/src/pages/rrhh/TabSueldos.tsx`
**Estado:** Aprobado en chat, listo para implementar.

Dos features independientes pedidas por Lucas sobre la card de sueldo de un empleado.

---

## Feature 1 — Hs extras en negativo

### Problema
Hoy "Hs extras" no acepta negativos (igual que el resto de las novedades). Lucas quiere
poder cargar hs extras negativas como ajuste/descuento de horas. **Solo** Hs extras; el
resto de los campos (Faltas, Dobles, Feriados, Vacaciones, Otros desc.) siguen sin permitir
negativos.

### Estado actual relevante
- `calcularHorasExtras(horas, sueldo)` en `src/lib/calculos/rrhh.ts` **ya acepta negativos**
  (comentario y soporte agregados 2026-05-19). El cálculo NO necesita cambios.
- `NovInput` tiene `min={0}` y clampea negativos a 0.
- `persistirNovedad` hace `horas_extras: Math.max(0, nov.horas_extras || 0)`.
- DB: CHECK `rrhh_novedades_no_negativos_ck` (migración 202606041700) bloquea
  `horas_extras < 0`.
- Display desglose (línea ~1256): `nov.horas_extras > 0 && ...` con label `+ N hs extra`.

### Cambios
1. **`NovInput`**: agregar prop `allowNegative?: boolean`. Cuando true, sacar `min={0}` y no
   clampear negativos. Pasarlo solo en el input de Hs extras.
2. **`persistirNovedad`**: para `horas_extras` usar `nov.horas_extras || 0` (sin
   `Math.max(0,...)`). El resto de campos siguen clampeados.
3. **Migración SQL nueva**: recrear `rrhh_novedades_no_negativos_ck` quitando la condición
   `horas_extras >= 0` (mantener las otras 5 columnas en `>= 0`).
4. **Display**: en el desglose en vivo y en las pills, mostrar bien el signo de hs extras
   negativas. Condición pasa de `> 0` a `!== 0`; label y signo según corresponda
   (`− 2 hs extra → −$X` en rojo). El total nunca baja de $0 (ya lo cubre
   `calcularDesglose` con `Math.max(0, total)`).

---

## Feature 2 — Pagar de más (redondeo para arriba)

### Problema
En Argentina ya casi no hay billetes chicos, así que al pagar sueldos en efectivo se redondea
para arriba. Hoy el botón **Confirmar** exige que Efectivo + MP sea exactamente igual al
total, y bloquea cualquier diferencia.

Decisiones de Lucas:
- Solo permitir pagar **de más**, nunca de menos (de menos sigue bloqueado).
- El extra **no se contabiliza aparte**: simplemente sale de la caja elegida junto con el
  pago. No se crea "saldo a favor" ni "deuda". (Ej: sueldo $9.900, pagás $10.000 → la caja
  registra un gasto de $10.000 y listo.)
- En legajo / cajas / historial el pago figura por el **monto real pagado** ($10.000), sin
  desglosar la diferencia.
- **Warning siempre** que se pague de más.
- El **aguinaldo se calcula sobre el sueldo real** ($9.900 / 12), no sobre lo pagado de más.

### Estado actual relevante
- Backend `pagar_sueldo` (migración 202605201300) ya acepta sobrepago, PERO capea
  `pagos_realizados` al total (`v_nuevos_pagos := LEAST(total, ...)`). El movimiento de caja
  sí registra el monto real. Por eso hoy el banner de pagado muestra $9.900 aunque salieron
  $10.000.
- Trigger `_resync_liquidacion_pagos` (migración 202605222300, deuda C4-F15) recalcula
  `pagos_realizados = SUM(-importe)` de los movimientos **sin capear**, y marca `estado`.
  Hoy la RPC pisa ese valor con el capeado (la RPC corre su UPDATE después del trigger).
- No hay CHECK constraint ni invariante E2E que exija `pagos_realizados <= total_a_pagar`.
- El único lugar de UI que muestra "monto pagado del sueldo" es el banner de pagado en
  TabSueldos (`liqInfo.pagos_realizados`). Caja ya muestra el movimiento real. TabEmpleados
  no muestra montos de liquidación.

### Cambios
1. **Confirmar (gate de la card)**: permitir confirmar cuando `cargado >= total`. Si
   `cargado < total` sigue bloqueado ("Falta $X"). Si `cargado > total` deja confirmar +
   warning **siempre**: *"Estás pagando $X de más"*. Cambiar el copy de "Excede en $X".
2. **Modal Pagar**: mismo criterio. Hoy ya deja pagar cualquier monto > 0; arreglar el copy
   que dice "(faltan $0)" cuando se paga de más → mostrar "pagás $X de más". (No romper el
   pago parcial existente, que es una feature aparte de cuotas.)
3. **Backend `pagar_sueldo`**: quitar el cap → `v_nuevos_pagos := v_ya_pagado +
   v_asignado_total` (sin `LEAST`). Así `pagos_realizados` guarda el monto real, alineado con
   el trigger. **Aguinaldo se sigue calculando sobre `total_a_pagar / 12`** (línea ya
   existente, no cambia). No se crea saldo a favor ni deuda. Actualizar comentarios que decían
   "capeado / nunca excede total".

### Contabilidad / EERR
- EERR (devengado) lee `rrhh_liquidaciones.total_a_pagar` = $9.900 → el sueldo real. El
  sobrepago NO infla el EERR.
- Caja (percibido) registra el movimiento de $10.000. El gap de $100 es "vuelto que no se
  dio" — coherente con la distinción devengado vs percibido del proyecto.

---

## Tests (obligatorios por reglas del repo)
1. **Unitario** `rrhh.test.ts`: confirmar `calcularTotalLiquidacion` con `horas_extras`
   negativas (descuenta del total; total nunca < 0 vía wrapper).
2. **E2E mutante** nuevo (`tests/*_mutante.spec.ts`): pagar $10.000 de un sueldo de $9.900 →
   caja −$10.000, liquidación `estado=pagado` + `pagos_realizados=10.000`, aguinaldo sobre
   $9.900. Sentinel numérico distintivo, asserts DB-only estrictas, cleanup en afterEach.
3. **E2E full** (`tests/e2e-full/sprint-1/`): agregar caso de sobrepago + caso de novedad con
   hs extras negativas. Ajustar/sumar invariante SQL si corresponde.

## Riesgos / a verificar en implementación
- Que ningún otro consumidor de `pagos_realizados` rompa al recibir un valor > total (revisar
  Caja, EERR, dashboards). Verificado preliminar: no hay constraint ni invariante que lo
  prohíba.
- Que `confirmarSlot` con plan > total preserve el comportamiento al pre-llenar el modal de
  pago (líneas = plan, paga el monto real).
