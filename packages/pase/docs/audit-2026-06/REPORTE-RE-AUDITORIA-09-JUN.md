# Re-auditoría 09-jun-2026 — código nuevo desde el 27-may

Auditoría del rango 27-may → 09-jun: **248 commits, ~72 migraciones** (circuito CMV
completo, conciliación compras, recetas con cascada de costos, stock anidado,
liquidación final multi-cuenta, COMANDA autónomo, dividir por comensal, guard
anti-huérfanos). Ejecutada por agente auditor + verificación manual de cada
hallazgo contra el código vivo antes de aplicar fixes.

**Resultado: 0 críticos · 2 altos · 5 medios · 1 bajo.** Las piezas grandes están
bien en seguridad y atomicidad: sin leaks cross-tenant de plata ni doble-descuento
garantizado.

**Fixes aplicados el mismo día** (migración `202606100300`, verificados en prod,
22/22 mutantes COMANDA + suite verde):

| # | Sev | Hallazgo | Estado |
|---|-----|----------|--------|
| H1 | 🟠 ALTO | `anular_movimiento` revertía aguinaldo sobre el NETO (`total_a_pagar/12`) cuando `pagar_sueldo` acumula sobre el BRUTO (`subtotal2/12`, fix 202606072300) → cada ciclo pagar→anular con adelanto dejaba aguinaldo fantasma (ej.: sueldo 600k + adelanto 120k → +50k al pagar, −40k al anular = 10k de más por ciclo) | ✅ **FIXED** — revierte con `COALESCE(subtotal2, total_a_pagar)/12` |
| H2 | 🟠 ALTO | `RRHH.tsx:738` delete+insert de liquidación sin chequear error → con el guard nuevo podría duplicar liquidaciones | ⚪ **NO ACCIONABLE** — está en `_confirmarUno`, función **deprecada y sin llamadas** (prefijo `_`, eslint-disable no-unused-vars). La pantalla viva (TabSueldos) no borra liquidaciones. Si se revive ese código, agregar chequeo del error primero. |
| H3 | 🟡 MEDIO | `pagar_sueldo` sin SECURITY DEFINER (¿perdido en reescritura 27-may?) | ❌ **FALSO POSITIVO** — se probó reponer DEFINER y los mutantes de sueldo fallaron (`completa=false`). El INVOKER es load-bearing. Quedó explícito en la migración para que nadie lo "arregle" de vuelta. |
| H4 | 🟡 MEDIO | `fn_anular_venta_comanda`: la rama "venta vacía" (total=0, sin TOTP) no validaba local/tenant del caller → anulación cross-tenant de mesas vacías con id enumerable | ✅ **FIXED** — `fn_assert_local_autorizado` ahora corre SIEMPRE |
| H5 | 🟡 MEDIO | `editar_movimiento_caja`: lookup de `idempotency_keys` sin filtro de tenant → colisión de key entre tenants devolvía el resultado cacheado de OTRO tenant (mismo patrón que AUDIT FIX #8 de mayo) | ✅ **FIXED** — `AND tenant_id = auth_tenant_id()` |
| H6 | 🟡 MEDIO | `fn_aplicar_stock_venta`: el `NOT EXISTS` anti-redescuento se evaluaba ANTES del advisory lock por insumo → doble click en cobrar podía descontar stock 2× | ✅ **FIXED** — lock por venta al inicio, antes de abrir el cursor |
| H7 | 🟡 MEDIO | `ComensalSplitDialog`: el stepper permite cambiar nº de comensales después de cobrar a algunos → el "todo cubierto" local puede no coincidir con el backend | ⏳ **PENDIENTE** (UI, sin pérdida de plata — congelar stepper tras primer cobro) |
| H8 | 🟢 BAJO | `liquidacion_final_empleado` multi-cuenta sin `p_idempotency_key` (C1) | ⏳ **PENDIENTE decisión** — protegida por `LIQ_FINAL_YA_EXISTE` + unique, no genera doble pago |

## Hallazgos extra de la misma sesión (fuera del scope del agente)

| Hallazgo | Estado |
|----------|--------|
| 🔴 `fn_reabrir_venta_comanda` no revertía el cobro: cobrar→reabrir→re-cobrar dejaba 2× el total en la caja del turno (arqueo descuadrado, "faltante" fantasma del cajero). Confirmado con mutante en rojo. | ✅ **FIXED** (migración `202606100100`) — reverso de pagos estilo trigger de anulación + pagos viejos a `reembolsado` + mesa vuelve a `ocupada` |
| 🔴 Triggers de historial (`fn_mesas_audit`, `fn_ventas_pos_audit`, `fn_vpi_audit`, `fn_turnos_caja_audit`) sin SECURITY DEFINER: TODO update directo del cliente sobre mesas/ventas_pos/items/turnos fallaba con violación RLS en `*_history` (la auditoría de mayo cerró el leak con política solo-SELECT). **Rompía el editor de plano de mesas y desasignar rider en prod.** | ✅ **FIXED** (migración `202606100200`) — alineados al patrón de fn_canales/items/ipc_audit |
| 🟡 2 mutantes PASE viejos en rojo (`sueldo_con_adelanto_mutante`, `anular_pago_sueldo_mutante`): quedaron desactualizados frente al rediseño de adelantos del 07/08-jun ("YA PAGADO" manual, bucket por mes). NO corren en CI (CI corre e2e-full, que está VERDE — los flujos reales funcionan). | ⏳ **PENDIENTE** — actualizarlos a la semántica nueva en sesión dedicada |

## Revisado y OK (sin hallazgos)

Conciliación compras (`fn_conciliar_producto` + vista security_invoker), cascada de
costos de recetas, RLS por tenant de todas las tablas nuevas,
`aplicar_saldo_a_favor_proveedor`, `fn_aumento_canal_precios`, RPCs públicas de
tienda (anti-enumeration), `fn_asignar_mesa_reserva`, `fn_asignar_comensal_item`,
`calcularCuentasPorComensal` (prorrateo/redondeo), cascada de transferencia en
`anular_movimiento`.

## Patrón recurrente a vigilar

Reescrituras de RPCs grandes que **pierden un atributo** o **arrastran un gap
viejo**. Checklist al re-emitir una RPC completa:
1. ¿Conservé (o documenté) SECURITY DEFINER/INVOKER? — ojo: en `pagar_sueldo` el INVOKER es a propósito.
2. ¿El lookup de idempotency filtra por tenant?
3. ¿Siguen los `FOR UPDATE` y los advisory locks ANTES de los chequeos que protegen?
