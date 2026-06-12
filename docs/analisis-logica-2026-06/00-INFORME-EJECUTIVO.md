# Informe ejecutivo — Análisis de lógica PASE + COMANDA + MESA vs el mundo

**Fecha:** 2026-06-11 (noche)
**Qué es esto:** la síntesis de 11 informes (6 de auditoría de lógica del código propio + 5 de investigación profunda de competidores). No es una lista de bugs ni de features: es una evaluación de las **decisiones de diseño** — qué tiene tope futuro, qué hay que cambiar ahora porque después sale caro, y qué está validado contra el estándar mundial.

**Los 11 informes** (en esta misma carpeta):

| # | Informe | Qué cubre |
|---|---|---|
| 01 | [Compras → Stock → CMV](./01-compras-stock-cmv.md) | El circuito completo de mercadería |
| 02 | [POS COMANDA](./02-pos-comanda.md) | Venta, mesas, caja, offline, KDS |
| 03 | [Finanzas / EERR](./03-finanzas-eerr.md) | Caja, gastos, devengado/percibido, P&L |
| 04 | [RRHH](./04-rrhh.md) | Sueldos, adelantos, SAC, liquidación final |
| 05 | [Permisos + Ajustes](./05-permisos-ajustes.md) | Usuarios, roles, y la pantalla Ajustes |
| 06 | [MESA + conexiones](./06-mesa-conexiones.md) | Reservas y la arquitectura de los 3 productos |
| 10 | [Toast](./10-competidor-toast.md) | El líder de USA por dentro |
| 11 | [Square / Lightspeed / TouchBistro](./11-competidor-square-lightspeed.md) | El referente de simplicidad día-1 |
| 12 | [OpenTable / Resy / SevenRooms](./12-competidor-reservas.md) | Las lógicas internas de reservas |
| 13 | [R365 / MarketMan / MarginEdge](./13-competidor-backoffice.md) | Back-office e inventario pro |
| 14 | [UX de settings y onboarding](./14-ux-settings-onboarding.md) | Cómo se configura un producto vendible |

---

## 1. Veredicto general en tres frases

1. **Las fundaciones están bien elegidas.** El modelo de 3 conceptos de mercadería, el libro mayor de caja y de stock, las RPCs atómicas, la DB compartida entre los 3 productos, el catálogo single-source, el RBAC rol+extras — todo eso coincide con cómo lo hacen Toast/Square/R365. **No hay que rehacer nada grande.**
2. **El problema sistémico no es ninguna pieza: son los eslabones entre piezas.** Cada módulo se construyó bien por dentro, pero los puentes entre productos quedaron abiertos (ventas del POS no llegan al EERR, dos catálogos de medios de cobro, reservas que no se conectan al cliente ni a la venta, tres altas por empleado). Eso es exactamente lo contrario del pitch ("todo integrado") y es barato de cerrar HOY, carísimo en 6 meses.
3. **El producto hoy es "PASE-para-Neko", no "PASE-producto".** Un tenant nuevo arranca con catálogos vacíos (y de fallback ve las categorías de Neko), sin defaults, sin plantillas, con 3 formularios por empleado. La distancia a "lo entendés el día 1" no es de diseño — es de terminación: defaults, seeds, un alta por persona, checklist de arranque.

---

## 2. Los 5 hallazgos estructurales (lo que cruza todos los informes)

### 🔴 H1 — Los puentes entre productos están cortados

El diferencial declarado es "una sola plataforma, datos en vivo, sin integraciones". La arquitectura lo permite (✅ misma DB, validado como el patrón Toast/Square). Pero los eslabones concretos no existen:

| Eslabón | Estado | Costo de esperar |
|---|---|---|
| Ventas COMANDA → `ventas` PASE (EERR) | **No existe ni esqueleto** — PASE no lee `ventas_pos` en ningún lado | Cuando un cliente use COMANDA, doble carga manual o EERR en cero |
| Medios de cobro | **Dos tablas** (`medios_cobro` PASE / `metodos_cobro` COMANDA) sin puente | Cada venta del piloto referencia un catálogo que los reportes no conocen |
| Reserva → cliente | `cliente_id` existe pero **nunca se llena** (ni en la pública ni en la manual) | Reservas huérfanas que el CRM 360° jamás va a poder unir |
| Reserva → venta | **No existe la columna** | El CRM con consumo real y el motor en vivo dependen de este join; backfill futuro = heurísticas frágiles |
| Alta de empleado | **3 formularios en 2 apps** sin vínculo | Cada cliente lo sufre el día 1; des-sincronizaciones (baja en RRHH, activo en POS) |

**Esta es la categoría #1 de trabajo.** Todos son cambios chicos hoy (una proyección, una columna, un seed) y migraciones dolorosas después.

### 🔴 H2 — "Multi-local" está prometido pero tiene agujeros en la base

- **Stock**: el cache es UNA columna global por insumo. Transferencias entre locales no cambian el número, los conteos por local comparan contra el global, el CMV per-local da números sin sentido. **Con el segundo local, el módulo Stock deja de decir la verdad** — y Neko (cocina central + satélites) apunta exactamente ahí. El libro mayor ya tiene `local_id`, así que la tabla `(insumo, local)` se puede backfillear hoy.
- **Finanzas**: gastos con `local_id NULL` desaparecen de la vista por-local (sin prorrateo) y los empleados cedidos cargan 100% del sueldo a su local principal → la comparativa de sucursales miente.
- **COMANDA**: un solo turno de caja por local — dos cajas en paralelo no se pueden modelar.

### 🟠 H3 — Hay "dos verdades" con el mismo nombre en varios lugares

- **Dos CMV**: el EERR llama CMV a "compras del mes" y Rentabilidad llama CMV al "consumo real" (la fórmula correcta). El dueño ve dos números distintos con el mismo nombre. La diferencia entre ambos ES la variación de inventario — mostrarla es un feature, no un parche.
- **Dos SAC**: columna acumulada que nadie ve + cálculo teórico que sí se muestra, mantenidos por lógicas distintas (ya generó bugs).
- **Dos roles POS dentro de COMANDA**: según si entrás con password o con PIN, tus permisos salen de tablas distintas con enums distintos.
- **Merma en 3 lugares** (materia prima, línea de receta, mermas declaradas) sin validación de doble conteo → costo del plato inflado 2x sin aviso.

Regla a adoptar: **cada concepto de negocio tiene UNA casa**. Donde hoy hay dos, elegir una y deprecar la otra.

### 🟠 H4 — El borde frágil de COMANDA: caja y offline

- El **cierre de caja no es ciego** (muestra el esperado y autocompleta) → el arqueo pierde su función anti-fraude. Toast lo resuelve como *permiso* ("este cajero cuenta a ciegas"); el shift review es un checklist bloqueante. Es el gap #1 contra el estándar en el POS.
- El **offline-first tiene motor excelente y borde frágil**: los 9 wrappers `_offline` son un contrato duplicado a mano que ya estuvo roto 26 días sin que nadie lo note, y el **cobro es online-only** (la operación más crítica no tiene rama offline). La solución estructural: un solo camino de escritura (todo por la cola; online = flush inmediato) y RPCs canónicas con idempotencia, matando los wrappers espejo.

### 🟠 H5 — No hay "producto día 1": defaults, seeds y onboarding

- `crear_tenant_v2` no siembra **ninguna** categoría, medio de cobro ni puesto. El fallback hardcodeado muestra el plan de cuentas de Neko a clientes ajenos.
- 62 categorías de gastos es el doble del estándar (Xero: un negocio chico usa 20-50 para TODO; lo recomendado para el dueño: ~15-20 en 5-6 familias).
- El wizard de onboarding existe pero no toca catálogos ni usuarios, y vive aparte (el patrón ganador es el checklist de Shopify/Square: en el Home, máx 5 pasos, auto-completables, ordenados por valor — primera venta <24h como métrica norte).

---

## 3. Veredicto por dominio (resumen)

| Dominio | Veredicto | Lo mejor | El tope/riesgo principal |
|---|---|---|---|
| **Compras→Stock→CMV** | ✅ base sólida, 🔴 un tope | Loop compra→precio→costo→CMV cerrado y automático; bandeja con memoria (nivel R365, mejor UX) | Stock global sin per-local (H2); fecha de compra = fecha de carga (ensucia CMV histórico); modificadores sin receta (tope para fast food) |
| **POS COMANDA** | ✅ venta, 🔴 caja/offline | Modelo de venta NO mesa-céntrico (sirve a todo tipo de local); 3-8 taps por operación; KDS al estándar | Cierre no ciego, turno único por local, cobro online-only, wrappers `_offline` frágiles (H4) |
| **Finanzas/EERR** | ✅ fundación, ⚠️ 3 sesgos | Ledger+cache correcto; devengado/percibido limpio y explicable; EERR ya restaurantero | Puente COMANDA→ventas inexistente (H1); sueldos imputados al mes equivocado; "CMV" = compras sin ajuste de inventario (H3); falta Prime Cost (es una suma) |
| **RRHH** | ✅ cálculo, ⚠️ modelo | Matemática centralizada con 118 tests; liquidación final LCT editable; informalidad manejada con dignidad (único en el mercado) | Slot mensual no soporta semanal/diario ni fichaje (el spec v2 correcto está dormido en prod sin usar); backend confía en el cálculo del frontend; sueldo blanco/negro no se puede separar |
| **Permisos+Ajustes** | ✅ mecánica, 🔴 contenido | RBAC rol+extras = el modelo Square; mecánica de Ajustes bien resuelta; override por local correcto | Sin defaults de producto (H5); 3 altas por persona (H1); 4 capas históricas de permisos en PASE y 2 sistemas en COMANDA |
| **MESA+conexiones** | ✅ arquitectura, ⚠️ modelo de estados | DB compartida = el lado correcto de la historia (Toast, no OpenTable); diferencial "en vivo" real y defendible | `cumplida` terminal al sentar (no se sabe quién ocupa ni cuándo se libera); sin reserva→venta ni reserva→cliente (H1); sin pacing/duración por grupo/combos — **no arrancar módulo #2 sin fijar esto** |

---

## 4. Respuesta directa: ¿la lógica de Ajustes es correcta o mejorable?

**La mecánica es correcta. El contenido es mejorable. Para vender, una parte es directamente incorrecta.**

- ✅ **No tocar**: catálogos en tablas, soft delete, buscador + grupos colapsables, override por local de medios de cobro, hooks con cache+Realtime.
- ⚠️ **Mejorable**: 62 categorías abruma (estándar: ~15-20 en familias, con las 62 actuales como "biblioteca de sugerencias" activables); la lista plana alfabética no distingue lo que usás siempre de lo que usaste una vez; "Turnos y horarios (0)" es un placeholder que confunde (ocultarlo); Ajustes no es el hub real (usuarios, roles, notificaciones y toda la config de COMANDA viven afuera sin link). Regla de la industria: **settings ≠ catálogos vivos** — separar "Mi negocio" (catálogos que crecen con el uso) de "Ajustes" (lo que se configura una vez).
- 🔴 **Incorrecto para cliente nuevo**: no hay defaults de producto — hay datos de Neko. La respuesta estándar es plantilla por tipo de negocio al crear el tenant (Square lo resuelve con UNA pregunta — "¿mostrador, salón o barra?" — que deriva todos los defaults) + crear-al-usar en los formularios.

---

## 5. Lo más valioso que dejó la competencia (por informe)

**Toast (10):** "la memoria muscular lo es todo" — controles core que nunca se mueven entre versiones. Save ≠ Publish en el menú (borradores). Order-by-seat se carga al tomar el pedido → el split por comensal al cobrar es gratis. Coursing con 3 disparadores (mozo/cocina/timer) sobre un solo concepto. Shift review como checklist bloqueante del cierre. Su talón: setup eterno (xtraCHEF 50-300 horas), fees sorpresa, contratos — el odio de sus clientes es nuestra lista de "qué no ser".

**Square (11):** la facilidad día-1 no es UI linda, es **sustracción** + **templates** (una pregunta reemplaza 30 toggles). Separación Categories (reportes) ≠ Menu Groups (layout del POS): reordenar la grilla jamás toca contabilidad — COMANDA debe garantizar lo mismo. Checklist reanudable, nunca wizard bloqueante. Su talón: full-service (coursing/seats paywalled, inventario plano) — **la oportunidad es "día-1 de Square + salón de Toast", que no existe ni en USA**.

**Reservas (12):** la lógica core universal son 4 capas: shifts → turn times por tamaño de grupo → pacing (cubiertos por slot de 15 min) → inventario de mesas con combinaciones. La mesa nunca se asigna en firme al reservar (asignación blanda + reflow). Anti no-show probado: depósito 10-15% → 1,7% de no-show. La pantalla del host necesita 3 vistas (lista / plano / **timeline** — no opcional). SevenRooms recomienda literalmente "un empleado dedicado a mantener estados del floor plan" — ese costo existe porque no ven el POS; MESA lo elimina de nacimiento.

**Back-office (13):** R365 separa "variance" de "**unexplained variance**" (post-mermas) — eso es lo accionable, copiarlo en el AvT. El conteo que sobrevive: completo mensual + 5-10 key items semanal (el de PASE es todo-o-nada → va a morir). **MarginEdge ganó invirtiendo la secuencia: el catálogo se construye solo desde las facturas, valor antes de setup** — exactamente la filosofía de nuestra bandeja; el playbook de onboarding es: día 1 solo facturas → semana 2 conteo de 20 ítems → semana 3-4 recetas del top-20 del sales mix → mes 2 AvT completo.

**Settings/onboarding (14):** checklist en el Home (no wizard aparte), máx 5 pasos, auto-completables, ordenados por valor (carta → venta de prueba → medios de cobro → equipo → caja real; lo fiscal/impresoras DESPUÉS de la primera venta). Progressive disclosure de exactamente 2 niveles. Multi-local: herencia con indicador visual de override + "Reset a global". Benchmark a superar: Fudo comunica "90% operando en menos de una semana".

---

## 6. Plan maestro: qué cambiar AHORA (priorizado por costo-de-esperar)

**Tier 1 — Estructural, antes del piloto / antes de MESA módulo #2** (cada semana de espera agrega datos que migrar):

1. **Stock por (insumo, local)** — tabla cache nueva + backfill desde el libro mayor (que ya tiene `local_id`). Arregla conteos, transferencias, CMV per-local y la promesa multi-local de un saque.
2. **Puente COMANDA → PASE de ventas** — proyección automática `ventas_pos` → `ventas` con `origen='comanda'`. El resto del sistema no se toca.
3. **Un solo catálogo de medios de cobro** (PASE es la verdad, COMANDA consume — consistente con la directiva de catálogo).
4. **MESA: las 4 decisiones de modelo antes del módulo #2** — estado `sentada` separado de `finalizada`; columna `venta_id` en reservas (se llena al sentar); `cliente_id` SIEMPRE + teléfono normalizado; unidad del motor = cubiertos + `mesas.capacidad NOT NULL`.
5. **Fechar compras con la fecha de la factura** (no la de carga) — cada semana sin esto ensucia el CMV histórico de forma irreversible.

**Tier 2 — Robustez COMANDA antes de operar con clientes:**

6. **Cierre de caja ciego** (como permiso por usuario) + **turno por caja** (no por local) + tabla de reversos pendientes (anular con turno cerrado).
7. **Unificar el contrato offline**: un solo camino de escritura (todo por la cola), RPCs canónicas con idempotencia, matar los 9 wrappers espejo; rama offline para el COBRO.
8. **Validación server-side del cálculo de sueldos** (la RPC recalcula y rechaza si difiere) — con multi-tenant real es seguridad, no prolijidad.

**Tier 3 — Producto vendible (el "día 1"):**

9. **Seed de catálogos al crear tenant** (plantilla AR genérica: ~20 gastos, ~10 compras, ~6 ingresos, ~10 medios, ~8 puestos) + matar el fallback de Neko + reempaquetar las 62 actuales como biblioteca de sugerencias.
10. **Un alta de persona** (desde /equipo: "¿usa el POS?" / "¿entra al back-office?" crean las otras dos filas vinculadas) + que el rol_pos de COMANDA otorgue permisos por default + un solo enum de rol POS.
11. **Checklist de arranque en el Home** (reciclar el wizard /onboarding existente) + ocultar "Turnos y horarios" + empty states con CTA + separar "Mi negocio" de "Ajustes".
12. **Una casa por concepto**: deprecar `aguinaldo_acumulado`, una sola casa para merma/rendimiento (con aviso anti doble-conteo), renombrar el "CMV" del EERR a "Compras de mercadería" hasta conectar inventario, Prime Cost en el EERR (es una suma + semáforo), una sola fuente de permisos en PASE (matar rol legacy + Config.tsx + slugs hardcodeados).

**Decisiones pendientes de Lucas (no son código):**

- **RRHH v2**: las tablas del modelo eventos están en prod vacías. Elegir: (a) ejecutar la migración el próximo trimestre con fecha, o (b) borrarlas y aceptar el slot. El fichaje y los semanales/diarios van a forzar (a) tarde o temprano — cuanto más tarde, más caro.
- **Rename de categorías**: propagar al historial o migrar a FK — cualquiera de las dos; lo caro es no decidir.
- **Sueldo blanco/en mano como componentes separados** (barato hoy, evita re-cablear recibos/EERR cuando el primer cliente lo pida).

---

## 7. Qué NO hay que cambiar (validado contra el estándar)

- El **modelo de 3 conceptos** (Materia Prima → Insumo → Receta anidada) — idéntico a R365/MarketMan.
- **Libro mayor + cache derivado** en caja y stock — el patrón correcto, bien implementado.
- **RPCs atómicas como backend único** de los 3 productos.
- **Una DB multi-tenant compartida** con deploys separados — el lado Toast/Square de la historia; separar MESA en su propia DB mataría el diferencial.
- **Catálogo single-source en PASE**, COMANDA consume — no hace falta event-sourcing ni versionado hoy.
- **La bandeja de conciliación con memoria** — ataca exactamente el dolor que hace fracasar a MarketMan/xtraCHEF.
- **RBAC rol+extras de PASE** (referencia viva) — es el modelo Square.
- **Flujo Confirmar→Pagar sin autosave** y **adelantos a checkbox manual** — aprendizaje ganado con 3 iteraciones; en plata informal el humano tiene contexto que el sistema no.
- **Devengado vs percibido** — separación limpia; el trabajo es explicarla mejor, no cambiarla.
- **Informalidad como ciudadana de primera en RRHH** — nadie más lo tiene; es ventaja, no vergüenza.
- **Sin comisión por cubierto en MESA** — la decisión comercial correcta contra OpenTable.

---

*Detalle, fuentes y razonamiento completo en los 11 informes de esta carpeta.*
