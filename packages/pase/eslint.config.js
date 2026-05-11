import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Regla C4 (CLAUDE.md "Convenciones"): bloquea INSERT/UPDATE/UPSERT/DELETE
// directo del cliente sobre tablas con plata. Estas operaciones deben pasar
// por una RPC atómica (transacción única en server-side) — el patrón viejo
// de 3 inserts sueltos del cliente generaba estados inconsistentes (caso
// histórico Ventas.tsx confirmado al armar ventas_efectivo_mutante).
//
// La regla matchea el patrón `db.from("<tabla>").<metodo>(...)` cuando
// <tabla> es financiera y <metodo> ∈ {insert, update, upsert, delete}.
// SELECT queda permitido — lectura no muta estado.
//
// Excluye archivos de test/seed/script donde el bypass es intencional
// (setup de fixtures, cleanup, audits one-off).
const noDirectFinancieraWrite = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Bloquea INSERT/UPDATE/UPSERT/DELETE directo sobre tablas financieras desde el cliente. Usar RPC atómica.',
    },
    messages: {
      direct: 'No {{metodo}} directo sobre "{{tabla}}". Usá una RPC atómica (ver CLAUDE.md → Convenciones → C4). Si es un setup de test/seed/script, agregá un comment // eslint-disable-next-line pase-local/no-direct-financiera-write con el motivo.',
    },
    schema: [],
  },
  create(context) {
    // Tablas que mueven plata directamente. Cambios en rrhh_empleados
    // (datos personales, sueldo_mensual) o rrhh_novedades (horas/asistencias)
    // NO entran porque el monto se cristaliza en pagar_sueldo via RPC —
    // editar la fuente del cálculo no es lo mismo que mover caja.
    // rrhh_documentos (PDFs del legajo) tampoco entra.
    // mp_credenciales tampoco (es un token, el RPC set_mp_token valida auth).
    const FINANCIERAS = /^(movimientos|saldos_caja|gastos|ventas|facturas|factura_items|remitos|rrhh_liquidaciones|rrhh_adelantos|rrhh_pagos|mp_movimientos)$/
    const METODOS = new Set(['insert', 'update', 'upsert', 'delete'])
    return {
      CallExpression(node) {
        if (node.callee?.type !== 'MemberExpression') return
        const metodo = node.callee.property?.name
        if (!METODOS.has(metodo)) return
        const fromCall = node.callee.object
        if (fromCall?.type !== 'CallExpression') return
        if (fromCall.callee?.type !== 'MemberExpression') return
        if (fromCall.callee.property?.name !== 'from') return
        const arg = fromCall.arguments?.[0]
        if (arg?.type !== 'Literal' || typeof arg.value !== 'string') return
        if (!FINANCIERAS.test(arg.value)) return
        context.report({
          node,
          messageId: 'direct',
          data: { metodo, tabla: arg.value },
        })
      },
    }
  },
}

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'pase-local': {
        rules: {
          'no-direct-financiera-write': noDirectFinancieraWrite,
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
      // El codebase ya usa el prefix `_` para señalar "intencionalmente sin
      // usar" (ej. _props, _vac, _novedadId). Hacemos que la regla respete
      // esa convención. Sin esto, código como `function Foo(_props: P)`
      // dispara false positive aunque el `_` documenta la intención.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'pase-local/no-direct-financiera-write': 'error',
    },
  },
  // Tests, scripts one-off, audits: el bypass de C4 es esperado (setup de
  // fixtures, cleanup, sondeos manuales). La regla queda desactivada.
  {
    files: [
      'tests/**/*.{ts,tsx,mjs,cjs,js}',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      'scripts/**/*.{ts,tsx,mjs,cjs,js}',
    ],
    rules: {
      'pase-local/no-direct-financiera-write': 'off',
    },
  },
])
