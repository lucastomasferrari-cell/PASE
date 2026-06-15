# Spec — Módulo Cashflow (Ruta del Dinero) · PASE

**Fecha:** 2026-06-14
**Autor:** Lucas + Claude
**Estado:** Diseño para revisión

---

## 1. Objetivo

Dar al dueño una **ruta del dinero** clara y verificable: cuánto arrancó, cuánto entró, cuánto salió y en qué, cuánto quedó — y **por qué la ganancia del Estado de Resultados (EERR) no coincide con la plata real en las cuentas**.

Nace de un problema real (Rene Cantina): el EERR decía ~$120M de ganancia pero la caja estaba justa. La causa no era falta de rentabilidad, sino **plata atrapada en capital de trabajo** (stock, float de tarjetas a liquidar), **timing de pagos** (devengado ≠ pagado) y **comisiones/IVA sin registrar** que inflaban la ganancia teórica.

### Distinción central (no negociable)
- **EERR = devengado** (base del hecho económico): ya existe en PASE (`Reportes`).
- **Cashflow = percibido** (plata que se movió de verdad): lo que construye este módulo.
- Son dos vistas distintas y ambas válidas. El módulo NO reemplaza el EERR: lo complementa y construye **el puente** entre los dos.

---

## 2. Alcance

### MVP (esta entrega)
1. Consolidar 3 cuentas: **Efectivo** (cajas de PASE), **MercadoPago**, **Banco**.
2. **Efectivo** sale de PASE automático; **MP y Banco** se cargan subiendo el extracto/cierre del mes.
3. Clasificación automática (con memoria) de cada línea + corrección manual.
4. **Cuenta "en tránsito"** (float): plata vendida que todavía no se acreditó.
5. **Venta bruta → comisión/retención → neto** explícito.
6. Vista mensual: saldo inicial + ingresos − egresos = saldo final, **verificado contra el saldo de cierre del extracto**.
7. **El puente** devengado↔cash con líneas de capital de trabajo (stock, por cobrar, por pagar, retiros, aportes).
8. **Cerrar/bloquear** el mes conciliado (control: no se modifica después).
9. UX: waterfall del mes + drill-down por categoría.

### Fase 2 (marcado, no se construye ahora)
- **Proyección / forecast a 13 semanas** (mirar hacia adelante: ¿cuándo me quedo corto?).
- **Alertas de quiebre de caja + runway.**
- **Escenarios "¿y si...?"** (¿y si reparto $X?).
- **Cálculo de "cuánto repartir"** (reserva / Profit First) — apoyado en el forecast.

### Fuera de alcance (decidido con Lucas, 14-jun)
- **USD / multimoneda** — no se incluye.
- **Cheques / pagos diferidos** — no en MVP; el modelo de datos NO debe impedir sumarlos después (otros locales los usan).
- **Integración automática de MP** — por ahora extracto manual (la integración no funcionó bien). El diseño debe permitir cambiar a feed automático más adelante sin rehacer todo.

---

## 3. Arquitectura de datos

### Fuentes
| Cuenta | Fuente | Mecanismo |
|---|---|---|
| Efectivo (Caja Chica/Mayor/Efectivo) | `movimientos` de PASE | automático |
| MercadoPago | extracto `.xlsx` oficial | upload mensual |
| Banco (BBVA) | resumen PDF/xlsx | upload mensual |

### Tablas nuevas (multi-tenant + multi-local, columnas estándar `tenant_id`, `local_id`, `created_at`, `updated_at`, RLS dual)
- **`cashflow_extractos`**: un registro por archivo subido. `cuenta` (MercadoPago/Banco), `periodo_mes` (date primer día), `saldo_inicial`, `saldo_final`, `archivo_url`, `estado` (borrador/confirmado). Reusa patrón de Conciliación si conviene.
- **`cashflow_lineas`**: cada línea parseada. `extracto_id`, `fecha`, `descripcion`, `monto_bruto`, `comision`, `retencion`, `monto_neto`, `categoria`, `es_interno` (bool), `regla_id` (qué regla la clasificó), `confirmada` (bool).
- **`cashflow_reglas`**: memoria de clasificación. `patron` (texto normalizado de la descripción), `categoria`, `es_interno`. Auto-match por texto normalizado (mismo patrón que `compras_mapeo` de la bandeja de conciliación de compras).
- **`cashflow_cierres`**: mes cerrado/bloqueado. `periodo_mes`, `saldos` (jsonb por cuenta), `bloqueado` (bool), `bloqueado_at`, `bloqueado_por`. Una vez bloqueado, las líneas de ese mes son read-only.

### Categorías de clasificación
`venta` · `comision` · `retencion/impuesto` · `proveedor` · `sueldo` · `gasto` · `retiro_socio` · `aporte_socio` · `obra_capex` · `transferencia_interna` · `otro`.

> **`transferencia_interna`** (entre tus propias cuentas: alivios caja↔caja, efvo↔MP↔banco, MP→banco): se marca y **NO cuenta** como ingreso ni egreso (netea). Es la causa de la mayoría de los descuadres históricos.

> **Refinado 2026-06-15 (brainstorm):** ver el **Addendum 2026-06-15** al final de este documento — el cashflow hereda las categorías del PyL por fecha de pago, los `retiro_socio` se gestionan en un **módulo Utilidades** aparte (con una **CAJA UTILIDADES** de reserva), y se agrega una vista de **libro contable / línea de tiempo**. La definición anti-mezcla de abajo sigue vigente y se refuerza.

### 3.1 Definición estricta de "retiro de socio" (anti-mezcla) — CRÍTICO

Fue el error recurrente de toda la reconstrucción: cosas que parecían retiros y no lo eran inflaban el número de reparto (de ~$57M real a ~$90M falso). El módulo debe **separar tajantemente**:

**ES `retiro_socio`** (distribución de utilidades — sale de la ganancia):
- La **repartija formal** a los socios (las "ganancias" que se llevan los dueños).
- Idealmente ligada a la repartija del mes (qué % de qué ganancia) y al destinatario socio.

**NO es `retiro_socio`** (aunque lo parezca):
- **Transferencias internas / alivios** (caja→caja, local→casa, entre cuentas). En los libros viejos los alivios estaban mal etiquetados como "retiro socios" → es `transferencia_interna`.
- **"Retiro efectivo" / "retiro del local"** = mover plata entre cajas. Es `transferencia_interna`, NO afecta P&L ni es distribución.
- **Pagos a personas/familiares por obra o servicios** (ej. "Armando Baldi" = mantenimiento) → `obra_capex` / `proveedor`, NO retiro.
- **Movimientos operativos a la cuenta de un socio que administra la plata** (ej. Anto, que es admin y pareja del dueño): mover plata a su cuenta para operar ≠ distribución. Solo la parte que es reparto es `retiro_socio`.
- **Aportes de capital** (plata que el socio PONE) → `aporte_socio`, es ingreso/financiación, NO retiro.

**Reglas de implementación:**
1. **`retiro_socio` NUNCA se auto-asigna por nombre del destinatario** (que diga "Baldi" o "retiro" en la descripción no lo hace retiro). Requiere **marcación/confirmación explícita** del usuario.
2. El módulo muestra un **total de retiros separado y auditable** (por socio, por mes), distinto de transferencias internas y de aportes.
3. Opcional (suma valor): **conciliar retiros vs repartija decidida** — comparar lo que se sacó contra lo que correspondía repartir, para detectar sobre/sub-distribución.

---

## 4. La cuenta "en tránsito" (float) — pieza clave

Modela la plata **vendida pero no acreditada todavía** (tarjeta/QR/MP a liquidar; ej. MP pasó a pagar a 10 días). Inspirado en el "Undeposited Funds" de Restaurant365.

- **Saldo en tránsito = Σ ventas no-efectivo cargadas (bruto) − Σ liquidaciones recibidas (del extracto) − Σ comisiones/retenciones.**
- Se deriva de `ventas` (PASE, por `medio`) menos las liquidaciones del extracto MP/banco.
- Se muestra como una "cuenta" más en la foto, para que la plata en tránsito sea **visible** y la posición real = líquido + en tránsito.

Esto resuelve dos cosas a la vez: hace visible el float, y permite reconciliar **bruto vendido vs neto acreditado** (la diferencia = comisiones + lo que falta liquidar).

---

## 5. Cálculo del cashflow mensual

Por mes y por cuenta, y consolidado:

```
Saldo inicial (efvo + MP + banco + en tránsito)
  + Ingresos    [venta, aporte_socio, otros]            (excluye transferencia_interna)
  − Egresos     [proveedor, sueldo, gasto, comision,
                 retencion/impuesto, retiro_socio,
                 obra_capex]                              (excluye transferencia_interna)
  = Saldo final calculado
  ✓ vs Saldo de cierre real del extracto  → marca OK / diferencia
```

- Efectivo: de `movimientos` (con `applyLocalScope`), clasificado, excluyendo transferencias internas (alivios).
- MP/Banco: de `cashflow_lineas`.
- Verificación: el saldo final calculado debe igualar el `saldo_final` del extracto. Si no, se muestra la diferencia para investigar (igual que cazamos los gastos huérfanos).

---

## 6. El puente devengado ↔ cash (método indirecto)

Explica por qué la ganancia del EERR ≠ plata. Líneas explícitas:

```
Ganancia teórica del mes (EERR, devengado)
  − Aumento de stock / mercadería               (compraste y no vendiste aún)
  − Aumento de cuentas por cobrar (float)       (vendiste y no cobraste aún)
  + Aumento de deuda a proveedores (por pagar)  (compraste y no pagaste aún)
  − Retiros de socios
  + Aportes de socios
  − Inversión / obra (CAPEX) no contabilizada en EERR
  ± Comisiones / IVA no registrados en el EERR
  = Cash real generado en el mes
```

- **Stock**: PASE tiene módulo de stock → variación de inventario valorizado (si está cargado; si no, queda como input manual del mes).
- **Por cobrar (float)**: del saldo en tránsito (sección 4).
- **Por pagar**: `facturas` con estado pendiente/vencida (PASE ya lo tiene en Compras).
- **Retiros/aportes**: de las líneas clasificadas.

---

## 7. UX / pantalla

Nueva pantalla **"Cashflow"** bajo `DIRECCIÓN` (al lado de Conciliación / Reportes). Pensada para dueño no-contador: mostrar **movimiento y timing**, no saldos estáticos.

- **Selector de mes** + selector de local.
- **Waterfall del mes**: Saldo inicial → +ingresos (por categoría) → −egresos (por categoría) → Saldo final. Verde/rojo, con el ✓ de verificación.
- **Tarjetas de saldo por cuenta** (efvo, MP, banco, en tránsito) + total líquido.
- **El puente** (sección 6) como bloque desplegable.
- **Drill-down**: tocar una categoría → lista de las transacciones que la componen (reusa patrón de tablas existentes).
- **Subir extracto**: botón para cargar el cierre MP/banco del mes (como en Conciliación), con preview de la clasificación antes de confirmar.
- **Cerrar mes**: botón para bloquear el mes una vez verificado.

---

## 8. Reglas del repo a cumplir
- RPCs atómicas para cualquier escritura financiera (no inserts sueltos). C1 idempotency, C9 error codes UPPER_SNAKE, C11 auth en SECURITY DEFINER.
- `applyLocalScope` en toda query a tablas con `local_id`.
- Tablas nuevas con checklist (RLS dual, columnas estándar).
- Lazy import en `App.tsx` (C8).
- Test E2E mutante + e2e-full para la lógica de plata (clasificación/consolidación/cierre).

---

## 9. Riesgos / cosas a cuidar
- **Pisado de fuentes**: efectivo viene de PASE; no double-contar con lo que pudiera venir en un extracto. Definir claramente qué cuenta viene de dónde.
- **Transición de libros manuales → PASE** (Control Integral dejó de usarse a mediados de mayo; PASE es oficial): el "punto cero" / saldo inicial de arranque debe fijarse explícitamente por cuenta.
- **Formato de extractos**: MP (`account_statement.xlsx`) y BBVA (PDF) — ya se sabe parsear ambos; validar contra formatos futuros.
- **Clasificación imperfecta**: siempre permitir corrección manual + memoria; nunca bloquear por una línea sin clasificar.

---

## 10. Criterio de éxito (MVP)
Para un mes dado, el dueño ve: saldo inicial, en qué entró/salió la plata, saldo final **que cuadra con el extracto real**, y el puente que explica la diferencia con la ganancia del EERR — sin ayuda de un contador.

---

# Addendum 2026-06-15 — Clasificación de movimientos, libro contable y módulo Utilidades

> Refina las secciones §3 (categorías) y §7 (UX) tras el brainstorm con Lucas (15-jun). Surgió al investigar el efectivo real de Rene: los movimientos manuales (`Ingreso/Egreso Manual`, ~$37M en mayo) mezclan saldos de arranque + transferencias internas + retiros mal etiquetados, y NO se pueden clasificar derecho por `tipo`. Estas decisiones son **autoritativas** sobre el modelo de clasificación.

## A. El cashflow hereda las categorías del PyL, fechadas por pago

**Principio (decisión de Lucas):** el cashflow **no inventa** categorías para lo operativo. Sigue cada **pago** hasta su **documento de origen** y usa **la misma categoría que el PyL/EERR**:

| Movimiento de caja | Documento de origen | Categoría |
|---|---|---|
| `Pago Proveedor` (`fact_id` / `remito_id_ref`) | factura / remito (Compras) | la `cat` del documento (CMV/bebidas/almacén…) |
| `Gasto fijo/variable/impuesto` (`gasto_id_ref`) | gasto (Gastos) | la `cat` del gasto (fijos/variables/impuestos/comisiones/publicidad) |
| `Pago Sueldo` / `Gasto empleado` (`liquidacion_id` / `adelanto_id_ref`) | liquidación / adelanto (Equipo) | `sueldo` |
| `Ingreso Venta` | venta efectivo | `venta` |

**La única diferencia con el PyL es la FECHA:** el PyL cuenta por la fecha del **documento** (devengado = "lo comprado"); el cashflow por la fecha del **pago** (percibido = "lo pagado"). El mecanismo ya es posible: `movimientos` guarda los links (`fact_id`, `gasto_id_ref`, `remito_id_ref`, `liquidacion_id`, `adelanto_id_ref`).

## B. Categorías propias del cashflow (solo para movimientos SIN documento)

Los manuales sin documento no aparecen en el PyL ("no afectan el EERR pero sí el cashflow"). Sus categorías son propias del cashflow:

| Categoría | Qué es |
|---|---|
| `apertura_ajuste` | saldo inicial, "caja en 0", arqueos (sobrante/faltante). Fija/corrige el conteo; **no es flujo operativo**; de acá sale el punto cero. |
| `transferencia_interna` | mover plata entre cajas/cuentas propias (local→casa, caja→caja, → CAJA UTILIDADES). Netea, no cambia la plata total. |
| `aporte_socio` | un socio **pone** plata (ej. para pagar proveedores). Financiación, no venta. |
| `otro` | lo que no encaja, hasta clasificar. |
| `retiro_socio` | reparto a socios. **Existe como línea, pero se GESTIONA en el módulo Utilidades** (ver D). El cashflow nunca lo auto-asigna. |

`venta` también aplica a cobros (efectivo del mostrador + liquidaciones del extracto MP/banco).

## C. Reglas de clasificación

1. **Con documento de origen → automático.** Hereda la categoría del documento (sección A). La mayoría de los movimientos.
2. **`Transferencia Entrada/Salida` → automático** = `transferencia_interna`.
3. **`Ingreso Venta` → automático** = `venta`.
4. **`Ingreso/Egreso Manual` (sin documento) → reglas de texto + memoria + bandeja "Por revisar":**
   - `saldo inicial` / `caja en 0` / `ajuste` / `sobrante` / `faltante` → `apertura_ajuste`.
   - `retiro del local` / `de caja X a caja Y` / "retiro lucas-anto" cuando es **mover plata** → `transferencia_interna`.
   - `aporte de socio…` → `aporte_socio`.
   - **`retiro_socio` NUNCA automático** — los retiros reales se cargan en el módulo Utilidades (D), no se infieren de un movimiento de caja.
   - La bandeja "Por revisar" junta los manuales sin clasificar (pocos y grandes) para resolverlos de una; las decisiones se recuerdan (memoria por texto normalizado).
5. **Memoria:** se reusa `cashflow_mapeo` (texto normalizado del `detalle` → categoría). Auto-aplica para todas las categorías propias menos `retiro_socio`.
6. **Modelo de datos (implicación):** `movimientos` no puede guardar la categoría del cashflow → se agrega una tabla de override `cashflow_mov_clasif (tenant_id, movimiento_id, categoria, es_interno, updated_at)`. El motor resuelve la categoría así: **override manual > categoría heredada del documento > regla de texto/default**.

## D. Decomposición: módulo Utilidades + CAJA UTILIDADES (futuro, su propio spec)

Lucas definió que el reparto a socios vive en un **módulo nuevo "Utilidades / Reparto de utilidades"**, separado del cashflow.

- **CAJA UTILIDADES** = una **cuenta nueva de reserva** (el "balde" de Profit First hecho real). Mover plata operativa → CAJA UTILIDADES = `transferencia_interna` con sentido de **reservar** (apartar). De CAJA UTILIDADES → socio = el `retiro_socio` real.
- **Cashflow (ahora):** consolida **todas** las cuentas, incluida CAJA UTILIDADES si existe; muestra la posición partida en **líquido operativo vs reservado (Utilidades) vs en tránsito**. **No gestiona** el reparto; solo **muestra** la línea de retiros (de los movimientos ya tipados como retiro).
- **Utilidades (módulo futuro):** crea y gestiona CAJA UTILIDADES — reservar (apartar un %), repartir a socios, el fondo, "cuánto es seguro repartir" (Profit First, contra la repartija del mes). Crea los movimientos de retiro que el cashflow después lee.
- **Orden:** el cashflow trata CAJA UTILIDADES de forma **genérica** (una cuenta más), así no se traba esperando a Utilidades; la **creación + gestión** se hacen en el módulo Utilidades. Los retiros históricos mal cargados (ej. "RETIRO SOCIOS JUANMA" como Egreso Manual) se re-registran prolijo cuando se construya Utilidades.

## E. Vistas (refina §7)

Tres formas de ver el mismo mes:

1. **📖 Libro contable / línea de tiempo** *(pedido de Lucas):* tabla cronológica, una fila por movimiento, con **Debe | Haber | Saldo corrido** — se ve cómo el saldo sube y baja. Por cuenta (efvo / MP / banco / CAJA UTILIDADES) o consolidado.

   | Fecha | Concepto | Categoría | Debe | Haber | Saldo |
   |---|---|---:|---:|---:|---:|
   | 04/05 | Cobro tarjeta (liquidación) | venta | | 215.077 | 505.512 |
   | 05/05 | LEY 25.413 | retención | 398 | | 65.892 |
   | 06/05 | Pago proveedor Distribuidora | proveedor | 120.000 | | … |

2. **📊 Resumen / waterfall:** saldo inicial → +ingresos por categoría → −egresos por categoría → saldo final, **verificado vs el extracto** (✓ o diferencia). `retiro_socio` y `aporte_socio` en bloques separados (anti-mezcla).

3. **🌉 El puente** (§6): por qué la ganancia del PyL ≠ la plata.

**Posición de caja (tarjetas):** líquido operativo · reservado en CAJA UTILIDADES · en tránsito (float) · total. Drill-down: tocar una categoría del resumen → sus filas en el libro contable.

## F. Impacto en el plan de implementación

- **Categoría nueva `apertura_ajuste`:** se agrega a la lista válida de categorías. Requiere una migración chica que actualice el CHECK de `cashflow_reclasificar` (hoy en prod acepta: venta, comision, retencion, proveedor, sueldo, gasto, retiro_socio, aporte_socio, obra_capex, transferencia_interna, otro) y el `fn_cashflow_clasificar_default`. Nomenclatura canónica: **`retencion`** cubre impuestos (no hay categoría `impuesto` separada).
- **Task 6 (`cashflow_resumen_mes`)** se reescribe: el efectivo se categoriza siguiendo el link al documento (no por `tipo` crudo); los manuales usan `cashflow_mov_clasif` + reglas/memoria; excluye `transferencia_interna` y `apertura_ajuste` de ingresos/egresos operativos.
- **Nueva tarea (Fase 3.5):** migración `cashflow_mov_clasif` + `apertura_ajuste` en la lista válida + RPC `cashflow_reclasificar_mov` (espejo de `cashflow_reclasificar` pero para movimientos de efectivo) + reglas default por `tipo`/texto.
- **Nueva vista (Fase 5):** el libro contable / línea de tiempo.
- **Módulo Utilidades:** spec + plan propios, futuros (no en este MVP).
