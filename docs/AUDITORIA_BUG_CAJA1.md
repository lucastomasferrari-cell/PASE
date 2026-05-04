# Auditoría — Bug Caja-1 (cuenta mal cargada por value-not-in-options)

**Generado**: 2026-05-04T19:57:45.755Z
**Ventana**: gastos desde 2026-03-05 hasta hoy (60 días)
**Método**: cruce de `gastos` × `auditoria` (detalle JSON) × `usuarios.cuentas_visibles`

## Resultado

- Total gastos en el período: **41**
- **Gastos potencialmente mal cargados: 1**
- Gastos sin fila de auditoría asociada (no se puede determinar quién los cargó): 7
- Monto total afectado: **$160.000**

> Esto es **estimativo**. Algunos casos pueden ser legítimos: usuarios con permiso especial, cuentas otorgadas y luego revocadas, etc. Lucas decide caso por caso.

## Breakdown por usuario

| Usuario | Cantidad |
|---|---:|
| CAJA BELGRANO (encargado) | 1 |

## Breakdown por cuenta destino persistida

| Cuenta persistida | Cantidad |
|---|---:|
| MercadoPago | 1 |

## Lista detallada de gastos sospechosos

| Gasto ID | Fecha | Cuenta persistida | Monto | Usuario | cuentas_visibles del usuario | Detalle |
|---|---|---|---:|---|---|---|
| GASTO-1777916715-facf | 2026-05-04 | MercadoPago | $160.000 | CAJA BELGRANO (encargado) | Caja Chica, Caja Mayor | Sueldo Abril Daniel Sushi |

## Notas

- La auditoría **NO modifica ninguna fila**. Solo lee.
- El fix de Caja-1 (commit en branch fix-bugs-camilo-caja) previene el bug a futuro pero **no corrige los gastos ya mal cargados**.
- Para cada gasto sospechoso, Lucas decide:
  - Si la cuenta persistida es la equivocada → corregir vía edición de movimiento (Caja.tsx ya tiene "Editar movimiento" con justificativo).
  - Si era legítimo (permiso especial, cuenta antes-visible) → ignorar.
- 7 gastos sin auditoría: pueden ser anteriores a la migración `20260418_auditoria.sql` o haber fallado el INSERT en auditoria por algún motivo.
