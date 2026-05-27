-- =============================================================================
-- F7B-S5: numeric(15,2) en columnas de plata
-- =============================================================================
-- F7B reportó 68 columnas numeric sin precision/scale. Sin garantía explícita,
-- la DB acepta valores arbitrarios y los redondeos quedan a merced de la
-- suerte. 15,2 cubre montos hasta 9_999_999_999_999.99 (10 trillones de pesos AR).
--
-- Las 4 views que dependen de columnas-target se DROPpean y RECREATEan
-- después del ALTER (Postgres no permite ALTER COLUMN TYPE en tabla con
-- view dependiente). Las defs se preservan exactamente como están.
-- =============================================================================

BEGIN;

-- 1. Drop views dependientes
DROP VIEW IF EXISTS v_admin_metricas_tenants;
DROP VIEW IF EXISTS v_kds_tickets;
DROP VIEW IF EXISTS v_rrhh_adelantos_desglose;
DROP VIEW IF EXISTS v_rrhh_empleados_visible;

-- 1b. Drop generated columns dependientes (rrhh_empleados.valor_dia +
-- valor_hora dependen de sueldo_mensual). Las recreamos al final con
-- la misma fórmula.
ALTER TABLE rrhh_empleados DROP COLUMN valor_dia;
ALTER TABLE rrhh_empleados DROP COLUMN valor_hora;

-- 2. ALTER columns de plata a numeric(15,2)

ALTER TABLE facturas
  ALTER COLUMN descuentos TYPE numeric(15,2),
  ALTER COLUMN iibb TYPE numeric(15,2),
  ALTER COLUMN iva105 TYPE numeric(15,2),
  ALTER COLUMN iva21 TYPE numeric(15,2),
  ALTER COLUMN neto TYPE numeric(15,2),
  ALTER COLUMN otros_cargos TYPE numeric(15,2),
  ALTER COLUMN perc_iva TYPE numeric(15,2),
  ALTER COLUMN total TYPE numeric(15,2);

ALTER TABLE factura_items
  ALTER COLUMN precio_unitario TYPE numeric(15,2),
  ALTER COLUMN subtotal TYPE numeric(15,2);

ALTER TABLE gastos
  ALTER COLUMN monto TYPE numeric(15,2);

ALTER TABLE gastos_plantillas
  ALTER COLUMN monto_estimado TYPE numeric(15,2);

ALTER TABLE movimientos
  ALTER COLUMN importe TYPE numeric(15,2);

ALTER TABLE saldos_caja
  ALTER COLUMN saldo TYPE numeric(15,2);

ALTER TABLE mp_liquidaciones
  ALTER COLUMN monto TYPE numeric(15,2);

ALTER TABLE mp_movimiento_facturas
  ALTER COLUMN monto_aplicado TYPE numeric(15,2);

ALTER TABLE mp_movimientos
  ALTER COLUMN monto TYPE numeric(15,2),
  ALTER COLUMN monto_bruto TYPE numeric(15,2),
  ALTER COLUMN saldo TYPE numeric(15,2);

ALTER TABLE nc_aplicaciones
  ALTER COLUMN monto TYPE numeric(15,2);

ALTER TABLE proveedores
  ALTER COLUMN saldo TYPE numeric(15,2);

ALTER TABLE remitos
  ALTER COLUMN monto TYPE numeric(15,2);

ALTER TABLE rrhh_adelantos
  ALTER COLUMN monto TYPE numeric(15,2);

ALTER TABLE rrhh_empleados
  ALTER COLUMN aguinaldo_acumulado TYPE numeric(15,2),
  ALTER COLUMN sueldo_mensual TYPE numeric(15,2);
-- valor_dia y valor_hora se recrean como generated abajo (dependen de sueldo_mensual)

ALTER TABLE rrhh_historial_sueldos
  ALTER COLUMN sueldo_anterior TYPE numeric(15,2),
  ALTER COLUMN sueldo_nuevo TYPE numeric(15,2);

ALTER TABLE rrhh_liquidaciones
  ALTER COLUMN adelantos TYPE numeric(15,2),
  ALTER COLUMN descuento_ausencias TYPE numeric(15,2),
  ALTER COLUMN efectivo TYPE numeric(15,2),
  ALTER COLUMN monto_presentismo TYPE numeric(15,2),
  ALTER COLUMN otros_descuentos TYPE numeric(15,2),
  ALTER COLUMN pagos_realizados TYPE numeric(15,2),
  ALTER COLUMN subtotal1 TYPE numeric(15,2),
  ALTER COLUMN subtotal2 TYPE numeric(15,2),
  ALTER COLUMN sueldo_base TYPE numeric(15,2),
  ALTER COLUMN total_a_pagar TYPE numeric(15,2),
  ALTER COLUMN total_dobles TYPE numeric(15,2),
  ALTER COLUMN total_feriados TYPE numeric(15,2),
  ALTER COLUMN total_horas_extras TYPE numeric(15,2),
  ALTER COLUMN total_vacaciones TYPE numeric(15,2),
  ALTER COLUMN transferencia TYPE numeric(15,2);

ALTER TABLE rrhh_novedades
  ALTER COLUMN adelantos TYPE numeric(15,2),
  ALTER COLUMN otros_descuentos TYPE numeric(15,2);

ALTER TABLE rrhh_pagos_especiales
  ALTER COLUMN monto TYPE numeric(15,2),
  ALTER COLUMN monto_pagado TYPE numeric(15,2);

ALTER TABLE ventas
  ALTER COLUMN monto TYPE numeric(15,2);

-- 3a. RECREATE generated columns con misma fórmula (numeric(15,2) implícito).
ALTER TABLE rrhh_empleados
  ADD COLUMN valor_dia numeric(15,2) GENERATED ALWAYS AS (sueldo_mensual / 30.0) STORED;
ALTER TABLE rrhh_empleados
  ADD COLUMN valor_hora numeric(15,2) GENERATED ALWAYS AS ((sueldo_mensual / 30.0) / 8.0) STORED;

-- 3b. RECREATE views (definiciones idénticas a las originales)

CREATE OR REPLACE VIEW public.v_admin_metricas_tenants AS
 WITH ventas_mes AS (
         SELECT v.tenant_id,
            count(*) AS ventas_mes,
            COALESCE(sum(v.monto), 0::numeric) AS facturado_mes
           FROM ventas v
          WHERE v.fecha >= date_trunc('month'::text, CURRENT_DATE::timestamp with time zone)
          GROUP BY v.tenant_id
        ), ventas_mes_pasado AS (
         SELECT v.tenant_id,
            COALESCE(sum(v.monto), 0::numeric) AS facturado_mes_pasado
           FROM ventas v
          WHERE v.fecha >= (date_trunc('month'::text, CURRENT_DATE::timestamp with time zone) - '1 mon'::interval) AND v.fecha < date_trunc('month'::text, CURRENT_DATE::timestamp with time zone)
          GROUP BY v.tenant_id
        )
 SELECT t.id AS tenant_id,
    t.nombre AS tenant_nombre,
    t.slug,
    t.activo,
    s.plan_id,
    bp.nombre AS plan_nombre,
    bp.precio_mensual_ars,
    s.estado AS sub_estado,
    s.trial_ends_at,
    s.next_billing_at,
    s.created_at AS tenant_creado_at,
    COALESCE(vm.ventas_mes, 0::bigint) AS ventas_mes_actual,
    COALESCE(vm.facturado_mes, 0::numeric) AS facturado_mes_actual,
    COALESCE(vmp.facturado_mes_pasado, 0::numeric) AS facturado_mes_pasado,
        CASE
            WHEN COALESCE(vmp.facturado_mes_pasado, 0::numeric) = 0::numeric THEN NULL::numeric
            ELSE (vm.facturado_mes - vmp.facturado_mes_pasado) / vmp.facturado_mes_pasado * 100::numeric
        END AS crecimiento_pct,
    ( SELECT count(*) AS count
           FROM locales l
          WHERE l.tenant_id = t.id) AS locales_count,
    ( SELECT count(*) AS count
           FROM usuarios u
          WHERE u.tenant_id = t.id) AS usuarios_count
   FROM tenants t
     LEFT JOIN tenant_subscriptions s ON s.tenant_id = t.id
     LEFT JOIN billing_plans bp ON bp.id = s.plan_id
     LEFT JOIN ventas_mes vm ON vm.tenant_id = t.id
     LEFT JOIN ventas_mes_pasado vmp ON vmp.tenant_id = t.id;

CREATE OR REPLACE VIEW public.v_kds_tickets AS
 SELECT vpi.id AS item_id,
    vpi.venta_id,
    vpi.cantidad,
    vpi.modificadores,
    vpi.curso,
    vpi.estado,
    vpi.enviado_at,
    vpi.notas,
    vpi.local_id,
    COALESCE(i.estacion, g.estacion_default, 'cocina_caliente'::text) AS estacion,
    i.nombre AS item_nombre,
    i.emoji AS item_emoji,
    vp.numero_local AS venta_numero,
    vp.modo,
    vp.mesa_id,
    vp.cliente_nombre,
    vp.notas AS venta_notas,
    m.numero AS mesa_numero,
    m.zona AS mesa_zona,
    COALESCE(e.nombre, ''::text) AS mozo_nombre,
    EXTRACT(epoch FROM now() - vpi.enviado_at)::integer AS segundos_desde_enviado
   FROM ventas_pos_items vpi
     JOIN items i ON vpi.item_id = i.id
     LEFT JOIN item_grupos g ON i.grupo_id = g.id
     JOIN ventas_pos vp ON vpi.venta_id = vp.id
     LEFT JOIN mesas m ON vp.mesa_id = m.id
     LEFT JOIN rrhh_empleados e ON vp.mozo_id = e.id
  WHERE vpi.deleted_at IS NULL AND (vpi.estado = ANY (ARRAY['enviado'::text, 'listo'::text])) AND vpi.enviado_at IS NOT NULL;

CREATE OR REPLACE VIEW public.v_rrhh_adelantos_desglose AS
 SELECT tenant_id,
    empleado_id,
    EXTRACT(year FROM fecha)::integer AS anio,
    EXTRACT(month FROM fecha)::integer AS mes,
    concepto,
    count(*) FILTER (WHERE NOT descontado) AS cantidad_pendiente,
    COALESCE(sum(monto) FILTER (WHERE NOT descontado), 0::numeric) AS monto_pendiente,
    count(*) AS cantidad_total,
    COALESCE(sum(monto), 0::numeric) AS monto_total
   FROM rrhh_adelantos a
  GROUP BY tenant_id, empleado_id, (EXTRACT(year FROM fecha)), (EXTRACT(month FROM fecha)), concepto;

CREATE OR REPLACE VIEW public.v_rrhh_empleados_visible AS
 SELECT id,
    tenant_id,
    local_id AS local_principal_id,
    nombre,
    activo,
    ARRAY( SELECT rel.local_id
           FROM rrhh_empleado_locales rel
          WHERE rel.empleado_id = e.id AND rel.deleted_at IS NULL
          ORDER BY rel.es_principal DESC, rel.local_id) AS locales_ids,
    ( SELECT count(*) AS count
           FROM rrhh_empleado_locales rel
          WHERE rel.empleado_id = e.id AND rel.deleted_at IS NULL AND rel.es_principal = false) AS cantidad_cesiones,
    creado_at AS created_at,
    fecha_inicio
   FROM rrhh_empleados e
  WHERE (fecha_egreso IS NULL OR fecha_egreso >= (CURRENT_DATE - '90 days'::interval)) AND (auth_es_dueno_o_admin() OR (EXISTS ( SELECT 1
           FROM rrhh_empleado_locales rel
          WHERE rel.empleado_id = e.id AND rel.deleted_at IS NULL AND (rel.local_id = ANY (auth_locales_visibles())))));

-- Smoke
DO $smoke$
DECLARE v_remaining int;
BEGIN
  SELECT COUNT(*) INTO v_remaining
  FROM information_schema.columns
  WHERE table_schema='public'
    AND data_type='numeric'
    AND numeric_precision IS NULL
    AND table_name IN (
      'facturas','factura_items','gastos','movimientos','saldos_caja',
      'mp_liquidaciones','mp_movimientos','nc_aplicaciones','proveedores',
      'remitos','rrhh_adelantos','rrhh_empleados','rrhh_liquidaciones',
      'rrhh_pagos_especiales','ventas'
    )
    AND column_name IN (
      'descuentos','iibb','iva105','iva21','neto','otros_cargos','perc_iva',
      'total','precio_unitario','subtotal','monto','importe','saldo',
      'monto_aplicado','monto_bruto','aguinaldo_acumulado','sueldo_mensual',
      'valor_dia','valor_hora','sueldo_anterior','sueldo_nuevo','adelantos',
      'descuento_ausencias','efectivo','monto_presentismo','otros_descuentos',
      'pagos_realizados','subtotal1','subtotal2','sueldo_base','total_a_pagar',
      'total_dobles','total_feriados','total_horas_extras','total_vacaciones',
      'transferencia','monto_pagado','monto_estimado'
    );
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL F7B-S5: % columnas críticas siguen sin precision', v_remaining;
  END IF;
  RAISE NOTICE 'SMOKE OK F7B-S5: columnas de plata ahora con numeric(15,2)';

  -- Views recreadas
  SELECT COUNT(*) INTO v_remaining FROM pg_views
   WHERE schemaname='public'
     AND viewname IN ('v_admin_metricas_tenants','v_kds_tickets','v_rrhh_adelantos_desglose','v_rrhh_empleados_visible');
  IF v_remaining <> 4 THEN
    RAISE EXCEPTION 'SMOKE FAIL: 4 views debían recrearse, encontradas %', v_remaining;
  END IF;
  RAISE NOTICE 'SMOKE OK: 4 views recreadas';
END $smoke$;

COMMIT;
