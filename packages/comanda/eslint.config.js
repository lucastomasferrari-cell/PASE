// ESLint config para COMANDA — mirror del de PASE con reglas C3/C4/C8 activas.
// Acordado Fase 0 (auditoría estructural 2026-05-15): COMANDA no tenía ESLint
// con reglas custom y eso permitía que features nuevas regresaran patrones
// que en PASE están bloqueados. Las 3 reglas custom son las mismas que en
// `packages/pase/eslint.config.js` pero adaptadas al universo de tablas de COMANDA.

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

// ─── Regla C4 — NO write directo a tablas financieras del POS ──────────────
// Toda operación financiera debe pasar por una RPC `fn_*_comanda` atómica
// (sprint 2/7/14 patterns). Excluye tests/scripts/seeds.
const noDirectFinancieraWrite = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Bloquea INSERT/UPDATE/UPSERT/DELETE directo sobre tablas financieras de COMANDA. Usar RPC atómica.',
    },
    messages: {
      direct: 'No {{metodo}} directo sobre "{{tabla}}". Usá una RPC atómica fn_*_comanda (ver Sprint 2/7/14). Si es setup de test/seed/script, agregá // eslint-disable-next-line pase-local/no-direct-financiera-write con motivo.',
    },
    schema: [],
  },
  create(context) {
    // Tablas que mueven plata o estado financiero en COMANDA.
    // - ventas_pos: total, estado venta. Update directo rompe trigger de history.
    // - ventas_pos_items: subtotal, precio_unitario, cantidad. Cambios deben recalcular total via RPC.
    // - ventas_pos_pagos: monto. Insert directo permite duplicados (sin idempotency).
    // - ventas_pos_overrides: append-only por diseño, solo desde RPCs de override.
    // - turnos_caja: monto_inicial, monto_final_calculado, diferencia.
    // - movimientos_caja: tipo, monto, ingreso/egreso de caja física.
    const FINANCIERAS = /^(ventas_pos|ventas_pos_items|ventas_pos_pagos|ventas_pos_overrides|turnos_caja|movimientos_caja)$/;
    const METODOS = new Set(['insert', 'update', 'upsert', 'delete']);
    return {
      CallExpression(node) {
        if (node.callee?.type !== 'MemberExpression') return;
        const metodo = node.callee.property?.name;
        if (!METODOS.has(metodo)) return;
        const fromCall = node.callee.object;
        if (fromCall?.type !== 'CallExpression') return;
        if (fromCall.callee?.type !== 'MemberExpression') return;
        if (fromCall.callee.property?.name !== 'from') return;
        const arg = fromCall.arguments?.[0];
        if (arg?.type !== 'Literal' || typeof arg.value !== 'string') return;
        if (!FINANCIERAS.test(arg.value)) return;
        context.report({
          node,
          messageId: 'direct',
          data: { metodo, tabla: arg.value },
        });
      },
    };
  },
};

// ─── Regla C3 — applyLocalScope o filtro manual local_id obligatorio ───────
// Defense-in-depth multi-local. RLS server-side también lo cubre, pero el
// patrón debe estar para que bugs como #27 (leak entre sucursales) no se
// puedan re-introducir.
//
// Heurística file-level: si el archivo llama `db.from("<tabla con local_id>")`
// debe (a) importar `applyLocalScope`, o (b) mencionarlo en alguna línea,
// o (c) filtrar manualmente con .eq('local_id', X) / .in('local_id', X)
// en alguna query del archivo.
const requireApplyLocalScope = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Toda query sobre tabla con local_id debe pasar por applyLocalScope o filtro manual (defense-in-depth multi-local).',
    },
    messages: {
      missing: 'db.from("{{tabla}}") está en una tabla con local_id pero el archivo no llama applyLocalScope ni filtra manual por local_id en ningún lado. Importá `applyLocalScope` de `src/lib/auth.ts` o agregá `.eq("local_id", X)`. Si es lectura cross-local intencional, agregá // eslint-disable-next-line pase-local/require-apply-local-scope con motivo.',
    },
    schema: [],
  },
  create(context) {
    // Tablas con `local_id` en COMANDA. NO incluye tablas globales por tenant
    // (canales, modifier_groups, modifiers, tax_rates, metodos_cobro pueden
    // tener local_id NULL = global del tenant — el filtro `local_id = X OR
    // local_id IS NULL` es el patrón pero más laxo, se chequea por RLS).
    // Las que SIEMPRE deben filtrar por local_id específico son las
    // transaccionales del local.
    const CON_LOCAL_ID = /^(ventas_pos|ventas_pos_items|ventas_pos_pagos|ventas_pos_overrides|turnos_caja|movimientos_caja|mesas|kds_tokens|menu_qr_tokens|comanda_local_settings)$/;
    const findings = [];
    let fileHasDefense = false;
    return {
      Identifier(node) {
        if (node.name === 'applyLocalScope') fileHasDefense = true;
      },
      CallExpression(node) {
        if (node.callee?.type === 'MemberExpression') {
          const m = node.callee.property?.name;
          if (m === 'eq' || m === 'in') {
            const a0 = node.arguments?.[0];
            if (a0?.type === 'Literal' && a0.value === 'local_id') {
              fileHasDefense = true;
            }
          }
        }
        if (node.callee?.type !== 'MemberExpression') return;
        if (node.callee.property?.name !== 'from') return;
        const recv = node.callee.object;
        if (recv?.type !== 'Identifier' || recv.name !== 'db') return;
        const arg = node.arguments?.[0];
        if (arg?.type !== 'Literal' || typeof arg.value !== 'string') return;
        if (!CON_LOCAL_ID.test(arg.value)) return;
        findings.push({ node, tabla: arg.value });
      },
      'Program:exit'() {
        if (fileHasDefense) return;
        for (const f of findings) {
          context.report({ node: f.node, messageId: 'missing', data: { tabla: f.tabla } });
        }
      },
    };
  },
};

// ─── Regla C8 — Lazy imports en App.tsx ────────────────────────────────────
const noEagerPageImportApp = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Páginas importadas en App.tsx deben usar lazy() — code-splitting (C8).',
    },
    messages: {
      eager: 'Import eager de página "{{ruta}}" en App.tsx. Cambialo a `const Page = lazy(() => import("{{ruta}}"));` y envolvé el render con <Suspense>. Login queda eager por diseño (entry point).',
    },
    schema: [],
  },
  create(context) {
    if (!context.filename.replace(/\\/g, '/').endsWith('/src/App.tsx')) return {};
    return {
      ImportDeclaration(node) {
        const src = node.source.value;
        if (typeof src !== 'string') return;
        if (!/^\.\/pages\//.test(src)) return;
        // Login queda eager: entry point sin sesión, no queremos latencia.
        if (src.startsWith('./pages/Login')) return;
        // admin-stubs/ contiene utilidades comunes (StubRoute, routeWrappers)
        // que se reutilizan en docenas de rutas — son helpers, no páginas
        // grandes. Lazy las cargaría apenas se navega a cualquier admin.
        if (src.startsWith('./pages/admin-stubs/')) return;
        context.report({ node, messageId: 'eager', data: { ruta: src } });
      },
    };
  },
};

export default defineConfig([
  globalIgnores(['dist', 'node_modules']),
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'pase-local': {
        rules: {
          'no-direct-financiera-write': noDirectFinancieraWrite,
          'require-apply-local-scope': requireApplyLocalScope,
          'no-eager-page-import-app': noEagerPageImportApp,
        },
      },
    },
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Reglas C3/C4/C8 (auditoría estructural 2026-05-15) — críticas para
      // arquitectura. Bloqueantes en CI.
      'pase-local/no-direct-financiera-write': 'error',
      'pase-local/require-apply-local-scope': 'error',
      'pase-local/no-eager-page-import-app': 'error',
      // react-hooks reglas adicionales — códigobase pre-existente las violaba
      // sin saberlo (100+ casos). Mantenemos `exhaustive-deps` como warn
      // porque es útil real. Las demás (React Compiler / Forget rules) están
      // OFF hasta sprint dedicado de cleanup — son demasiado estrictas para
      // patterns standard (setState dentro de async then en useEffect es
      // legítimo en 80% de los casos).
      // Deuda C-react-hooks (sprint dedicado): re-habilitar las 5 reglas
      // como 'warn' y hacer pasada de cleanup completo.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/component-hook-factories': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-refresh/only-export-components': 'warn',
    },
  },
  // Tests/scripts/seeds — bypass intencional.
  {
    files: [
      'tests/**/*.{ts,tsx,mjs,cjs,js}',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      'scripts/**/*.{ts,tsx,mjs,cjs,js}',
    ],
    rules: {
      'pase-local/no-direct-financiera-write': 'off',
      'pase-local/require-apply-local-scope': 'off',
    },
  },
]);
