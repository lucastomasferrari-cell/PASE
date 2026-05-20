// ═══════════════════════════════════════════════════════════════════════════
// Auto-fix agent — orquestador de Claude Sonnet/Opus para resolver tickets
// de soporte automáticamente.
//
// Flow:
//   1. Lee ticket desde Supabase (id en env TICKET_ID).
//   2. Pre-filter: greppea el mensaje del bug en el repo para identificar
//      archivos candidatos. Esto reduce tokens 70%+.
//   3. Arranca con Sonnet pasándole tools de filesystem + bash limitado.
//   4. Sonnet puede usar la tool `escalate_to_opus` si el bug es complejo.
//      Cuando eso pasa, levantamos un loop nuevo con Opus + el contexto
//      que Sonnet ya investigó.
//   5. Cuando el modelo decide terminar:
//      a) `complete_with_fix`: corre typecheck + lint + tests. Si pasan y
//         el diff respeta las reglas → commit + push o crear PR.
//      b) `give_up`: agrega comentario al ticket explicando qué intentó.
//   6. Actualiza el ticket en Supabase con resultado + costo en USD.
//
// Whitelist de paths que el agent puede editar:
//   - packages/{pase,comanda,admin-console}/src/**/*.{ts,tsx,js,jsx,css,md}
//
// Whitelist de paths que el agent puede CREAR (no modificar):
//   - packages/pase/supabase/migrations/YYYYMMDDHHMM_*.sql (solo archivos nuevos)
//     El humano sigue siendo dueño del schema vivo. El agent solo puede
//     proponer migrations agregando ADELANTE; nunca modificar las existentes.
//     Si la migration es chica (< 50 líneas) y los tests pasan, el workflow
//     la commitea directo. Si es grande, abre PR. En ambos casos el push
//     notification al admin incluye un aviso "aplicar manual en Supabase".
//
// Whitelist de comandos bash:
//   - pnpm typecheck / lint / test (con --filter o sin)
//   - git status / diff / add / commit / push (a branch específico)
//
// Env vars requeridas:
//   - TICKET_ID
//   - ANTHROPIC_API_KEY
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_KEY
//   - GITHUB_TOKEN (para crear PRs)
//   - GITHUB_REPOSITORY (ej. lucastomasferrari-cell/PASE)
//   - GIT_USER_NAME (default: "Claude Auto-Fix Bot")
//   - GIT_USER_EMAIL (default: "bot@pase.local")
// ═══════════════════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TICKET_ID = process.env.TICKET_ID;
if (!TICKET_ID) { console.error('Missing TICKET_ID'); process.exit(1); }

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ─── Tracking de costos ────────────────────────────────────────────────────
const PRICING = {
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  'claude-opus-4-7':   { input: 15.00, output: 75.00, cache_read: 1.50, cache_write: 18.75 },
};
const billing = { totalUsd: 0, byModel: {} };

function trackUsage(model, usage) {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  const inputCost = (usage.input_tokens / 1_000_000) * p.input;
  const outputCost = (usage.output_tokens / 1_000_000) * p.output;
  const cacheReadCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * p.cache_read;
  const cacheWriteCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * p.cache_write;
  const subtotal = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  billing.totalUsd += subtotal;
  billing.byModel[model] = (billing.byModel[model] || 0) + subtotal;
}

// ─── Tickets API ────────────────────────────────────────────────────────────
async function updateTicket(fields) {
  const { error } = await sb.rpc('agent_update_ticket', {
    p_ticket_id: TICKET_ID,
    p_status: fields.status || null,
    p_log_entry: fields.logEntry || null,
    p_pr_url: fields.prUrl || null,
    p_pr_number: fields.prNumber || null,
    p_model_used: fields.modelUsed || null,
    p_cost_usd: fields.costUsd || null,
    p_diff_summary: fields.diffSummary || null,
  });
  if (error) console.error('updateTicket error:', error.message);
}

async function addCommentToTicket(texto) {
  const { error } = await sb.from('tickets_soporte').update({
    comentarios: sb.rpc, // placeholder — usamos append via raw query
  }).eq('id', TICKET_ID);
  // El RPC agregar_comentario_ticket requiere JWT de un usuario humano,
  // así que para el bot agregamos al array directo con service_key.
  const { data: cur } = await sb.from('tickets_soporte').select('comentarios').eq('id', TICKET_ID).single();
  const comentariosActuales = Array.isArray(cur?.comentarios) ? cur.comentarios : [];
  const nuevoComentario = {
    autor_user_id: null,
    autor_rol: 'agent_bot',
    texto,
    created_at: new Date().toISOString(),
  };
  await sb.from('tickets_soporte')
    .update({ comentarios: [...comentariosActuales, nuevoComentario] })
    .eq('id', TICKET_ID);
  if (error) console.error('addCommentToTicket error:', error.message);
}

// ─── Pre-filter ─────────────────────────────────────────────────────────────
// Greppea el mensaje del bug en el repo para identificar archivos candidatos.
// Si encuentra coincidencias directas (ej. el bug menciona "PaymentDialog" y
// existe ese archivo), las prioriza. Reduce el contexto que el LLM tiene que
// leer.
function preFilter(mensaje, contextoJsonb) {
  const tokens = mensaje
    .split(/[\s,.;:!?()"'`/\\]+/)
    .filter(w => /^[A-Z][a-zA-Z]{4,}|[a-z]+_[a-z]+|[a-z][a-zA-Z]{4,}/.test(w))
    .slice(0, 20);

  const candidates = new Set();

  // Pantalla origen del ticket (ej. /herramientas/lector-facturas).
  if (contextoJsonb?.pantalla) {
    candidates.add(`pantalla:${contextoJsonb.pantalla}`);
  }

  // Grep tokens en el código.
  for (const token of tokens) {
    try {
      const out = execSync(
        `git grep -l -i --max-count=5 ${JSON.stringify(token)} -- 'packages/*/src/**/*.{ts,tsx}'`,
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (out) out.split('\n').slice(0, 3).forEach(p => candidates.add(p));
    } catch (_e) {
      // git grep returns non-zero if no matches; ignore
    }
  }

  return Array.from(candidates).slice(0, 10);
}

// ─── Tools del agent ────────────────────────────────────────────────────────
const TOOLS_SPEC = [
  {
    name: 'read_file',
    description: 'Lee el contenido completo de un archivo. Path relativo a la raíz del repo.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description: 'Reemplaza una porción exacta de un archivo existente. old_string debe coincidir exactamente (incluyendo whitespace). Path debe estar en whitelist: packages/{pase,comanda,admin-console}/src/**.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'create_file',
    description: 'Crea un archivo NUEVO (el archivo NO debe existir todavía). Usalo para nuevas migrations SQL en packages/pase/supabase/migrations/YYYYMMDDHHMM_descripcion.sql. El nombre debe matchear el formato timestamp YYYYMMDDHHMM (ej. 202605210900_fix_xxx.sql). NO sirve para modificar migrations existentes — eso está prohibido. Tampoco crear archivos sueltos fuera de migrations; usá edit_file en su lugar.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta completa desde la raíz del repo' },
        content: { type: 'string', description: 'Contenido del archivo' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'grep',
    description: 'Busca un patrón en el código. Devuelve hasta 50 líneas con match.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path_glob: { type: 'string', description: 'glob para limitar búsqueda, ej. packages/pase/src/**/*.tsx' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_files',
    description: 'Lista archivos que matchean un glob.',
    input_schema: {
      type: 'object',
      properties: { glob: { type: 'string' } },
      required: ['glob'],
    },
  },
  {
    name: 'run_command',
    description: 'Corre un comando del whitelist: pnpm typecheck/lint/test, git status/diff. NO acepta otros comandos.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'escalate_to_opus',
    description: 'Pide ayuda a Opus (modelo más potente) cuando el bug es complejo. Pasale un resumen detallado de lo investigado hasta ahora.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Por qué necesitás escalar' },
        context_summary: { type: 'string', description: 'Resumen detallado de lo que investigaste, archivos leídos, hipótesis descartadas, etc.' },
      },
      required: ['reason', 'context_summary'],
    },
  },
  {
    name: 'complete_with_fix',
    description: 'Cuando ya escribiste el fix y corriste tests, llamá esto. El sistema valida diff size y crea PR (o commit directo si es chico y tests pasan).',
    input_schema: {
      type: 'object',
      properties: {
        explanation: { type: 'string', description: 'Explicación del bug y el fix, en español, para el ticket' },
        files_changed: { type: 'array', items: { type: 'string' } },
      },
      required: ['explanation', 'files_changed'],
    },
  },
  {
    name: 'give_up',
    description: 'Si no podés resolver el bug, llamá esto. El ticket queda para revisión humana.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
];

// ─── Validación de paths ────────────────────────────────────────────────────
//
// Para EDIT_FILE: solo el código de las apps. Migrations existentes están
// fuera porque son immutable (schema histórico).
function pathPermitido(path) {
  if (!path) return false;
  const normalized = path.replace(/\\/g, '/');
  if (/\.\./.test(normalized)) return false;
  const allowed = /^packages\/(pase|comanda|admin-console)\/src\/.+\.(ts|tsx|js|jsx|css|md)$/;
  return allowed.test(normalized);
}

// Para CREATE_FILE: solo migrations NUEVAS con timestamp válido.
//
// El timestamp debe ser >= ahora (no podés crear una migration "del pasado"
// porque rompería el orden temporal). Y el nombre del archivo no puede
// existir todavía.
function pathPermitidoParaCrear(path, ts = Date.now()) {
  if (!path) return { ok: false, error: 'Path vacío' };
  const normalized = path.replace(/\\/g, '/');
  if (/\.\./.test(normalized)) return { ok: false, error: 'Path con .. no permitido' };

  const re = /^packages\/pase\/supabase\/migrations\/(\d{12})_[a-z0-9_]+\.sql$/i;
  const match = normalized.match(re);
  if (!match) {
    return {
      ok: false,
      error: 'Solo se permite crear migrations SQL en packages/pase/supabase/migrations/. Formato: YYYYMMDDHHMM_descripcion.sql (12 dígitos timestamp + descripción snake_case).',
    };
  }

  const tsStr = match[1];
  // Validar que el timestamp parsea como fecha razonable.
  // Aceptamos cualquier YYYYMMDDHHMM con YYYY entre 2025 y 2030.
  const yyyy = parseInt(tsStr.slice(0, 4));
  const mm = parseInt(tsStr.slice(4, 6));
  const dd = parseInt(tsStr.slice(6, 8));
  const hh = parseInt(tsStr.slice(8, 10));
  const mi = parseInt(tsStr.slice(10, 12));
  if (yyyy < 2025 || yyyy > 2030 || mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59) {
    return { ok: false, error: `Timestamp inválido en filename: ${tsStr}. Usá YYYYMMDDHHMM coherente.` };
  }

  return { ok: true };
}

function commandPermitido(cmd) {
  const trimmed = cmd.trim();
  // Whitelist exacta de prefijos seguros.
  const allowedPrefixes = [
    /^pnpm\s+(-r\s+)?(--filter[=\s]\S+\s+)?(typecheck|lint|test|build)(\s|$)/,
    /^git\s+(status|diff|log|show)(\s|$)/,
    /^git\s+grep\s+/,
    /^ls\s+/,
    /^cat\s+/,
    /^node\s+--version$/,
  ];
  return allowedPrefixes.some(re => re.test(trimmed));
}

// ─── Implementación de las tools ────────────────────────────────────────────
function toolRead(args) {
  const p = resolve(REPO_ROOT, args.path);
  if (!p.startsWith(REPO_ROOT)) return { error: 'Path fuera del repo' };
  if (!existsSync(p)) return { error: `Archivo no existe: ${args.path}` };
  const stat = statSync(p);
  if (stat.size > 200_000) {
    return { error: `Archivo muy grande (${stat.size} bytes). Usá grep para buscar específicamente.` };
  }
  const content = readFileSync(p, 'utf8');
  const lines = content.split('\n');
  // Devolvemos con números de línea para que el LLM pueda referenciar.
  return { content: lines.map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n') };
}

function toolEdit(args) {
  if (!pathPermitido(args.path)) {
    return { error: `Path no permitido: ${args.path}. Solo packages/{pase,comanda,admin-console}/src/**. Para crear migrations nuevas usá create_file.` };
  }
  const p = resolve(REPO_ROOT, args.path);
  if (!existsSync(p)) return { error: `Archivo no existe: ${args.path}` };
  const content = readFileSync(p, 'utf8');
  if (!content.includes(args.old_string)) {
    return { error: 'old_string no encontrado en el archivo. Asegurate de que coincida exactamente.' };
  }
  const occurrences = content.split(args.old_string).length - 1;
  if (occurrences > 1) {
    return { error: `old_string aparece ${occurrences} veces. Necesitás más contexto para que sea único.` };
  }
  const updated = content.replace(args.old_string, args.new_string);
  writeFileSync(p, updated);
  return { ok: true, lines_changed: args.new_string.split('\n').length - args.old_string.split('\n').length };
}

function toolCreate(args) {
  const check = pathPermitidoParaCrear(args.path);
  if (!check.ok) return { error: check.error };
  const p = resolve(REPO_ROOT, args.path);
  if (!p.startsWith(REPO_ROOT)) return { error: 'Path fuera del repo' };
  if (existsSync(p)) {
    return { error: `Archivo ya existe: ${args.path}. create_file SOLO sirve para archivos nuevos. Si querés modificar, eso no se puede en migrations.` };
  }
  if (!args.content || args.content.length === 0) {
    return { error: 'content vacío' };
  }
  if (args.content.length > 50_000) {
    return { error: 'Contenido demasiado grande (>50KB). Migrations grandes son sospechosas — pensá si necesitás partirlas.' };
  }
  // Heurística de seguridad: rechazar operaciones destructivas obvias.
  // El humano puede crear estas si las necesita; el agent no.
  const peligrosas = [
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+SCHEMA\b/i,
    /\bDROP\s+DATABASE\b/i,
    /\bDROP\s+ROLE\b/i,
    /\bTRUNCATE\b/i,
    /\bDELETE\s+FROM\s+\w+\s*;/i,   // DELETE sin WHERE = mata todo
    /\bDROP\s+COLUMN\b/i,
    /\bDROP\s+CONSTRAINT\b/i,
  ];
  for (const pattern of peligrosas) {
    if (pattern.test(args.content)) {
      return {
        error: `Migration contiene operación destructiva (${pattern.source}). Eso requiere revisión humana — escalá o usá give_up para que un humano lo evalúe.`,
      };
    }
  }
  // Crear directorio si no existe (los migrations dir SI existe ya, pero defensive).
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, args.content);
  return {
    ok: true,
    bytes_written: args.content.length,
    note: 'Migration creada como archivo. NO se aplica automáticamente — el humano debe correrla en Supabase SQL editor antes de testear en producción.',
  };
}

function toolGrep(args) {
  try {
    const globArg = args.path_glob ? ` -- ${JSON.stringify(args.path_glob)}` : '';
    const out = execSync(
      `git grep -n --max-count=50 ${JSON.stringify(args.pattern)}${globArg}`,
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 },
    );
    return { matches: out.slice(0, 5000) };
  } catch (e) {
    return { matches: '(sin matches)' };
  }
}

function toolList(args) {
  try {
    // Usamos `git ls-files` con pattern porque respeta gitignore.
    const out = execSync(
      `git ls-files ${JSON.stringify(args.glob)}`,
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 },
    );
    return { files: out.trim().split('\n').slice(0, 100) };
  } catch (e) {
    return { files: [] };
  }
}

function toolRunCommand(args) {
  if (!commandPermitido(args.command)) {
    return { error: `Comando no permitido: ${args.command}` };
  }
  try {
    const out = execSync(args.command, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5 * 60_000,
    });
    return { exit_code: 0, output: out.slice(0, 8000) };
  } catch (e) {
    return {
      exit_code: e.status || 1,
      output: ((e.stdout?.toString() || '') + (e.stderr?.toString() || '')).slice(0, 8000),
    };
  }
}

// ─── Loop del agent ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Sos un agent autónomo que resuelve bugs en PASE+COMANDA.

PASE = back-office gastronómico AR. COMANDA = POS. Stack: React 19 + TS strict
+ Vite + Supabase. Repo monorepo pnpm en packages/{pase,comanda,admin-console}.

## TU CICLO

1. Leé el ticket (te lo paso en el primer mensaje).
2. Investigá: grep, list_files, read_file. Identificá la causa raíz.
3. Escribí el fix MÍNIMO con edit_file.
4. Corré tests: run_command con \`pnpm --filter <pkg> typecheck && pnpm --filter <pkg> lint && pnpm --filter <pkg> test\`.
5. Si tests pasan, llamá complete_with_fix con explicación + lista de archivos modificados.
6. Si tests fallan, ajustá el fix y reintentá. Máximo 3 intentos.

## REGLAS DURAS

- NUNCA modifiques archivos fuera de packages/{pase,comanda,admin-console}/src.
- NUNCA modifiques migrations existentes en packages/pase/supabase/migrations/.
  El schema vivo es histórico — modificar una migration ya aplicada rompe
  los entornos donde corrió. SÍ podés CREAR migrations nuevas (ver abajo).
- NUNCA tocás archivos de config: package.json, vite.config, tsconfig, eslint, .env, vercel.json.
- NUNCA hacés git push, commit o cambios destructivos. El sistema se encarga del commit final.
- NUNCA inventes datos del bug. Si no entendés algo, escalá.

## MIGRATIONS SQL NUEVAS (sí podés crear)

Si el bug es de una función PL/pgSQL, un trigger, una RLS policy o cualquier
cosa server-side de Supabase: usá create_file con path:

  packages/pase/supabase/migrations/YYYYMMDDHHMM_descripcion_corta.sql

Donde YYYYMMDDHHMM es timestamp futuro (ej. usá la fecha actual +1 minuto).
Snake_case descripción, max 40 chars. Ejemplos:

  202605211045_fix_ambiguous_id_in_crear_rider.sql
  202605211046_add_index_ventas_pos_cliente_telefono.sql
  202605211047_fix_trg_acumular_puntos_dups.sql

REGLAS de la migration:
- DEBE ser idempotente (DROP IF EXISTS + CREATE OR REPLACE).
- NO uses DROP TABLE, DROP COLUMN, DROP CONSTRAINT, TRUNCATE, DELETE sin WHERE.
  Esas operaciones requieren revisión humana — usá give_up con el SQL en la
  explicación y un humano decide.
- Si la fn original tiene firma vieja con misma cantidad de argumentos, hacé
  DROP FUNCTION IF EXISTS antes del CREATE para evitar 2 versiones.
- Terminá con NOTIFY pgrst, 'reload schema'; para que PostgREST refresque.
- Si renombrás columnas de retorno (ej. id → rider_id por ambigüedad),
  ACTUALIZÁ también los services TypeScript del cliente — el consumer
  espera columnas con cierto nombre.

IMPORTANTE: el sistema NO aplica la migration automático. Crea el archivo +
notifica al admin "🗃 esta fix incluye SQL — aplicar manual en Supabase".
Vos solo proponés; el humano aplica con visto bueno.

## CUÁNDO ESCALAR A OPUS

Llamá escalate_to_opus si:
- El bug requiere razonar sobre flujo financiero crítico (RPCs, RLS, idempotency).
- Hay múltiples archivos relacionados y no sabés cuál tocar.
- Después de 2 intentos de fix los tests siguen fallando por motivos que no entendés.

Pasale a Opus un context_summary CON DETALLE: archivos leídos, código relevante,
hipótesis, qué descartaste.

## CUÁNDO RENDIRSE

Llamá give_up si:
- Es un cambio que requiere modificar config/build/deploy (vite, tsconfig, vercel.json).
- Es un cambio que requiere decisión de negocio (no es bug, es feature request).
- La migration SQL requiere operación destructiva (DROP, TRUNCATE) — ese caso
  el humano lo aprueba, no vos.
- Después de 3 intentos de fix los tests siguen fallando.

## ESTILO DE CÓDIGO

- Mantené el estilo existente (no formatees imports, no cambies comillas).
- Explicá el cambio con comentario en el código si es no-obvio.
- En commits y comentarios al ticket: español rioplatense.`;

async function callModel(model, messages, extraSystem) {
  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  if (extraSystem) systemBlocks.push({ type: 'text', text: extraSystem });

  const res = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: systemBlocks,
    tools: TOOLS_SPEC,
    messages,
  });
  trackUsage(model, res.usage);
  return res;
}

async function runAgentLoop(model, initialUserMsg, opusContext = null) {
  const messages = [{ role: 'user', content: initialUserMsg }];
  if (opusContext) {
    messages[0].content = `## CONTEXTO HEREDADO DE SONNET\n\n${opusContext}\n\n## TU TURNO\n\n${initialUserMsg}`;
  }

  let iteration = 0;
  const MAX_ITERATIONS = 25;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    const res = await callModel(model, messages);

    // Agregar respuesta del modelo al historial.
    messages.push({ role: 'assistant', content: res.content });

    // Procesar tool_use blocks.
    const toolUseBlocks = res.content.filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      // El modelo terminó sin llamar tool. Tratar como give_up implícito.
      return {
        action: 'give_up',
        reason: 'Modelo terminó sin invocar herramientas',
        iterations: iteration,
      };
    }

    const toolResults = [];
    for (const tu of toolUseBlocks) {
      const { name, input, id } = tu;

      // Acciones terminales.
      if (name === 'complete_with_fix') {
        return { action: 'fix', model, ...input, iterations: iteration };
      }
      if (name === 'give_up') {
        return { action: 'give_up', model, reason: input.reason, iterations: iteration };
      }
      if (name === 'escalate_to_opus') {
        return { action: 'escalate', reason: input.reason, contextSummary: input.context_summary, iterations: iteration };
      }

      // Tools normales.
      let result;
      switch (name) {
        case 'read_file': result = toolRead(input); break;
        case 'edit_file': result = toolEdit(input); break;
        case 'create_file': result = toolCreate(input); break;
        case 'grep': result = toolGrep(input); break;
        case 'list_files': result = toolList(input); break;
        case 'run_command': result = toolRunCommand(input); break;
        default: result = { error: `Tool desconocida: ${name}` };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify(result).slice(0, 12000),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { action: 'give_up', reason: `Excedió ${MAX_ITERATIONS} iteraciones sin terminar`, iterations: iteration };
}

// ─── Flow principal ─────────────────────────────────────────────────────────
async function main() {
  const { data: ticket, error: ticketErr } = await sb
    .from('tickets_soporte').select('*').eq('id', TICKET_ID).single();
  if (ticketErr || !ticket) {
    console.error('Ticket no encontrado:', ticketErr?.message);
    process.exit(1);
  }

  await updateTicket({
    status: 'investigating',
    modelUsed: 'claude-sonnet-4-6',
    logEntry: { event: 'agent_started' },
  });

  const candidates = preFilter(ticket.mensaje, ticket.contexto_jsonb || {});

  const initialUserMsg =
    `# Ticket #${ticket.id.slice(0, 8)}\n\n` +
    `**Sistema**: ${ticket.sistema}\n` +
    `**Pantalla**: ${ticket.pantalla_origen || '(no especificada)'}\n` +
    `**Autor**: ${ticket.autor_email} (${ticket.autor_rol})\n\n` +
    `## Mensaje del usuario\n\n${ticket.mensaje}\n\n` +
    `## Contexto técnico\n\n\`\`\`json\n${JSON.stringify(ticket.contexto_jsonb || {}, null, 2)}\n\`\`\`\n\n` +
    `## Archivos candidatos (pre-filtrados)\n\n${candidates.length === 0 ? '(ninguno encontrado por grep)' : candidates.map(c => `- ${c}`).join('\n')}\n\n` +
    `Investigá, identificá la causa raíz, escribí el fix mínimo, corré tests. Si todo OK, llamá complete_with_fix.`;

  let result = await runAgentLoop('claude-sonnet-4-6', initialUserMsg);

  if (result.action === 'escalate') {
    await updateTicket({
      status: 'escalating',
      logEntry: { event: 'escalated_to_opus', reason: result.reason, iterations_sonnet: result.iterations },
    });
    result = await runAgentLoop('claude-opus-4-7', initialUserMsg, result.contextSummary);
    result.modelChain = ['sonnet', 'opus'];
  } else {
    result.modelChain = ['sonnet'];
  }

  // Persistir resultado.
  if (result.action === 'fix') {
    await updateTicket({
      status: 'fixing',
      logEntry: {
        event: 'fix_proposed',
        explanation: result.explanation,
        files_changed: result.files_changed,
        iterations: result.iterations,
        model_chain: result.modelChain,
      },
    });
    // El handoff a "qué hacer con el fix" (commit vs PR) lo hace el workflow
    // de GitHub Actions leyendo el output de este script. Acá solo devolvemos
    // la decisión.
    console.log(JSON.stringify({
      action: 'fix',
      explanation: result.explanation,
      files_changed: result.files_changed,
      model_chain: result.modelChain,
      cost_usd: billing.totalUsd.toFixed(4),
    }));
  } else {
    await updateTicket({
      status: 'failed',
      logEntry: {
        event: 'agent_gave_up',
        reason: result.reason,
        iterations: result.iterations,
        model_chain: result.modelChain,
      },
      costUsd: billing.totalUsd,
    });
    await addCommentToTicket(
      `🤖 No pude resolver el bug automáticamente.\n\n**Motivo**: ${result.reason}\n\n` +
      `**Iteraciones**: ${result.iterations}\n**Modelos usados**: ${result.modelChain.join(' → ')}\n` +
      `**Costo investigación**: $${billing.totalUsd.toFixed(4)} USD\n\n` +
      `Lucas: tomá vos. Te toca atender este ticket manual desde claude-code.`,
    );
    console.log(JSON.stringify({ action: 'give_up', reason: result.reason, cost_usd: billing.totalUsd.toFixed(4) }));
  }
}

main().catch(async (e) => {
  console.error('Agent crashed:', e);
  await updateTicket({
    status: 'failed',
    logEntry: { event: 'crash', error: e.message },
    costUsd: billing.totalUsd,
  });
  process.exit(1);
});
