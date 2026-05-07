-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint Realtime — habilitar Supabase Realtime en tablas críticas
--
-- Contexto: hoy los cambios hechos por un usuario NO se propagan a otros
-- usuarios del mismo tenant hasta que cierran sesión y vuelven a entrar.
-- Reportado en producción (cambio de medio de cobro Rappi no reflejado
-- en otra computadora).
--
-- Solución: agregar las tablas críticas a la publication
-- `supabase_realtime` (Postgres logical replication slot que el servicio
-- Realtime de Supabase consume). El frontend se suscribe via
-- `db.channel(...).on('postgres_changes', ...)` con filtro de tenant_id.
--
-- Esta migration es IDEMPOTENTE: cada ALTER PUBLICATION va precedido por
-- un check en pg_publication_tables. Re-correrla NO falla.
--
-- IMPORTANTE: la publication `supabase_realtime` debe existir en el
-- proyecto. Supabase la crea automáticamente. Si por algún motivo no
-- existe (raro), correr:
--   CREATE PUBLICATION supabase_realtime FOR TABLE [...];
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tables TEXT[] := ARRAY[
    -- ─── PASE / negocio ────────────────────────────────────────────────
    'movimientos',
    'saldos_caja',
    'facturas',
    'factura_items',
    'remitos',
    'gastos',
    'proveedores',
    'ventas',                 -- ventas legacy (Maxirest/manual)
    'medios_cobro',
    'config_categorias',
    'usuarios',
    'usuario_permisos',
    'usuario_locales',
    'locales',
    'tenants',
    'mp_credenciales',
    'mp_movimientos',
    'mp_liquidaciones',
    'rrhh_empleados',
    'rrhh_novedades',
    'rrhh_liquidaciones',
    'rrhh_valores_doble',
    'rrhh_documentos',
    'rrhh_historial_sueldos',
    'rrhh_pagos_especiales',
    'blindaje_tipos_documento',
    'blindaje_documentos',
    -- ─── COMANDA ───────────────────────────────────────────────────────
    'items',
    'item_grupos',
    'item_precios_canal',
    'canales',
    'mesas',
    'ventas_pos',
    'ventas_pos_items',
    'ventas_pos_pagos',
    'ventas_pos_overrides',
    'turnos_caja',
    'movimientos_caja',
    'comanda_local_settings',
    'kds_tokens',
    'menu_qr_tokens',
    'metodos_cobro'
  ];
  t TEXT;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      -- También verificar que la tabla exista — algunas RPCs/migrations
      -- futuras pueden agregarla; otras pueden no estar creadas todavía.
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
        RAISE NOTICE 'Realtime habilitado: %', t;
      ELSE
        RAISE NOTICE 'Tabla no existe, skip: %', t;
      END IF;
    END IF;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTAS sobre filtros desde el cliente:
--
-- Supabase Realtime soporta filtros server-side con sintaxis:
--   filter: 'tenant_id=eq.<uuid>'
--   filter: 'local_id=in.(1,2,3)'
--
-- Operadores soportados: eq, neq, gt, gte, lt, lte, in.
-- NO soportados: OR (combinaciones explícitas), LIKE, IS NULL.
--
-- Para tablas SIN tenant_id (kds_tokens, menu_qr_tokens si aplica) el
-- frontend debe filtrar por local_id o no filtrar (tokens públicos por
-- diseño).
--
-- Las RLS policies de Postgres TAMBIÉN se aplican al stream Realtime.
-- Eso es defense-in-depth: aunque el frontend olvide el filtro de
-- tenant_id, la fila no llega si el user no tiene RLS access.
-- ═══════════════════════════════════════════════════════════════════════════
