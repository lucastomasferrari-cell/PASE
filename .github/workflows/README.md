# GitHub Actions cron — PASE

Reemplaza Vercel Cron Jobs (eliminados de `vercel.json`) y cron-job.org
(disable manual post-verificación).

## Workflows

| Archivo | Schedule UTC | Schedule ART | Endpoint(s) | Costo aprox |
|---|---|---|---|---|
| `mp-cron-generate.yml` | `0,30 * * * *` | cada 30 min | `/api/mp-generate` | ~25 min/mes |
| `mp-cron-process.yml`  | `2,32 * * * *` | cada 30 min, offset +2min | `/api/mp-process` | ~25 min/mes |
| `mp-cron-daily.yml`    | `0 9 * * *`    | 06:00 ART          | `/api/mp-sync` + `/api/mp-update-pending-releases` | ~5 min/mes |
| `mp-cron-weekly.yml`   | `0 8 * * 0`    | dom 05:00 ART      | `/api/backup-tenants` + `/api/backup-cleanup` | ~2 min/mes |

**Total**: ~55 min/mes. Bien debajo del cap de 2000 min/mes del free tier
GitHub Hobby (repo privado).

### Por qué generate y process en workflows separados

Si fueran 1 solo workflow con `sleep 120` entre llamadas, costo sería
~140 min/día = ~4200 min/mes (excede el free tier). Separados sin
sleep, cada job dura ~30s → ~50 min/mes total para el ciclo cada 30min.

**Trade-off**: si GH Actions atrasa el scheduler (puede pasar en
horarios busy, +10min reportado por GH), `mp-process` puede correr
antes de que `mp-generate` haya completado. mp-process es idempotente
(`upsert ignoreDuplicates`) y MP suele tener CSV listo en <30s, así que
en práctica funciona. Si Lucas detecta huecos consistentes, alternativa
es volver a 1-workflow con sleep + pagar ~$4/mes GH Pro.

## Setup inicial

### 1. Generar token Bearer

```bash
# En tu máquina (cualquier UNIX):
openssl rand -hex 32
# → ej: 5c8f9a2e...
```

Guardalo (no lo expongas). Vamos a ponerlo en 2 lugares.

### 2. Configurar GitHub Secret

1. GitHub → repo `lucastomasferrari-cell/PASE` → **Settings** → **Secrets and
   variables** → **Actions** → **New repository secret**.
2. **Name**: `MP_CRON_BEARER`
3. **Value**: el token del paso 1.
4. Click **Add secret**.

Los workflows lo leen como `${{ secrets.MP_CRON_BEARER }}`.

### 3. Configurar Vercel Environment Variable (DESPUÉS de paso 4)

Esperar — primero validar que GH Actions corre OK SIN auth (`CRON_BEARER`
no seteado en Vercel = endpoints aceptan cualquier llamada, backwards
compat para que cron-job.org no se rompa). Después de validar, setear:

1. Vercel dashboard → proyecto `pase-yndx` → **Settings** → **Environment
   Variables** → **Add New**.
2. **Key**: `CRON_BEARER`
3. **Value**: el MISMO token que pusiste en GitHub.
4. **Environments**: marcar Production + Preview + Development.
5. **Save** → redeploy producción (Vercel pregunta).

A partir de ese momento:
- GH Actions sigue funcionando (manda Bearer correcto).
- cron-job.org devuelve 401 (no tiene Bearer).
- Cualquier llamada manual sin Bearer → 401.

### 4. Validación inicial — trigger manual

Antes de esperar 30 min al primer run automático:

1. GitHub → repo PASE → **Actions** tab.
2. Sidebar → seleccionar **MP cron - generate CSV**.
3. Click **Run workflow** (botón derecha, arriba) → **Run workflow** verde.
4. Esperar 30s, refrescar. Debería aparecer un run con ✓ verde.
5. Repetir con **MP cron - process CSV**.
6. Repetir con **MP cron - daily** y **MP cron - weekly**.

Si algún run falla, click → ver logs del step `curl ...` para diagnosticar.

### 5. Confirmar ciclo completo

Esperar al primer ciclo automático (próxima media hora UTC, ej. si son
las 14:23 UTC → 14:30 UTC corre generate, 14:32 UTC corre process).
Verificar logs Vercel:

- `/api/mp-generate` debería verse 1 hit por :00 / :30.
- `/api/mp-process` debería verse 1 hit por :02 / :32.

Y en PASE UI: tab "Por cobrar" muestra movimientos del día.

### 6. Disable cron-job.org (manual, después de paso 5)

Una vez que GH Actions corre estable durante ~24h, ir a cron-job.org y
desactivar/borrar los jobs viejos. Si tenés `CRON_BEARER` seteado en
Vercel ya, los jobs de cron-job.org están dando 401 silencioso — no
hace daño dejarlos pero es ruido.

## Trigger manual ad-hoc

Cualquier workflow es trigger-able manualmente desde Actions UI →
**Run workflow** (gracias a `workflow_dispatch:`). Útil para:

- Re-correr el ciclo si MP devolvió algo raro.
- Forzar `backup-tenants` antes de un cambio crítico.
- Debug de un step en particular.

Equivalente CLI:
```bash
gh workflow run mp-cron-process.yml
```

## Monitoreo

GitHub envía email al owner del repo si un workflow falla. Si querés
alertas más activas:
- Slack: GH Actions tiene integración nativa.
- Datadog/Sentry: webhooks desde Actions on-failure.

## Backwards compat con cron-job.org

Mientras `CRON_BEARER` NO esté seteado en Vercel:
- Endpoints aceptan cualquier llamada (GH Actions y cron-job.org both
  funcionan).
- Pueden ejecutarse 2 veces por ciclo (1 GH, 1 cron-job.org).
- Idempotencia: el upsert `ignoreDuplicates` del cron evita problemas.

Cuando `CRON_BEARER` se setea en Vercel:
- cron-job.org da 401.
- Solo GH Actions funciona.

**Recomendación**: dejar 24-48h de ambos corriendo, después setear
`CRON_BEARER` en Vercel y desactivar cron-job.org en su UI.
