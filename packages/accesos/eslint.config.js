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
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    rules: {
      // Convención del paquete: carga de datos on-mount con flag de loading
      // (useEffect(() => void reload(), [reload]) donde reload hace setCargando).
      // La regla nueva de react-hooks lo marca como falso positivo en TODAS las
      // páginas. Se desactiva a nivel paquete en vez de sembrar disables por línea.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);
