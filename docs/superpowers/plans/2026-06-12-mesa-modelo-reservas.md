# MESA — Decisiones de Modelo de Reservas (Tier 1 #4) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans para ejecutar tarea por tarea. Checkboxes para tracking.

**Goal:** Las 6 decisiones de modelo del informe `docs/analisis-logica-2026-06/06-mesa-conexiones.md` §3 que bloquean el módulo #2 de MESA: (1) estado `sentada` separado del terminal `finalizada`; (2) vínculo reserva↔venta bidireccional con auto-link y auto-finalizar al cobrar; (3) `cliente_id` SIEMPRE + teléfono normalizado; (4) `mesas.capacidad NOT NULL`; (5) cron auto-no-show; (6) `duracion_min` por reserva con default por tamaño de grupo. Unidad del motor = CUBIERTOS queda fijada en la disponibilidad v2 (cuenta personas con solapamiento por duración).

**Architecture:** Migración única de modelo: estados nuevos en el CHECK (migrando `cumplida`→`finalizada` histórico y aceptando `'cumplida'` como alias de `'sentada'` para bundles viejos), columnas `venta_id`/`duracion_min`/`sentada_at`/`finalizada_at`/`no_show_auto`, `fn_normalizar_telefono` (IMMUTABLE, cadena de strips AR: dígitos→saca 00/54/9/0 iniciales) usada en upserts + índice funcional NO único en clientes (los duplicados pre-existentes impiden unique hoy — se documenta), máquina de estados v2 que al SENTAR upsertea cliente y auto-linkea la venta abierta de la mesa, `fn_abrir_venta_comanda` v2 que linkea en la dirección inversa (y copia cliente_id al ticket), trigger AFTER UPDATE en ventas_pos que auto-finaliza la reserva sentada al cobrar, cron pg_cron de auto-no-show con gracia configurable por local, y `fn_check_disponibilidad_reserva` v2 que cuenta pendiente+confirmada+sentada con solapamiento real por `duracion_min`. UI ReservasAdmin (COMANDA) gana el estado nuevo + botón Finalizar.

**Reglas del repo:** C2 mutante + e2e-full misma PR, C9 errores UPPER_SNAKE, `REVOKE FROM PUBLIC, anon`, dry-run antes de aplicar, push + deploys READY (pase y comanda), memoria al cierre.

**Hechos verificados (relevamiento 12-jun):** DDL `reservas` en 202605203600 (CHECK 5 estados; cliente_id existe pero SIEMPRE null; sin venta_id/duracion_min); máquina de estados `fn_cambiar_estado_reserva` en `202606100400:139-203` (la vigente); `fn_crear_reserva` (manual, NO upsertea cliente) `202606100400:18-77`; `fn_crear_reserva_publica` `202605203600:241-326` (llama `fn_upsert_cliente_publico_comanda` best-effort en línea ~314 pero DESCARTA el id); upsert cliente en `202605151730:108-157` (lookup por `trim(telefono)` exacto); `clientes` UNIQUE (tenant, telefono) WHERE deleted_at IS NULL; `mesas.capacidad INTEGER NULL` (202605051800:113); cron pattern = **pg_cron** (`202606021500`: cron.schedule + fn SECURITY DEFINER que marca y retorna); config por local en `comanda_local_settings` (reservas_duracion_estimada_min default 90, etc.); `fn_abrir_venta_comanda` `202605051800:727-775` (verificar si hay versión posterior — trampa conocida×3: puede estar schema-qualified en otra migración); `fn_asignar_mesa_reserva` `202606021400:11-67`; UI `packages/comanda/src/pages/Salon/ReservasAdmin.tsx` (tabs pendientes/próximas/histórico, handlers confirmar/no-show/cancelar/sentar→'cumplida'); `ventas_pos.cliente_id` existe; mutante `tests/reservas_mutante.spec.ts` está SKIPPED; e2e-full no toca reservas.

---

### Task 1: Migración — modelo completo

**Files:**
- Create: `packages/pase/supabase/migrations/202606130100_mesa_modelo_reservas.sql`

- [ ] **Step 0: localizar versiones VIGENTES** (trampa conocida: pueden estar schema-qualified en migraciones posteriores): `fn_cambiar_estado_reserva`, `fn_crear_reserva`, `fn_crear_reserva_publica`, `fn_check_disponibilidad_reserva`, `fn_upsert_cliente_publico_comanda`, `fn_abrir_venta_comanda` — `grep -ln "FUNCTION \(public\.\)\?<nombre>" packages/pase/supabase/migrations/*.sql`, timestamp más alto gana. Copiar SIEMPRE desde la vigente.

- [ ] **Step 1: escribir la migración** con estas secciones (todo en BEGIN/COMMIT):

**§1 Columnas y estados de `reservas`:**
```sql
ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS venta_id      BIGINT REFERENCES ventas_pos(id),
  ADD COLUMN IF NOT EXISTS duracion_min  INTEGER,
  ADD COLUMN IF NOT EXISTS sentada_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalizada_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS no_show_auto  BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_reservas_venta ON reservas(venta_id) WHERE venta_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservas_mesa_sentada ON reservas(mesa_id) WHERE estado = 'sentada' AND deleted_at IS NULL;

-- histórico: cumplida (terminal viejo) pasa a finalizada
UPDATE reservas SET estado = 'finalizada', finalizada_at = COALESCE(cumplida_at, updated_at)
 WHERE estado = 'cumplida';

ALTER TABLE reservas DROP CONSTRAINT IF EXISTS reservas_estado_check;
ALTER TABLE reservas ADD CONSTRAINT reservas_estado_check
  CHECK (estado IN ('pendiente','confirmada','sentada','finalizada','no_show','cancelada'));
```
(OJO: verificar el nombre real del CHECK con grep en 202605203600; si era inline el default es `reservas_estado_check`.)

**§2 `mesas.capacidad`:** `UPDATE mesas SET capacidad = 4 WHERE capacidad IS NULL;` + `ALTER TABLE mesas ALTER COLUMN capacidad SET NOT NULL, ALTER COLUMN capacidad SET DEFAULT 4;` + `ALTER TABLE mesas ADD CONSTRAINT chk_mesas_capacidad CHECK (capacidad > 0);` (con DROP IF EXISTS previo).

**§3 Config por local:**
```sql
ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS reservas_no_show_gracia_min INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS reservas_duracion_por_personas JSONB NOT NULL DEFAULT
    '[{"hasta":2,"min":90},{"hasta":4,"min":105},{"hasta":6,"min":120},{"hasta":99,"min":150}]'::jsonb;
```

**§4 Normalización de teléfono (IMMUTABLE + índice funcional NO único):**
```sql
CREATE OR REPLACE FUNCTION fn_normalizar_telefono(p_tel TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(
    regexp_replace(                                   -- 4. saca 0 inicial (prefijo nacional)
      regexp_replace(                                 -- 3. saca 9 inicial (móvil post-54)
        regexp_replace(                               -- 2. saca 54 inicial (país)
          regexp_replace(                             -- 1. saca 00 inicial + no-dígitos
            regexp_replace(COALESCE(p_tel,''), '[^0-9]', '', 'g'),
            '^00', ''),
          '^54', ''),
        '^9', ''),
      '^0', ''),
  '');
$$;
REVOKE ALL ON FUNCTION fn_normalizar_telefono(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_normalizar_telefono(TEXT) TO authenticated, anon, service_role;
-- (anon SÍ la necesita: corre dentro de las RPCs públicas SECURITY DEFINER, el GRANT
--  directo es inocuo porque es IMMUTABLE y pura)

CREATE INDEX IF NOT EXISTS idx_clientes_tel_norm
  ON clientes (tenant_id, fn_normalizar_telefono(telefono)) WHERE deleted_at IS NULL;
-- NO unique: hay clientes pre-existentes que pueden normalizar igual; el unique
-- llega después de un merge manual (documentado como pendiente).
```
Casos que unifica: `+54 9 11 5555-1234` ≡ `011 5555-1234` ≡ `11-5555-1234` → `1155551234`.

**§5 `fn_upsert_cliente_publico_comanda` v2:** copiar la vigente y cambiar SOLO: lookup `WHERE fn_normalizar_telefono(telefono) = fn_normalizar_telefono(p_telefono)` (en vez de `telefono = trim(p_telefono)`) y el INSERT guarda `fn_normalizar_telefono(p_telefono)` como telefono canónico.

**§6 Helper de duración:**
```sql
CREATE OR REPLACE FUNCTION fn_duracion_reserva_default(p_local_id INTEGER, p_personas INTEGER)
RETURNS INTEGER LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tabla JSONB; v_item JSONB; v_fallback INTEGER;
BEGIN
  SELECT reservas_duracion_por_personas, COALESCE(reservas_duracion_estimada_min, 90)
    INTO v_tabla, v_fallback
    FROM comanda_local_settings WHERE local_id = p_local_id;
  IF v_tabla IS NULL THEN RETURN COALESCE(v_fallback, 90); END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_tabla)
  LOOP
    IF p_personas <= (v_item->>'hasta')::INT THEN RETURN (v_item->>'min')::INT; END IF;
  END LOOP;
  RETURN COALESCE(v_fallback, 90);
END; $$;
REVOKE ALL ON FUNCTION fn_duracion_reserva_default(INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_duracion_reserva_default(INTEGER, INTEGER) TO authenticated, service_role;
```

**§7 `fn_cambiar_estado_reserva` v2** (copiar vigente como base, reemplazar la lógica de transiciones):
- Alias de compat: `IF p_nuevo_estado = 'cumplida' THEN p_nuevo_estado := 'sentada'; END IF;` (bundles COMANDA viejos mandan 'cumplida' al sentar — siguen andando con la semántica nueva).
- Transiciones: `pendiente → confirmada|sentada|cancelada` · `confirmada → sentada|no_show|cancelada` · `sentada → finalizada` · terminales: finalizada/no_show/cancelada.
- `p_mesa_id` solo al pasar a `sentada` (error `MESA_SOLO_AL_SENTAR` se mantiene).
- Al pasar a **sentada**: `sentada_at = NOW()`; si la reserva tiene `cliente_telefono` y `cliente_id IS NULL` → `cliente_id := fn_upsert_cliente_publico_comanda(...)` usando el slug del local (derivarlo) O mejor: extraer la parte upsert a una llamada interna con tenant ya resuelto — si la firma pública exige slug y complica, hacer el upsert inline (mismas 15 líneas, lookup normalizado). Después: **auto-link de venta**: si hay `ventas_pos` viva en esa mesa (`mesa_id = v_mesa`, `local_id` match, `estado IN ('abierta','enviada','lista','entregada')`, `deleted_at IS NULL`, sin otra reserva ya linkeada a esa venta) → `venta_id := esa venta` y copiar `cliente_id` al ticket si le falta (`UPDATE ventas_pos SET cliente_id = COALESCE(cliente_id, v_cliente_id)`).
- Al pasar a **finalizada**: `finalizada_at = NOW()`.
- Timestamps existentes (confirmada_at/cancelada_at) se mantienen igual.

**§8 `fn_crear_reserva` v2 (manual) y `fn_crear_reserva_publica` v2:** copiar vigentes; ambas: (a) setear `duracion_min = fn_duracion_reserva_default(local, personas)` si no vino; (b) upsert de cliente cuando hay teléfono y **GUARDAR el id en cliente_id** (en la pública: capturar el retorno de la llamada best-effort que hoy se descarta; en la manual: agregar el upsert best-effort que hoy no existe). `fn_editar_reserva`: si cambia personas y duracion_min era el default, recalcular (simplificación aceptable: recalcular siempre que no se haya seteado manualmente — si no hay forma de saberlo, recalcular cuando cambia personas; documentar).

**§9 `fn_abrir_venta_comanda` v2** (copiar VIGENTE — verificar versión posterior a 202605051800): tras el INSERT, si `p_mesa_id IS NOT NULL`:
```sql
UPDATE reservas r
   SET venta_id = v_id
 WHERE r.mesa_id = p_mesa_id
   AND r.local_id = p_local_id
   AND r.estado = 'sentada'
   AND r.venta_id IS NULL
   AND r.deleted_at IS NULL
   AND r.fecha_hora BETWEEN NOW() - INTERVAL '4 hours' AND NOW() + INTERVAL '2 hours'
 RETURNING r.cliente_id INTO v_reserva_cliente;
IF v_reserva_cliente IS NOT NULL THEN
  UPDATE ventas_pos SET cliente_id = COALESCE(cliente_id, v_reserva_cliente) WHERE id = v_id;
END IF;
```
(UPDATE..RETURNING INTO toma una sola fila; si hubiera más de una reserva sentada en la misma mesa, limitar con un subselect por id de la más cercana a NOW().)

**§10 Auto-finalizar al cobrar** (trigger nuevo, NO tocar los existentes):
```sql
CREATE OR REPLACE FUNCTION fn_trg_venta_pos_finalizar_reserva()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado = 'cobrada' AND (OLD.estado IS NULL OR OLD.estado <> 'cobrada') THEN
    UPDATE reservas SET estado = 'finalizada', finalizada_at = NOW(), updated_at = NOW()
     WHERE venta_id = NEW.id AND estado = 'sentada' AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_venta_pos_finalizar_reserva ON ventas_pos;
CREATE TRIGGER trg_venta_pos_finalizar_reserva
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW EXECUTE FUNCTION fn_trg_venta_pos_finalizar_reserva();
```

**§11 Cron auto-no-show** (mismo patrón que 202606021500):
```sql
CREATE OR REPLACE FUNCTION fn_cron_auto_no_show()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE reservas r
     SET estado = 'no_show', no_show_auto = TRUE, updated_at = NOW()
    FROM comanda_local_settings s
   WHERE s.local_id = r.local_id
     AND r.estado = 'confirmada'
     AND r.deleted_at IS NULL
     AND r.fecha_hora < NOW() - make_interval(mins => COALESCE(s.reservas_no_show_gracia_min, 30));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION fn_cron_auto_no_show() FROM PUBLIC, anon, authenticated;
-- solo pg_cron / service_role la ejecutan
GRANT EXECUTE ON FUNCTION fn_cron_auto_no_show() TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('mesa-auto-no-show')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mesa-auto-no-show');
  PERFORM cron.schedule('mesa-auto-no-show', '*/10 * * * *',
    $cmd$ SELECT fn_cron_auto_no_show(); $cmd$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible: agendar mesa-auto-no-show a mano';
END $$;
```
NOTA: reservas con `fecha_hora` pasada y estado `pendiente` NO se tocan (todavía no confirmadas — el dueño decide); solo confirmadas. Las que el cron marca quedan con `no_show_auto = TRUE` para revisión.

**§12 `fn_check_disponibilidad_reserva` v2** (copiar vigente; cambiar el conteo): contar personas de reservas `pendiente|confirmada|sentada` cuyo intervalo `[fecha_hora, fecha_hora + duracion_min)` SOLAPA con el pedido `[p_fecha_hora, p_fecha_hora + dur_pedida)` donde `dur_pedida = fn_duracion_reserva_default(local, p_personas)` y la duración de cada reserva existente es `COALESCE(r.duracion_min, config default global)`:
```sql
AND r.fecha_hora < p_fecha_hora + make_interval(mins => v_dur_pedida)
AND r.fecha_hora + make_interval(mins => COALESCE(r.duracion_min, v_dur_default)) > p_fecha_hora
```
La unidad sigue siendo CUBIERTOS contra `reservas_capacidad_max` (motor completo de slots/pacing = módulo #2; esto solo corrige estados y solapamiento).

REVOKE/GRANT en cada función recreada con las MISMAS audiencias vigentes (las públicas conservan su GRANT a anon — son SECURITY DEFINER diseñadas para la página pública).

- [ ] **Step 2: Commit** — `feat(mesa): modelo de reservas v3 — sentada/finalizada, reserva<->venta, cliente_id+tel normalizado, capacidad NOT NULL, auto-no-show, duracion por grupo (Tier1 #4)`

---

### Task 2: Aplicar en producción

- [ ] Flow oficial: env pull → script Write tool (NO here-strings con regex) → DRY_RUN=1 (neutralizar BEGIN/COMMIT + ROLLBACK) → aplicar. **Purga preventiva de huérfanos** del tenant E2E si la FK de venta_id chocara (trampa conocida: eliminar_tenant_completo deja restos) — el dry-run avisa.
- [ ] Verificaciones post: count reservas por estado (las `cumplida` viejas ahora `finalizada`); `SELECT COUNT(*) FROM mesas WHERE capacidad IS NULL` = 0; `SELECT cron.job` contiene `mesa-auto-no-show`; `fn_normalizar_telefono('+54 9 11 5555-1234') = '1155551234'`.
- [ ] Limpiar temporales.

---

### Task 3: UI — ReservasAdmin.tsx (COMANDA)

**Files:** `packages/comanda/src/pages/Salon/ReservasAdmin.tsx` (+ el service que llama `fn_cambiar_estado_reserva` si tipa los estados)

- [ ] Tipo `EstadoReserva`: + `'sentada' | 'finalizada'` (mantener `'cumplida'` en el tipo solo si llega histórico — el backend ya migró todo, así que reemplazarla).
- [ ] Tabs: agregar grupo **"En mesa"** (`estado === 'sentada'`) entre Próximas e Histórico; Histórico pasa a `finalizada|no_show|cancelada|confirmada vieja`.
- [ ] `confirmarSentar()` manda `'sentada'` (antes `'cumplida'`).
- [ ] Botón **"Finalizar"** en las sentadas → `cambiarEstado(r, 'finalizada')` (con nota visible de que al cobrar el ticket se finaliza sola).
- [ ] Colores: sentada = índigo/violeta, finalizada = sky (el viejo de cumplida). Badge "auto" si `no_show_auto`.
- [ ] Mostrar `duracion_min` en el detalle si existe (read-only, mínimo).
- [ ] `pnpm --filter comanda typecheck` + lint → verdes. Commit.

---

### Task 4: Tests

- [ ] **Mutante nuevo** `packages/pase/tests/mesa_modelo_reservas_mutante.spec.ts` (DB-only, patrón createDuenoClient + mecánica venta_pos del mutante del puente; el spec viejo `reservas_mutante.spec.ts` está SKIPPED por UI oculta — dejarlo, este lo reemplaza como cobertura):
  1. Crear reserva MANUAL (`fn_crear_reserva`) con tel `+54 9 11 4444-7788` → assert `cliente_id NOT NULL` y `duracion_min` = default por personas; crear SEGUNDA reserva con tel `011 4444-7788` → assert MISMO `cliente_id` (normalización unifica).
  2. Confirmar → sentar con mesa (`fn_cambiar_estado_reserva` a `'sentada'` + mesa) → assert estado/sentada_at/mesa_id. Compat: una tercera reserva transicionada con el alias `'cumplida'` → queda `'sentada'`.
  3. Abrir venta en esa mesa (`fn_abrir_venta_comanda`) → assert `reservas.venta_id` = la venta y `ventas_pos.cliente_id` copiado.
  4. Cobrar la venta (`fn_cobrar_venta_comanda`) → assert reserva **auto-finalizada** (estado, finalizada_at).
  5. Auto-no-show: reserva confirmada con `fecha_hora` = hace 2 horas → ejecutar `fn_cron_auto_no_show()` vía service client → assert `no_show` + `no_show_auto = true`; y una confirmada FUTURA no se toca.
  6. Disponibilidad: con la config del local de prueba, crear reserva sentada que solape el horario consultado → `fn_check_disponibilidad_reserva` la cuenta (personas_actuales la incluye).
  7. Cleanup completo (reservas de test soft-delete, venta anulada, cliente de test soft-delete).
- [ ] **e2e-full**: spec nuevo `tests/e2e-full/sprint-1/44-mesa-reservas-ciclo.spec.ts` (DB-only, tenant E2E): ciclo crear→confirmar→sentar→venta→cobrar→auto-finalizada + invariante "ninguna reserva sentada con venta cobrada". Registrarlo donde la suite lo levante (mismo patrón de archivos vecinos). OJO: el seed E2E debe tener `comanda_local_settings` para el local (verificar; si falta, el spec lo crea con `reservas_activas=true`).
- [ ] Correr: mutante nuevo + regresión (`puente_ventas_comanda_mutante`, porque tocamos `fn_abrir_venta_comanda` y el trigger de cobro convive con el del puente) + **suite e2e-full completa** → verdes. Commit.

---

### Task 5: Cierre

- [ ] Push + deploys READY (pase y comanda).
- [ ] Memoria: sprint nuevo + MEMORY.md. Pendientes a registrar: unique funcional de teléfono tras merge de duplicados; badge de reserva próxima en SalonView (primer contacto POS↔reservas, módulo #2); motor de slots/pacing/combos = módulo #2 ya desbloqueado; view/legacy de medios borrables más adelante.

---

## Self-review
- Cobertura informe §3: puntos 1 (estados ✅ §1/§7), 2 (venta_id ✅ §7/§9/§10), 3 (cliente_id+normalización ✅ §4/§5/§7/§8), 4 (capacidad ✅ §2), 5 (auto-no-show ✅ §11), 6 (duración ✅ §3/§6/§8), 7 (cubiertos ✅ §12). Punto 9 (badge SalonView) explícitamente diferido.
- Compat con bundles viejos: alias `'cumplida'`→`'sentada'` en la RPC + la UI vieja sigue mandando cumplida sin romper. Histórico migrado a `finalizada`.
- Riesgos: (a) `fn_abrir_venta_comanda` puede tener versión vigente posterior — Step 0 obligatorio; (b) wrappers `_offline` llaman a la inner — al recrearla con MISMA firma no se rompen (verificar firma idéntica); (c) el índice funcional de teléfono NO es unique todavía (duplicados legacy) — documentado.
