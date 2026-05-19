# Admin Console — Deploy en Vercel

## Setup inicial (1 sola vez)

1. Ir a https://vercel.com/new
2. **Import Git Repository** → seleccionar el repo `lucastomasferrari-cell/PASE`
3. En la pantalla "Configure Project":
   - **Project Name**: `pase-admin-console` (o el que prefieras)
   - **Framework Preset**: Vite (se detecta solo si no, elegirlo manual)
   - **Root Directory**: `packages/admin-console` ← muy importante. Click "Edit" y pegá esto.
   - **Build & Output Settings**: dejar los valores que vienen del `vercel.json`
     - Build Command: ya viene `cd ../.. && pnpm --filter admin-console build`
     - Output Directory: ya viene `dist`
     - Install Command: ya viene `cd ../.. && pnpm install --frozen-lockfile`
4. **Environment Variables** (Production + Preview + Development):
   - `VITE_SUPABASE_URL` = https://pduxydviqiaxfqnshhdc.supabase.co
   - `VITE_SUPABASE_ANON_KEY` = (la misma anon key que usás en PASE y COMANDA — copiar de Vercel proyecto PASE → Settings → Environment Variables)
5. Click **Deploy**.

## Después del primer deploy

- La URL inicial será algo como `pase-admin-console.vercel.app` o `pase-admin-console-<hash>.vercel.app`.
- Cada push a `main` redespliega automáticamente.

## Cómo entrar la primera vez

El gate de auth requiere que tu usuario en la tabla `usuarios` tenga `rol = 'superadmin'`. Si en algún momento no podés entrar al admin console:

1. Conectarte a la DB con `psql` o desde Supabase Studio.
2. Verificar tu fila: `SELECT id, email, rol, activo FROM usuarios WHERE email = 'tu-email';`
3. Si `rol != 'superadmin'`:
   ```sql
   UPDATE usuarios SET rol = 'superadmin' WHERE email = 'tu-email';
   ```

## Variables de entorno locales (dev)

Para correr `pnpm --filter admin-console dev` en localhost:

```bash
# packages/admin-console/.env.local
VITE_SUPABASE_URL=https://pduxydviqiaxfqnshhdc.supabase.co
VITE_SUPABASE_ANON_KEY=<la anon key>
```

Sin esto, el supabase client tira error en bootstrap.
