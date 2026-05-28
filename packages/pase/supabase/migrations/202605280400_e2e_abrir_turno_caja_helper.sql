-- ─────────────────────────────────────────────────────────────────────────
-- RPC helper para E2E: abrir turno_caja sin disparar validators con
-- auth_tenant_id() (que es NULL con service_role).
-- ─────────────────────────────────────────────────────────────────────────
--
-- Bug E2E descubierto 2026-05-28:
--   E2E seedComandaPos hace `svc.from("turnos_caja").insert(...)` con
--   service_role. El trigger AFTER INSERT `trg_drenar_reversos_al_abrir_turno`
--   llama a `fn_procesar_reversos_pendientes_comanda` que llama a
--   `fn_assert_local_autorizado`. Esa función chequea:
--     `tenant_id = auth_tenant_id()`
--   Pero con service_role, `auth_tenant_id()` retorna NULL → la query
--   interna no encuentra el local → EXCEPTION 'LOCAL_NO_AUTORIZADO'.
--
-- Resultado: ~10 tests E2E fallaban con cascada.
--
-- Solución: RPC SECURITY DEFINER (corre con privilegios del owner = postgres)
-- que:
--   1. ALTER TABLE turnos_caja DISABLE TRIGGER trg_drenar_reversos_al_abrir_turno
--   2. INSERT turno
--   3. ALTER TABLE turnos_caja ENABLE TRIGGER trg_drenar_reversos_al_abrir_turno
--
-- Solo callable por service_role (privilegio E2E test infra). NO se otorga
-- a authenticated/anon.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._e2e_abrir_turno_caja(
  p_tenant_id UUID,
  p_local_id INTEGER,
  p_cajero_id UUID,
  p_numero INTEGER DEFAULT 1,
  p_monto_inicial NUMERIC DEFAULT 0
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_turno_id BIGINT;
BEGIN
  -- Gate: solo para test infra (service_role). auth.uid() es NULL.
  -- Si hubiera un usuario logueado intentando llamar esto, rechazar.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'E2E_ONLY: esta RPC es solo para test infra con service_role';
  END IF;

  -- Deshabilitar el trigger problemático (validator con auth_tenant_id NULL).
  ALTER TABLE turnos_caja DISABLE TRIGGER trg_drenar_reversos_al_abrir_turno;

  BEGIN
    INSERT INTO turnos_caja (
      tenant_id, local_id, numero, cajero_id, monto_inicial, estado
    ) VALUES (
      p_tenant_id, p_local_id, p_numero, p_cajero_id, p_monto_inicial, 'abierto'
    ) RETURNING id INTO v_turno_id;
  EXCEPTION WHEN OTHERS THEN
    -- Re-habilitar trigger antes de propagar el error
    ALTER TABLE turnos_caja ENABLE TRIGGER trg_drenar_reversos_al_abrir_turno;
    RAISE;
  END;

  -- Re-habilitar trigger
  ALTER TABLE turnos_caja ENABLE TRIGGER trg_drenar_reversos_al_abrir_turno;

  RETURN v_turno_id;
END;
$$;

-- Solo service_role puede llamar (REVOKE explícito de anon/authenticated).
REVOKE ALL ON FUNCTION public._e2e_abrir_turno_caja(UUID, INTEGER, UUID, INTEGER, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._e2e_abrir_turno_caja(UUID, INTEGER, UUID, INTEGER, NUMERIC) TO service_role;

COMMENT ON FUNCTION public._e2e_abrir_turno_caja IS
  'E2E test infra ONLY: insert turno_caja deshabilitando el trigger '
  'trg_drenar_reversos_al_abrir_turno que llama validadores con '
  'auth_tenant_id() (NULL para service_role). Gate por auth.uid() IS NULL.';
