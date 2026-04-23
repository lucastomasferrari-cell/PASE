# PASE — Sistema de Gestión Gastronómica

## Stack
- Frontend: React + TypeScript + Vite
- Backend: Supabase (pduxydviqiaxfqnshhdc.supabase.co)
- Deploy: Vercel (pase-yndx.vercel.app)
- Repo: lucastomasferrari-cell/PASE

## Estructura
- src/pages/ → un archivo por módulo
- src/components/Layout.tsx → sidebar + navegación
- src/lib/supabase.ts → cliente Supabase (anon key desde VITE_SUPABASE_ANON_KEY)
- src/lib/auth.ts → hook useAuth(), tienePermiso(), esEncargado(), localesVisibles(), scopeLocales(), applyLocalScope(), cuentasVisibles(), puedeVerCuenta()
- api/ → endpoints serverless (mp-sync, mp-generate, mp-process, claude, telegram-webhook, auth-admin, auth-setup, auth-hash-passwords, auth-migrate-all)

## Autenticación
- Login exclusivo vía Supabase Auth (`db.auth.signInWithPassword`). El fallback SHA-256 se eliminó en commit 3805ea7.
- Todos los usuarios activos tienen `auth_id` poblado. El email para Auth: `email` de la tabla `usuarios`; si no contiene `@`, se concatena `@pase.local`.
- Roles: dueno (acceso total), admin (casi total), encargado (restringido por local y por cuentas).
- Permisos por módulo en tabla `usuario_permisos`.
- Locales por encargado en tabla `usuario_locales`.
- Cuentas visibles en Tesorería por usuario: columna `usuarios.cuentas_visibles TEXT[]` (NULL = todas, array = filtro, array vacío = ninguna).
- Password temporal: columna `usuarios.password_temporal BOOLEAN`. Si es true, el componente `src/pages/ForcePasswordChange.tsx` bloquea la navegación hasta que el usuario cambie su password.
- Para resetear password de un usuario: Supabase Dashboard → Authentication → Users → "Reset password", y después opcionalmente `UPDATE usuarios SET password_temporal = true WHERE id = X` para forzar cambio al próximo login.

## Módulos activos
- Dashboard, Ventas, Facturas, Remitos, Gastos, Proveedores
- Import Maxirest, Caja & Bancos, Caja Efectivo
- Conciliación MP (MercadoPago), Estado de Resultados, Contador IVA
- Lector Facturas IA, Insumos, Recetas
- Empleados (módulo viejo, ocultar del sidebar — reemplazado por RRHH)
- RRHH (nuevo, ver detalle abajo)
- Usuarios (gestión de accesos)

## Módulo RRHH — Estado actual
Tabs: Dashboard | Empleados | Novedades | Pagos
Modal Legajo accesible desde Empleados (botón "Legajo" por fila)
Ícono ⚙ en esquina para configuración de valores de dobles

### Tablas RRHH en Supabase
- rrhh_empleados: id(uuid), local_id(int), apellido, nombre, cuil, puesto, modo_pago, sueldo_mensual, valor_dia(generated), valor_hora(generated), alias_mp, fecha_inicio, activo, vacaciones_dias_acumulados, aguinaldo_acumulado, fecha_egreso, motivo_baja
- rrhh_novedades: id, empleado_id, mes, anio, inasistencias, presentismo, dias_trabajados, horas_extras, dobles, pagos_dobles_realizados, feriados, adelantos, vacaciones_dias, observaciones, estado(borrador/confirmado), cargado_por, updated_at
- rrhh_liquidaciones: id, novedad_id, sueldo_base, descuento_ausencias, total_horas_extras, total_dobles, total_feriados, total_vacaciones, subtotal1, monto_presentismo, subtotal2, adelantos, pagos_realizados, total_a_pagar, efectivo, transferencia, estado(pendiente/pagado), gasto_id, pagado_at, pagado_por
- rrhh_valores_doble: puesto, valor
- rrhh_historial_sueldos: empleado_id, sueldo_anterior, sueldo_nuevo, fecha_cambio, motivo
- rrhh_documentos: empleado_id, tipo, nombre_archivo, url, mes, anio, subido_por
- rrhh_pagos_especiales: empleado_id, tipo(vacaciones/aguinaldo/liquidacion_final), monto, dias, periodo_desde, periodo_hasta, gasto_id, pagado_at

### Lógica de cálculo liquidación mensual
- sueldo_base: MENSUAL=sueldo, QUINCENAL=sueldo/2, SEMANAL=sueldo/4
- valor_dia = sueldo_mensual / 30
- valor_hora = valor_dia / 8
- descuento_ausencias = inasistencias × valor_dia
- total_horas_extras = horas_extras × valor_hora
- total_dobles = dobles × valor_doble[puesto]
- total_feriados = feriados × valor_dia
- presentismo = sueldo_mensual × 0.05 si MANTIENE, 0 si no
- subtotal1 = sueldo_base - descuento_ausencias + adicionales
- subtotal2 = subtotal1 + presentismo
- total_a_pagar = subtotal2 - adelantos - pagos_dobles_realizados

### Vacaciones (cálculo automático por antigüedad)
- < 5 años: 14 días/año → 14/12 por mes trabajado
- 5-10 años: 21 días/año
- 10-20 años: 28 días/año
- > 20 años: 35 días/año

### SAC / Aguinaldo
- Se paga en junio y diciembre
- SAC = mejor sueldo del semestre / 2
- Se acumula: aguinaldo_acumulado += sueldo/12 con cada pago mensual

## Conciliación MercadoPago
- Sync automático vía cron-job.org cada 30 min
- Job 1 (mp-generate): genera CSV en MP
- Job 2 (mp-process): descarga y procesa CSV
- Saldo inicial fijado: $1.843.593 el 11/04/2026
- Prefijos: rr-* = release_report (autoritativo), sin prefijo = payments API

## Tablas principales Supabase
- **usuarios**: id(int serial), nombre, email, password(sha256 legacy, no usar), rol, locales(array legacy), auth_id(uuid), activo, password_temporal(bool), cuentas_visibles(text[])
- **usuario_permisos**: usuario_id(int), modulo_slug
- **usuario_locales**: usuario_id(int), local_id(int)
- **locales**: id(int), nombre
- **movimientos**, **saldos_caja**, **caja_efectivo**
- **facturas**, **factura_items**, **factura_items_stock**
- **ventas**, **gastos**, **gastos_plantillas**
- **remitos**, **remito_items**
- **proveedores**, **insumos**, **recetas**, **receta_items**
- **mp_credenciales**, **mp_movimientos**, **mp_liquidaciones**
- **empleados** (legacy), **empleado_archivos**
- **rrhh_empleados**, **rrhh_novedades**, **rrhh_liquidaciones**, **rrhh_valores_doble**
- **rrhh_historial_sueldos**, **rrhh_documentos**, **rrhh_pagos_especiales**, **rrhh_adelantos**
- **auditoria**
- **blindaje_tipos_documento**, **blindaje_documentos**
- **config_categorias**

## Pendientes prioritarios
1. Fix RRHH: vacaciones muestra 0.0d — cálculo por antigüedad no funciona
2. Fix RRHH: SAC acumulado muestra $0 — mostrar SAC teórico del semestre
3. Fix RRHH: Novedades y Pagos no autoseleccionan local
4. Fix RRHH: botón Pagar mes no aparece en legajo → movido a tab Pagos
5. Liquidación final pendiente de implementar en legajo
6. Módulo Empleados viejo → ocultar del sidebar (reemplazado por RRHH)
7. Refactor: pasar `user` a `src/lib/services/caja.service.ts` y `rrhh.service.ts` para que usen `applyLocalScope` en lugar del `if (localId) q.eq(...)` actual.

## Decisiones de arquitectura tomadas
- **Login: Supabase Auth como único sistema** (cambio de política: antes era SHA-256 en tabla usuarios).
- **RLS activo y restrictivo en todas las tablas** (migration 20260423_rls_real_policies.sql + extensión para gastos_plantillas, factura_items_stock, remito_items, rrhh_adelantos, mp_liquidaciones).
- **Helpers de scope SECURITY DEFINER** en Postgres: `auth_usuario_id()`, `auth_es_dueno_o_admin()`, `auth_locales_visibles()`.
- **Anon key fuera del código**: se lee de `VITE_SUPABASE_ANON_KEY`. Rotar siguiendo `ROTATE_ANON_KEY.md` ante cualquier sospecha.
- **Defense-in-depth en frontend**: `applyLocalScope(q, user, localActivo)` de `src/lib/auth.ts` en toda query a tablas con `local_id`.
- local_id y usuario_id son INTEGER (no UUID) en todas las tablas.
- El módulo RRHH NO depende del módulo Empleados viejo.
- Pagos de sueldo crean gastos en tabla gastos con categoría "Sueldos".
- Legajo del empleado es modal, no página separada.

## Comandos útiles
- Claude Code: claude --dangerously-skip-permissions
- Deploy: push a main → Vercel auto-deploya

## Cómo agregar una tabla nueva (checklist obligatorio)

Cuando crees una tabla, hacé estos pasos o **no va a funcionar desde el frontend** (RLS bloquea todo por default):

### A) Tabla con `local_id` (datos scoped por sucursal):

```sql
ALTER TABLE mi_tabla ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mt_scope_all" ON mi_tabla FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL)
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL);
```

### B) Master data global (catálogo, config):

```sql
ALTER TABLE mi_tabla ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mt_read" ON mi_tabla FOR SELECT TO authenticated USING (true);
CREATE POLICY "mt_admin_write" ON mi_tabla FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());
```

### C) Tabla hija (items de otra tabla que ya tiene RLS):

```sql
ALTER TABLE mi_tabla_hija ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mth_scope_all" ON mi_tabla_hija FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM tabla_padre p WHERE p.id = mi_tabla_hija.padre_id
    AND (auth_es_dueno_o_admin() OR p.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM tabla_padre p WHERE p.id = mi_tabla_hija.padre_id
    AND (auth_es_dueno_o_admin() OR p.local_id = ANY(auth_locales_visibles()))));
```

### D) En el frontend, toda query a tablas con `local_id` debe usar `applyLocalScope`:

```typescript
import { applyLocalScope } from "../lib/auth";
let q = db.from("mi_tabla").select("*").gte("fecha", desde);
q = applyLocalScope(q, user, localActivo);
const { data } = await q.order("fecha");
```

### E) Endpoints serverless en `api/`:

Usar siempre `SUPABASE_SERVICE_KEY` (env var en Vercel), nunca anon. La service_key bypassa RLS — filtrar manualmente por `local_id` en el código del endpoint si corresponde.

## Troubleshooting rápido

- **"Usuario no ve sus datos"** → falta policy (pasos A/B/C).
- **"Encargado ve datos de otro local"** → falta `applyLocalScope` en frontend o policy mal escrita.
- **"new row violates row-level security policy"** → el `WITH CHECK` no pasa. El `local_id` del INSERT/UPDATE tiene que estar en los del usuario.
- **"relation does not exist"** en policies con JOIN → nombre de columna mal escrito.
