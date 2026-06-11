-- 202606111600_anular_transferencia_huerfana.sql
-- Fix data: anular la pata huérfana de la transferencia del 7/6 en Caja Chica.
-- La pata hermana en Caja Mayor (MOV-1780860583-5874) fue anulada el 10-jun
-- vía Solicitud #24 ANTES de que existiera la lógica anti-huérfanos (09-jun).
-- El efecto neto: CC tenía -$300k que nunca llegaron a CM → saldo CC -$121k
-- cuando debería ser +$179k.

UPDATE movimientos
   SET anulado = true,
       anulado_motivo = 'Anulación de pata huérfana: la hermana en Caja Mayor (MOV-1780860583-5874) fue anulada el 10-jun antes del fix anti-huérfanos'
 WHERE id = 'MOV-1780860583-c783'
   AND transferencia_id = '50d7d790-a410-4a59-b062-b3a648c23c45'
   AND cuenta = 'Caja Chica'
   AND anulado = false;
