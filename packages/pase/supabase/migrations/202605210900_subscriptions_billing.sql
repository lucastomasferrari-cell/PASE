-- ═══════════════════════════════════════════════════════════════════════════
-- Subscriptions + Invoices — billing de PASE como SaaS
--
-- Decisión Lucas (2026-05-20): dejar todo armado pero AGNÓSTICO del
-- gateway. Cuando registremos en MP Suscripciones (o dLocal), conectamos
-- los webhooks. Por ahora el sistema funciona en "modo manual":
--   - Crear suscripción → estado=pending_payment
--   - Lucas la marca como pagada manualmente (registrar pago)
--   - Genera invoice cada período según billing_cycle
--   - Si vence trial sin pago → estado=trial_expired (UI bloquea acceso)
--
-- Cuando se conecte el gateway:
--   - Reemplazar marcar-pago-manual por webhook gateway → marca pago auto
--   - Agregar columna gateway_subscription_id, gateway_customer_id
--   - Trigger de cobro automático en fecha vencimiento
--
-- Schema agnóstico: gateway_provider TEXT permite múltiples gateways
-- coexistiendo (cliente A paga con MP, cliente B con dLocal, etc.).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Tabla planes (catálogo) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_plans (
  id              TEXT PRIMARY KEY,  -- 'trial', 'basic', 'pro', 'enterprise'
  nombre          TEXT NOT NULL,
  descripcion     TEXT,
  precio_mensual_ars NUMERIC(12, 2) NOT NULL DEFAULT 0,
  precio_anual_ars   NUMERIC(12, 2),  -- NULL = no soportado anual
  -- Features incluidos (JSON para flexibilidad)
  features        JSONB DEFAULT '{}'::jsonb,
  -- Límites (NULL = sin límite)
  max_locales     INTEGER,
  max_usuarios    INTEGER,
  max_ventas_mes  INTEGER,
  -- Display
  orden           INTEGER DEFAULT 0,
  activo          BOOLEAN DEFAULT TRUE,
  destacado       BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed básico: planes iniciales editables después desde admin-console
INSERT INTO billing_plans (id, nombre, descripcion, precio_mensual_ars, max_locales, max_usuarios, orden) VALUES
  ('trial',      'Trial gratuito', '14 días gratis para probar',                       0,        2,    5, 0),
  ('basic',      'Básico',         'Hasta 2 locales, funcionalidad core',          30000,        2,   10, 1),
  ('pro',        'Pro',            'Hasta 5 locales, todas las features',          75000,        5,   30, 2),
  ('enterprise', 'Enterprise',     'Sin límites + soporte prioritario',           150000,     NULL, NULL, 3)
ON CONFLICT (id) DO NOTHING;

-- ─── 2. Tabla subscriptions (estado actual del tenant) ───────────────────
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL UNIQUE,  -- 1 sub por tenant (UNIQUE)
  plan_id         TEXT NOT NULL REFERENCES billing_plans(id),
  -- Estado del ciclo de vida
  estado          TEXT NOT NULL DEFAULT 'trial'
                  CHECK (estado IN (
                    'trial',                -- en período de prueba
                    'pending_payment',      -- esperando primer pago
                    'active',               -- al día
                    'past_due',             -- atraso pago, días de gracia
                    'suspended',            -- bloqueado por falta de pago
                    'cancelled',            -- canceló voluntariamente
                    'trial_expired'         -- trial venció sin convertir
                  )),
  -- Ciclo facturación
  billing_cycle   TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'annual')),
  -- Fechas clave
  trial_ends_at   TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  next_billing_at TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  -- Gateway (NULL si aún no conectado)
  gateway_provider TEXT,  -- 'mercadopago' | 'dlocal' | 'stripe' | 'manual'
  gateway_subscription_id TEXT,  -- ID de la sub en el gateway externo
  gateway_customer_id    TEXT,
  -- Datos comerciales
  precio_actual_ars NUMERIC(12, 2),  -- snapshot al activar (por si cambia el plan)
  descuento_pct     NUMERIC(5, 2) DEFAULT 0,
  notas             TEXT,
  -- Audit
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  created_by      INTEGER,
  -- Atendido por Lucas manualmente (cobro manual) o automáticamente?
  modo_cobro      TEXT NOT NULL DEFAULT 'manual' CHECK (modo_cobro IN ('manual', 'automatico'))
);

CREATE INDEX IF NOT EXISTS idx_subs_estado ON tenant_subscriptions(estado);
CREATE INDEX IF NOT EXISTS idx_subs_next_billing ON tenant_subscriptions(next_billing_at) WHERE estado IN ('active', 'past_due');
CREATE INDEX IF NOT EXISTS idx_subs_trial_ends ON tenant_subscriptions(trial_ends_at) WHERE estado = 'trial';

-- RLS: solo superadmin ve esto
ALTER TABLE tenant_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subs_superadmin ON tenant_subscriptions FOR ALL TO authenticated
  USING (auth_es_superadmin());

ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY plans_read ON billing_plans FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY plans_write ON billing_plans FOR ALL TO authenticated
  USING (auth_es_superadmin());

-- ─── 3. Tabla invoices (facturas/recibos generados) ──────────────────────
CREATE TABLE IF NOT EXISTS tenant_invoices (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  subscription_id BIGINT REFERENCES tenant_subscriptions(id) ON DELETE SET NULL,
  -- Período facturado
  periodo_desde   DATE NOT NULL,
  periodo_hasta   DATE NOT NULL,
  -- Importe
  importe_ars     NUMERIC(12, 2) NOT NULL,
  iva_ars         NUMERIC(12, 2) DEFAULT 0,
  total_ars       NUMERIC(12, 2) GENERATED ALWAYS AS (importe_ars + COALESCE(iva_ars, 0)) STORED,
  -- Estado
  estado          TEXT NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente', 'pagada', 'vencida', 'anulada', 'reembolsada')),
  fecha_emision   DATE DEFAULT CURRENT_DATE,
  fecha_vencimiento DATE,
  fecha_pago      DATE,
  -- Método de cobro
  metodo_pago     TEXT,  -- 'mercadopago', 'transferencia', 'efectivo', etc.
  gateway_payment_id TEXT,  -- ID transacción en gateway
  -- Documento fiscal (si se emite factura AFIP propia)
  comprobante_numero TEXT,
  comprobante_cae    TEXT,
  comprobante_url    TEXT,
  -- Audit
  notas           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  cobrada_por     INTEGER  -- usuario_id del superadmin que registró el cobro manual
);

CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON tenant_invoices(tenant_id, fecha_emision DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_estado_venc ON tenant_invoices(estado, fecha_vencimiento) WHERE estado IN ('pendiente', 'vencida');

ALTER TABLE tenant_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_superadmin ON tenant_invoices FOR ALL TO authenticated
  USING (auth_es_superadmin());

-- ─── 4. Triggers updated_at ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_billing_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS billing_plans_updated_at ON billing_plans;
CREATE TRIGGER billing_plans_updated_at BEFORE UPDATE ON billing_plans
  FOR EACH ROW EXECUTE FUNCTION trg_billing_updated_at();

DROP TRIGGER IF EXISTS tenant_subs_updated_at ON tenant_subscriptions;
CREATE TRIGGER tenant_subs_updated_at BEFORE UPDATE ON tenant_subscriptions
  FOR EACH ROW EXECUTE FUNCTION trg_billing_updated_at();

DROP TRIGGER IF EXISTS tenant_invoices_updated_at ON tenant_invoices;
CREATE TRIGGER tenant_invoices_updated_at BEFORE UPDATE ON tenant_invoices
  FOR EACH ROW EXECUTE FUNCTION trg_billing_updated_at();

-- ─── 5. Backfill: cada tenant existente arranca con subscription trial ───
INSERT INTO tenant_subscriptions (
  tenant_id, plan_id, estado, billing_cycle, trial_ends_at,
  current_period_start, current_period_end, modo_cobro
)
SELECT
  t.id,
  COALESCE(t.plan, 'trial'),
  CASE
    WHEN t.plan = 'trial' AND t.trial_ends_at > NOW() THEN 'trial'
    WHEN t.plan = 'trial' AND t.trial_ends_at <= NOW() THEN 'trial_expired'
    WHEN t.activo = FALSE THEN 'suspended'
    ELSE 'active'
  END,
  'monthly',
  t.trial_ends_at,
  t.created_at,
  COALESCE(t.trial_ends_at, t.created_at + INTERVAL '30 days'),
  'manual'
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id = t.id);

-- ─── 6. RPC: registrar pago manual de invoice ────────────────────────────
-- Llamada por Lucas desde admin-console cuando un tenant le paga por
-- transferencia o efectivo. Marca invoice como pagada + actualiza
-- subscription (estado=active + nuevo período).
CREATE OR REPLACE FUNCTION fn_registrar_pago_invoice(
  p_invoice_id BIGINT,
  p_metodo_pago TEXT DEFAULT 'transferencia',
  p_gateway_payment_id TEXT DEFAULT NULL,
  p_notas TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_inv RECORD;
  v_user_id INTEGER;
BEGIN
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SOLO_SUPERADMIN';
  END IF;

  SELECT * INTO v_inv FROM tenant_invoices WHERE id = p_invoice_id;
  IF v_inv IS NULL THEN RAISE EXCEPTION 'INVOICE_NO_ENCONTRADA'; END IF;
  IF v_inv.estado = 'pagada' THEN RAISE EXCEPTION 'INVOICE_YA_PAGADA'; END IF;

  v_user_id := auth.uid()::INTEGER;

  UPDATE tenant_invoices SET
    estado = 'pagada',
    fecha_pago = CURRENT_DATE,
    metodo_pago = p_metodo_pago,
    gateway_payment_id = p_gateway_payment_id,
    notas = COALESCE(notas || E'\n', '') || COALESCE(p_notas, ''),
    cobrada_por = v_user_id,
    updated_at = NOW()
  WHERE id = p_invoice_id;

  -- Activar subscription + adelantar período
  UPDATE tenant_subscriptions SET
    estado = 'active',
    current_period_start = v_inv.periodo_desde,
    current_period_end = v_inv.periodo_hasta,
    next_billing_at = v_inv.periodo_hasta + INTERVAL '1 day',
    updated_at = NOW()
  WHERE id = v_inv.subscription_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_registrar_pago_invoice(BIGINT, TEXT, TEXT, TEXT) TO authenticated;

-- ─── 7. RPC: generar invoice del próximo período ─────────────────────────
-- Llamado manual o por cron mensual. Genera la invoice pendiente para
-- que el tenant pague el siguiente período.
CREATE OR REPLACE FUNCTION fn_generar_invoice_proxima(p_tenant_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_sub RECORD;
  v_plan RECORD;
  v_desde DATE;
  v_hasta DATE;
  v_importe NUMERIC;
  v_invoice_id BIGINT;
BEGIN
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SOLO_SUPERADMIN';
  END IF;

  SELECT * INTO v_sub FROM tenant_subscriptions WHERE tenant_id = p_tenant_id;
  IF v_sub IS NULL THEN RAISE EXCEPTION 'SUB_NO_ENCONTRADA'; END IF;

  SELECT * INTO v_plan FROM billing_plans WHERE id = v_sub.plan_id;
  IF v_plan.precio_mensual_ars = 0 THEN
    RAISE EXCEPTION 'PLAN_GRATUITO_NO_GENERA_INVOICE';
  END IF;

  -- Período: siguiente al actual
  v_desde := COALESCE(v_sub.current_period_end, CURRENT_DATE) + INTERVAL '1 day';
  IF v_sub.billing_cycle = 'annual' THEN
    v_hasta := v_desde + INTERVAL '1 year' - INTERVAL '1 day';
    v_importe := COALESCE(v_plan.precio_anual_ars, v_plan.precio_mensual_ars * 12);
  ELSE
    v_hasta := v_desde + INTERVAL '1 month' - INTERVAL '1 day';
    v_importe := v_plan.precio_mensual_ars;
  END IF;

  -- Aplicar descuento si tiene
  v_importe := v_importe * (1 - COALESCE(v_sub.descuento_pct, 0) / 100);

  INSERT INTO tenant_invoices (
    tenant_id, subscription_id,
    periodo_desde, periodo_hasta,
    importe_ars, iva_ars,
    estado, fecha_emision, fecha_vencimiento
  ) VALUES (
    p_tenant_id, v_sub.id,
    v_desde, v_hasta,
    v_importe, v_importe * 0.21,  -- IVA 21%
    'pendiente', CURRENT_DATE, v_desde + INTERVAL '10 days'
  ) RETURNING id INTO v_invoice_id;

  RETURN v_invoice_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_generar_invoice_proxima(UUID) TO authenticated;

-- ─── 8. Vista consolidada para Métricas (admin-console) ──────────────────
CREATE OR REPLACE VIEW v_admin_metricas_tenants AS
WITH ventas_mes AS (
  SELECT v.tenant_id, COUNT(*) AS ventas_mes, COALESCE(SUM(v.monto), 0) AS facturado_mes
  FROM ventas v
  WHERE v.fecha >= date_trunc('month', CURRENT_DATE)
  GROUP BY v.tenant_id
),
ventas_mes_pasado AS (
  SELECT v.tenant_id, COALESCE(SUM(v.monto), 0) AS facturado_mes_pasado
  FROM ventas v
  WHERE v.fecha >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
    AND v.fecha < date_trunc('month', CURRENT_DATE)
  GROUP BY v.tenant_id
)
SELECT
  t.id AS tenant_id,
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
  -- Métricas de uso
  COALESCE(vm.ventas_mes, 0) AS ventas_mes_actual,
  COALESCE(vm.facturado_mes, 0) AS facturado_mes_actual,
  COALESCE(vmp.facturado_mes_pasado, 0) AS facturado_mes_pasado,
  CASE
    WHEN COALESCE(vmp.facturado_mes_pasado, 0) = 0 THEN NULL
    ELSE (vm.facturado_mes - vmp.facturado_mes_pasado) / vmp.facturado_mes_pasado * 100
  END AS crecimiento_pct,
  -- Local count
  (SELECT COUNT(*) FROM locales l WHERE l.tenant_id = t.id) AS locales_count,
  -- Usuarios count
  (SELECT COUNT(*) FROM usuarios u WHERE u.tenant_id = t.id) AS usuarios_count
FROM tenants t
LEFT JOIN tenant_subscriptions s ON s.tenant_id = t.id
LEFT JOIN billing_plans bp ON bp.id = s.plan_id
LEFT JOIN ventas_mes vm ON vm.tenant_id = t.id
LEFT JOIN ventas_mes_pasado vmp ON vmp.tenant_id = t.id;

GRANT SELECT ON v_admin_metricas_tenants TO authenticated;

NOTIFY pgrst, 'reload schema';
