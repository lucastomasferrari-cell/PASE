-- LISTAS DE PRECIOS — sync canal ↔ lista (coherencia de aumentos)
-- ═════════════════════════════════════════════════════════════════════════
-- Tras Fase 2 la LISTA es la autoridad del precio. Pero fn_aumento_canal_precios
-- y fn_aumento_masivo_precios todavía leen atado_madre/ajuste_madre_pct/redondeo_a
-- del CANAL. Si alguien edita esos atributos en la lista, el canal quedaría con
-- el % viejo y un aumento masivo usaría un valor incorrecto.
--
-- Solución mínima y robusta: mantener los atributos de precio del canal como
-- espejo de su lista, vía triggers (funcionan sin importar qué UI escriba).
-- No recalcula precios (eso sólo pasa en un aumento explícito) — sólo config.
-- (Deuda futura: que los aumentos lean directo de la lista y estos campos del
--  canal se retiren del form. Se hace en la sesión de refactor del cobro.)
-- ═════════════════════════════════════════════════════════════════════════

-- Al cambiar los atributos de una lista → propagarlos a sus canales miembros.
CREATE OR REPLACE FUNCTION public.fn_sync_canales_de_lista()
 RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE canales SET
    atado_madre      = NEW.atado_madre,
    ajuste_madre_pct = NEW.ajuste_madre_pct,
    redondeo_a       = COALESCE(NEW.redondeo_a, redondeo_a)
  WHERE lista_precio_id = NEW.id AND deleted_at IS NULL
    AND (atado_madre      IS DISTINCT FROM NEW.atado_madre
      OR ajuste_madre_pct IS DISTINCT FROM NEW.ajuste_madre_pct
      OR redondeo_a       IS DISTINCT FROM COALESCE(NEW.redondeo_a, redondeo_a));
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_sync_canales_de_lista ON listas_precios;
CREATE TRIGGER trg_sync_canales_de_lista AFTER INSERT OR UPDATE ON listas_precios
  FOR EACH ROW EXECUTE FUNCTION fn_sync_canales_de_lista();

-- Al asignar un canal a una lista (cambia lista_precio_id) → hereda los
-- atributos de esa lista, así comparte precios Y reglas de precio.
CREATE OR REPLACE FUNCTION public.fn_canal_hereda_lista()
 RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE lp RECORD;
BEGIN
  IF NEW.lista_precio_id IS NOT NULL AND NEW.lista_precio_id IS DISTINCT FROM OLD.lista_precio_id THEN
    SELECT atado_madre, ajuste_madre_pct, redondeo_a INTO lp
      FROM listas_precios WHERE id = NEW.lista_precio_id;
    IF FOUND THEN
      NEW.atado_madre      := lp.atado_madre;
      NEW.ajuste_madre_pct := lp.ajuste_madre_pct;
      NEW.redondeo_a       := COALESCE(lp.redondeo_a, NEW.redondeo_a);
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_canal_hereda_lista ON canales;
CREATE TRIGGER trg_canal_hereda_lista BEFORE UPDATE ON canales
  FOR EACH ROW EXECUTE FUNCTION fn_canal_hereda_lista();
