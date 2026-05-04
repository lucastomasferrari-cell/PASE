# Auditoría — Bug Caja-1 (extendida a Compras / Remitos / RRHH)

**Generado**: 2026-05-04T21:12:36.243Z
**Ventana**: movimientos desde 2026-03-05 hasta hoy (60 días)
**Método**: cruce de `movimientos` × `auditoria` (detalle JSON, indexado por FK) × `usuarios.cuentas_visibles`

## Resultado global

- Total movimientos no-anulados en el período: **209**
- Gastos en el período (puede haber doble-conteo con movimientos): 41
- **Movimientos potencialmente mal cargados: 2**
- Movimientos sin fila de auditoría asociada: 60
- Monto absoluto total afectado: **$3.777.300,43**

> Esto es **estimativo**. Algunos casos pueden ser legítimos: cuentas otorgadas y luego revocadas, usuarios con scope cambiado entre carga y auditoría, etc. Lucas decide caso por caso.

## Breakdown por path de carga

| Path (módulo de carga) | Cantidad |
|---|---:|
| Gastos (cargar) | 1 |
| Caja (movimiento manual) | 1 |

## Breakdown por usuario

| Usuario | Cantidad |
|---|---:|
| CAJA BELGRANO (encargado) | 1 |
| Agostina (encargado) | 1 |

## Breakdown por cuenta destino persistida

| Cuenta persistida | Cantidad |
|---|---:|
| MercadoPago | 1 |
| Caja Chica | 1 |

## Lista detallada de movimientos sospechosos

| Mov ID | Path | Fecha | Cuenta | Importe | Usuario | cuentas_visibles | Detalle |
|---|---|---|---|---:|---|---|---|
| `MOV-1777916715-77bb` | Gastos (cargar) | 2026-05-04 | MercadoPago | $-160.000 | CAJA BELGRANO (encargado) | Caja Chica, Caja Mayor | Sueldo Abril Daniel Sushi |
| `MOV-1777047907-4a6f` | Caja (movimiento manual) | 2026-04-01 | Caja Chica | $3.617.300,43 | Agostina (encargado) | MercadoPago, Banco | saldo inicial |

## Movimientos legacy con local_id NULL

Reportar (no tocar). Nota del prompt: hay un movimiento legacy con local_id=NULL contra MercadoPago. Listamos los del período por si aparecen más.

| Mov ID | Fecha | Cuenta | Importe | Tipo | Detalle |
|---|---|---|---:|---|---|
| `MOV-1776870196619-b5wk` | 2026-04-21 | MercadoPago | $-9.545,65 | Gasto variable | ZILVER SA  |

## Notas

- La auditoría **NO modifica ninguna fila**. Solo lee.
- El refactor de permisos (PR refactor-permisos-cuentas) previene que el bug aparezca con el patrón controlled-select-value-not-in-options. NO corrige los movimientos ya mal cargados.
- Para cada caso sospechoso, Lucas decide:
  - Si la cuenta persistida es la equivocada → corregir vía edición de movimiento (Caja.tsx → Editar Movimiento, con justificativo).
  - Si era legítimo (permiso especial, cuenta antes-visible) → ignorar.
- 60 movimientos sin fila de auditoría: pueden ser anteriores a la migración `20260418_auditoria.sql`, INSERT directo desde código (no vía RPC), o haber fallado el INSERT en auditoria por algún motivo.
