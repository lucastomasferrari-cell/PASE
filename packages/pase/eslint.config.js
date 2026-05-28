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

// Regla C3 (CLAUDE.md "Convenciones"): defense-in-depth multi-local.
// Toda query sobre tabla con `local_id` debe pasar por `applyLocalScope`
// (definido en `src/lib/auth.ts`) ANTES de ejecutarla. RLS server-side
// también lo cubre, pero el patrón debe estar para que el bug histórico
// #27 (leak entre sucursales si RLS falla) no se pueda re-introducir.
//
// Heurística (file-level): si un archivo llama `db.from("<tabla con
// local_id>")` y NO menciona `applyLocalScope` en ningún lado, falla.
// Si el archivo lo usa al menos una vez (para cualquier query), pasa —
// el caso "uso applyLocalScope para una query pero olvido para otra del
// mismo archivo" queda como falso negativo aceptable: hoy nadie tiene
// 2 queries de tablas distintas con local_id en el mismo file sin
// aplicarlo a ambas. Si aparece, agregar análisis más fino.
//
// La regla aplica solo a archivos del cliente — los scripts y tests
// están excluidos via override (igual que C4).
const requireApplyLocalScope = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Toda query sobre tabla con local_id debe pasar por applyLocalScope (defense-in-depth multi-local).',
    },
    messages: {
      missing: 'db.from("{{tabla}}") está en una tabla con local_id pero el archivo no llama applyLocalScope en ningún lado. Importá `applyLocalScope` de `src/lib/auth.ts` y wrappeá la query (CLAUDE.md → C3). Si es lectura cross-local intencional, agregá // eslint-disable-next-line pase-local/require-apply-local-scope con motivo.',
    },
    schema: [],
  },
  create(context) {
    // Tablas con `local_id` (TS strict). No incluye tablas globales
    // (locales, tenants, usuarios, config_categorias, etc).
    const CON_LOCAL_ID = /^(ventas|gastos|facturas|factura_items|remitos|movimientos|saldos_caja|conceptos_caja|mp_movimientos|mp_credenciales|mp_justificaciones|conciliaciones_mp|rrhh_empleados|rrhh_liquidaciones|rrhh_adelantos|rrhh_pagos|caja_movimientos_categorias)$/
    const findings = []
    let fileHasDefense = false
    return {
      Identifier(node) {
        if (node.name === 'applyLocalScope') fileHasDefense = true
      },
      // Filtro manual sobre local_id: `q.eq("local_id", X)` /
      // `q.in("local_id", X)` también es defense-in-depth aceptable.
      // Pattern: CallExpression con callee MemberExpression cuyo
      // property es 'eq' o 'in' y el primer argumento es literal "local_id".
      CallExpression(node) {
        if (node.callee?.type === 'MemberExpression') {
          const m = node.callee.property?.name
          if (m === 'eq' || m === 'in') {
            const a0 = node.arguments?.[0]
            if (a0?.type === 'Literal' && a0.value === 'local_id') {
              fileHasDefense = true
            }
          }
        }
        // db.from("<tabla>")
        if (node.callee?.type !== 'MemberExpression') return
        if (node.callee.property?.name !== 'from') return
        // Solo aplica a `db.from(...)` directo. `db.storage.from(...)`
        // accede a Storage (buckets), no a tablas — el "facturas" en
        // `db.storage.from("facturas")` es un bucket, no la tabla.
        const recv = node.callee.object
        if (recv?.type !== 'Identifier' || recv.name !== 'db') return
        const arg = node.arguments?.[0]
        if (arg?.type !== 'Literal' || typeof arg.value !== 'string') return
        if (!CON_LOCAL_ID.test(arg.value)) return
        findings.push({ node, tabla: arg.value })
      },
      'Program:exit'() {
        if (fileHasDefense) return
        for (const f of findings) {
          context.report({ node: f.node, messageId: 'missing', data: { tabla: f.tabla } })
        }
      },
    }
  },
}

// Regla C8 (CLAUDE.md "Convenciones"): toda página nueva en App.tsx se
// importa con `lazy(() => import(...))` + Suspense. Importarla eager
// (import Page from "./pages/Page") arruina el code-splitting de F5 y
// la página entra en el initial chunk, inflando el bundle inicial.
//
// La regla solo aplica al archivo `src/App.tsx`. Cualquier
// `ImportDeclaration` con `source` que matchee `./pages/X` queda
// flageada (excepto Login, que es entry-point y queda eager por diseño).
const noEagerPageImportApp = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Páginas importadas en App.tsx deben usar lazy() — code-splitting (C8).',
    },
    messages: {
      eager: 'Import eager de página "{{ruta}}" en App.tsx. Cambialo a `const Page = lazy(() => import("{{ruta}}"));` y envolvé el render con <Suspense> (ver Dashboard como ejemplo). CLAUDE.md → C8.',
    },
    schema: [],
  },
  create(context) {
    if (!context.filename.replace(/\\/g, '/').endsWith('/src/App.tsx')) return {}
    return {
      ImportDeclaration(node) {
        const src = node.source.value
        if (typeof src !== 'string') return
        if (!/^\.\/pages\//.test(src)) return
        // Login queda eager: entry point sin sesión, no queremos latencia.
        if (src === './pages/Login') return
        context.report({ node, messageId: 'eager', data: { ruta: src } })
      },
    }
  },
}

// ─────────────────────────────────────────────────────────────────────
// C12 (audit F4B#1): preferir el componente <Modal> en vez de overlay
// manual con className="overlay". El Modal compartido tiene focus trap,
// Escape para cerrar, body-scroll lock, role="dialog" + aria-modal,
// header consistente. Hoy 24 archivos dibujan overlay manual con 3
// patterns distintos coexistiendo.
// ─────────────────────────────────────────────────────────────────────
const preferModalComponent = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Usar <Modal> de components/ui en vez de overlay manual.',
    },
    messages: {
      overlay: 'className="overlay" detectado — preferí <Modal> de components/ui que ya tiene focus trap, Escape, body-scroll lock y a11y (CLAUDE.md → C12 / F4B#1).',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name?.name !== 'className') return
        // Detecta className="overlay" o className="overlay ..." literal
        const val = node.value
        if (!val) return
        let str = null
        if (val.type === 'Literal' && typeof val.value === 'string') str = val.value
        if (val.type === 'JSXExpressionContainer' && val.expression?.type === 'Literal' &&
            typeof val.expression.value === 'string') str = val.expression.value
        if (!str) return
        const classes = str.split(/\s+/)
        if (classes.includes('overlay')) {
          context.report({ node, messageId: 'overlay' })
        }
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
          'require-apply-local-scope': requireApplyLocalScope,
          'no-eager-page-import-app': noEagerPageImportApp,
          'prefer-modal-component': preferModalComponent,
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
      'pase-local/require-apply-local-scope': 'error',
      'pase-local/no-eager-page-import-app': 'error',
      // C12 modal pattern: WARN (no error) durante el ramp-up.
      // 24 archivos hoy dibujan overlay manual. Migrar gradual.
      // Convertir a error cuando coverage llegue a >80%.
      'pase-local/prefer-modal-component': 'warn',
      // React 19 nuevo: set-state-in-effect detecta `setX()` dentro de
      // un useEffect. Es bug-prone (cascading renders) pero la mayoría
      // de los ~28 casos en el codebase son legítimos (cargar data y
      // setearla post-fetch). Downgrade a warn — convertirlo en error
      // cuando se migre cada caso a el pattern recomendado (react query,
      // useReducer, o setState dentro de un event handler en vez de
      // efecto). Refactor sprint dedicado.
      'react-hooks/set-state-in-effect': 'warn',
      // React 19 nuevo: detectar cómputos no-puros (Date.now, Math.random)
      // y acceso a refs durante render. Son señales de bugs pero los 2
      // casos actuales son legítimos (Date.now en una const local que se
      // usa para formatear; ref.current accessed en map() condicional).
      // Downgrade a warn hasta refactor dedicado.
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
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
      'pase-local/require-apply-local-scope': 'off',
    },
  },
  // Endpoints serverless (api/*.js) tienen `// eslint-disable-next-line
  // pase-local/no-direct-financiera-write` para casos legítimos (RPC bot
  // marketplace que escribe a movimientos). Sin registrar el plugin acá,
  // la directiva referencia una regla desconocida y eslint la marca como
  // error "Definition for rule X was not found". Plugin registrado sin
  // reglas activas (no necesitamos lint estricto en api/ — ya pasa cron auth).
  {
    files: ['api/**/*.{js,mjs}'],
    plugins: {
      'pase-local': {
        rules: {
          'no-direct-financiera-write': noDirectFinancieraWrite,
          'require-apply-local-scope': requireApplyLocalScope,
          'no-eager-page-import-app': noEagerPageImportApp,
          'prefer-modal-component': preferModalComponent,
        },
      },
    },
    rules: {
      'pase-local/no-direct-financiera-write': 'off',
      'pase-local/require-apply-local-scope': 'off',
    },
  },
])
