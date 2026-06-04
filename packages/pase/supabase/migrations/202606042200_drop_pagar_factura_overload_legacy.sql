-- Drop overload legacy de pagar_factura (6 args) que quedó conviviendo con la
-- versión nueva de 8 args introducida en 202606031400 (proveedor saldo a favor).
--
-- Problema: la migración de saldo a favor hizo CREATE OR REPLACE con una firma
-- DISTINTA (agregó p_generar_saldo + p_cerrar_factura), así que en vez de
-- reemplazar la función vieja, Postgres creó un segundo overload. Como ambas
-- versiones matchean una llamada de 6 args (la nueva vía defaults), Postgres no
-- puede elegir candidato → error 42725 "Could not choose the best candidate
-- function". Rompía los E2E full (07-factura-pagar, 09-factura-anular) que
-- llaman con 6 args nombrados.
--
-- Fix: dropear la versión vieja. La nueva con ambos flags en FALSE por default
-- es idéntica en comportamiento a la legacy (ver comentario en 202606031400).
-- El frontend (Compras.tsx) ya llama exclusivamente la firma de 8 args.

DROP FUNCTION IF EXISTS public.pagar_factura(text, numeric, text, date, text, text);
