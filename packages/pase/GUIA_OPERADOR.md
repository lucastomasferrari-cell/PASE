# PASE — Guía para el dueño / operador

Esta guía está escrita en castellano simple para alguien que **no es
programador**: un dueño de restaurante o gerente que recién arranca con
PASE. No explica arquitectura — para eso está `CONTEXTO.md`.

Si recién creaste tu cuenta, lo primero es completar los **5 pasos del
wizard** que aparecen en `/onboarding`. Después podés volver a esta guía
cuando necesites hacer algo específico.

---

## Índice rápido

1. [Cargar mi primer empleado](#1-cargar-mi-primer-empleado)
2. [Pagar un sueldo o adelanto](#2-pagar-un-sueldo-o-adelanto)
3. [Cargar un gasto del día](#3-cargar-un-gasto-del-día)
4. [Cargar una factura de proveedor](#4-cargar-una-factura-de-proveedor)
5. [Cargar una venta a mano](#5-cargar-una-venta-a-mano)
6. [Conciliar Mercado Pago](#6-conciliar-mercado-pago)
7. [Mirar el resultado del mes (EERR)](#7-mirar-el-resultado-del-mes-eerr)
8. [Compartir el acceso con mi encargado](#8-compartir-el-acceso-con-mi-encargado)
9. [Si algo se rompió o no entiendo](#9-si-algo-se-rompió-o-no-entiendo)

---

## 1. Cargar mi primer empleado

**Dónde:** `Equipo` (en el menú lateral).

**Qué necesitás a mano:**
- Nombre y apellido.
- CUIL (sirve para evitar duplicados — el sistema te avisa si ya existe).
- Sueldo bruto mensual o por hora.
- Fecha de ingreso (cuándo arrancó realmente).
- Si lo asignás a una sucursal o si trabaja en varias.

**Cómo:**
1. Click en `+ Nuevo empleado` arriba a la derecha.
2. Completá los datos. Los obligatorios tienen asterisco.
3. Guardar. Aparece en la lista.

**Tip:** si no sabés el sueldo exacto todavía, poné un valor aproximado y
después lo editás. No frena nada.

---

## 2. Pagar un sueldo o adelanto

**Dónde:** `Equipo` → click en el empleado → tab `Liquidaciones`.

**Sueldo de mes completo:**
1. Click en `Liquidar mes` (botón arriba a la derecha).
2. Elegí mes y año.
3. El sistema calcula el bruto, descuentos y neto a pagar.
4. Click en `Pagar` → elegís medio de cobro (efectivo, transferencia, MP).
5. Aparece el movimiento en `Caja`.

**Adelanto:**
1. Tab `Adelantos` dentro del legajo del empleado.
2. Click `+ Adelanto`.
3. Monto + motivo + medio de cobro.
4. Se descuenta automático del próximo sueldo.

**Quincenas:** si el empleado cobra quincenal, en vez de `Liquidar mes`
usá `+ Novedad` y elegí `Quincena 1` o `Quincena 2`.

---

## 3. Cargar un gasto del día

**Dónde:** `Gastos` (menú lateral) o desde `Caja` con `+ Gasto`.

**Casos:**
- **Compraste algo chico (pilas, repuesto, etc.)** → `+ Gasto`, categoría
  `Varios` o la que corresponda, medio de cobro `Efectivo`.
- **Pagaste el alquiler / sueldo en negro / impuesto** → `+ Gasto`,
  categoría específica (Alquiler, Impuestos, etc.).
- **Le diste plata a un empleado** → NO uses Gastos; usá `Equipo →
  Adelantos`. Si lo cargás como gasto, no se descuenta del sueldo.

**Importante:** los gastos con factura cargada se manejan distinto — ver
sección siguiente.

---

## 4. Cargar una factura de proveedor

**Dónde:** `Compras → Facturas` o `Herramientas → Lector de Facturas IA`.

**Manual:**
1. Click `+ Cargar factura`.
2. Proveedor (si no existe, podés crearlo desde el mismo formulario).
3. Tipo (A, B, C), número, fecha, items con monto.
4. Guardar como `Pendiente` (todavía no pagada).
5. Cuando pagues, abrís la factura y click `Pagar`.

**Con foto (Lector IA):**
1. `Herramientas → Lector de Facturas IA`.
2. Subí foto o PDF de la factura.
3. El sistema extrae los datos. Revisá lo que detectó (los campos con
   confianza baja salen en amarillo).
4. Confirmar → se carga como `Pendiente`.

**Pagar:** abrís la factura → `Pagar` → elegís cuenta. Genera el
movimiento en Caja automático.

---

## 5. Cargar una venta a mano

Las ventas normales salen del POS (COMANDA, en otra URL). Pero si tenés
que cargar una venta que no pasó por el POS (un evento, una venta vieja
que olvidaste), usá esto:

**Dónde:** `Ventas` (menú lateral).

1. Click `+ Cargar venta`.
2. Fecha, sucursal, total, medio de cobro.
3. Si es por efectivo: aparece automático en Caja.
4. Si es por MP / transferencia: tenés que conciliarla después (sección
   siguiente).

---

## 6. Conciliar Mercado Pago

PASE baja automático tus movimientos de MP cada 30 min. Vos tenés que:

1. Ir a `Mercado Pago` (menú lateral).
2. Ver la lista de movimientos del día.
3. Para cada uno, asignarle qué venta o factura representa.
4. Lo que no podés matchear, marcalo como `Justificado` con un motivo
   (reembolso, comisión, etc.).

**Si los números no cierran:** abrí `Conciliación MP` → te muestra el
saldo teórico vs el real y dónde está la diferencia. NO ignores
diferencias de más de $5.000.

---

## 7. Mirar el resultado del mes (EERR)

**Dónde:** `Reportes` (menú lateral).

- **A fin de mes:** mostrás el resultado del mes cerrado (ingresos vs
  egresos vs sueldos). Es la foto contable.
- **A mitad de mes:** el número se ve raro porque los gastos fijos
  (alquiler, etc.) caen los primeros 15 días. NO juzgues rentabilidad
  intra-mes mirando este reporte. Para eso está `Negocio` (Punto de
  Equilibrio, Objetivos del Mes).

**Qué incluye el EERR (base devengada):**
- Ventas del mes (fecha de la venta, no cuándo cobraste).
- Facturas del mes (fecha de la factura, no cuándo pagaste).
- Sueldos del mes liquidados.

**Qué NO incluye:**
- Movimientos de Caja sueltos (eso es base percibida — vive en `Caja`).
- Liquidaciones de Rappi/PedidosYa/MP que ya estaban contadas en la
  venta original.

---

## 8. Compartir el acceso con mi encargado

**Dónde:** `Usuarios` (menú lateral).

1. Click `+ Nuevo usuario`.
2. Nombre, email, rol (`encargado` es el típico para no-dueños).
3. Asignále las sucursales en las que opera.
4. Si tiene rol `encargado`, podés tildar `cuentas_visibles` para que
   NO vea Caja Efectivo / banco / MP. Por default no las ve.
5. Generale una contraseña temporal — el sistema lo obliga a cambiarla
   en el primer login.

**Permisos finos:** `Usuarios → Roles y permisos`. Cada módulo se puede
habilitar / deshabilitar por usuario. Si dudás, dejá el default del rol.

---

## 9. Si algo se rompió o no entiendo

**Botón flotante de soporte abajo a la derecha** (✆ widget):
1. Click en el ícono.
2. Describí qué te pasa con tus palabras.
3. El sistema captura automáticamente: qué pantalla estabas viendo, qué
   errores tiró la consola, qué tenés en sessión.
4. Mandás → genera ticket que se procesa automático en menos de 5 min.

**Si necesitás hablar con un humano:** WhatsApp a Lucas (el dueño del
producto). El ticket suele resolverse antes.

---

## Atajos útiles

| Atajo | Qué hace |
|---|---|
| Click en logo `pase.` | Vuelve al panel de inicio. |
| Click en nombre del local arriba | Cambia de sucursal (si tenés varias). |
| `?` | Abre la ayuda contextual de la pantalla actual. |
| `Esc` | Cierra modales. |

---

## Glosario rápido

- **CMV** = Costo de Mercadería Vendida. Lo que te cuestan los insumos
  de lo que vendiste. Si vendiste un sándwich a $5.000 y los ingredientes
  te costaron $1.500, tu CMV es 30%.
- **EERR** = Estado de Resultados. El "cuánto ganaste o perdiste este
  mes" formal.
- **Devengado vs Percibido** = la venta es devengada cuando ocurre, es
  percibida cuando te entra la plata a mano. El EERR usa devengado, Caja
  usa percibido.
- **Encargado** = rol con acceso solo a su sucursal y sin cuentas de
  banco / Caja Efectivo por default.
- **Manager Override** = código TOTP que ingresás cuando algo necesita
  autorización del dueño (cancelar venta, anular factura, etc.).

---

**Última actualización:** 2026-05-27
