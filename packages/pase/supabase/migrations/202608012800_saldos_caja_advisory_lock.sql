-- saldos_caja: advisory lock para cerrar la ventana de carrera (auditoría H2, 01-ago)
-- Dos movimientos concurrentes en la misma cuenta podían pisar el SUM del saldo
-- con un valor viejo. Se serializa el recálculo por (cuenta, local). Resto igual.

CREATE OR REPLACE FUNCTION public.fn_trg_sync_saldos_caja()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Movimientos sin local_id no participan del cache de saldos por cuenta.
  -- (saldos_caja exige local_id para ser útil; sin local no hay a qué imputar)
  IF TG_OP = 'INSERT' AND NEW.local_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND OLD.local_id IS NULL THEN RETURN OLD; END IF;

  -- Fix concurrencia (auditoría 01-ago H2): serializar el recálculo del saldo por
  -- (cuenta, local) con un advisory lock. Sin esto, dos movimientos concurrentes
  -- en la misma cuenta computaban el SUM sobre un snapshot viejo y uno pisaba al
  -- otro (saldo cacheado mal hasta el próximo movimiento). El lock se libera solo
  -- al terminar la transacción.
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.local_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('saldo:'||NEW.cuenta||':'||NEW.local_id)::bigint);
  END IF;
  IF TG_OP = 'DELETE' AND OLD.local_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('saldo:'||OLD.cuenta||':'||OLD.local_id)::bigint);
  ELSIF TG_OP = 'UPDATE' AND OLD.local_id IS NOT NULL
     AND (OLD.cuenta IS DISTINCT FROM NEW.cuenta OR OLD.local_id IS DISTINCT FROM NEW.local_id) THEN
    PERFORM pg_advisory_xact_lock(hashtext('saldo:'||OLD.cuenta||':'||OLD.local_id)::bigint);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.local_id IS NOT NULL THEN
    INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id)
    VALUES (
      NEW.cuenta, NEW.local_id,
      (SELECT COALESCE(SUM(importe), 0)
         FROM movimientos
        WHERE local_id = NEW.local_id AND cuenta = NEW.cuenta AND NOT anulado),
      NEW.tenant_id
    )
    ON CONFLICT (cuenta, local_id) DO UPDATE SET saldo = EXCLUDED.saldo;
  END IF;

  -- UPDATE con cambio de cuenta o local: además sincronizar el OLD.
  -- IS DISTINCT FROM trata NULL correctamente.
  IF TG_OP = 'UPDATE'
     AND (OLD.cuenta IS DISTINCT FROM NEW.cuenta
       OR OLD.local_id IS DISTINCT FROM NEW.local_id)
     AND OLD.local_id IS NOT NULL THEN
    INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id)
    VALUES (
      OLD.cuenta, OLD.local_id,
      (SELECT COALESCE(SUM(importe), 0)
         FROM movimientos
        WHERE local_id = OLD.local_id AND cuenta = OLD.cuenta AND NOT anulado),
      OLD.tenant_id
    )
    ON CONFLICT (cuenta, local_id) DO UPDATE SET saldo = EXCLUDED.saldo;
  END IF;

  IF TG_OP = 'DELETE' AND OLD.local_id IS NOT NULL THEN
    INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id)
    VALUES (
      OLD.cuenta, OLD.local_id,
      (SELECT COALESCE(SUM(importe), 0)
         FROM movimientos
        WHERE local_id = OLD.local_id AND cuenta = OLD.cuenta AND NOT anulado),
      OLD.tenant_id
    )
    ON CONFLICT (cuenta, local_id) DO UPDATE SET saldo = EXCLUDED.saldo;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$

