# PASE Monorepo

Monorepo gestionado con **pnpm workspaces** + **Turborepo**. Contiene 3 paquetes:

| Paquete | Descripción |
|---|---|
| `packages/pase` | App principal — sistema de gestión gastronómico (Tesorería, Compras, RRHH, Conciliación MP, etc). React 19 + Vite + Supabase. Deploy en `pase-yndx.vercel.app`. |
| `packages/comanda` | Segundo proyecto, en construcción. Stack idéntico (React 19 + Vite + TS strict). DB compartida con PASE. |
| `packages/shared` | Utils, types y servicios compartidos entre `pase` y `comanda`. Scaffolding inicial; la extracción real se hace en sprint dedicado entre Fase 1 y COMANDA Ola 1. |

## Requisitos

- Node ≥ 20
- pnpm 9 (la versión está fijada en `package.json#packageManager`; instalala con `npm i -g pnpm@9` si no la tenés)

## Instalar

```bash
pnpm install
```

Esto instala las dependencias de los 3 paquetes y crea los symlinks de workspace (por ejemplo `comanda` → `@pase/shared`).

## Comandos por paquete

```bash
# PASE
pnpm --filter pase dev          # http://localhost:5173
pnpm --filter pase build
pnpm --filter pase test         # vitest, suite unitaria (152 tests al momento del setup)
pnpm --filter pase test:e2e     # playwright

# COMANDA
pnpm --filter comanda dev       # http://localhost:5174
pnpm --filter comanda build

# Shared (solo type-check)
pnpm --filter @pase/shared build
```

## Comandos del monorepo (turborepo)

```bash
pnpm build       # turbo build — buildea todos los paquetes con cache
pnpm test        # turbo test  — corre tests de todos los paquetes
pnpm dev         # turbo dev   — arranca dev servers en paralelo
pnpm lint        # turbo lint
```

Turbo cachea outputs en `.turbo/`. La caché es local; podés borrarla con `rm -rf node_modules/.cache/turbo` o `pnpm turbo prune`.

## Deploy

- **PASE en Vercel**: el proyecto Vercel apunta a `packages/pase` como Root Directory. Vercel detecta `package.json`, `vite.config.ts`, `vercel.json` y `api/` dentro de ese directorio. Los crons (mp-sync) están en `packages/pase/vercel.json`.
- **COMANDA**: cuando esté listo, se crea un proyecto Vercel separado apuntando a `packages/comanda`.
- **DB**: ambos proyectos comparten la instancia Supabase `pduxydviqiaxfqnshhdc`. Las migrations están en `packages/pase/supabase/migrations/` y se aplican vía el flow oficial documentado en `packages/pase/CONTEXTO.md` (`vercel env pull` + script Node con `pg`).

## Estructura

```
.
├── package.json               # workspace orchestrator (turbo, scripts proxy)
├── pnpm-workspace.yaml        # declara packages/* como workspaces
├── turbo.json                 # pipeline de build/test/dev/lint
├── packages/
│   ├── pase/                  # app PASE (todo el código histórico)
│   │   ├── api/               # Vercel serverless functions
│   │   ├── public/
│   │   ├── src/
│   │   ├── supabase/migrations/
│   │   ├── tests/
│   │   ├── package.json
│   │   ├── vercel.json
│   │   └── ...
│   ├── comanda/               # WIP
│   │   └── src/App.tsx        # placeholder
│   └── shared/                # @pase/shared
│       └── src/               # placeholders por ahora
└── .gitignore                 # ignores universales del monorepo
```

## TypeScript

- `packages/shared` y `packages/comanda` arrancan con **`strict: true`** desde día 1 (decisión SESION_1).
- `packages/pase` mantiene el `tsconfig` laxo actual durante la transición; se migra a strict en un sprint dedicado entre Fase 1 y COMANDA Ola 1.

## Documentación adicional

La documentación completa de PASE (módulos, decisiones de arquitectura, taxonomía de movimientos, política de migrations, RLS, etc) vive en `packages/pase/CONTEXTO.md`.
