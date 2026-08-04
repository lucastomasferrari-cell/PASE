-- Marketing modelo OPT-OUT (decisión Lucas 04-ago)
-- ---------------------------------------------------------------------------
-- No se pide consentimiento previo: los contactos entran ACEPTADOS por default y
-- la salida es el botón de baja (mkt-unsubscribe → fn_mkt_baja, ya implementado:
-- setea acepta_marketing=false + unsubscribed_at + supresión do-not-send).
--
-- 1) default de acepta_marketing = true → todo contacto nuevo entra aceptado.
-- 2) backfill de los existentes a true, PERO respetando a quien ya se dio de baja
--    (unsubscribed_at seteado) o esté en la lista de supresiones. Hoy no hay bajas,
--    así que esto habilita ~todos los contactos con email.

ALTER TABLE clientes ALTER COLUMN acepta_marketing SET DEFAULT true;

UPDATE clientes
   SET acepta_marketing = true
 WHERE acepta_marketing IS DISTINCT FROM true
   AND unsubscribed_at IS NULL
   AND deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM mkt_supresiones s
      WHERE s.tenant_id = clientes.tenant_id
        AND lower(s.email) = lower(clientes.email)
   );
