-- ============================================================
-- 202607031200_reservas_combinaciones_explicitas.sql
-- Combinar mesas por COMBINACIONES EXPLÍCITAS (estilo OpenTable/SevenRooms).
--
-- Antes: fn_buscar_mesas_reserva juntaba CUALQUIER grupo de mesas libres del
-- mismo sector que sumara la capacidad → podía ofrecer combos físicamente
-- imposibles (mesas que no se tocan) y asumía capacidad = suma.
--
-- Ahora: el dueño define combos concretos (qué mesas se juntan + cuántos
-- cubiertos da esa combinación) en `reservas_combinaciones`. El motor, cuando
-- no entra en una mesa sola, ofrece el combo MÁS CHICO que entre y cuyas mesas
-- estén TODAS libres en la ventana (y todas del sector pedido, si se pidió).
--
-- Sigue: mesa sola primero; combos solo si p_permite_combinar; fallback de
-- mesa sola relajando el mín del sector.
-- ============================================================

BEGIN;

-- 1) Tabla de combinaciones ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservas_combinaciones (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  local_id    INTEGER NOT NULL REFERENCES locales(id),
  nombre      TEXT,
  mesa_ids    BIGINT[] NOT NULL,
  capacidad   INTEGER NOT NULL,
  activa      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT reservas_combinaciones_min2 CHECK (array_length(mesa_ids, 1) >= 2),
  CONSTRAINT reservas_combinaciones_cap CHECK (capacidad >= 1)
);
CREATE INDEX IF NOT EXISTS idx_reservas_combinaciones_local
  ON reservas_combinaciones (local_id) WHERE deleted_at IS NULL;

ALTER TABLE reservas_combinaciones ENABLE ROW LEVEL SECURITY;

-- Mismas reglas que `mesas`: lo administra dueño/admin (o encargado del local
-- con permiso comanda.mesas.gestionar). El motor público lo lee vía función
-- SECURITY DEFINER, así que no necesita policy para anon.
DROP POLICY IF EXISTS rc_select ON reservas_combinaciones;
CREATE POLICY rc_select ON reservas_combinaciones FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      auth_es_superadmin() OR (
        tenant_id = auth_tenant_id()
        AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
      )
    )
  );
DROP POLICY IF EXISTS rc_write ON reservas_combinaciones;
CREATE POLICY rc_write ON reservas_combinaciones FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id()
      AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
      AND auth_tiene_permiso('comanda.mesas.gestionar')
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id()
      AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
      AND auth_tiene_permiso('comanda.mesas.gestionar')
    )
  );

-- 2) Motor: mesa sola → combo EXPLÍCITO → fallback mesa sola ─────────────────
CREATE OR REPLACE FUNCTION public.fn_buscar_mesas_reserva(
  p_local_id integer, p_inicio timestamp with time zone, p_dur_min integer,
  p_personas integer, p_permite_combinar boolean, p_zona text DEFAULT NULL::text
)
RETURNS bigint[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $function$
DECLARE
  v_mesa bigint;
  v_ids bigint[];
BEGIN
  -- 1) Mejor mesa individual (respeta mín Y máx del sector).
  SELECT m.id INTO v_mesa FROM mesas m
  WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
    AND COALESCE(m.capacidad,0) >= p_personas
    AND (p_zona IS NULL OR m.zona = p_zona)
    AND fn_zona_admite_personas(p_local_id, m.zona, p_personas)
    AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
  ORDER BY m.capacidad ASC, m.id ASC LIMIT 1;
  IF v_mesa IS NOT NULL THEN RETURN ARRAY[v_mesa]; END IF;

  -- 2) Combinación EXPLÍCITA: el combo definido más chico que entre y cuyas
  --    mesas estén TODAS libres en la ventana (y todas del sector pedido).
  IF p_permite_combinar THEN
    SELECT c.mesa_ids INTO v_ids
    FROM reservas_combinaciones c
    WHERE c.local_id = p_local_id AND c.activa AND c.deleted_at IS NULL
      AND COALESCE(c.capacidad,0) >= p_personas
      -- si se pidió un sector, TODAS las mesas del combo deben ser de ese sector
      AND (p_zona IS NULL OR NOT EXISTS (
            SELECT 1 FROM mesas m WHERE m.id = ANY(c.mesa_ids) AND m.zona IS DISTINCT FROM p_zona))
      -- todas las mesas del combo existen en el local, reservables y no borradas
      AND NOT EXISTS (
            SELECT 1 FROM unnest(c.mesa_ids) mid
            WHERE NOT EXISTS (
              SELECT 1 FROM mesas m
              WHERE m.id = mid AND m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable))
      -- ninguna mesa del combo ocupada en la ventana
      AND NOT EXISTS (
            SELECT 1 FROM unnest(c.mesa_ids) mid
            WHERE fn_mesa_ocupada_en(mid, p_inicio, p_dur_min, NULL))
    ORDER BY c.capacidad ASC, c.id ASC
    LIMIT 1;
    IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
      RETURN v_ids;
    END IF;
  END IF;

  -- 3) FALLBACK: mesa sola relajando el mín del sector (solo respeta máx).
  SELECT m.id INTO v_mesa FROM mesas m
  WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
    AND COALESCE(m.capacidad,0) >= p_personas
    AND (p_zona IS NULL OR m.zona = p_zona)
    AND fn_zona_admite_personas(p_local_id, m.zona, p_personas, TRUE)
    AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
  ORDER BY m.capacidad ASC, m.id ASC LIMIT 1;
  IF v_mesa IS NOT NULL THEN RETURN ARRAY[v_mesa]; END IF;

  RETURN ARRAY[]::bigint[];
END; $function$;

COMMIT;
