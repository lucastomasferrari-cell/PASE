# Rotar la anon key de Supabase

La anon key vive en `import.meta.env.VITE_SUPABASE_ANON_KEY` (Vite la inlinea en
el bundle al buildear). Rotarla requiere generar una nueva en Supabase, cargarla
en Vercel, y redeployar. Abajo los pasos.

## Precondición

El código del frontend ya debe estar leyendo la key desde la env var (commit
`feat(security)` que mueve la key fuera de `src/lib/supabase.ts`). Verificar
que `src/lib/supabase.ts` NO tenga la key hardcodeada.

## Pasos

1. **Dashboard de Supabase → Project Settings → API.**
   - Sección "Project API keys" → fila `anon` `public`.
   - Click "Reset anon key" (o equivalente). Confirmar.
   - Copiar el valor nuevo (empieza con `eyJ...`).

2. **Actualizar `.env.local` local** (sólo para desarrollo):
   ```
   VITE_SUPABASE_ANON_KEY=<nueva-key>
   ```
   Reiniciar `npm run dev` si estaba corriendo.

3. **Actualizar la env var en Vercel:**
   - Dashboard → proyecto `pase-yndx` → Settings → Environment Variables.
   - Si ya existe `VITE_SUPABASE_ANON_KEY`: editar y pegar el valor nuevo.
   - Si no existe: Add New → key `VITE_SUPABASE_ANON_KEY`, value `<nueva-key>`,
     environments: Production (y Preview/Development si querés).
   - Save.

4. **Redeploy (OBLIGATORIO — Vercel no recompila solo al cambiar una var):**
   - Deployments → último → menú `⋯` → Redeploy.
   - Esperar a que el deploy termine (~1 min).

5. **Verificación post-rotación (obligatorio):**
   - Abrir la app en modo incógnito: https://pase-yndx.vercel.app
   - Loguearse.
   - DevTools → Network → inspeccionar un request a `*.supabase.co`.
   - Confirmar que el header `apikey` usa el valor nuevo (empieza con `eyJ...`
     y coincide con lo que pegaste).
   - Si ves la key vieja: revisar el build cache (Deployments → Redeploy sin
     "Use existing Build Cache"), o que la env var esté en el scope correcto.

## Impacto en cron jobs de MP

Los endpoints serverless `api/mp-sync.js`, `api/mp-generate.js`,
`api/mp-process.js` usan `SUPABASE_SERVICE_KEY` (no la anon key), así que la
rotación de anon key **no los afecta**. Los crons siguen funcionando durante
y después de la rotación.

## Cuándo rotar

- Obligatorio: después de este commit (la key vieja ya estuvo commiteada al
  source y es considerada comprometida).
- Recomendado: cada vez que se sospeche exposición o cada N meses (política
  interna).
