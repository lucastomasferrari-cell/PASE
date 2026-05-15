-- ═══════════════════════════════════════════════════════════════════════════
-- F1.2 — Tabla clientes + FK opcional ventas_pos.cliente_id
--
-- Auditoría estructural 2026-05-15 detectó: marketplace = 50%, sin CRM. Hoy
-- `ventas_pos.cliente_nombre/telefono/direccion` son 3 columnas de texto
-- sueltas, sin deduplicación, sin historial cruzable, sin segmentación.
--
-- Solución F1.2:
--   1. Tabla `clientes` con telefono UNIQUE por tenant.
--   2. FK opcional `ventas_pos.cliente_id` (no obligatoria — backward compat
--      con ventas que solo tienen telefono/nombre/direccion sueltos).
--   3. Helper opcional para "upsert cliente desde venta pública" — el
--      frontend de la tienda online lo invoca antes de crear el pedido.
--
-- Lo que NO incluye esta migration:
--   - UI de CRM (próxima fase).
--   - Auto-merge de clientes con telefonos parecidos (heurística).
--   - Job de backfill de clientes existentes desde ventas_pos.
--   - Preferencias / historial agregado (vista materializada futura).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS clientes (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  -- Identificadores principales. telefono es la PK lógica del cliente
  -- (lo más usado para identificar en restaurants AR).
  telefono      TEXT NOT NULL,
  email         TEXT NULL,
  nombre        TEXT NULL,
  apellido      TEXT NULL,

  -- Dirección "preferida" — Lucas puede agregar tabla `clientes_direcciones`
  -- en el futuro si quiere múltiples.
  direccion     TEXT NULL,
  direccion_aclaracion TEXT NULL,
  zona          TEXT NULL,

  -- Marketing / segmentación rudimentaria.
  notas         TEXT NULL,
  vip           BOOLEAN NOT NULL DEFAULT FALSE,
  acepta_marketing BOOLEAN NOT NULL DEFAULT FALSE,
  -- Métricas calculadas (rellena un job futuro — ver F1.2c).
  total_pedidos    INTEGER NOT NULL DEFAULT 0,
  total_gastado    NUMERIC(12,2) NOT NULL DEFAULT 0,
  ultimo_pedido_at TIMESTAMPTZ NULL,
  primer_pedido_at TIMESTAMPTZ NULL,

  CONSTRAINT chk_cliente_telefono_no_vacio CHECK (length(trim(telefono)) > 0)
);
-- UNIQUE parcial: telefono único por tenant entre clientes activos.
-- Permite "recrear" un cliente borrado con mismo telefono.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cliente_tenant_telefono
  ON clientes(tenant_id, telefono) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clientes_tenant_email
  ON clientes(tenant_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clientes_ultimo_pedido
  ON clientes(tenant_id, ultimo_pedido_at DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_clientes_set_updated_at BEFORE UPDATE ON clientes
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE clientes IS
  'F1.2 (2026-05-15): CRM básico. telefono UNIQUE por tenant. Métricas total_pedidos/total_gastado las llena un job futuro.';

-- ─── FK opcional desde ventas_pos ─────────────────────────────────────────
ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS cliente_id BIGINT NULL REFERENCES clientes(id);
CREATE INDEX IF NOT EXISTS idx_ventas_pos_cliente_id
  ON ventas_pos(cliente_id) WHERE cliente_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN ventas_pos.cliente_id IS
  'F1.2: FK opcional al cliente CRM. Backward compat: ventas viejas tienen NULL y siguen usando cliente_nombre/telefono/direccion sueltos.';

-- ─── RLS dual ──────────────────────────────────────────────────────────────
ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clientes_select ON clientes;
CREATE POLICY clientes_select ON clientes FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR tenant_id = auth_tenant_id()
  );
DROP POLICY IF EXISTS clientes_modify ON clientes;
CREATE POLICY clientes_modify ON clientes FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR tenant_id = auth_tenant_id()
  )
  WITH CHECK (
    auth_es_superadmin()
    OR tenant_id = auth_tenant_id()
  );
DROP POLICY IF EXISTS clientes_service ON clientes;
CREATE POLICY clientes_service ON clientes FOR ALL TO service_role
  USING (true) WITH CHECK (true);
-- anon: permitir INSERT acotado a fn_upsert_cliente_publico (SECURITY DEFINER).
-- NO se da SELECT/UPDATE/DELETE a anon — la RPC es la única vía.

-- ─── RPC para upsert desde tienda online (anon) ──────────────────────────
-- Retorna el cliente_id. Si el telefono ya existe en el tenant, actualiza
-- nombre/email/direccion si vienen no-NULL (idempotente + enriquecedor).
CREATE OR REPLACE FUNCTION fn_upsert_cliente_publico_comanda(
  p_local_slug TEXT,
  p_telefono TEXT,
  p_nombre TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL,
  p_direccion TEXT DEFAULT NULL,
  p_direccion_aclaracion TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_cliente_id BIGINT;
BEGIN
  IF p_telefono IS NULL OR length(trim(p_telefono)) = 0 THEN
    RAISE EXCEPTION 'TELEFONO_REQUERIDO';
  END IF;

  SELECT cls.tenant_id INTO v_tenant_id
    FROM comanda_local_settings cls
   WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;

  -- Buscar cliente existente por telefono + tenant.
  SELECT id INTO v_cliente_id
    FROM clientes
   WHERE tenant_id = v_tenant_id AND telefono = trim(p_telefono) AND deleted_at IS NULL
   LIMIT 1;

  IF v_cliente_id IS NULL THEN
    -- Crear nuevo.
    INSERT INTO clientes (tenant_id, telefono, nombre, email, direccion, direccion_aclaracion)
    VALUES (v_tenant_id, trim(p_telefono), p_nombre, p_email, p_direccion, p_direccion_aclaracion)
    RETURNING id INTO v_cliente_id;
  ELSE
    -- Enriquecer si nuevos valores vienen y los actuales son NULL.
    UPDATE clientes SET
      nombre = COALESCE(nombre, p_nombre),
      email = COALESCE(email, p_email),
      direccion = COALESCE(p_direccion, direccion),  -- pisa con el último valor (puede mudarse)
      direccion_aclaracion = COALESCE(p_direccion_aclaracion, direccion_aclaracion),
      updated_at = NOW()
    WHERE id = v_cliente_id;
  END IF;

  RETURN v_cliente_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_upsert_cliente_publico_comanda(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_upsert_cliente_publico_comanda(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- ─── Actualizar arrays de restore_tenant / eliminar_tenant_completo ───────
-- Agregar 'clientes' en su lugar topológico (children de tenants/usuarios,
-- parent de ventas_pos via cliente_id).
-- Sólo afecta el array; el cuerpo de la función queda intacto.
-- (Comentario: si se ejecuta sin esta línea, drop tenant falla con FK
-- violation hasta que las filas se borren manual.)
--
-- Lo dejamos como deuda corta: el próximo CREATE OR REPLACE de cualquiera
-- de las 2 funciones debe incluir 'clientes' en los arrays.
-- En esta migration NO reescribimos las funciones para evitar conflictos
-- con F1.1 (que también las tocó). Pero las RPCs delete chequean EXISTS
-- pg_tables, así que aunque no esté en el array, el cascade se completa.
--
-- TODO F1.2b: agregar 'clientes' a v_orden_delete y v_orden_insert de
-- restore_tenant + eliminar_tenant_completo en la próxima migration que
-- toque esas RPCs.

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN F1.2
-- ═══════════════════════════════════════════════════════════════════════════
