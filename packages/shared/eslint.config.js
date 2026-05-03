// Config minimal para @pase/shared. TS puro, sin React (es una lib que
// va a ser consumida por pase y comanda — no tiene UI propia). Mismo
// stack base que packages/pase/eslint.config.js (js.recommended +
// typescript-eslint.recommended) para que las reglas no diverjan.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist', 'node_modules']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
    },
  },
]);
