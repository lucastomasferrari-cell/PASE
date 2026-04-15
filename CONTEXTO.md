# PASE — Sistema de Gestión Gastronómica

## Stack
- Frontend: React + TypeScript + Vite
- Backend: Supabase (pduxydviqiaxfqnshhdc.supabase.co)
- Deploy: Vercel (pase-yndx.vercel.app)
- Repo: lucastomasferrari-cell/PASE

## Estructura
- src/pages/ → un archivo por módulo
- src/components/Layout.tsx → sidebar + navegación
- src/lib/supabase.ts → cliente Supabase
- src/lib/auth.ts → hook useAuth(), tienePermiso(), esEncargado(), localesVisibles()
- api/ → endpoints serverless (mp-sync, mp-generate, mp-process, claude, telegram-webhook, auth-admin, auth-setup, auth-hash-passwords)

## Autenticación
- Login usa SHA-256 contra tabla usuarios (fallback principal)
- Supabase Auth secundario, usuarios pueden tener auth_id null
- Roles: dueno (acceso total), admin, encargado (restringido por local)
- Permisos por módulo en tabla usuario_permisos
- Locales por encargado en tabla usuario_locales

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
- usuarios: id(int serial), nombre, email, password(sha256), rol, locales(array), auth_id(uuid), activo
- usuario_permisos: usuario_id(int), modulo_slug
- usuario_locales: usuario_id(int), local_id(int)
- locales: id(int), nombre
- mp_movimientos, mp_credenciales, saldos_caja, movimientos
- facturas, factura_items, ventas, gastos, remitos
- proveedores, empleados(vieja), insumos, recetas, receta_items

## Pendientes prioritarios
1. Fix RRHH: vacaciones muestra 0.0d — cálculo por antigüedad no funciona
2. Fix RRHH: SAC acumulado muestra $0 — mostrar SAC teórico del semestre
3. Fix RRHH: Novedades y Pagos no autoseleccionan local
4. Fix RRHH: botón Pagar mes no aparece en legajo → movido a tab Pagos
5. Sesión no persiste al refrescar → guardar en sessionStorage
6. Legajo debe abrirse como modal (no página separada) — implementado pero verificar
7. Liquidación final pendiente de implementar en legajo
8. Módulo Empleados viejo → ocultar del sidebar (reemplazado por RRHH)

## Decisiones de arquitectura tomadas
- No usar Supabase Auth como sistema principal (SHA-256 en tabla usuarios)
- RLS policies: FOR ALL USING (true) WITH CHECK (true) en todas las tablas nuevas
- local_id e usuario_id son INTEGER (no UUID) en todas las tablas
- El módulo RRHH NO depende del módulo Empleados viejo
- Pagos de sueldo crean gastos en tabla gastos con categoria "Sueldos"
- Legajo del empleado es modal, no página separada

## Comandos útiles
- Claude Code: claude --dangerously-skip-permissions
- Deploy: push a main → Vercel auto-deploya
