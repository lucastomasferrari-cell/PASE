// Genera los PNGs PWA desde public/icons/source.svg.
// Correr: pnpm --filter comanda exec node scripts/generate-pwa-icons.mjs
//
// Outputs:
//   public/icons/icon-192.png         — Android home icon
//   public/icons/icon-512.png         — Android splash + chrome
//   public/icons/icon-512-maskable.png — Android adaptive (safe-area 80%)
//   public/apple-touch-icon.png       — iOS home (180x180)
//   public/favicon.svg                — favicon vector

import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'public/icons/source.svg');
const OUT = resolve(ROOT, 'public/icons');
mkdirSync(OUT, { recursive: true });

const svgBuffer = readFileSync(SRC);

// Maskable: el contenido debe caber en el centro 80% (safe area). Reescalo
// el SVG dentro de un fondo sólido del mismo color para que Android pueda
// recortar en cualquier forma sin perder la letra.
const MASKABLE_SVG = svgBuffer
  .toString()
  .replace('viewBox="0 0 512 512"', 'viewBox="-64 -64 640 640"');

async function gen(size, file, source = svgBuffer) {
  await sharp(source).resize(size, size).png().toFile(resolve(OUT, file));
  console.log(`✓ ${file} (${size}x${size})`);
}

await gen(192, 'icon-192.png');
await gen(512, 'icon-512.png');
await gen(512, 'icon-512-maskable.png', Buffer.from(MASKABLE_SVG));

// Apple touch icon
await sharp(svgBuffer).resize(180, 180).png().toFile(resolve(ROOT, 'public/apple-touch-icon.png'));
console.log('✓ apple-touch-icon.png (180x180)');

// Favicon SVG (copia del source — el browser escala)
copyFileSync(SRC, resolve(ROOT, 'public/favicon.svg'));
console.log('✓ favicon.svg');

console.log('\nListo. Vite copia public/ a dist/ en el build.');
