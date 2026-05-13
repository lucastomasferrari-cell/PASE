# DECISIONES_BACKUP.md

**TASK 0.17 — Sistema de backup/restore por tenant.**
Capa 2 sobre los backups nativos de Supabase. Granularidad por tenant,
UI superadmin para listar / descargar / restaurar.

Estado: **IMPLEMENTADO** (commits etapa 1-4, mayo 2026).

**Cadencia final (decidida 2026-05-12):**
- **Backup: semanal**, domingos 08:00 UTC (05:00 ART). Disparado por
  GH Actions workflow `mp-cron-weekly.yml`.
- **Retención: 1 año** = 52 snapshots por tenant.
- **Cleanup: semanal**, mismo workflow inmediatamente después del backup,
  borra archivos >365 días.

El plan original del doc abajo era diario + 30 días con Vercel Cron — eso
quedó superado. Sección 2 (endpoint backup), 3 (cleanup) y 8.2 (horario)
referencian el plan original a título histórico.

---

## 0. Investigación previa (estado actual)

### 0.1 Bucket `tenant-backups`
**No existe.** Hay que crearlo en la migration del Commit 1, con RLS
estricta (solo superadmin lee/escribe; service_role bypassa por diseño,
que es lo que usa el cron).

Confirmado por inspección de `supabase/migrations/*storage*.sql` — solo
existen `facturas`, `empleados` (legacy) y `blindaje`.

### 0.2 35 tablas con tenant_id (inventario completo del sprint multi-tenant)

Tomadas de `202604281201_tenant_id_columns.sql` y
`202604281209_drop_policies_viejas.sql`:

| # | Tabla | Tipo | FK relevantes |
|---|---|---|---|
| 1 | `locales` | raíz | — |
| 2 | `usuarios` | raíz | tenant_id |
| 3 | `usuario_locales` | hija | usuario_id, local_id |
| 4 | `usuario_permisos` | hija | usuario_id |
| 5 | `proveedores` | catálogo | — |
| 6 | `insumos` | catálogo | — |
| 7 | `recetas` | catálogo | — |
| 8 | `receta_items` | hija | receta_id |
| 9 | `config_categorias` | catálogo | — |
| 10 | `rrhh_valores_doble` | catálogo | — |
| 11 | `blindaje_tipos_documento` | catálogo | — |
| 12 | `medios_cobro` | catálogo | local_id (nullable) |
| 13 | `ventas` | operativa | local_id |
| 14 | `gastos` | operativa | local_id (nullable) |
| 15 | `gastos_plantillas` | operativa | local_id (nullable) |
| 16 | `facturas` | operativa | local_id, prov_id |
| 17 | `factura_items` | hija | factura_id |
| 18 | `factura_items_stock` | hija | factura_id, insumo_id |
| 19 | `movimientos` | operativa | local_id (nullable) |
| 20 | `remitos` | operativa | local_id |
| 21 | `remito_items` | hija | remito_id |
| 22 | `saldos_caja` | operativa | local_id |
| 23 | `caja_efectivo` | operativa | local_id |
| 24 | `mp_credenciales` | operativa | local_id |
| 25 | `mp_movimientos` | operativa | local_id, credencial_id |
| 26 | `mp_liquidaciones` | hija | credencial_id |
| 27 | `rrhh_empleados` | operativa | local_id |
| 28 | `rrhh_novedades` | hija | empleado_id |
| 29 | `rrhh_liquidaciones` | hija | novedad_id |
| 30 | `rrhh_documentos` | hija | empleado_id |
| 31 | `rrhh_historial_sueldos` | hija | empleado_id |
| 32 | `rrhh_pagos_especiales` | hija | empleado_id |
| 33 | `rrhh_adelantos` | hija | empleado_id |
| 34 | `blindaje_documentos` | operativa | local_id |
| 35 | `auditoria` | log | — |

`empleado_archivos` está deprecada (0 filas, tabla huérfana post-DROP de
`empleados`). **Decisión:** la incluimos en backup defensivo si la tabla
todavía existe, pero no en orden topológico (sin parent vivo).

### 0.3 Tablas con archivos en Storage

| Tabla | Columna path | Bucket | Usado por |
|---|---|---|---|
| `facturas` | `imagen_url` | `facturas` | `Compras.tsx`, `LectorFacturasIA.tsx` |
| `blindaje_documentos` | `archivo_url` | `blindaje` | `Blindaje.tsx` |
| `rrhh_documentos` | `url` | `rrhh-documentos` | `RRHHLegajo.tsx` |
| `empleados` (deprecada) | — | `empleados` | legacy 1 archivo |

**Bucket `rrhh-documentos` no aparece en `202604281208_storage_rls_multitenant.sql`** — gap del
sprint anterior. Lo dejo flagueado pero NO es scope de TASK 0.17 (queda
para una task de hardening de Storage RLS).

### 0.4 Orden topológico (export = parents primero, restore = parents primero)

```
1. usuarios                          (raíz independiente; tiene su propia tenant FK)
2. locales
3. usuario_locales, usuario_permisos
4. tenant_admins                     (FK → tenants, usuarios)
5. proveedores, insumos, config_categorias, rrhh_valores_doble,
   blindaje_tipos_documento, medios_cobro
6. recetas → receta_items
7. mp_credenciales
8. rrhh_empleados
9. ventas, gastos, gastos_plantillas, saldos_caja, caja_efectivo,
   mp_movimientos, mp_liquidaciones, blindaje_documentos
10. facturas → factura_items, factura_items_stock
11. remitos → remito_items
12. rrhh_novedades → rrhh_liquidaciones
13. rrhh_documentos, rrhh_historial_sueldos, rrhh_pagos_especiales,
    rrhh_adelantos
14. movimientos                      (FK → ventas/facturas/gastos/etc; va casi al final)
15. auditoria                        (log puro, último)
16. empleado_archivos                (legacy, defensivo, último)
```

**Para DELETE en restore: orden inverso** (children primero, parents
después). El RPC implementa ambos órdenes en una sola transacción.

---

## 1. Schema del archivo de backup

```jsonc
{
  "version": 1,
  "tenant_id": "uuid",
  "tenant_nombre": "Neko",
  "tenant_slug": "neko",
  "created_at": "2026-04-29T07:00:00.000Z",
  "stats": {
    "total_filas": 12345,
    "total_archivos_storage": 7,
    "compresion": "gzip"
  },
  "tablas": {
    "usuarios": [ {...}, ... ],
    "locales": [ {...}, ... ],
    "ventas": [ {...}, ... ],
    "facturas": [ {...}, ... ],
    "factura_items": [ {...}, ... ],
    // ... 35 tablas en orden topológico
    "auditoria": [ {...}, ... ]
  },
  "storage_paths": {
    "facturas": [
      "tenant_id/abc123.jpeg",
      "tenant_id/def456.pdf"
    ],
    "blindaje": [ ... ],
    "rrhh-documentos": [ ... ]
  }
}
```

**Notas:**
- Cada array de tabla contiene los rows tal como vienen de Postgres
  (JSON-serializados — `timestamptz` → ISO 8601, `numeric` → string para
  no perder precisión, `bytea` → base64).
- `storage_paths` es un **inventario de paths**, no los archivos.
  Decisión: los archivos NO se incluyen en el JSON (ver sección 7.2).
- `version` permite evolucionar el schema sin romper restores viejos.

---

## 2. Endpoint cron `api/backup-tenants.js`

**Vercel cron diario a las 04:00 ART (07:00 UTC).**
Decisión a confirmar: ver sección 8.

### 2.1 Algoritmo

```
1. Validar SUPABASE_URL + SUPABASE_SERVICE_KEY (service_role).
2. SELECT * FROM tenants WHERE activo = true.
3. Para cada tenant:
   a. Para cada tabla en orden topológico:
        SELECT * FROM <tabla> WHERE tenant_id = $1
   b. Para cada bucket con archivos del tenant:
        storage.list(bucket, { prefix: '<tenant_id>/' })
        → guardar paths en storage_paths.<bucket>
   c. Construir el JSON.
   d. gzip → buffer.
   e. storage.from('tenant-backups').upload(
        '<tenant_id>/<YYYY-MM-DD>.json.gz',
        buffer,
        { contentType: 'application/gzip', upsert: true }
      )
   f. INSERT INTO auditoria (tabla='backup', accion='BACKUP_TENANT',
        detalle={ tenant_id, path, bytes, filas }, tenant_id).
4. Resumen JSON al cron caller (Vercel cron logs).
```

**Idempotencia:** `upsert: true` permite re-correr el cron del mismo día
sin duplicar archivo.

**maxDuration:** 300s en `vercel.json` (igual que `mp-sync`). Si
crece más allá: ver riesgos sección 7.1.

### 2.2 Tabla `auditoria` — nuevas acciones

`accion` es text libre, no hay CHECK. Las nuevas acciones son:
- `BACKUP_TENANT` (cron de backup)
- `BACKUP_CLEANUP` (cron de cleanup)
- `RESTORE_TENANT` (RPC manual de restore)

Detalle típico:
```json
{ "path": "uuid/2026-04-29.json.gz", "bytes": 245678, "filas": 12345 }
```

---

## 3. Endpoint cron `api/backup-cleanup.js`

**Vercel cron semanal — domingo 05:00 ART (08:00 UTC).**

### 3.1 Algoritmo

```
1. Listar todos los archivos del bucket tenant-backups.
2. Filtrar los que tengan path con fecha < hoy - 30 días.
   (Parsear la fecha del path: <tenant_id>/<YYYY-MM-DD>.json.gz)
3. storage.from('tenant-backups').remove(paths_a_borrar).
4. INSERT INTO auditoria (tabla='backup', accion='BACKUP_CLEANUP',
     detalle={ borrados: N, paths: [...] }, tenant_id=NULL).
```

**Edge case:** archivos cuyo path no parsea como `<uuid>/<fecha>.json.gz`
los IGNORA (no los borra). Defensive — evita borrar accidentalmente
backups manuales o estructuras futuras.

---

## 4. RPC `restore_tenant(p_tenant_id uuid, p_backup_path text)`

**SECURITY DEFINER, solo superadmin.**

### 4.1 Validaciones de entrada

```sql
1. IF NOT auth_es_superadmin() THEN RAISE 'NO_AUTORIZADO'.
2. SELECT * FROM tenants WHERE id = p_tenant_id; IF NOT FOUND → 'TENANT_NOT_FOUND'.
3. Descargar el JSON del bucket tenant-backups en p_backup_path.
4. ungzip + parse.
5. IF backup.tenant_id != p_tenant_id THEN RAISE 'CROSS_TENANT_RESTORE_BLOCKED'.
   (Defensa anti restore de un backup en el tenant equivocado.)
6. IF backup.version != 1 THEN RAISE 'BACKUP_VERSION_UNSUPPORTED'.
```

### 4.2 Algoritmo (transacción única)

```sql
BEGIN;

-- DELETE en orden inverso topológico (children primero):
DELETE FROM auditoria          WHERE tenant_id = p_tenant_id;
DELETE FROM empleado_archivos  WHERE tenant_id = p_tenant_id;
DELETE FROM movimientos        WHERE tenant_id = p_tenant_id;
DELETE FROM rrhh_adelantos     WHERE tenant_id = p_tenant_id;
... (resto del orden inverso)
DELETE FROM usuario_locales    WHERE tenant_id = p_tenant_id;
DELETE FROM locales            WHERE tenant_id = p_tenant_id;
-- usuarios al final porque tenant_admins.usuario_id las referencia;
-- de hecho tenant_admins se borra antes que usuarios.
DELETE FROM tenant_admins      WHERE tenant_id = p_tenant_id;
DELETE FROM usuarios           WHERE tenant_id = p_tenant_id;

-- INSERT en orden topológico (parents primero) desde el JSON:
INSERT INTO usuarios       (...) VALUES ... ;
INSERT INTO locales        (...) VALUES ... ;
INSERT INTO usuario_locales(...) VALUES ... ;
... (resto del orden directo)

-- Auditoría (después de re-insertar la propia auditoría — usa otro tenant_id si fuera):
INSERT INTO auditoria (tabla, accion, detalle, fecha, tenant_id)
VALUES ('tenants', 'RESTORE_TENANT',
  jsonb_build_object('backup_path', p_backup_path,
                     'filas_restauradas', v_total,
                     'restaurado_por_uid', auth.uid()),
  now(), p_tenant_id);

COMMIT;
```

### 4.3 Triggers append-only de `auditoria`

Igual que en backfill de etapa 2, los triggers
`trg_auditoria_no_update` y `trg_auditoria_no_delete` bloquean DELETE
sobre `auditoria`. El RPC los desactiva al inicio y los reactiva antes
del COMMIT (rollback-safe — si la TX falla, vuelven al estado activo).

### 4.4 Triggers de saldos / movimientos

`movimientos` y `saldos_caja` tienen lógica de actualización
incremental. **Decisión:** durante el restore desactivamos triggers de
mutación en estas tablas y se restaura el snapshot tal cual. Los saldos
restaurados son los que estaban en el momento del backup — coherentes
por construcción.

Triggers a desactivar dentro de la TX:
- (a confirmar al implementar — listar con `SELECT trigger_name FROM
  information_schema.triggers WHERE event_object_schema='public'` y
  filtrar por las tablas afectadas).

### 4.5 Storage rollback — fuera de scope

El RPC NO toca Storage. Los archivos del bucket `facturas`/`blindaje`/
`rrhh-documentos` quedan como estaban antes del restore.

**Implicación:** si en el momento del backup había un archivo X y
después del backup se subió Y (sin estar en el snapshot), tras el
restore queda Y huérfano (no referenciado) hasta cleanup manual.

**Justificación:** restaurar archivos físicos requiere descargar y
re-subir cada uno → escala mal y agrega complejidad. Para v1, el RPC
restaura solo data relacional. Los `storage_paths` del backup se usan
sólo como referencia/auditoría (para que un superadmin sepa qué archivos
existían en ese momento).

Si más adelante hace falta full restore (data + archivos), se agrega un
endpoint API separado que recorra `storage_paths` y haga el rebuild.

### 4.6 Auditoría

```json
{
  "backup_path": "uuid/2026-04-29.json.gz",
  "filas_restauradas": 12345,
  "filas_borradas": 12300,
  "restaurado_por_uid": "auth-uuid"
}
```

---

## 5. UI superadmin — tab "Backups" en `Tenants.tsx`

### 5.1 Estructura

```
Tenants.tsx
├── Tab "Listado" (existente)
├── Tab "Onboarding" (existente, OnboardingTenant.tsx)
└── Tab "Backups" (NUEVO)
    ├── Selector de tenant (dropdown con tenants activos)
    ├── Tabla con backups del tenant seleccionado:
    │   ├── Fecha (parseada del path)
    │   ├── Tamaño (bytes → KB/MB humanizado)
    │   ├── Antigüedad ("hace 3 días")
    │   └── Acciones: [Descargar] [Restaurar]
    └── Indicador "Último backup: hace N horas / hace N días"
        + Estado de salud (verde si <26h, amarillo si <72h, rojo si >72h o inexistente)
```

### 5.2 Acciones

**Descargar:**
1. `db.storage.from('tenant-backups').createSignedUrl(path, 60)`.
2. `window.open(url)` o `<a href={url} download>`.

**Restaurar:**
1. Confirmación doble:
   - Modal #1: "¿Restaurar tenant X al backup del DD/MM/YYYY? Se
     borrarán todas las filas actuales del tenant."
   - Modal #2: input que requiere escribir el nombre del tenant para
     habilitar el botón "RESTAURAR".
2. `db.rpc('restore_tenant', { p_tenant_id, p_backup_path })`.
3. Spinner. Si ok → toast verde + refrescar lista. Si error → toast
   rojo con mensaje del RPC.

**Permisos:** todo el tab sólo aparece si `user.rol === 'superadmin'`.
Aprovecha que `Tenants.tsx` ya está gateada por el slug `tenants` en
`getPermisos()` (auth.ts:62) — exclusivo de superadmin.

### 5.3 RLS policy del bucket `tenant-backups`

```sql
CREATE POLICY "tenant_backups_superadmin_read"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'tenant-backups' AND auth_es_superadmin());

CREATE POLICY "tenant_backups_superadmin_all"
  ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'tenant-backups' AND auth_es_superadmin())
  WITH CHECK (bucket_id = 'tenant-backups' AND auth_es_superadmin());
```

(El cron usa service_role, que bypassa RLS. La policy es para el UI.)

---

## 6. Plan de implementación — 4 commits

### Commit 1 — Bucket + RLS + cron de backup
Archivos:
- `supabase/migrations/20260429xxxx_tenant_backups_bucket.sql`
  - INSERT INTO storage.buckets ('tenant-backups', public=false).
  - 2 policies (sólo superadmin).
- `api/backup-tenants.js` (cron handler).
- `vercel.json`: agregar cron + maxDuration.

### Commit 2 — Cron de cleanup
Archivos:
- `api/backup-cleanup.js`.
- `vercel.json`: agregar cron semanal.

### Commit 3 — RPC `restore_tenant`
Archivos:
- `supabase/migrations/20260430xxxx_rpc_restore_tenant.sql`.
- Tests unitarios opcionales (vitest no llega a Postgres directo, pero
  podemos sanity-checkear el shape del JSON con un fixture).

### Commit 4 — UI superadmin tab "Backups"
Archivos:
- `src/pages/Tenants.tsx` (agregar tab).
- `src/pages/BackupsAdmin.tsx` (componente del tab — nuevo).

Cada commit = build + tests + push a main (siguiendo el patrón de los
sprints anteriores).

---

## 7. Riesgos

### 7.1 Tamaño del backup
- Hoy Neko tiene ~419 saldos_caja + miles de movimientos/ventas. El
  JSON crudo puede ser **~5–20 MB**. Gzip baja a ~1–4 MB. Aceptable.
- Tablas grandes futuras (auditoria sin TTL, mp_movimientos creciendo)
  pueden empujar el JSON a >50 MB sin gzip → ~10 MB con gzip.
  **Mitigación:** si excede X MB (a definir, ~50 MB pre-gzip),
  excluir `auditoria` del export y manejarla en un segundo archivo
  `<tenant_id>/<fecha>.audit.json.gz`.
- **Vercel function memory:** 1024 MB default. Procesar 50 MB JSON en
  memoria es OK. Si crece más → streaming gzip.

### 7.2 Archivos físicos NO incluidos
Decisión consciente (sección 4.5). El backup contiene **paths**, no
binarios. Justificación:
- Bucket `facturas` puede crecer indefinidamente (escaneos de PDFs).
- Backup por tenant con archivos puede ser GBs → no entra en JSON.
- Supabase ya tiene backup nativo del bucket completo (Capa 1 cubre).
- Restore selectivo de archivos es complejo (re-bind a IDs nuevos).

Si después se necesita full restore con archivos → endpoint separado
que recorra `storage_paths` y descargue del backup nativo de Supabase.

### 7.3 RLS del superadmin en INSERT
Las 35 policies `_mt` aceptan `auth_es_superadmin()` como bypass
(verificado en `202604281204_rls_etapa_3a_dual_policies.sql`). El RPC
es SECURITY DEFINER así que corre como el dueño de la function — no
sufre RLS. Riesgo bajo.

**Validar al implementar:** que las RLS no bloqueen DELETE/INSERT
desde dentro del RPC con SECURITY DEFINER (Postgres por default
bypassa RLS dentro de SECURITY DEFINER salvo `FORCE ROW LEVEL
SECURITY` — ninguna tabla del proyecto lo tiene).

### 7.4 Restore atómico — timeout
- `restore_tenant` borra y re-inserta todo en una TX.
- Si el tenant tiene 100k filas, el COMMIT puede tomar 30-60s.
- **Vercel timeout:** la RPC se llama desde el frontend, NO desde
  Vercel function → timeout es del cliente HTTP de supabase-js
  (default 6 min). Suficiente para v1.
- **Plan B futuro:** dividir en chunks (DELETE en una TX, INSERT en
  varias TX dentro de un savepoint). Postergar hasta que pegue.

### 7.5 Storage usage
- 30 backups × N tenants × ~5 MB promedio = ~150 MB por tenant.
- Con 10 tenants = 1.5 GB. Plan Pro de Supabase tiene 100 GB → margen
  enorme para el primer año.
- Si crece: evaluar S3/R2 externo como Capa 3 (post-MVP).

### 7.6 Restauración de FKs y secuencias
- PKs (`id integer/uuid`) se preservan tal cual del JSON.
- Secuencias (`SERIAL`/`bigserial`) NO se reajustan automáticamente —
  riesgo: si se restauran filas con `id=42` y la secuencia está en
  `last_value=10`, el próximo INSERT dará conflicto.
- **Mitigación:** al final del RPC, para cada tabla con secuencia:
  ```sql
  PERFORM setval(pg_get_serial_sequence('<tabla>', 'id'),
                 (SELECT COALESCE(MAX(id), 1) FROM <tabla>
                   WHERE tenant_id = p_tenant_id));
  ```
  Listar las tablas afectadas durante implementación.

### 7.7 Backups nativos de Supabase ya existen
Capa 1 (snapshot completo de la DB) sigue funcionando — esta task no
la toca. Esto da redundancia: si el restore de Capa 2 falla
catastróficamente, el PITR de Supabase sigue siendo el último
recurso.

---

## 8. Decisiones a confirmar con Lucas (BLOQUEAN implementación)

### 8.1 Bucket de backups: Supabase Storage vs externo
**Recomendación: Supabase Storage (`tenant-backups`).**

Pros:
- Cero infra adicional, ya tenemos plan Pro con 100 GB.
- service_role + RLS estricta cubren seguridad.
- API uniforme (mismo cliente que el resto).

Contras:
- Si Supabase mismo cae, los backups caen con la DB. Pero la Capa 1
  (PITR de Supabase) ya tiene la misma dependencia, así que no es
  peor que el estado actual.

**Alternativa:** S3/R2 externo. Solo si querés independencia total.
Implica gestionar credenciales, CORS, etc. Postergable.

### 8.2 Horario del cron diario
**Recomendación: 04:00 ART (07:00 UTC).**

Justificación: madrugada, fuera del horario de uso operativo, el cron
de mp-sync ya corre a las 06:00 UTC (= 03:00 ART) — backup-tenants 1h
después le da tiempo a mp-sync de terminar y los datos consolidados
del día anterior quedan ya escritos.

¿Otro horario? OK con cualquier hora siempre que sea madrugada local.

### 8.3 Botón "Restaurar" en UI vs solo manual
**Recomendación: ambos, pero con doble confirmación.**

Pros del botón en UI:
- Velocidad de respuesta a un incidente (Lucas no necesita SSH ni
  abrir la consola de Postgres).
- El RPC ya valida `auth_es_superadmin()` server-side → no es menos
  seguro que un script.

Contras (mitigados):
- Click accidental → mitigado con doble modal + tipear nombre del
  tenant.
- Restore en tenant equivocado → mitigado con validación
  CROSS_TENANT_RESTORE_BLOCKED en el RPC.

**Si preferís paranoia máxima:** sólo descargar desde la UI, restore
SOLO vía script Node con `SUPABASE_SERVICE_KEY` local. Decime y lo
hago así. La RPC se queda igual (la usa el script).

---

## 9. Resumen ejecutivo

- **Cubrimos:** 35 tablas con tenant_id, paths de Storage de 3 buckets
  (facturas, blindaje, rrhh-documentos), retención 30 días, restore
  atómico transaccional.
- **NO cubrimos en v1:** archivos físicos del Storage (paths sí, blobs
  no) — la Capa 1 nativa de Supabase ya respalda buckets enteros.
- **Riesgos principales:** tamaño del JSON al crecer (mitigación:
  separar auditoria en archivo aparte), reajuste de secuencias post-
  restore (mitigación: setval explícito por tabla), RLS bloqueando
  RPC (riesgo bajo, validar en implementación).
- **Implementación:** 4 commits a main, sin ramas, mismo flujo
  defensivo del sprint multi-tenant (script Node con pg en TX +
  validaciones + COMMIT/ROLLBACK).

**Esperando OK + decisiones 8.1 / 8.2 / 8.3 antes de empezar.**
