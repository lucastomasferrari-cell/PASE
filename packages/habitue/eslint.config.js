// ESLint de Habitué — base estándar del monorepo (igual que MESA).
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist', 'node_modules']),
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      // react-hooks v7 trae 2 reglas del RFC "Components/Hooks must be pure":
      //   - `react-hooks/purity`         — flagea `Date.now()` y similares en render
      //   - `react-hooks/set-state-in-effect` — flagea el patrón clásico de fetch+setState
      // Son sugerencias del RFC, no requirements de React 19. Refactorizar
      // a SWR/useSyncExternalStore es un proyecto aparte; por ahora warn.
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
]);
