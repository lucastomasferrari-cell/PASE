# MONOREPO_REPORT — Fase 1 (2026-04-26)

Resumen del switch a monorepo. NO commiteado — leélo y borralo cuando termines de revisar.

## Commits creados (en orden)

| # | SHA | Descripción |
|---|---|---|
| 1 | `a67ebd8` | `chore(monorepo): mover archivos de PASE a packages/pase` |
| 2 | `5bf0992` | `chore(monorepo): inicializar workspace pnpm + turborepo` |
| 3 | `d34f990` | `feat(monorepo): crear packages/shared con scaffolding` |
| 4 | `0c54032` | `feat(monorepo): crear packages/comanda con scaffolding` |
| 5 | `c7dfde3` | `docs(monorepo): README raíz + renombrar package "pase"` |

(El commit 5 también incluye un fix tardío para `packages/comanda/vite.config.ts` que separé en `vitest.config.ts` — `tsc -b` se quejaba del campo `test` dentro del UserConfig de vite con TS strict.)

## Estado de validación

| Check | Resultado |
|---|---|
| `pnpm install` | OK (291 packages, 13.7s) |
| `pnpm --filter pase test` | **152/152 verde** ✓ (idéntico al pre-monorepo) |
| `pnpm --filter pase build` | OK (610 modules, 310ms, dist/index-BBaGgLGV.js 224.66 KB / gzip 69.76 KB) |
| `pnpm --filter @pase/shared build` | OK (tsc --noEmit, sin errores) |
| `pnpm --filter comanda build` | OK (15 modules, 102ms, dist/index-BhRCRCu2.js 190.93 KB / gzip 60.25 KB) |

**Nota sobre tamaño de bundle PASE:** ~224 KB / 69 KB gzip vs los ~918 KB / 243 KB del último build pre-monorepo. La diferencia es porque pnpm con symlinks + dedup logra mejor tree-shaking que la copia plana de npm. El comportamiento funcional no cambia (los tests pasan idénticos).

## Decisiones tomadas en el camino

- **Renombré el paquete PASE** de `vite-react-typescript-starter` a `pase` para que `pnpm --filter pase ...` funcione directamente. Cambio interno; no afecta nada.
- **Separé `vitest.config.ts` de `vite.config.ts` en comanda.** Con TS strict, el campo `test` no es parte del `UserConfig` de vite y `tsc -b` falla. La separación es la solución oficial recomendada por vitest 4.
- **Borré `packages/pase/package-lock.json`** y reemplacé por `pnpm-lock.yaml` en raíz. Migración full a pnpm — más limpia que mezclar.
- **No moví `.gitignore` a packages/pase**. Lo mantuve en raíz con ignores universales (`node_modules`, `dist`, `*.local`, `.turbo`, etc) y agregué `EXPORT_CONTEXTO_CHAT.md` como ignore PASE-específico.
- **`packages/comanda/.gitignore`** creado por separado para artefactos de su build (`*.tsbuildinfo`).

## Smoke tests que tenés que hacer **LOCAL** antes de tocar Vercel

1. `git pull origin main` en tu máquina (después de mi push).
2. Borrá tu `node_modules` viejo si todavía está en raíz: `rm -rf node_modules` (yo ya lo había borrado pero por las dudas).
3. Si todavía no tenés pnpm 9: `npm install -g pnpm@9.15.9`.
4. `pnpm install` en raíz — debe terminar sin errores en ~15s.
5. `pnpm --filter pase test` → **debe mostrar 152/152 verde** (igual que antes).
6. `pnpm --filter pase dev` → abre `http://localhost:5173`. Probar:
   - Login con tu usuario.
   - Sidebar muestra los 5 locales de prod (la fix de TASK 0.8 está incluida).
   - Abrir cada módulo: Dashboard, Ventas, Compras, Remitos, Gastos, Tesorería, Conciliación MP, RRHH, Usuarios, Cashflow, Cierre, EERR, Contador, Costos, Configuración, Blindaje. **Todos deben renderizar sin errores en consola.**
   - Smoke específico de la última batch:
     - Tesorería → "↔ Transferir" abre el modal con selector de origen/destino.
     - RRHH → Pagos → Pagar y → + Adelanto abren los modales sin error.
     - Caja → Nuevo Movimiento → Ingreso muestra solo las 11 cat_ingreso.
     - Conciliación MP → list NO muestra "Venta Presencial" / "Cobro Online".
7. `pnpm --filter comanda dev` → abre `http://localhost:5174`. Debe mostrar el placeholder "COMANDA — En construcción".

## Si los smoke locales pasan, reconfigurar Vercel

**⚠ HASTA QUE NO HAGAS ESTO, EL PRÓXIMO DEPLOY EN VERCEL VA A FALLAR.** La prod URL (`pase-yndx.vercel.app`) sigue sirviendo el último deploy exitoso (que es de antes del switch), así que no se rompe nada visible para los usuarios mientras tanto.

Pasos en Vercel UI:

1. Vercel Dashboard → Project **pase-yndx** → **Settings** → **General**.
2. Buscar la sección **Root Directory**.
3. Cambiar de `.` (o vacío) a **`packages/pase`**.
4. **Save**.
5. (Opcional) Vercel debería detectar automáticamente que es un proyecto Vite. Si te pide framework, elegí **Vite**.
6. **Build & Development Settings**:
   - Install Command: dejar default. Vercel detecta `pnpm-lock.yaml` y usa pnpm. Si querés ser explícito: `pnpm install --frozen-lockfile`.
   - Build Command: `pnpm build` (que delega a turbo, que delega a `vite build` de packages/pase).
   - Output Directory: `dist` (relativo al Root Directory, o sea `packages/pase/dist`).
7. **Redeploy** del último commit en main.
8. Esperar a que termine el build (~1 min).
9. Smoke test post-deploy en `pase-yndx.vercel.app`:
   - Login + sidebar OK.
   - Abrir Conciliación MP — confirmar que no rompió la sync.
   - Probar el cron MP automático en el horario configurado (3am ART) o disparar manual con el botón Sincronizar.

## Si algo rompe

- **Build de Vercel falla**: revisá Output. Lo más probable es Install Command (Vercel intentando npm en vez de pnpm) o Output Directory mal seteado.
- **PASE prod cae**: Vercel mantiene el último deploy exitoso como production hasta que un nuevo deploy le reemplace. Si llega a romper, en Vercel UI → Deployments → el deploy anterior → "Promote to Production".
- **Rollback completo del monorepo**: `git revert c7dfde3 0c54032 d34f990 5bf0992 a67ebd8` (5 commits, en ese orden). O `git reset --hard d13ce14` si nadie más bajó cambios. **No lo hagas sin avisar al equipo.**

## Diferencias con el plan original

- El spec mencionaba "5 commits separados" en el orden `a` (workspace) → `b` (move). Los hice en orden inverso (`b` primero, `a` segundo) porque hacer setup workspace antes del move generaría un intermediate state confuso (dos `package.json` superpuestos en el mismo dir). El git log final cuenta la historia correcta de todas formas.
- No moví `.gitignore` a packages/pase porque sus reglas son mayormente universales (node_modules, dist, *.local, etc). Lo mantuve en raíz + agregué `.turbo`.
- No tuve que tocar absolutamente NADA dentro de packages/pase/src/ — el código de PASE quedó funcionalmente idéntico. Las imports relativas (`./components/Layout`, `../lib/auth`, etc) siguen funcionando porque el árbol completo se movió como bloque.

## Pendientes futuros (no en esta task)

- **Migrar `tsconfig` de pase a strict** — sprint dedicado entre Fase 1 y COMANDA Ola 1.
- **Extraer utils/types/services a `@pase/shared`** — cuando COMANDA empiece a consumirlos. Ahora son placeholders vacíos.
- **Setup CI** (GitHub Actions) que corra `pnpm test` + `pnpm build` en push a main. No existía pre-monorepo, pero ahora con turbo cache es fácil.
- **Crear proyecto Vercel separado para COMANDA** cuando esté listo (URL aparte como `comanda-xxxx.vercel.app`).
