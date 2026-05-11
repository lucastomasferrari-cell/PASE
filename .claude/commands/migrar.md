---
description: Aplicar migración SQL siguiendo el flow oficial del repo
argument-hint: <descripcion-corta>
---

# Migración SQL: $ARGUMENTS

Vas a aplicar una migración SQL siguiendo el procedimiento oficial documentado en `CLAUDE.md` sección "Migraciones SQL". **No existe endpoint HTTP** para correr migraciones — el patrón viejo de `api/admin-run-sql.js` se eliminó (commits `ce11694` / `e9284d4`).

## Procedimiento paso a paso

### 1. Crear el archivo de migración

Usá timestamp en formato `YYYYMMDDHHMM` con la fecha de hoy. La descripción corta va al final:

```
packages/pase/supabase/migrations/<timestamp>_$ARGUMENTS.sql
```

(reemplazá espacios por `_` en `$ARGUMENTS`, todo minúsculas)

Mostrame qué nombre exacto vas a usar antes de crear el archivo.

### 2. Antes de escribir SQL — leé el contexto

- `packages/pase/CONTEXTO.md` para taxonomía de movimientos, RPCs existentes, RLS pattern.
- Migraciones recientes (`ls -t packages/pase/supabase/migrations/ | head -5`) para seguir el estilo.
- Si la migración crea una tabla nueva: leé "Agregar tabla nueva — checklist obligatorio" en `CLAUDE.md` (RLS + applyLocalScope + tenant_id + timestamptz).

### 3. Escribí el SQL en el archivo y mostrámelo

- Idempotente cuando sea razonable (`CREATE OR REPLACE`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ... IF EXISTS`).
- RLS habilitado en tablas nuevas con `local_id` (policy con `auth_locales_visibles()`).
- `tenant_id` en toda fila nueva.
- Comentarios SQL explicando el "por qué", no el "qué".

**Esperá mi OK antes de aplicar.** Migraciones contra prod son irreversibles.

### 4. Bajar credenciales de Vercel

```bash
cd packages/pase
npx vercel env pull .env.local.tmp --environment=production
```

Eso baja `POSTGRES_URL_NON_POOLING`. **Pre-requisito**: la env var no debe estar marcada Sensitive en Vercel (si lo está, `vercel env pull` baja `""`). Si pasa, pedime que la destilde en el dashboard.

### 5. Crear y correr el script Node one-off

Creá `packages/pase/scripts/run_<timestamp>.cjs` (descartable, no se commitea) que:

- Lee `POSTGRES_URL_NON_POOLING` de `.env.local.tmp`.
- Conecta con `pg` (instalalo con `npm install --no-save pg` si hace falta).
- Ejecuta el SQL **dentro de una transacción** (`BEGIN; ... COMMIT;`).
- Si falla, `ROLLBACK` y mostrame el error.
- Después de aplicar, hace una verificación (ej. `SELECT count(*) FROM nueva_tabla` o equivalente) y mostrame el resultado.

Mostrame el script antes de correrlo.

### 6. Aplicar

Después de mi OK, corré el script. Si la verificación pasa:
- `git add packages/pase/supabase/migrations/<archivo>.sql`
- Mostrame el `git diff` y esperá que yo decida cuándo commitear/pushear.

### 7. Cleanup obligatorio

```bash
rm packages/pase/.env.local.tmp
rm packages/pase/scripts/run_<timestamp>.cjs
```

`.env.local.tmp` tiene la URL de Postgres con password en claro — no puede quedar en disco después de la migración.

## Reglas duras

- **No correr migraciones sin que yo apruebe el SQL primero.** Esto es contra la DB productiva compartida con COMANDA.
- **Nunca `DROP TABLE` ni borrado masivo sin confirmación explícita en chat**, aunque el flag `--dangerously-skip-permissions` permita ejecutar.
- **Si la migración modifica una RPC o tabla con datos vivos**, considerá si vale la pena un test mutante que valide el flujo afectado antes de commitear (regla del repo).
- Si encontrás que la migración necesita rollback retroactivo de datos (ej. backfill complejo), **frená y planteámelo** — esos casos requieren más diseño que un script one-off.

Si en cualquier punto detectás que el SQL puede romper algo en producción que no estaba previsto, **frená y avisame**.
