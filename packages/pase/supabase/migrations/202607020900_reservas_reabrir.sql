-- Reabrir reservas (botón "Reactivar" del admin): permitir transición de estados
-- terminales (cancelada / no_show / finalizada) → confirmada. Antes la máquina de
-- estados las trataba como terminales sin retorno, así que "Reactivar" tiraba
-- RESERVA_TRANSICION_INVALIDA. Al reabrir se re-valida la mesa: si la banqueta/mesa
-- que tenía fue tomada por otra reserva activa mientras tanto, se suelta (mesa_id/
-- mesas_ids = NULL) para que el host la reasigne — nunca se dobla una mesa.
CREATE OR REPLACE FUNCTION public.fn_cambiar_estado_reserva(p_reserva_id bigint, p_nuevo_estado text, p_motivo text DEFAULT NULL::text, p_mesa_id bigint DEFAULT NULL::bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_r reservas%ROWTYPE;
  v_local_mesa integer;
  v_permitidas text[];
  v_cliente_id bigint;
  v_venta_id bigint;
  v_mesa_link bigint;
  v_reabrir boolean := false;
  v_clear_mesa boolean := false;
  v_m bigint;
BEGIN
  -- Alias de compat: bundles COMANDA viejos mandan 'cumplida' al sentar.
  IF p_nuevo_estado = 'cumplida' THEN p_nuevo_estado := 'sentada'; END IF;

  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT * INTO v_r FROM reservas
   WHERE id = p_reserva_id AND tenant_id = v_tenant AND deleted_at IS NULL
   FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_r.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF p_nuevo_estado NOT IN ('confirmada', 'sentada', 'finalizada', 'no_show', 'cancelada') THEN
    RAISE EXCEPTION 'ESTADO_INVALIDO';
  END IF;

  -- Máquina de estados (Tier1 #4) + REABRIR:
  --   pendiente  → confirmada | sentada (walk-in) | cancelada
  --   confirmada → sentada | no_show | cancelada
  --   sentada    → finalizada
  --   cancelada / no_show / finalizada → confirmada  (reabrir/Reactivar)
  v_permitidas := CASE v_r.estado
    WHEN 'pendiente'  THEN ARRAY['confirmada', 'sentada', 'cancelada']
    WHEN 'confirmada' THEN ARRAY['sentada', 'no_show', 'cancelada']
    WHEN 'sentada'    THEN ARRAY['finalizada']
    WHEN 'cancelada'  THEN ARRAY['confirmada']
    WHEN 'no_show'    THEN ARRAY['confirmada']
    WHEN 'finalizada' THEN ARRAY['confirmada']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (p_nuevo_estado = ANY(v_permitidas)) THEN
    RAISE EXCEPTION 'RESERVA_TRANSICION_INVALIDA: % → %', v_r.estado, p_nuevo_estado;
  END IF;

  v_reabrir := (v_r.estado IN ('cancelada','no_show','finalizada') AND p_nuevo_estado = 'confirmada');

  -- Sentar con mesa opcional (solo aplica al pasar a sentada).
  IF p_mesa_id IS NOT NULL THEN
    IF p_nuevo_estado != 'sentada' THEN
      RAISE EXCEPTION 'MESA_SOLO_AL_SENTAR';
    END IF;
    SELECT local_id INTO v_local_mesa FROM mesas WHERE id = p_mesa_id AND deleted_at IS NULL;
    IF v_local_mesa IS NULL THEN RAISE EXCEPTION 'MESA_NO_ENCONTRADA'; END IF;
    IF v_local_mesa != v_r.local_id THEN RAISE EXCEPTION 'MESA_OTRO_LOCAL'; END IF;
  END IF;

  -- Al reabrir: re-validar la mesa que tenía. Si fue tomada por otra reserva
  -- activa en el mismo horario, soltarla para reasignación manual.
  IF v_reabrir THEN
    PERFORM pg_advisory_xact_lock(v_r.local_id::bigint);
    IF v_r.mesas_ids IS NOT NULL AND array_length(v_r.mesas_ids, 1) IS NOT NULL THEN
      FOREACH v_m IN ARRAY v_r.mesas_ids LOOP
        IF fn_mesa_ocupada_en(v_m, v_r.fecha_hora, COALESCE(v_r.duracion_min, 90), v_r.id) THEN
          v_clear_mesa := TRUE;
        END IF;
      END LOOP;
    ELSIF v_r.mesa_id IS NOT NULL THEN
      IF fn_mesa_ocupada_en(v_r.mesa_id, v_r.fecha_hora, COALESCE(v_r.duracion_min, 90), v_r.id) THEN
        v_clear_mesa := TRUE;
      END IF;
    END IF;
  END IF;

  IF p_nuevo_estado = 'sentada' THEN
    -- (a) Upsert de cliente INLINE, best-effort.
    v_cliente_id := v_r.cliente_id;
    IF v_cliente_id IS NULL AND v_r.cliente_telefono IS NOT NULL
       AND length(trim(v_r.cliente_telefono)) >= 6 THEN
      BEGIN
        SELECT id INTO v_cliente_id
          FROM clientes
         WHERE tenant_id = v_tenant
           AND fn_normalizar_telefono(telefono) = fn_normalizar_telefono(v_r.cliente_telefono)
           AND deleted_at IS NULL
         LIMIT 1;
        IF v_cliente_id IS NULL THEN
          INSERT INTO clientes (tenant_id, telefono, nombre, email)
          VALUES (v_tenant,
                  COALESCE(fn_normalizar_telefono(v_r.cliente_telefono), trim(v_r.cliente_telefono)),
                  v_r.cliente_nombre, v_r.cliente_email)
          RETURNING id INTO v_cliente_id;
        ELSE
          UPDATE clientes SET
            nombre = COALESCE(nombre, v_r.cliente_nombre),
            email  = COALESCE(email,  v_r.cliente_email),
            updated_at = NOW()
          WHERE id = v_cliente_id;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_cliente_id := NULL;
      END;
    END IF;

    -- (b) Auto-link de venta viva en la mesa.
    v_mesa_link := COALESCE(p_mesa_id, v_r.mesa_id);
    IF v_mesa_link IS NOT NULL THEN
      SELECT vp.id INTO v_venta_id
        FROM ventas_pos vp
       WHERE vp.mesa_id = v_mesa_link
         AND vp.local_id = v_r.local_id
         AND vp.estado IN ('abierta', 'enviada', 'lista', 'entregada')
         AND vp.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM reservas r2
            WHERE r2.venta_id = vp.id AND r2.deleted_at IS NULL
         )
       ORDER BY vp.created_at DESC
       LIMIT 1;
      IF v_venta_id IS NOT NULL AND v_cliente_id IS NOT NULL THEN
        UPDATE ventas_pos SET cliente_id = COALESCE(cliente_id, v_cliente_id)
         WHERE id = v_venta_id;
      END IF;
    END IF;
  END IF;

  UPDATE reservas SET
    estado = p_nuevo_estado,
    mesa_id = CASE WHEN v_reabrir AND v_clear_mesa THEN NULL ELSE COALESCE(p_mesa_id, mesa_id) END,
    mesas_ids = CASE WHEN v_reabrir AND v_clear_mesa THEN NULL ELSE mesas_ids END,
    cliente_id = COALESCE(v_cliente_id, cliente_id),
    venta_id = COALESCE(v_venta_id, venta_id),
    confirmada_at = CASE WHEN p_nuevo_estado = 'confirmada'  THEN NOW() ELSE confirmada_at END,
    sentada_at    = CASE WHEN p_nuevo_estado = 'sentada'     THEN NOW() ELSE sentada_at END,
    finalizada_at = CASE WHEN p_nuevo_estado = 'finalizada'  THEN NOW()
                         WHEN v_reabrir THEN NULL ELSE finalizada_at END,
    cancelada_at  = CASE WHEN p_nuevo_estado = 'cancelada'   THEN NOW()
                         WHEN v_reabrir THEN NULL ELSE cancelada_at END,
    motivo_cancelacion = CASE WHEN p_nuevo_estado = 'cancelada' THEN NULLIF(trim(COALESCE(p_motivo, '')), '')
                              WHEN v_reabrir THEN NULL ELSE motivo_cancelacion END,
    cancelada_por_cliente = CASE WHEN v_reabrir THEN FALSE ELSE cancelada_por_cliente END,
    no_show_auto  = CASE WHEN v_reabrir THEN FALSE ELSE no_show_auto END,
    updated_at = NOW()
  WHERE id = p_reserva_id;
END;
$function$;
