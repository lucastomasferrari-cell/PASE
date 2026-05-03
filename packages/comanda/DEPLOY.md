# COMANDA — Deploy en Vercel

Pasos exactos para crear el proyecto Vercel que deploya `packages/comanda`.
PASE sigue independiente en `pase-yndx.vercel.app` desde `packages/pase` —
acá creamos un proyecto **nuevo**.

## 1. Crear el proyecto en Vercel

1. Abrí [vercel.com/new](https://vercel.com/new).
2. **Import Git Repository** → buscá `lucastomasferrari-cell/PASE` → click **Import**.
3. **Configure Project**:

   | Campo | Valor |
   |---|---|
   | Project Name | `comanda` (o el que prefieras, ej. `comanda-yndx`) |
   | Framework Preset | **Vite** |
   | Root Directory | `packages/comanda` ⚠️ click **Edit** y poné este path |
   | Build Command | `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter comanda build` |
   | Output Directory | `dist` |
   | Install Command | `cd ../.. && pnpm install --frozen-lockfile` |
   | Node.js Version | `20.x` |

   **Por qué `cd ../..`**: el proyecto está dentro de un monorepo con pnpm
   workspaces. Vercel ejecuta los comandos desde Root Directory
   (`packages/comanda`), pero pnpm necesita correr en la raíz para
   resolver workspaces. `cd ../..` sube a la raíz antes de cada comando.

4. **Environment Variables** (por ahora ninguna — comanda scaffold no usa
   Supabase). Cuando agreguemos cliente Supabase real:
   - `VITE_SUPABASE_URL` = `https://pduxydviqiaxfqnshhdc.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = (el anon key del proyecto Supabase)

5. Click **Deploy**.

6. Esperá ~2min → te da una URL tipo `comanda-xxx.vercel.app`. Pegamela
   cuando la tengas.

## 2. Verificación post-deploy

1. Abrí la URL → debería mostrar la página "COMANDA — En construcción".
2. Si tira 404 → revisá Output Directory = `dist`.
3. Si tira error de build → revisá los logs:
   - Si dice "command not found: pnpm" → revisá Install Command.
   - Si dice "Cannot find package '@pase/shared'" → el `cd ../..` no se
     ejecutó. Revisá Build Command.

## 3. Conectar el dominio (opcional, después)

En **Settings → Domains** podés agregar un dominio custom (ej.
`comanda.tudominio.com`). No urgente para este sprint.

## 4. CI/CD automático

Vercel ya monitorea el repo:
- Push a `main` que toque `packages/comanda/` → redeploy automático a producción.
- Cualquier otra branch → preview deploy automático.
- Push que NO toque `packages/comanda/` → no redeploya (Vercel detecta path).

## 5. Si querés desactivar el deploy temporalmente

**Project Settings → Git → Production Branch** → cambiá `main` a alguna
branch inexistente. Vercel deja de redeployar. Para reactivar, volvé a
poner `main`.
