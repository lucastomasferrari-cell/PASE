// Config minimal para comanda. Mantiene js.recommended +
// typescript-eslint.recommended (alineado con pase) pero SIN
// react-hooks/react-refresh plugins — esos requieren devDeps que el
// scaffolding actual de comanda no tiene. Cuando el módulo crezca a
// código React real, mirroreamos packages/pase/eslint.config.js
// completo y agregamos las deps a packages/comanda/package.json.

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
