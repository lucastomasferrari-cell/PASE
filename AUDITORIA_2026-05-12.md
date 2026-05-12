# Auditoría técnica PASE — 2026-05-12

Auditoría exhaustiva del sistema realizada por 5 agentes en paralelo cubriendo: RLS multi-tenant, lógica de permisos, type mismatches, lógica de negocio y flujos de plata, schema DB. Reporte consolidado, dedupeado, priorizado por severidad.

**Alcance**: `packages/pase/` completo (98 migraciones + ~50 pages + hooks + libs). DB Supabase compartida con COMANDA.

---

## Resumen ejecutivo

| Severidad | Hallazgos activos | Tema dominante |
|---|---|---|
| **CRÍTICO** | 3 | Deuda C4 (INSERTs financieros sin RPC) que ya causaron bugs reales |
| **ALTO** | 11 | Fallback silencioso de hooks, FKs sin ON DELETE, códigos RPC sin traducir |
| **MEDIO** | 10 | UX inconsistente, validaciones cliente-only, indexes faltantes |
| **BAJO** | 8 | Deuda preventiva, idempotencia migrations, etc. |

**Tres patrones sistémicos** que explican la mayoría de los bugs que venís encontrando:

1. **Fallback silencioso**: cuando un SELECT falla (RLS, network, error), varios hooks caen a `constants.ts` hardcoded sin alertar. El usuario ve datos viejos sin saberlo. **Caso real**: el bug de Carolina hoy era exactamente esto — RLS de `config_categorias` filtraba todo, hook caía a fallback con `RETIROS_SOCIOS=[]`, Carolina no veía los nuevos conceptos.

2. **INSERTs financieros directos sin RPC atómica (deuda C4)**: la regla C4 dice que toda modificación de tabla financiera va por RPC. Hay 6+ lugares con `// eslint-disable-next-line ... -- deuda C4-FN` esperando refactor. Cada uno es un bug potencial si la operación falla a mitad (ej: insert factura entra pero update proveedor falla → saldo desincronizado).

3. **UI muestra opciones/badges que mienten**: dropdowns muestran cosas que el RPC va a rechazar, badges dicen "disponible" cuando la fila está marcada consumida. **Caso real**: el bug de NC con `estado='pagada'` que arreglamos hoy.

---

## Bugs ya resueltos en esta sesión (contexto)

Para que no aparezcan como pendientes:

- ✅ **`config_categorias` policy RLS muy estricta** — fixed en migration `202605121500`. SELECT abierto a todos del tenant, escritura sigue requiriendo permiso `'configuracion'`.
- ✅ **NCs nuevas insertadas con `estado='pagada'`** — fixed en commit `ab9d35d` + UPDATE en DB para 3 NCs históricas.
- ✅ **Badge "NC disponible" mentía** — fixed en mismo commit, ahora distingue disponible/consumida/anulada.
- ✅ **`prov_id` con comparación estricta en modal pagar** — fixed con `String()===String()` defensive.

---

# CRÍTICOS (acción inmediata)

## C-1. INSERT directo en `facturas` desde LectorFacturasIA bypasea RPC

**Archivo:** `packages/pase/src/pages/LectorFacturasIA.tsx:317`
**Categoría:** Deuda C4 / Operación financiera sin RPC

**Problema:** El INSERT de factura desde el lector IA va directo a `facturas`. NO usa una RPC atómica que (a) inserte la factura, (b) inserte los items, (c) actualice `proveedores.saldo`, (d) registre en `auditoria` en una sola transacción. Si el trigger `trg_saldo_prov_facturas` falla silenciosamente (raro pero posible), la factura entra pero el saldo del proveedor no se actualiza. EERR y dashboard muestran números incorrectos sin error visible.

**Reproducción:** Cargar factura por el lector IA, simular fallo de trigger (RLS revocada, permisos, lock). Factura persiste, saldo proveedor no se actualiza.

**Fix propuesto:** RPC `crear_factura_completa(p_datos, p_items_json, p_idempotency_key)` que agrupe todo en TX. Reemplazar el insert en LectorFacturasIA por la RPC. Mismo patrón se aplica a `ModalCargarFactura.tsx` en Compras.

---

## C-2. INSERT/UPDATE directo en `remitos`, `saldos_caja`, `rrhh_historial_sueldos`, `rrhh_liquidaciones` (5 lugares)

**Archivos:**
- `packages/pase/src/pages/Compras.tsx` — INSERT remitos + UPDATE remitos al vincular factura
- `packages/pase/src/pages/Caja.tsx:346-355` — UPDATE saldos_caja al editar movimiento (deuda C4-F11)
- `packages/pase/src/pages/RRHH.tsx` — INSERT/UPDATE rrhh_historial_sueldos y rrhh_liquidaciones
- `packages/pase/src/pages/ImportarMaxirest.tsx` — DELETE ventas + movimientos en rollback parcial

**Categoría:** Deuda C4

**Problema:** Mismo problema que C-1 multiplicado. Cada uno tiene `// eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-FN` esperando refactor. Si cualquier operación falla a mitad, queda DB inconsistente.

**Riesgo concreto del caso Caja.tsx**: editar movimiento "Caja Chica $100 → Banco $100" hace 2 UPDATE separados (revertir vieja + aplicar nueva). Si falla entre ambos, una cuenta queda -$100 y la otra sin cambios → total contable del negocio cambia sin operación real.

**Fix propuesto:** RPCs atómicas dedicadas, una por flujo:
- `vincular_remito_a_factura(p_remito_id, p_factura_id, p_idempotency_key)`
- `editar_movimiento(p_mov_id, p_nuevos_datos, p_idempotency_key)`
- `cambiar_sueldo_empleado(p_emp_id, p_nuevo_sueldo, p_motivo)`
- `rollback_importacion_batch(p_venta_ids[], p_movimiento_ids[])`
- `eliminar_liquidacion(p_liq_id)` (revierte movimiento asociado)

---

## C-3. Hooks `useCategorias` y `useMediosCobro` caen silenciosamente a `constants.ts` sin alertar

**Archivos:**
- `packages/pase/src/lib/useCategorias.ts:181-186, 207-213`
- `packages/pase/src/lib/useMediosCobro.ts:114-133`

**Categoría:** Fallback silencioso

**Problema:** Cuando el SELECT a `config_categorias` o `medios_cobro` retorna 0 rows o error, el hook cae a `constants.ts` hardcoded sin emitir `console.warn` ni toast ni nada. El usuario ve dropdowns con datos viejos pensando que están al día. **Este patrón fue el causa raíz del bug de Carolina hoy** — RLS le devolvía 0 rows y veía el fallback con `RETIROS_SOCIOS:[]`.

**Reproducción:** Forzar error de RLS (bloquear policy) o desconectar la red mid-fetch. La UI sigue funcional pero con datos viejos. Si el usuario carga un movimiento con categoría que solo existe en DB (no en constants), el RPC lo rechaza con error confuso.

**Fix propuesto:**
- Agregar `console.warn("useCategorias usando FALLBACK por error/empty - los datos pueden estar desactualizados")` antes del set state.
- Agregar `source: "fallback"` al estado retornado (ya existe en useCategorias).
- En las pages, mostrar badge "⚠ Datos sin conexión" si `source === "fallback"` (Configuración, Gastos, ConciliacionMP).
- Considerar bloquear write si `source !== "db"` (defensive — evita guardar movimientos con catálogo viejo).

---

# ALTOS (deuda activa, va a generar bugs)

## A-1. Cache de permisos stale: hasta 1h después de cambio sin reflejar

**Archivos:** `packages/pase/src/App.tsx:196`, `packages/pase/src/lib/auth.ts`

**Problema:** Permisos cacheados en `sessionStorage.pase_user`. Si el dueño le agrega un permiso a un encargado, el usuario afectado no lo ve hasta logout/login. El botón "Actualizar permisos" del sidebar acabamos de eliminarlo en commit `1102ad5` (estaba sin uso explícito). Ahora la única forma es cerrar sesión.

**Fix propuesto:** Tres opciones (de menor a mayor esfuerzo):
- (a) Reducir TTL de cache a 15min en lugar de 1h.
- (b) Realtime subscription a `usuario_permisos` filtrando por `usuario_id = currentUser.id` → invalida cache local cuando hay cambio.
- (c) Volver a poner el botón pero con label más claro: "Sincronizar permisos (si te cambiaron algo)".

---

## A-2. Botones de acción visibles sin chequear permiso fino

**Archivos varios** — ejemplos:
- `packages/pase/src/pages/Compras.tsx:590` — botón "Anular" visible para cualquier user con permiso `'compras'`.
- Otros casos similares en `Ventas.tsx` (anular venta), `Caja.tsx` (anular movimiento).

**Problema:** El permiso `'compras'` permite entrar al módulo pero **no debería implicar que puede anular** facturas. La RPC `anular_factura` no valida permiso fino, así que un user con `'compras'` puede ejecutarla. UX rota: error en cara del usuario en lugar de no mostrarse el botón.

**Fix propuesto:** Definir permisos granulares:
- `compras_anular`, `ventas_anular`, `caja_anular`.
- Backend: cada RPC `anular_*` chequea `auth_tiene_permiso(...)` en primeras 5 líneas.
- Frontend: `disabled={!tienePermiso(user, "compras_anular")}` en cada botón.

---

## A-3. Códigos de error RPC sin traducir (12+ códigos raw mostrados al usuario)

**Archivo:** `packages/pase/src/lib/errors.ts`

**Códigos sin entrada en el MAP:**
- De `aplicar_nc_a_factura`: `NC_YA_CONSUMIDA`, `NC_TIPO_INVALIDO`, `NC_PROVEEDOR_DISTINTO`, `NC_SALDO_INSUFICIENTE`, `NC_ANULADA`, `FACTURA_MONTO_EXCEDE_PENDIENTE`
- De `crear_cierre_ventas`: `NO_HAY_LINEAS_VALIDAS`, `LINEAS_REQUIRED`, `TURNO_REQUIRED`, `FECHA_REQUIRED`, `LOCAL_REQUIRED`
- De otras RPCs: `GASTO_NO_ENCONTRADO`, `JUSTIFICATIVO_NO_ENCONTRADO`, `LIQ_FINAL_YA_EXISTE`, `REMITO_YA_ANULADO`, `VENTA_ANULADA`, `FACTURAS_DE_PROVEEDORES_DISTINTOS`

**Fix propuesto:** Una sola edición a `errors.ts` que sume las ~15 entradas faltantes con mensajes amigables en español. Trabajo de 20 minutos.

---

## A-4. FKs en RRHH sin `ON DELETE SET NULL` (RRHH es módulo en uso activo)

**Archivo:** `packages/pase/supabase/migrations/20260414_rrhh_legajo.sql`

**FKs problemáticas:**
- `rrhh_historial_sueldos.registrado_por → usuarios(id)` (sin ON DELETE)
- `rrhh_documentos.subido_por → usuarios(id)` (sin ON DELETE)
- `rrhh_pagos_especiales.pagado_por → usuarios(id)` (sin ON DELETE)

**Problema:** Si se intenta borrar un usuario que aprobó sueldos/subió docs/aprobó pagos, Postgres rechaza con "still referenced". O peor: si el borrado se hace por una RPC que no contempla esto, falla la transacción entera.

**Fix propuesto:** Migration que cambia los 3 FKs a `ON DELETE SET NULL`. La historia queda preservada con `registrado_por=NULL` (auditoría débil pero aceptable).

---

## A-5. NCs siempre tienen `total < 0` pero el invariante no está documentado ni validado

**Archivos:** `packages/pase/src/pages/Compras.tsx:211`, `packages/pase/src/lib/saldoProveedor.ts:52-56`

**Problema:** El frontend hace `total = isNC ? -Math.abs(totalAbs) : totalAbs` al cargar. El cálculo de saldo de NC usa `Math.abs(f.total) - aplicado`. El cálculo de saldo proveedor usa `- Math.abs(total)` (resta a la deuda). **Si alguna lectura olvida `Math.abs`, los signos se rompen**. No hay CHECK constraint que valide `tipo='nota_credito' → total < 0`.

**Fix propuesto:** Dos pasos:
- Documentar invariante en `lib/saldoProveedor.ts` y `types/finanzas.ts` con comentario claro.
- Migration con CHECK constraint:
  ```sql
  ALTER TABLE facturas ADD CONSTRAINT facturas_nc_total_signo
    CHECK (tipo != 'nota_credito' OR total < 0);
  ```
- Centralizar cálculo: helper `saldoNC(factura)` en `lib/saldoFactura.ts` (nuevo archivo).

---

## A-6. `facturas.estado` sin CHECK constraint, valores inválidos se cuelan

**Archivo:** Schema legacy de `facturas`

**Problema:** No hay `CHECK (estado IN ('pendiente', 'vencida', 'pagada', 'anulada'))`. El bug NC con `estado='pagada'` que arreglamos hoy fue exactamente esto — un INSERT con valor inválido pasó silenciosamente. Si en otro flujo se mete `estado='paga'` (typo) o `estado='vencido'` (sin tilde), entra a la DB y rompe filtros.

**Fix propuesto:**
```sql
ALTER TABLE facturas ADD CONSTRAINT facturas_estado_check
  CHECK (estado IN ('pendiente', 'vencida', 'pagada', 'anulada'));
```
Aplicar el mismo patrón a `ventas.estado`, `remitos.estado`, `gastos.tipo`, `rrhh_liquidaciones.estado`.

---

## A-7. `crear_cierre_ventas` silenciosamente ignora líneas con monto 0 o medio vacío

**Archivo:** `packages/pase/supabase/migrations/202605111800_rpc_crear_cierre_ventas.sql:122`

**Problema:** La RPC itera líneas con `IF v_medio IS NULL OR v_monto <= 0 THEN CONTINUE END IF`. Si el usuario carga 3 líneas y 1 tiene monto 0 por error de UI, la RPC inserta solo 2 ventas sin avisar. El cierre queda incompleto.

**Fix propuesto:** Cambiar `CONTINUE` por `RAISE EXCEPTION 'LINEA_INVALIDA'` con detalle del row index. Validación cliente también, pero el RPC tiene que ser fail-loud.

---

## A-8. Multi-factura MP sin validación de over-assignment server-side

**Archivo:** `packages/pase/src/pages/ConciliacionMP.tsx:183-190`

**Problema:** El frontend permite asignar un movimiento MP a N facturas. Hay validación cliente de `sum montos asignados ≤ monto movimiento`, pero **no en el RPC**. Si alguien hace POST manual con JSON corrupto o si la validación cliente tiene bug, puede asignar $500+$500 contra un movimiento de $1000 fracturado (asignando más que el monto disponible). Bug de aritmética contable difícil de detectar.

**Fix propuesto:** Validación dura en el RPC de aplicar:
```sql
IF (sum montos asignados) > v_mov.monto THEN
  RAISE EXCEPTION 'OVER_ASSIGNMENT';
END IF;
```

---

## A-9. `useMediosCobro` y `useCategorias` invalidación cross-tab no funciona

**Archivos:** mismos hooks que C-3

**Problema:** Si el dueño cambia categorías en una pestaña/máquina, los otros usuarios logueados ven el cambio recién después de:
- Cerrar/abrir la pestaña (sessionStorage se borra)
- Esperar el TTL de 1h
- Refrescar página

`useRealtimeTable` existe en `Configuracion.tsx` pero **no en Gastos / ConciliacionMP / EERR** (las pages que consumen el hook). Así que cuando Caro edite un gasto, no recibe la actualización en tiempo real.

**Fix propuesto:** Agregar `useRealtimeTable({ table: 'config_categorias', onChange: () => refresh() })` dentro de `useCategorias.ts` mismo (vez de en cada page que lo consume). Centraliza la lógica.

---

## A-10. Tenant override del superadmin persistiendo en sessionStorage cross-user

**Archivos:** `packages/pase/src/App.tsx:49, 205-211`

**Problema:** El `pase_tenant_override` se guarda en sessionStorage. Si Lucas hace override a tenant Beta, después crashea el browser, después Caro entra en la misma máquina sin pasar por logout limpio, su `applyLogin()` lee el override y lo descarta porque chequea `rol === "superadmin"`. **El check funciona**, pero la confianza está en la lógica del if, no en aislamiento de storage. Si alguien introduce un bug que olvida el check, el leak es inmediato.

**Fix propuesto:**
- Renombrar la key a `pase_tenant_override__superadmin_only` (señal visual de que es solo superadmin).
- Limpiar la key en cada `applyLogin()` que NO sea superadmin: `if (enriched.rol !== "superadmin") sessionStorage.removeItem(KEY)`.
- Mejor: mover a estado in-memory (no persistente), se pierde al cerrar pestaña — pero Lucas tendría que re-impersonate después de F5.

---

## A-11. Idempotency keys crecen sin límite (no hay TTL automático)

**Archivos:** todas las RPCs financieras + `idempotency_keys` table

**Problema:** Cada llamada a `pagar_factura` / `pagar_remito` / etc inserta una fila en `idempotency_keys`. Nunca se borran. Después de meses, la tabla acumula decenas de miles de filas inútiles. Performance de las RPCs cae lentamente.

**Fix propuesto:** Una de dos:
- (a) Cron de Vercel diario que ejecuta `DELETE FROM idempotency_keys WHERE created_at < now() - interval '30 days'`.
- (b) `pg_cron` (extensión Supabase) con el mismo DELETE. Más nativo.

---

# MEDIOS (mejora UX / preventivo)

## M-1. Comparaciones `=== f.prov_id` inconsistentes en varios archivos

**Archivos:**
- `ModalVerFactura.tsx:42` — `proveedores.find(p => p.id === factura.prov_id)` estricto
- `ModalVincularRemito.tsx:17` — `f.prov_id === remito.prov_id` estricto
- `Compras.tsx:174` — `p.id === f.prov_id` estricto
- `Ventas.tsx:228` — `l.id === g.local_id` estricto
- `Dashboard.tsx:111` — usa `String()===String()` defensive

**Problema:** Mismo bug que arreglamos en el modal pagar factura hoy. Si en algún lugar un ID viene como string (de `<select>`, de URL params, de form serialization), la comparación estricta falla silenciosamente. Los archivos que usan `String()===String()` están protegidos, los demás son bombas de tiempo.

**Fix propuesto:** Estandarizar a `String(a)===String(b)` en todos los `.find` y `.filter` que comparen IDs. Costo: ~15 ediciones de 1 línea cada una.

## M-2. EERR mezcla devengado (calculado_at) sin advertir al usuario
**Archivo:** `EERR.tsx:93-96`. Documentar en UI/CONTEXTO.md que EERR es base devengada usando `calculado_at`, no `pagado_at`.

## M-3. Modo "Mostrar todos los locales" en Configuración persiste en localStorage entre sesiones
**Archivo:** `Configuracion.tsx:252-264`. Cambiar a sessionStorage o limpiar al logout.

## M-4. `auth_tenant_id()` retorna NULL para superadmin sin docstring/error amigable
**Archivo:** Migration `202604281200_tenants_foundation.sql`. Agregar trigger o comentario que avise.

## M-5. Tabla `idempotency_keys` sin índice en `(rpc_name, key)` (LOOKUP frecuente)
**Verificar:** la migration `202605091220` debería tenerlo. Si no, agregar.

## M-6. `mp_credenciales` legible por encargados desde 2026-05-07 (decisión a documentar)
**Archivo:** Migration `202605071500`. Si fue accidental, revertir. Si intencional, agregar nota en CONTEXTO.md.

## M-7. Permisos `ventas_historico` y `ver_anulados` definidos pero no asignables vía UI
**Archivo:** `Usuarios.tsx`. Agregar checkboxes en el modal de edit.

## M-8. `saldoProveedor.ts:50` chequea estado antes de tipo (orden frágil)
**Archivo:** `lib/saldoProveedor.ts:48-56`. Reordenar: primero `isNC`, luego estado.

## M-9. ConciliacionMP suma `Number(x.monto)` perdiendo precisión sobre numeric(19,2)
**Archivos:** `ConciliacionMP.tsx:372-501-808`. Considerar `Decimal.js` o aritmética de strings para sumas grandes.

## M-10. FK `usuarios.tenant_id` sin ON DELETE CASCADE (riesgo bajo, las RPCs lo manejan)
**Archivo:** Migration `202604281200`. Agregar CASCADE como defensive.

---

# BAJOS (deuda menor)

## B-1. `pagos` array tipado `PagoFactura[]` pero puede venir null de DB
Cambiar a `PagoFactura[] | null` en `types/finanzas.ts`.

## B-2. `cast as Factura[]` en `setFacturas` sin null check
Reemplazar `as` por validación defensive `Array.isArray(...)`.

## B-3. Hooks de history tables (COMANDA) usan tenant_id desde JSONB, no columna directa
Performance issue a futuro (10k+ filas). Backlog Capa 2b.

## B-4. Falta índice `(tenant_id, cuenta)` en `saldos_caja`
Bajo hoy (5 locales × 1 tenant). Preventivo para escala.

## B-5. Varias migrations CREATE TABLE sin `IF NOT EXISTS` (legacy pre-2026-04)
Bajo: no afecta prod, solo dev resets.

## B-6. `ForcePasswordChange` se puede bypassear con DevTools (sessionStorage manipulation)
Aceptable: si el atacante tiene DevTools, el browser ya está comprometido.

## B-7. Locales en dropdown de Configuración no filtran por tenant_id explícito
RLS lo cubre. Solo preventivo.

## B-8. Buckets de Storage con fallback legacy para paths sin prefijo UUID
Solo afecta los ~7 archivos legacy de Neko. Migrar a paths con prefijo + remover el fallback.

---

# Patrones sistémicos detectados

## P-1. La capa de fallback silencioso es la fuente principal de bugs invisibles

Pattern: hook hace SELECT, si falla → cae a `constants.ts` hardcoded → UI sigue funcional con datos viejos.

**Bugs reales causados por este patrón en las últimas 2 semanas:**
- Carolina no veía `RETIROS_SOCIOS` (resuelto hoy con la migration 202605121500).
- Maxirest importer rechaza batch cuando un medio nuevo no está en el catálogo cacheado.
- (probable) Operadores cargan gastos con categorías obsoletas que ya no existen en DB.

**Recomendación**: TODOS los hooks con fallback deben:
1. Emitir `console.warn` con causa (RLS, network, empty).
2. Exponer `source: "db" | "cache" | "fallback"` al consumer.
3. Mostrar badge "⚠ Datos sin conexión" en UI cuando `source !== "db"`.
4. Bloquear operaciones write (insert/update) si `source === "fallback"`.

## P-2. Deuda C4 (INSERTs financieros sin RPC) sigue presente en 6+ lugares

Pattern: el código tiene `// eslint-disable-next-line ... -- deuda C4-FN` pero el refactor nunca se hace. Cada vez que esto se manifiesta es un bug de inconsistencia en plata.

**Lugares marcados como deuda C4 hoy:**
- `LectorFacturasIA.tsx:317` (C4-F12)
- `Compras.tsx` (varios)
- `Caja.tsx:346-355` (C4-F11)
- `RRHH.tsx` (cambios de sueldo, eliminación de liquidaciones)
- `ImportarMaxirest.tsx` (rollback parcial)
- `caja.service.ts:27,36`, `rrhh.service.ts`

**Recomendación**: tratar la deuda C4 como **tema bloqueante de cualquier feature nueva en esas pages**. Cuando vayas a tocar una de estas pages, ese día se crea la RPC. Es la única forma de que la deuda se vaya bajando.

## P-3. Validaciones cliente-only sin contraparte server-side

Pattern: el frontend valida (ej: sum NCs ≤ saldo factura), pero el RPC no. Si alguien con conocimiento técnico hace POST manual, bypass.

**Casos:**
- Multi-factura MP (A-8).
- Cierre de ventas con líneas inválidas (A-7).
- Botón "Anular" visible sin chequear permiso fino (A-2).

**Recomendación**: cada validación del frontend tiene que tener su gemela en el RPC. Defense-in-depth.

## P-4. Type mismatches en comparaciones de IDs

Pattern: `===` estricto donde uno de los lados podría venir como string (de `<select>`, URL, etc).

**Recomendación**: usar `String(a) === String(b)` por convención en TODOS los `.find` y `.filter` que comparen IDs. Es +5 caracteres por comparación, costo casi cero, previene una clase entera de bugs.

## P-5. UI muestra cosas que el RPC va a rechazar

Pattern: botón visible aunque el RPC va a fallar. Badge dice "disponible" aunque la fila está consumida. Dropdown muestra opciones que el filtro server-side va a rechazar.

**Casos:**
- Botón "Anular" sin permiso fino (A-2).
- Badge "NC disponible" siempre (resuelto hoy).
- Cuentas operables en dropdown (parcialmente resuelto con effects defensivos en Caja/Gastos).

**Recomendación**: convención **"frontend nunca muestra lo que el backend va a rechazar"**. Si la regla de validación está en el RPC, replicarla en el JSX (`disabled={...}`, `.filter(...)`).

---

# Acción priorizada — orden recomendado

## Fase 1 — Esta semana (alto impacto, bajo esfuerzo)

1. **Traducir los 15 códigos RPC faltantes** (A-3). 1 sola edición a `errors.ts`. **20 min**.
2. **Agregar CHECK constraints a `facturas.estado`, `ventas.estado`, `remitos.estado`** (A-6). Migration de 5 líneas. **30 min**.
3. **Cambiar FKs RRHH a `ON DELETE SET NULL`** (A-4). Migration de 5 líneas. **30 min**.
4. **Agregar `console.warn` + `source: "fallback"` a useCategorias y useMediosCobro** (C-3, parcial). **45 min**.

## Fase 2 — Próximas 2-3 semanas (deuda C4)

5. **RPC `crear_factura_completa` + reemplazo en LectorFacturasIA y Compras** (C-1). **3-4h**.
6. **RPC `editar_movimiento_caja` + reemplazo en Caja.tsx** (C-2 parte 1). **2h**.
7. **RPC `cambiar_sueldo_empleado` + reemplazo en RRHH** (C-2 parte 2). **2h**.
8. **Eliminar las 6 `// eslint-disable -- deuda C4`** una por una a medida que se hacen las RPCs.

## Fase 3 — Mes próximo (preventivo y UX)

9. **Permisos granulares `*_anular`** + chequeo en RPCs (A-2). **3h**.
10. **`useRealtimeTable` adentro de `useCategorias`** para invalidación cross-tab (A-9). **1h**.
11. **Cron de cleanup `idempotency_keys`** (A-11). **30 min**.
12. **Estandarización `String()===String()` en `.find`/`.filter` de IDs** (M-1, P-4). **2h** + grep.

## Fase 4 — Backlog frío

13. Test mutante de aislamiento entre tenants (Sprint A backlog).
14. Indexes preventivos para multi-tenant escala (B-4).
15. Migrar archivos legacy de Storage a paths con prefijo UUID (B-8).

---

# Categorías sin hallazgos críticos

Para que sepas qué está OK:

- ✅ **Multi-tenant aislamiento RLS**: 100+ tablas, todas con tenant_id + policy dual. Verificado.
- ✅ **applyLocalScope coverage**: aplicado en las pages que importan, ESLint rule activa.
- ✅ **Idempotency en RPCs financieras**: las 4 principales (`pagar_factura`, `pagar_remito`, `pagar_sueldo`, `crear_gasto`) tienen `p_idempotency_key`.
- ✅ **SECURITY DEFINER auth checks**: las RPCs revisadas chequean `auth_*()` en primeras 5 líneas.
- ✅ **Cuentas visibles vs operables**: semánticas distintas correctamente implementadas.
- ✅ **TZ Argentina**: display usa `fmt_dt_ar`, DB usa `timestamptz`. Sin casos de `.toISOString()` sobre fechas sin TZ.
- ✅ **Aislamiento entre locales**: encargados ven solo sus locales (RLS + applyLocalScope + UI).

---

**Fin del reporte.** Si querés que ataque algún hallazgo en particular, decime el ID (ej. "A-3" o "C-1") y arrancamos.
