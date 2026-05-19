-- ═══════════════════════════════════════════════════════════════════════════
-- AFIP — facturación electrónica AR
-- Sesión 2026-05-18 (roadmap A3.1)
--
-- Bloqueador legal para operar en AR. COMANDA emite ticket no-fiscal por
-- default, pero los restaurantes formales necesitan factura B/C con CAE.
--
-- 2 tablas:
--   1. afip_credenciales: cert X.509 + clave privada por tenant, junto
--      con la config (CUIT, ambiente: testing/produccion, punto de venta,
--      tipo de contribuyente). El cert lo genera Lucas en AFIP web (con
--      su CUIT + DNI + huella digital o token).
--   2. afip_facturas: registro inmutable de cada factura emitida. Una
--      venta_pos puede tener 0..1 facturas asociadas. CAE + fecha vto +
--      QR fiscal van acá.
--
-- ⚠️ SEGURIDAD: la clave privada del cert NUNCA debe llegar al browser.
-- Solo se accede via service_role en endpoints server-side (Vercel
-- Functions o Supabase Edge Functions). RLS bloquea SELECT directo a
-- authenticated.
--
-- Implementación pendiente:
--   - Endpoint Vercel `/api/afip-cae` que toma la venta + cert del tenant,
--     llama a WSAA (token) + WSFEv1 (factura) y guarda el CAE.
--   - Vercel Free está en 12/12 functions — para agregar este endpoint,
--     liberar slot o usar Supabase Edge Functions (gratis, no cuenta).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Credenciales AFIP por tenant ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS afip_credenciales (
  tenant_id        UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  cuit             TEXT NOT NULL CHECK (cuit ~ '^\d{11}$'),
  ambiente         TEXT NOT NULL DEFAULT 'testing' CHECK (ambiente IN ('testing', 'produccion')),
  punto_venta      INTEGER NOT NULL DEFAULT 1 CHECK (punto_venta > 0),
  tipo_contribuyente TEXT NOT NULL CHECK (tipo_contribuyente IN ('monotributo', 'responsable_inscripto', 'exento')),
  -- Cert X.509 PEM (~2KB texto). Clave privada PKCS#8 PEM (~2KB).
  -- Ambos cifrados at-rest por Supabase (column encryption opcional via
  -- pgsodium). Por ahora plain text en BD — RLS bloquea acceso a
  -- authenticated, solo service_role lee. La key SOLO se usa en endpoints
  -- server-side, NUNCA llega al browser.
  cert_pem         TEXT NULL,
  key_pem          TEXT NULL,
  -- Fecha de expiración del cert (típicamente 2 años desde generación)
  cert_vence_at    TIMESTAMPTZ NULL,
  -- Último login WSAA exitoso (token tiene TTL 12hs)
  ultimo_token_at  TIMESTAMPTZ NULL,
  -- Activa: true para empezar a emitir facturas; false = solo configurada
  activa           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       INTEGER NULL REFERENCES usuarios(id)
);

CREATE TRIGGER trg_afip_cred_set_updated_at
  BEFORE UPDATE ON afip_credenciales
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE afip_credenciales ENABLE ROW LEVEL SECURITY;

-- SELECT solo dueño/admin/superadmin del tenant. La clave PEM NO se expone
-- aunque la policy permita SELECT — se hace GRANT solo en columnas no-secretas.
DROP POLICY IF EXISTS afip_cred_select ON afip_credenciales;
CREATE POLICY afip_cred_select ON afip_credenciales FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  );

DROP POLICY IF EXISTS afip_cred_modify ON afip_credenciales;
CREATE POLICY afip_cred_modify ON afip_credenciales FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  );

DROP POLICY IF EXISTS afip_cred_service ON afip_credenciales;
CREATE POLICY afip_cred_service ON afip_credenciales FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Revocar SELECT amplio + GRANT solo en columnas no-secretas
REVOKE SELECT ON afip_credenciales FROM authenticated;
GRANT SELECT (
  tenant_id, cuit, ambiente, punto_venta, tipo_contribuyente,
  cert_vence_at, ultimo_token_at, activa,
  created_at, updated_at, created_by
) ON afip_credenciales TO authenticated;

-- ─── Facturas emitidas via AFIP ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS afip_facturas (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  venta_pos_id     BIGINT REFERENCES ventas_pos(id) ON DELETE SET NULL,
  -- Tipo: 6=B, 11=C, 1=A (códigos AFIP)
  tipo_comprobante INTEGER NOT NULL CHECK (tipo_comprobante IN (1, 6, 11, 51, 56, 61, 66, 81, 86, 91, 96)),
  punto_venta      INTEGER NOT NULL,
  numero           BIGINT NOT NULL,
  -- Totales
  importe_neto     NUMERIC(14,2) NOT NULL,
  importe_iva      NUMERIC(14,2) NOT NULL DEFAULT 0,
  importe_total    NUMERIC(14,2) NOT NULL,
  -- Concepto: 1=Productos, 2=Servicios, 3=Productos+Servicios
  concepto         INTEGER NOT NULL DEFAULT 1 CHECK (concepto IN (1, 2, 3)),
  -- Cliente
  doc_tipo         INTEGER NULL,  -- 96=DNI, 80=CUIT, 99=CF (consumidor final)
  doc_nro          TEXT NULL,
  cliente_razon_social TEXT NULL,
  -- CAE retornado por AFIP
  cae              TEXT NULL,
  cae_vence_at     DATE NULL,
  -- QR fiscal AR (Res. Gral. 4892/2020) — URL completa a www.afip.gob.ar/fe/qr/
  qr_fiscal_url    TEXT NULL,
  -- Estado del trámite
  estado           TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aprobada', 'rechazada', 'anulada')),
  rechazo_motivo   TEXT NULL,
  -- Para reintentos: idempotency key del request a AFIP
  request_uuid     UUID UNIQUE,
  -- Auditoría
  emitida_at       TIMESTAMPTZ NULL,
  emitida_por      INTEGER NULL REFERENCES usuarios(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uniq_afip_factura_numero UNIQUE (tenant_id, tipo_comprobante, punto_venta, numero)
);

CREATE INDEX IF NOT EXISTS idx_afip_facturas_tenant_emitida
  ON afip_facturas(tenant_id, emitida_at DESC) WHERE estado = 'aprobada';
CREATE INDEX IF NOT EXISTS idx_afip_facturas_venta
  ON afip_facturas(venta_pos_id) WHERE venta_pos_id IS NOT NULL;

CREATE TRIGGER trg_afip_fac_set_updated_at
  BEFORE UPDATE ON afip_facturas
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE afip_facturas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS afip_fac_select ON afip_facturas;
CREATE POLICY afip_fac_select ON afip_facturas FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR tenant_id = auth_tenant_id()
  );

DROP POLICY IF EXISTS afip_fac_modify ON afip_facturas;
CREATE POLICY afip_fac_modify ON afip_facturas FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  );

DROP POLICY IF EXISTS afip_fac_service ON afip_facturas;
CREATE POLICY afip_fac_service ON afip_facturas FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE afip_credenciales IS
  'Cert X.509 + clave privada AFIP por tenant. Clave NUNCA al browser — solo service_role la lee desde endpoints server-side.';

COMMENT ON TABLE afip_facturas IS
  'Registro inmutable de facturas electrónicas emitidas via AFIP WSFEv1. Cada venta_pos puede tener 0..1 facturas. CAE + QR fiscal obligatorios AR.';

NOTIFY pgrst, 'reload schema';
