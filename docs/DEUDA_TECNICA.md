# Deuda técnica — repo PASE

Documento de seguimiento de deuda técnica que excede el scope del trabajo
en curso pero merece atención antes de que se vuelva urgente. Cada ítem
incluye contexto, urgencia y pista de cómo resolverlo.

## CI / GitHub Actions — Node 20 deprecado el 16-sep-2026

**Severidad:** menor · **Deadline:** 2026-09-16

`.github/workflows/ci.yml` usa hoy:

```yaml
- uses: actions/checkout@v4         # corre en Node 20
- uses: pnpm/action-setup@v4        # corre en Node 20
- uses: actions/setup-node@v4       # corre en Node 20
```

GitHub avisa que Node 20 se deprecará el **2026-09-16**. Hay que
actualizar a las versiones que ya soporten Node 24 (presumiblemente
`@v5` cuando sean GA, o equivalentes).

Acción cuando la fecha se acerque:
1. `actions/checkout@v5`
2. `actions/setup-node@v5` (verificar que `node-version: 22` o `24`
   esté disponible).
3. `pnpm/action-setup@v5` (si existe; sino mantener v4 hasta que el
   mantenedor publique compatibilidad con Node 24).
4. Re-correr el pipeline. Tests existentes alcanzan como sanity check.

No bloquea nada hoy — los cron jobs siguen funcionando idénticamente.

## Otros ítems

(Vacío por ahora. Agregar acá en futuros sprints.)
