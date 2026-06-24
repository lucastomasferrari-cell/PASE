# Bot de diagnóstico IA — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir el widget de soporte en un asistente de diagnóstico **read-only** que, para quien tenga el permiso, consulta la base (scopeada a su tenant + sus locales) vía un menú cerrado de herramientas, con un protocolo de preguntas para ser preciso.

**Architecture:** Nuevo `task: 'diagnostico-chat'` en `api/claude.js` con un loop de *tool use* server-side. Helpers nuevos: `_diagnostico-scope.js` (locales visibles + chequeo de permiso, server-side con service client) y `_diagnostico-tools.js` (definiciones de tools + ejecución read-only scopeada). Permiso nuevo `diagnostico_ia` en `auth.ts` / `Usuarios.tsx`. El frontend (`SoporteWidget`, COMANDA y PASE) cambia de task si el user tiene el permiso.

**Tech Stack:** Vercel serverless (Node ESM), Anthropic Messages API (Sonnet 4.6 + tool use), Supabase service_role (filtrado manual), React 19 + TS estricto.

**Spec de referencia:** `docs/superpowers/specs/2026-06-24-bot-diagnostico-ia-design.md`

---

## Estructura de archivos

- **Create** `packages/pase/api/_diagnostico-scope.js` — `localesVisibles(admin,row)` + `tienePermisoDiagnostico(admin,row)`. Núcleo de seguridad.
- **Create** `packages/pase/api/_diagnostico-tools.js` — `TOOLS` (schemas JSON) + `executeTool(admin, scope, name, input)` (cada consulta read-only, scopeada, con tope de filas).
- **Create** `packages/pase/api/_diagnostico-prompt.js` — system prompt del protocolo de preguntas (importa/extiende el manual de `_soporte-prompt.js`).
- **Modify** `packages/pase/api/claude.js` — rama `task: 'diagnostico-chat'` con loop tool_use; gate de permiso; fix de tracking de caché.
- **Modify** `packages/pase/src/lib/auth.ts` — `PERMISOS_EXTRAS += diagnostico_ia`.
- **Modify** `packages/pase/src/components/SoporteWidget.tsx` y `packages/comanda/src/components/SoporteWidget.tsx` — elegir task según permiso + label "modo diagnóstico".
- **Test** `packages/pase/api/__tests__/_diagnostico-scope.test.js`, `_diagnostico-tools.test.js`.

Orden: **menor a mayor riesgo de seguridad primero** (el aislamiento es lo que no se puede equivocar).

---

### Task 1: Permiso + scoping + gate (aislamiento — lo más sensible)

**Files:**
- Modify: `packages/pase/src/lib/auth.ts` (array `PERMISOS_EXTRAS`)
- Create: `packages/pase/api/_diagnostico-scope.js`
- Test: `packages/pase/api/__tests__/_diagnostico-scope.test.js`

- [ ] **Step 1: Agregar el permiso.** En `auth.ts`, dentro de `PERMISOS_EXTRAS`, sumar:

```ts
{ slug:"diagnostico_ia", label:"Asistente de diagnóstico IA",
  descripcion:"Permite usar el bot en modo diagnóstico: mira la base (SOLO LECTURA) para ayudar a encontrar y entender datos. Acotado a los locales del usuario. Por default solo dueño/admin." },
```

`Usuarios.tsx` ya renderiza `PERMISOS_EXTRAS` como checkboxes → no requiere cambio adicional (verificar que aparece).

- [ ] **Step 2: Escribir el helper de scope.** `_diagnostico-scope.js`:

```js
// Calcula los local_id que un usuario puede ver, y si tiene el permiso de
// diagnóstico — TODO server-side con el service client (la API no tiene el
// JWT del user, así que NO se puede usar auth_locales_visibles()/auth_tiene_permiso()).
const ROL_ALTO = new Set(['dueno', 'admin', 'superadmin']);

export async function localesVisibles(admin, row) {
  if (ROL_ALTO.has(row.rol)) {
    const { data } = await admin.from('locales').select('id').eq('tenant_id', row.tenant_id);
    return (data || []).map(r => r.id);
  }
  const { data } = await admin.from('usuario_locales').select('local_id').eq('usuario_id', row.id);
  return (data || []).map(r => r.local_id);
}

export async function tienePermisoDiagnostico(admin, row) {
  if (ROL_ALTO.has(row.rol)) return true;
  // Unión rol_permisos (via usuarios.rol_id) + usuario_permisos. CONFIRMAR en impl
  // los nombres exactos de columnas de permiso (slug) contra el schema real.
  const slug = 'diagnostico_ia';
  const [up, rp] = await Promise.all([
    admin.from('usuario_permisos').select('permiso').eq('usuario_id', row.id).eq('permiso', slug),
    row.rol_id
      ? admin.from('rol_permisos').select('permiso').eq('rol_id', row.rol_id).eq('permiso', slug)
      : Promise.resolve({ data: [] }),
  ]);
  return (up.data?.length > 0) || (rp.data?.length > 0);
}
```

> Nota de impl: `checkUserAuth` hoy selecciona `id, rol, activo, tenant_id, password_temporal`. Agregar `rol_id` al select de `_user-auth.js` para que el gate de rol funcione.

- [ ] **Step 3: Test de aislamiento (mutante).** `_diagnostico-scope.test.js` con un admin client mockeado o contra `Local Prueba 2`:
  - encargado con 1 local → `localesVisibles` devuelve solo ese local (NO los de otro).
  - dueño → todos los locales del tenant.
  - sin permiso y rol bajo → `tienePermisoDiagnostico` = false.
  - con permiso (fila en `usuario_permisos`) → true.
  - **Assert clave**: un encargado del local A nunca obtiene el local B.

- [ ] **Step 4: Correr el test** (`pnpm --filter pase test -- api/__tests__/_diagnostico-scope.test.js`). Verde.

- [ ] **Step 5: Commit** (`feat(diagnostico): permiso diagnostico_ia + scope server-side`).

---

### Task 2: Loop de tool use + primera herramienta end-to-end

**Files:**
- Create: `packages/pase/api/_diagnostico-tools.js` (con `buscar_movimiento` solamente, por ahora)
- Modify: `packages/pase/api/claude.js` (rama `diagnostico-chat` + loop)
- Test: `packages/pase/api/__tests__/_diagnostico-tools.test.js`

- [ ] **Step 1: Definir la primera tool + su ejecución.** En `_diagnostico-tools.js`:

```js
export const TOOLS = [
  {
    name: 'buscar_movimiento',
    description: 'Busca gastos/ingresos/ventas/pagos del usuario. Usala cuando alguien dice que cargó algo y no lo encuentra. Pedí SIEMPRE local y un dato más (fecha aprox o monto aprox) antes de llamar — no busques a ciegas.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['gasto','ingreso','venta','pago','factura'] },
        local_id: { type: 'integer' },
        fecha_desde: { type: 'string', description: 'YYYY-MM-DD' },
        fecha_hasta: { type: 'string', description: 'YYYY-MM-DD' },
        monto_aprox: { type: 'number' },
      },
      required: ['tipo', 'local_id'],
    },
  },
];

const MAX_FILAS = 20;

export async function executeTool(admin, scope, name, input) {
  // scope = { tenantId, locales:[id...] }. Validar SIEMPRE el local pedido.
  if (!scope.locales.includes(input.local_id)) {
    return { error: 'LOCAL_FUERA_DE_ALCANCE' };
  }
  if (name === 'buscar_movimiento') {
    let q = admin.from('movimientos')
      .select('id, fecha, monto, concepto, cuenta, anulado')
      .eq('tenant_id', scope.tenantId)
      .eq('local_id', input.local_id)
      .order('fecha', { ascending: false })
      .limit(MAX_FILAS);
    if (input.fecha_desde) q = q.gte('fecha', input.fecha_desde);
    if (input.fecha_hasta) q = q.lte('fecha', input.fecha_hasta);
    if (input.monto_aprox != null) {
      const tol = Math.max(Math.abs(input.monto_aprox) * 0.05, 100); // ±5% o ±$100
      q = q.gte('monto', -(Math.abs(input.monto_aprox)+tol)).lte('monto', Math.abs(input.monto_aprox)+tol);
    }
    const { data, error } = await q;
    if (error) return { error: error.message };
    return { filas: data || [], truncado: (data || []).length >= MAX_FILAS };
  }
  return { error: 'TOOL_DESCONOCIDA' };
}
```

> Impl: confirmar columnas reales de `movimientos` (concepto/cuenta) y el rango de monto (los egresos son negativos). El filtro de monto es aproximado, no exacto.

- [ ] **Step 2: Rama `diagnostico-chat` con el loop en `claude.js`.** Después del gate de permiso:

```js
if (body.task === 'diagnostico-chat') {
  const ok = await tienePermisoDiagnostico(admin, auth.row); // admin = service client de checkUserAuth
  if (!ok) { res.status(403).json({ error: 'SIN_PERMISO_DIAGNOSTICO' }); return; }
  const scope = { tenantId: auth.row.tenant_id, locales: await localesVisibles(admin, auth.row) };
  const result = await runDiagnosticoLoop(body, scope, admin); // ver abajo
  res.status(200).json(result);
  return;
}
```

`runDiagnosticoLoop`: arma `system` (manual + protocolo, con cache_control) + `tools: TOOLS`; loop:
1. POST a Anthropic (Sonnet, max_tokens cap).
2. Si `stop_reason === 'tool_use'`: por cada bloque `tool_use`, `executeTool(...)`, push `tool_result`; volver a 1.
3. Si `end_turn` o **iteración > 5**: devolver el último mensaje de texto.
4. Trackear usage de **todas** las vueltas (sumar tokens, incluyendo cache — ver Task 6).

- [ ] **Step 3: Test de `buscar_movimiento`** contra `Local Prueba 2`: crea un movimiento sentinel, lo encuentra por local+monto; pedir un `local_id` fuera de scope → `LOCAL_FUERA_DE_ALCANCE`.
- [ ] **Step 4: Smoke del loop** contra Anthropic en transacción/ROLLBACK o con mock: una pregunta que dispara la tool y vuelve con respuesta. typecheck + lint.
- [ ] **Step 5: Commit** (`feat(diagnostico): loop tool_use + buscar_movimiento`).

---

### Task 3: Resto del catálogo de herramientas

**Files:** `packages/pase/api/_diagnostico-tools.js` (+ tests)

Replicar el patrón de Task 2 (schema + branch en `executeTool`, siempre validando `scope`) para: `detalle_registro`, `estado_conciliacion_mp`, `saldo_y_movimientos_cuenta`, `desglose_eerr`, `estado_empleado`, `actividad_reciente`, `fallas_recientes` (ver tabla en la spec). Reutilizar lógica existente donde aplique (EERR drill-down `eerrDetalle`, conciliación, RRHH). Cada tool: tope de filas, scopeada, read-only.

- [ ] Una tool por commit chico, cada una con su test de scope + un caso real.
- [ ] Para las que tocan plata sensible (estado_empleado, desglose_eerr): test que confirme que un encargado no ve datos de otro local.

---

### Task 4: System prompt del protocolo

**Files:** Create `packages/pase/api/_diagnostico-prompt.js`

- [ ] Importar `SOPORTE_SYSTEM_PROMPT` y agregarle el bloque de protocolo: clasificar → juntar mínimo (1-2 preguntas) → consultar lo justo → interpretar/responder corto (rioplatense) → si hay arreglo, explicarlo **por la UI** (read-only, no ejecuta). Incluir reglas: nunca pedir todos los datos de golpe; si hay varias candidatas, mostrarlas y preguntar; nunca inventar.
- [ ] Verificación: prompts de ejemplo ("hice un gasto y no lo encuentro", "la caja no cuadra", "no le figura el aguinaldo") producen primero preguntas acotadas y después una sola tool call.

---

### Task 5: UI — modo diagnóstico en el widget

**Files:** `packages/pase/src/components/SoporteWidget.tsx`, `packages/comanda/src/components/SoporteWidget.tsx`

- [ ] Leer del user cacheado si tiene `diagnostico_ia`. Si sí: mandar `task: 'diagnostico-chat'` y mostrar un label/cartelito "Modo diagnóstico — puedo mirar tus datos (solo lectura)". Si no: comportamiento actual (`soporte-chat`, default transparente).
- [ ] Mostrar estado "buscando…" mientras corre el loop (puede tardar más que el chat normal).
- [ ] Sin test mutante (UI/frontend, sin lógica de plata) — verificación visual + typecheck/lint.

---

### Task 6: Fix del tracking de costo (caché)

**Files:** `packages/pase/api/claude.js`

- [ ] `trackUsage`/`calcCost` deben sumar `cache_creation_input_tokens` (×1,25 del precio in) y `cache_read_input_tokens` (×0,1) además de `input_tokens`. Hoy se ignoran → `llm_usage_log.cost_usd` subestima la factura real (medido 24-jun). Agregar columnas `tokens_cache_write` / `tokens_cache_read` a `llm_usage_log` (migración) o plegarlas al costo. Aplica a TODAS las tasks, no solo diagnóstico.
- [ ] Verificación: una llamada con system prompt cacheado registra un `cost_usd` coherente con el cálculo manual.

---

## Self-review (cubierto)
- **Spec coverage**: permiso ✓, read-only ✓, PASE+COMANDA ✓, protocolo ✓, catálogo ✓, seguridad/scope ✓, tracking ✓.
- **Riesgo nº1 (aislamiento)**: Task 1 primero, con test que prueba que un encargado no cruza de local; `executeTool` revalida el local en cada llamada (defensa en profundidad).
- **Vercel**: no se agrega function nueva (todo cuelga de `claude.js`); cap de 5 iteraciones; subir `maxDuration` si hace falta.
- **Pendiente de confirmar en impl**: nombres de columnas de `usuario_permisos`/`rol_permisos` y de `movimientos`; agregar `rol_id` al select de `_user-auth.js`.
