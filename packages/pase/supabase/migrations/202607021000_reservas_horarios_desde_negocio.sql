-- Un solo origen de verdad para los horarios: las columnas de negocio
-- horario_dom..horario_sab ("HH:MM – HH:MM" o NULL = cerrado). El motor de
-- reservas usaba un JSONB aparte (reservas_horarios) que podía quedar
-- desincronizado → dejaba reservar días cerrados (ej. Maneki lunes/domingo).
-- Ahora reservas_horarios se DERIVA automáticamente de las columnas de negocio
-- vía trigger, así el link de reservas siempre respeta cuándo abre el local.

CREATE OR REPLACE FUNCTION public.fn_derivar_reservas_horarios(p_row comanda_local_settings)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_dias text[] := ARRAY['dom','lun','mar','mie','jue','vie','sab']; -- índice 0..6 = DOW
  v_i int; v_txt text; v_abre text; v_cierra text; v_parts text[];
BEGIN
  FOR v_i IN 0..6 LOOP
    EXECUTE format('SELECT ($1).horario_%s', v_dias[v_i+1]) INTO v_txt USING p_row;
    IF v_txt IS NULL OR btrim(v_txt) = '' THEN CONTINUE; END IF; -- cerrado ese día
    -- separar por guion normal o en-dash, tolerando espacios
    v_parts := regexp_split_to_array(v_txt, '\s*[–-]\s*');
    IF array_length(v_parts,1) < 2 THEN CONTINUE; END IF;
    v_abre := btrim(v_parts[1]); v_cierra := btrim(v_parts[2]);
    IF v_abre !~ '^\d{1,2}:\d{2}$' OR v_cierra !~ '^\d{1,2}:\d{2}$' THEN CONTINUE; END IF;
    v_out := v_out || jsonb_build_object('dia', v_i, 'abre', v_abre, 'cierra', v_cierra);
  END LOOP;
  RETURN v_out;
END; $$;

CREATE OR REPLACE FUNCTION public.trg_sync_reservas_horarios()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.reservas_horarios := fn_derivar_reservas_horarios(NEW);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS sync_reservas_horarios ON comanda_local_settings;
CREATE TRIGGER sync_reservas_horarios
  BEFORE INSERT OR UPDATE OF horario_dom, horario_lun, horario_mar, horario_mie,
                             horario_jue, horario_vie, horario_sab
  ON comanda_local_settings
  FOR EACH ROW EXECUTE FUNCTION trg_sync_reservas_horarios();

-- Backfill: recalcular para todos los locales existentes.
UPDATE comanda_local_settings
   SET reservas_horarios = fn_derivar_reservas_horarios(comanda_local_settings.*);
