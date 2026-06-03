-- 202606031200_solicitudes_timeout_1h.sql
-- Pedido Lucas 03-jun: el timeout para aprobar/rechazar una solicitud
-- de Manager (Herramientas → Códigos) era 15 minutos y se queda corto
-- — para cuando el dueño ve el push, abre la app, decide, ya expiró
-- y el empleado tiene que pedir de nuevo.
--
-- Cambia el DEFAULT del expires_at a `1 hour`. Las solicitudes ya
-- creadas mantienen su expires_at viejo (no las re-extendemos
-- retroactivamente — al final del día ya están todas expiradas o
-- usadas, no vale la pena el riesgo).

ALTER TABLE manager_solicitudes
  ALTER COLUMN expires_at SET DEFAULT (now() + INTERVAL '1 hour');

COMMENT ON COLUMN manager_solicitudes.expires_at IS
  'Cuándo expira la solicitud si el manager no responde. Default 1 hora ' ||
  '(cambiado 2026-06-03 desde 15 min — el dueño no siempre ve el push al instante).';

NOTIFY pgrst, 'reload schema';
