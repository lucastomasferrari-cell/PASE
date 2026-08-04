-- Reconciliar opt-in de marketing: usar el flag existente `acepta_marketing`
-- ---------------------------------------------------------------------------
-- La migr 202608040100 agregó `marketing_opt_in` sin ver que YA existía
-- `clientes.acepta_marketing` (que usa segmentosService y el resto de Habitué).
-- Para no tener dos flags competidos, se elimina el duplicado y todo el motor de
-- marketing usa `acepta_marketing`. Se conserva `unsubscribed_at` (timestamp útil).
-- Las RPCs de evento/baja pasan a togglear `acepta_marketing`.

ALTER TABLE clientes DROP COLUMN IF EXISTS marketing_opt_in;

-- fn_mkt_registrar_evento: en 'complained', opt-out por acepta_marketing.
CREATE OR REPLACE FUNCTION public.fn_mkt_registrar_evento(
  p_resend_email_id text, p_tipo text, p_url text DEFAULT NULL, p_metadata jsonb DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_dest       mkt_campana_destinatarios%ROWTYPE;
  v_primera_op boolean := false;
  v_primer_cl  boolean := false;
BEGIN
  SELECT * INTO v_dest FROM mkt_campana_destinatarios WHERE resend_email_id = p_resend_email_id LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO mkt_eventos (tenant_id, campana_id, destinatario_id, email, tipo, url, resend_email_id, metadata)
    VALUES (v_dest.tenant_id, v_dest.campana_id, v_dest.id, v_dest.email, p_tipo, p_url, p_resend_email_id, p_metadata);

  IF p_tipo = 'delivered' THEN
    UPDATE mkt_campana_destinatarios SET estado = 'entregado' WHERE id = v_dest.id AND estado NOT IN ('entregado','rebotado');
    IF FOUND THEN UPDATE mkt_campanas SET total_entregados = total_entregados + 1 WHERE id = v_dest.campana_id; END IF;
  ELSIF p_tipo = 'opened' THEN
    v_primera_op := NOT v_dest.abierto;
    UPDATE mkt_campana_destinatarios SET abierto = true, aperturas = aperturas + 1,
      primera_apertura_at = COALESCE(primera_apertura_at, now()) WHERE id = v_dest.id;
    IF v_primera_op THEN UPDATE mkt_campanas SET total_aperturas = total_aperturas + 1 WHERE id = v_dest.campana_id; END IF;
  ELSIF p_tipo = 'clicked' THEN
    v_primer_cl := NOT v_dest.clickeado;
    UPDATE mkt_campana_destinatarios SET clickeado = true, clicks = clicks + 1, ultimo_click_at = now() WHERE id = v_dest.id;
    IF v_primer_cl THEN UPDATE mkt_campanas SET total_clicks = total_clicks + 1 WHERE id = v_dest.campana_id; END IF;
  ELSIF p_tipo = 'bounced' THEN
    UPDATE mkt_campana_destinatarios SET estado = 'rebotado' WHERE id = v_dest.id AND estado <> 'rebotado';
    IF FOUND THEN UPDATE mkt_campanas SET total_rebotes = total_rebotes + 1 WHERE id = v_dest.campana_id; END IF;
    INSERT INTO mkt_supresiones (tenant_id, email, motivo, campana_id)
      VALUES (v_dest.tenant_id, v_dest.email, 'bounce', v_dest.campana_id) ON CONFLICT (tenant_id, email) DO NOTHING;
  ELSIF p_tipo = 'complained' THEN
    UPDATE mkt_campanas SET total_quejas = total_quejas + 1 WHERE id = v_dest.campana_id;
    INSERT INTO mkt_supresiones (tenant_id, email, motivo, campana_id)
      VALUES (v_dest.tenant_id, v_dest.email, 'complaint', v_dest.campana_id) ON CONFLICT (tenant_id, email) DO NOTHING;
    UPDATE clientes SET acepta_marketing = false, unsubscribed_at = now()
      WHERE tenant_id = v_dest.tenant_id AND lower(email) = v_dest.email;
  END IF;
  RETURN true;
END;
$function$;

-- fn_mkt_baja: opt-out por acepta_marketing.
CREATE OR REPLACE FUNCTION public.fn_mkt_baja(
  p_tenant_id uuid, p_email text, p_campana_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_email text := lower(trim(p_email));
BEGIN
  INSERT INTO mkt_supresiones (tenant_id, email, motivo, campana_id)
    VALUES (p_tenant_id, v_email, 'unsubscribe', p_campana_id) ON CONFLICT (tenant_id, email) DO NOTHING;
  UPDATE clientes SET acepta_marketing = false, unsubscribed_at = now()
    WHERE tenant_id = p_tenant_id AND lower(email) = v_email;
  IF p_campana_id IS NOT NULL THEN
    UPDATE mkt_campanas SET total_bajas = total_bajas + 1 WHERE id = p_campana_id;
  END IF;
END;
$function$;
