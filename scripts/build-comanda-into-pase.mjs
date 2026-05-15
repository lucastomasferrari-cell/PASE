// Script que buildea COMANDA con base path /comanda-app/ y copia el dist
// resultante a packages/pase/public/comanda-app/. Después el build de PASE
// los copia tal cual a su dist/.
//
// Esto permite servir COMANDA como una "ruta" de PASE sin deploy separado:
//   pase-yndx.vercel.app/comanda-app/  → app COMANDA
//   pase-yndx.vercel.app/comanda-app/pos/salon  → ruta interna SPA (necesita
//                                                 rewrite Vercel, ver vercel.json)
//
// Flujo Vercel: el build command de pase-yndx ahora es:
//   pnpm install --frozen-lockfile && node scripts/build-comanda-into-pase.mjs && pnpm --filter pase build

import { execSync } from 'node:child_process';
import { existsSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const comandaDir = resolve(repoRoot, 'packages/comanda');
const comandaDist = resolve(comandaDir, 'dist');
const paseTarget = resolve(repoRoot, 'packages/pase/public/comanda-app');

console.log('▶ Build COMANDA con base=/comanda-app/');
execSync('pnpm --filter comanda build', {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, VITE_BASE_PATH: '/comanda-app/' },
});

if (!existsSync(comandaDist)) {
  console.error(`✗ No se encontró ${comandaDist} después del build`);
  process.exit(1);
}

console.log(`▶ Limpio target ${paseTarget}`);
if (existsSync(paseTarget)) rmSync(paseTarget, { recursive: true, force: true });
mkdirSync(paseTarget, { recursive: true });

console.log(`▶ Copio ${comandaDist} → ${paseTarget}`);
cpSync(comandaDist, paseTarget, { recursive: true });

console.log('✓ COMANDA embebido en PASE. Próximo paso: pnpm --filter pase build');
