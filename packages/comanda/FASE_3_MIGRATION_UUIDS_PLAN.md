# FASE 3 — Plan de migración BIGINT → UUIDs en tablas POS

**Estado**: planificada, NO ejecutada. Ejecutar solo en ventana de mantenimiento coordinada con backup completo de DB.

**Por qué este documento**: la migración toca tablas que PASE usa en producción (ventas_pos, ventas_pos_items, ventas_pos_pagos, ventas_pos_overrides, mesas, clientes). Cualquier error rompe operación real de PASE. NO se puede hacer "a la pasada" en una sesión cualquiera.

## Pre-requisitos antes de ejecutar

- [ ] **Backup completo de DB de Supabase** (Project → Settings → Database → Daily backups + manual snapshot).
- [ ] **Ventana de mantenimiento ~2-4 horas** sin operación activa (típicamente martes a la madrugada).
- [ ] **Notificación a usuarios** de PASE: 1-2 días antes.
- [ ] **Ambiente staging** ideal: clonar la DB, correr la migración ahí, validar smoke tests, después aplicar en prod. (Si no hay staging, considerar crearlo solo para esto.)
- [ ] **Plan de rollback definido**: restore del backup si la migración falla.

## Alternativa simpler (recomendada antes de pensar en esto)

**Patrón "Idempotency UUID sin migrar PKs"** — ya implementado en Fase 4:

- Las tablas POS mantienen sus PKs BIGINT.
- Cuando un device escribe local offline, genera un `idempotency_uuid` client-side (UUID v4).
- Al sync con cloud, se manda como `p_idempotency_key` en la RPC — el server detecta duplicados y no duplica.
- El BIGINT real lo asigna el server cuando inserta.
- El device aprende el BIGINT real al ver la respuesta + actualiza su row local (cambio de PK local de UUID-temp a BIGINT-real).

**Pros**: NO requiere migración de schema. Funciona con el modelo actual. Compatible con PASE sin cambios.
**Cons**: row local tiene PK temporal durante un breve período (entre creación offline y sync). El repo abstrae esto, no es visible para el resto del código.

**Esta migration a UUIDs como PK real solo es necesaria si**:
1. El patrón idempotency falla en algún caso de uso (no debería).
2. Querés operar con múltiples devices que comparten estado SIN cloud (mesh local) y necesitás IDs únicos sin coordinación con server. Esto es más Fase 5 que Fase 4.

**Recomendación**: NO ejecutar Fase 3 a menos que sea absolutamente necesario después de Fases 4-5. Mantener BIGINT + idempotency_uuid es más simple y compatible.

---

## Plan de migración (si se decide ejecutar)

### Fase 3.A — Agregar columnas UUID paralelas (no rompe nada)

Esta fase es backward-compatible — agrega columnas pero no las usa. PASE y COMANDA siguen funcionando sin cambios.

```sql
-- ── ventas_pos
ALTER TABLE ventas_pos ADD COLUMN uuid UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX uniq_ventas_pos_uuid ON ventas_pos(uuid);

-- ── ventas_pos_items
ALTER TABLE ventas_pos_items ADD COLUMN uuid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE ventas_pos_items ADD COLUMN venta_uuid UUID;
CREATE UNIQUE INDEX uniq_ventas_pos_items_uuid ON ventas_pos_items(uuid);
-- Backfill FK paralela
UPDATE ventas_pos_items i
   SET venta_uuid = v.uuid
  FROM ventas_pos v
 WHERE i.venta_id = v.id;
ALTER TABLE ventas_pos_items ADD CONSTRAINT fk_venta_uuid
  FOREIGN KEY (venta_uuid) REFERENCES ventas_pos(uuid);

-- ── ventas_pos_pagos
ALTER TABLE ventas_pos_pagos ADD COLUMN uuid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE ventas_pos_pagos ADD COLUMN venta_uuid UUID;
CREATE UNIQUE INDEX uniq_ventas_pos_pagos_uuid ON ventas_pos_pagos(uuid);
UPDATE ventas_pos_pagos p
   SET venta_uuid = v.uuid
  FROM ventas_pos v
 WHERE p.venta_id = v.id;
ALTER TABLE ventas_pos_pagos ADD CONSTRAINT fk_pago_venta_uuid
  FOREIGN KEY (venta_uuid) REFERENCES ventas_pos(uuid);

-- ── ventas_pos_overrides
ALTER TABLE ventas_pos_overrides ADD COLUMN uuid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE ventas_pos_overrides ADD COLUMN venta_uuid UUID;
ALTER TABLE ventas_pos_overrides ADD COLUMN venta_item_uuid UUID;
CREATE UNIQUE INDEX uniq_ventas_pos_overrides_uuid ON ventas_pos_overrides(uuid);
UPDATE ventas_pos_overrides o
   SET venta_uuid = v.uuid
  FROM ventas_pos v
 WHERE o.venta_id = v.id;
UPDATE ventas_pos_overrides o
   SET venta_item_uuid = i.uuid
  FROM ventas_pos_items i
 WHERE o.venta_item_id = i.id;

-- ── mesas
ALTER TABLE mesas ADD COLUMN uuid UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX uniq_mesas_uuid ON mesas(uuid);
-- ventas_pos.mesa_uuid paralelo
ALTER TABLE ventas_pos ADD COLUMN mesa_uuid UUID;
UPDATE ventas_pos vp
   SET mesa_uuid = m.uuid
  FROM mesas m
 WHERE vp.mesa_id = m.id;

-- ── clientes
ALTER TABLE clientes ADD COLUMN uuid UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX uniq_clientes_uuid ON clientes(uuid);
ALTER TABLE ventas_pos ADD COLUMN cliente_uuid UUID;
UPDATE ventas_pos vp
   SET cliente_uuid = c.uuid
  FROM clientes c
 WHERE vp.cliente_id = c.id;
```

**Smoke test post 3.A**:
- PASE sigue funcionando normal (consultas siguen usando BIGINT).
- Cada nueva fila inserta automaticamente con UUID generado (default).
- Verificar: `SELECT id, uuid FROM ventas_pos LIMIT 5;` muestra ambas columnas.

### Fase 3.B — Refactorizar services PASE + COMANDA para usar UUID

Esta fase cambia código pero NO el schema (que ya tiene ambas columnas). Permite hacer rollout gradual.

Servicios afectados en COMANDA (alta criticidad):
- `services/ventasService.ts` — todas las RPCs cambian para aceptar UUID.
- `services/mesasService.ts` — listar/operar por UUID.
- `services/clientesService.ts` — query por UUID.
- `services/itemsService.ts` (referencias indirectas si hay).
- `services/overridesService.ts`.

Servicios afectados en PASE (revisar):
- `services/ventas.ts` — reportes, filtros.
- `services/conciliacion.ts` — FK a ventas_pos.
- Endpoints `/api/*` que manejan ventas.

Helpers nuevos:
- `lib/idMapping.ts` con `bigintToUuid(id)` y `uuidToBigint(uuid)` para casos legacy.

RPCs a actualizar (server-side):
- `fn_abrir_venta_comanda` → retorna UUID además de BIGINT.
- `fn_agregar_item_comanda` → acepta `p_venta_uuid` o `p_venta_id`.
- `fn_cobrar_venta_comanda` → idem.
- `fn_mandar_curso_comanda` → idem.
- (Listar todas en ejecución).

**Smoke test post 3.B**:
- Operar todos los flujos POS desde UI, verificar que los IDs en logs son UUIDs.
- Reportes en PASE muestran datos correctos.
- Cobros con tarjeta → conciliación cruza correcto.

### Fase 3.C — Drop columnas BIGINT viejas (point of no return)

DESPUÉS de N días (idealmente 7-14) sin issues reportados con UUIDs:

```sql
-- Drop FKs viejas BIGINT
ALTER TABLE ventas_pos_items DROP CONSTRAINT IF EXISTS ventas_pos_items_venta_id_fkey;
ALTER TABLE ventas_pos_pagos DROP CONSTRAINT IF EXISTS ventas_pos_pagos_venta_id_fkey;
-- ... resto
-- Drop columnas viejas
ALTER TABLE ventas_pos_items DROP COLUMN venta_id;
ALTER TABLE ventas_pos_items RENAME COLUMN venta_uuid TO venta_id;
ALTER TABLE ventas_pos_items DROP COLUMN id;
ALTER TABLE ventas_pos_items RENAME COLUMN uuid TO id;
ALTER TABLE ventas_pos_items ADD PRIMARY KEY (id);
-- ... repetir por cada tabla en orden topológico (children antes que parents)
```

**Punto de no retorno**: después de drop columnas BIGINT, no se puede rollback fácilmente. El backup pre-fase 3.A es el único safety net.

### Fase 3.D — Validación post-migration

- [ ] Reportes de ventas históricas: cantidades coinciden.
- [ ] Conciliación MP: ventas siguen cruzando.
- [ ] AFIP (si existe): numeración correlativa intacta (no afectada por cambio de PK).
- [ ] Backup post-migration: snapshot de la DB después de Fase 3.C.

## Plan de rollback (si Fase 3.C falla)

1. Restore DB del backup pre-Fase 3.A.
2. Revertir commits de services PASE + COMANDA.
3. Notificar usuarios.

**Tiempo estimado de rollback**: 30-60 min si se tiene el backup a mano + el repo revertible.

## Decisión recomendada

**NO ejecutar Fase 3 hoy.** El patrón idempotency_uuid de Fase 4 cubre el caso de uso (operación offline + dedup en sync) sin la complejidad de migrar PKs.

Re-evaluar Fase 3 solo si después de Fase 5 (mesh) aparece un caso donde múltiples devices del local generan rows que necesitan PK única sin coordinación con cloud. Hasta entonces, mantener BIGINT + idempotency_uuid.
