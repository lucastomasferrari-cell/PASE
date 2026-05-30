-- ─────────────────────────────────────────────────────────────────────────
-- IG multi-cuenta — Backfill ig_config_id en conversaciones viejas
-- ─────────────────────────────────────────────────────────────────────────
--
-- Contexto (30-may): tras el refactor multi-cuenta, ig_conversaciones tiene
-- columna ig_config_id (qué cuenta IG recibió esa conversación). Las ~154
-- conversaciones históricas quedaron con ig_config_id = NULL porque fueron
-- creadas antes del refactor. El webhook backfillea de a una cuando el cliente
-- vuelve a escribir (webhook.js línea ~229), pero las que no reescriben quedan
-- NULL para siempre.
--
-- Síntoma reportado por Lucas: al filtrar la bandeja por @nekosushi.ar o
-- @maneki.ar, NO aparecía NINGUNA conversación. Verificado en el código del
-- filtro (MensajeriaIG.tsx línea 198):
--     if (filtroCuentaId !== null && c.ig_config_id !== filtroCuentaId) return false;
-- NULL nunca es igual a un id concreto → toda conversación NULL se descarta
-- bajo cualquier filtro de cuenta específica. Solo el filtro "Todas"
-- (filtroCuentaId = null) las mostraba.
--
-- Fix: asignar cada conversación NULL al ig_config ORIGINAL (id más chico) de
-- su mismo tenant. Seguro porque maneki (la 2da cuenta del tenant Neko) se
-- conectó el mismo 30-may con CERO conversaciones, así que el 100% de las
-- históricas son de la cuenta original (neko, MIN id del tenant).
--
-- Idempotente: solo toca filas con ig_config_id IS NULL. Re-ejecutable sin
-- efecto. No financiero, reversible.
-- ─────────────────────────────────────────────────────────────────────────

UPDATE ig_conversaciones c
SET ig_config_id = sub.original_id
FROM (
  SELECT tenant_id, MIN(id) AS original_id
  FROM ig_config
  GROUP BY tenant_id
) sub
WHERE c.tenant_id = sub.tenant_id
  AND c.ig_config_id IS NULL;
