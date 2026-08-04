-- Habitué marketing · RPC atómica para ingestar eventos de Resend (webhook)
-- ---------------------------------------------------------------------------
-- El webhook llama a esta fn por cada evento (delivered/opened/clicked/bounced/
-- complained). Hace todo en una transacción para evitar carreras al contar
-- aperturas/clicks concurrentes: inserta el evento crudo, actualiza el
-- destinatario (apertura/click únicos), incrementa los contadores rollup de la
-- campaña y — en bounce/complaint — agrega la supresión (do-not-send).
-- SECURITY DEFINER: la llama el endpoint con service key; igual valida por
-- resend_email_id (no expone nada por tenant ajeno).

CREATE OR REPLACE FUNCTION public.fn_mkt_registrar_evento(
  p_resend_email_id text,
  p_tipo text,
  p_url text DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_dest       mkt_campana_destinatarios%ROWTYPE;
  v_primera_op boolean := false;
  v_primer_cl  boolean := false;
BEGIN
  SELECT * INTO v_dest FROM mkt_campana_destinatarios
   WHERE resend_email_id = p_resend_email_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;  -- evento sin destinatario conocido (ej. test) → ignorar
  END IF;

  INSERT INTO mkt_eventos (tenant_id, campana_id, destinatario_id, email, tipo, url, resend_email_id, metadata)
    VALUES (v_dest.tenant_id, v_dest.campana_id, v_dest.id, v_dest.email, p_tipo, p_url, p_resend_email_id, p_metadata);

  IF p_tipo = 'delivered' THEN
    UPDATE mkt_campana_destinatarios SET estado = 'entregado'
     WHERE id = v_dest.id AND estado NOT IN ('entregado','rebotado');
    IF FOUND THEN
      UPDATE mkt_campanas SET total_entregados = total_entregados + 1 WHERE id = v_dest.campana_id;
    END IF;

  ELSIF p_tipo = 'opened' THEN
    v_primera_op := NOT v_dest.abierto;
    UPDATE mkt_campana_destinatarios
       SET abierto = true, aperturas = aperturas + 1,
           primera_apertura_at = COALESCE(primera_apertura_at, now())
     WHERE id = v_dest.id;
    IF v_primera_op THEN
      UPDATE mkt_campanas SET total_aperturas = total_aperturas + 1 WHERE id = v_dest.campana_id;
    END IF;

  ELSIF p_tipo = 'clicked' THEN
    v_primer_cl := NOT v_dest.clickeado;
    UPDATE mkt_campana_destinatarios
       SET clickeado = true, clicks = clicks + 1, ultimo_click_at = now()
     WHERE id = v_dest.id;
    IF v_primer_cl THEN
      UPDATE mkt_campanas SET total_clicks = total_clicks + 1 WHERE id = v_dest.campana_id;
    END IF;

  ELSIF p_tipo = 'bounced' THEN
    UPDATE mkt_campana_destinatarios SET estado = 'rebotado' WHERE id = v_dest.id AND estado <> 'rebotado';
    IF FOUND THEN
      UPDATE mkt_campanas SET total_rebotes = total_rebotes + 1 WHERE id = v_dest.campana_id;
    END IF;
    INSERT INTO mkt_supresiones (tenant_id, email, motivo, campana_id)
      VALUES (v_dest.tenant_id, v_dest.email, 'bounce', v_dest.campana_id)
      ON CONFLICT (tenant_id, email) DO NOTHING;

  ELSIF p_tipo = 'complained' THEN
    UPDATE mkt_campanas SET total_quejas = total_quejas + 1 WHERE id = v_dest.campana_id;
    INSERT INTO mkt_supresiones (tenant_id, email, motivo, campana_id)
      VALUES (v_dest.tenant_id, v_dest.email, 'complaint', v_dest.campana_id)
      ON CONFLICT (tenant_id, email) DO NOTHING;
    UPDATE clientes SET marketing_opt_in = false, unsubscribed_at = now()
      WHERE tenant_id = v_dest.tenant_id AND lower(email) = v_dest.email;
  END IF;

  RETURN true;
END;
$function$;

-- Baja (unsubscribe) desde nuestro endpoint: supresión + opt-out + rollup.
CREATE OR REPLACE FUNCTION public.fn_mkt_baja(
  p_tenant_id uuid, p_email text, p_campana_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_email text := lower(trim(p_email));
BEGIN
  INSERT INTO mkt_supresiones (tenant_id, email, motivo, campana_id)
    VALUES (p_tenant_id, v_email, 'unsubscribe', p_campana_id)
    ON CONFLICT (tenant_id, email) DO NOTHING;
  UPDATE clientes SET marketing_opt_in = false, unsubscribed_at = now()
    WHERE tenant_id = p_tenant_id AND lower(email) = v_email;
  IF p_campana_id IS NOT NULL THEN
    UPDATE mkt_campanas SET total_bajas = total_bajas + 1 WHERE id = p_campana_id;
  END IF;
END;
$function$;
