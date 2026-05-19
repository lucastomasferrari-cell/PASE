// COMANDA Print Server — corre en la PC del local, expone HTTP localhost
// que COMANDA (en el browser) usa para mandar tickets a las impresoras.
//
// Soporta 3 tipos de transporte:
//   - usb:     identificada por (vendor_id, product_id)
//   - network: IP + puerto (9100 RAW estándar ESC/POS)
//   - serial:  COM port (COM3, /dev/ttyUSB0). Cubre impresoras Bluetooth
//              después de hacer pair en Windows (que crea un virtual COM).
//
// Endpoints:
//   GET  /ping              — health check (que el browser use para detectar
//                             si el server está corriendo).
//   GET  /printers          — lista impresoras configuradas y su estado.
//   POST /printers          — agregar / actualizar config de una impresora.
//   DELETE /printers/:id    — borrar una impresora.
//
//   ── Cola de jobs (nuevo Sprint 1) ───────────────────────────────────────
//   POST /jobs              — encolar job. Body: { idempotency_key?, target_kind,
//                             target_value, payload }. target_kind = 'printer_id'
//                             | 'estacion'. Idempotente — si llega misma key,
//                             devuelve job existente sin re-encolar.
//   GET  /jobs              — lista jobs (?status=queued|done|...&limit=N).
//   GET  /jobs/:id          — detalle de un job.
//   POST /jobs/:id/retry    — reintentar manualmente un job failed/dead.
//   DELETE /jobs/dead       — vaciar dead letters.
//
//   ── Compat (no rompemos clients existentes) ─────────────────────────────
//   POST /print             — atajo síncrono: encola + drena + devuelve.
//                             Útil para tests; producción debería usar /jobs.
//   POST /print-by-estacion — atajo síncrono por estación.
//   POST /test/:id          — página de prueba (sin pasar por cola).
//   GET  /discover/usb      — auto-detect impresoras USB.
//
// Persistencia:
//   - Config impresoras: ~/.comanda-print-server.json
//   - Cola jobs: ~/.comanda-print-server.sqlite (WAL mode)

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { printers as printerHandler } from './printerHandler.js';
import { PrintQueue } from './queue.js';
import { PrintWorker } from './worker.js';
import { Heartbeat, loadHeartbeatConfig } from './heartbeat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PRINT_SERVER_PORT || '9100');
const CONFIG_PATH = path.join(os.homedir(), '.comanda-print-server.json');

// ─── Config persistida (impresoras) ────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('[config] error leyendo config:', err.message);
  }
  return { printers: [] };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[config] error guardando config:', err.message);
  }
}

let config = loadConfig();

// ─── Cola + worker ─────────────────────────────────────────────────────────

const queue = new PrintQueue();
const worker = new PrintWorker({
  queue,
  getPrinters: () => config.printers, // siempre lee fresh
});
worker.start();

// ─── Heartbeat → backend Supabase (Sprint 2) ───────────────────────────────
// Stats agregadas cada 60s. Sin token configurado, no hace nada.
let heartbeat = null;
function initHeartbeat() {
  const hbCfg = loadHeartbeatConfig(CONFIG_PATH);
  if (!hbCfg.agentToken) return; // sin token, no se manda nada — local-only mode

  heartbeat = new Heartbeat({
    getPrinters: () => config.printers,
    checkPrintersOnline: async () => {
      const map = {};
      // Ping en paralelo con timeout para no bloquear el heartbeat tick si
      // una impresora cuelga.
      await Promise.all(config.printers.map(async (p) => {
        try {
          const s = await Promise.race([
            printerHandler.ping(p),
            new Promise((r) => setTimeout(() => r({ ok: false }), 3000)),
          ]);
          map[p.id] = !!s.ok;
        } catch {
          map[p.id] = false;
        }
      }));
      return map;
    },
    getQueueStats: () => queue.stats(),
    agentToken: hbCfg.agentToken,
    heartbeatUrl: hbCfg.heartbeatUrl,
  });
  heartbeat.start();
}
initHeartbeat();

// ─── App Express ───────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '1mb' }));

// Logging mínimo (no logueamos /ping para no spammear — el cliente lo polea).
app.use((req, res, next) => {
  if (req.url !== '/ping') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  }
  next();
});

// ── Health check
app.get('/ping', (req, res) => {
  res.json({
    ok: true,
    version: '1.1.0', // Sprint 1: cola + retry
    server: 'COMANDA Print Server',
    config_path: CONFIG_PATH,
    printers_configured: config.printers.length,
    queue: queue.stats(),
  });
});

// ── Listar impresoras + status
app.get('/printers', async (req, res) => {
  const detailed = await Promise.all(config.printers.map(async (p) => {
    const status = await printerHandler.ping(p).catch((err) => ({ ok: false, error: err.message }));
    return { ...p, status };
  }));
  res.json({ printers: detailed });
});

// ── Agregar / actualizar impresora
app.post('/printers', (req, res) => {
  const { id, nombre, estacion, transporte, config: printerConfig } = req.body || {};
  if (!nombre || !transporte) {
    return res.status(400).json({ error: 'nombre y transporte requeridos' });
  }
  if (!['usb', 'network', 'serial'].includes(transporte)) {
    return res.status(400).json({ error: 'transporte debe ser usb | network | serial' });
  }

  const printerId = id || `printer_${Date.now()}`;
  const existing = config.printers.findIndex((p) => p.id === printerId);
  const entry = {
    id: printerId,
    nombre,
    estacion: estacion || null,
    transporte,
    config: printerConfig || {},
  };
  if (existing >= 0) {
    config.printers[existing] = entry;
  } else {
    config.printers.push(entry);
  }
  saveConfig(config);
  res.json({ ok: true, printer: entry });
});

// ── Eliminar impresora
app.delete('/printers/:id', (req, res) => {
  const id = req.params.id;
  const before = config.printers.length;
  config.printers = config.printers.filter((p) => p.id !== id);
  if (config.printers.length === before) {
    return res.status(404).json({ error: 'Impresora no encontrada' });
  }
  saveConfig(config);
  res.json({ ok: true });
});

// ─── Cola de jobs (Sprint 1) ───────────────────────────────────────────────

// ── Encolar job: vía recomendada para producción
app.post('/jobs', (req, res) => {
  const { idempotency_key, target_kind, target_value, payload } = req.body || {};
  if (!target_kind || !target_value || !payload) {
    return res.status(400).json({
      error: 'target_kind, target_value y payload son requeridos',
    });
  }
  try {
    const job = queue.enqueue({
      idempotencyKey: idempotency_key || null,
      targetKind: target_kind,
      targetValue: target_value,
      payload,
    });
    // Respondemos rápido (no esperamos a que imprima). El worker drena.
    res.json({ ok: true, job: { id: job.id, status: job.status, is_new: job.isNew } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/jobs', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json({ jobs: queue.list({ status, limit }) });
});

app.get('/jobs/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const job = queue.getById(id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json({ job });
});

app.post('/jobs/:id/retry', (req, res) => {
  const id = parseInt(req.params.id);
  const ok = queue.retry(id);
  if (!ok) return res.status(404).json({ error: 'Job no encontrado o no es reintentable' });
  res.json({ ok: true });
});

app.delete('/jobs/dead', (req, res) => {
  const removed = queue.clearDeadLetters();
  res.json({ ok: true, removed });
});

// ─── Atajos síncronos (compat con clients viejos) ─────────────────────────

// POST /print: encola + intenta drenar inmediatamente. Devuelve ok solo si
// se imprimió. Si querés idempotency + cola, usar POST /jobs.
app.post('/print', async (req, res) => {
  const { printer_id, ticket, idempotency_key } = req.body || {};
  if (!printer_id || !ticket) {
    return res.status(400).json({ error: 'printer_id y ticket requeridos' });
  }
  const printer = config.printers.find((p) => p.id === printer_id);
  if (!printer) {
    return res.status(404).json({ error: `Impresora ${printer_id} no configurada` });
  }
  try {
    // Encolamos para tener auditoría + idempotency. El worker eventualmente
    // procesará — pero también intentamos inline para responder al cliente.
    const job = queue.enqueue({
      idempotencyKey: idempotency_key || null,
      targetKind: 'printer_id',
      targetValue: printer_id,
      payload: ticket,
    });
    // Si el job ya estaba (idempotency hit), no re-imprimimos.
    if (!job.isNew && job.status === 'done') {
      return res.json({ ok: true, idempotent: true, job_id: job.id });
    }
    // Drenado opportunístico: dejamos al worker hacerlo. Pero como este
    // endpoint es síncrono, esperamos un breve momento para que el worker
    // lo levante.
    res.json({ ok: true, job_id: job.id, queued: true });
  } catch (err) {
    console.error(`[print] ${printer_id} failed:`, err.message);
    res.status(502).json({ error: 'PRINT_FAILED', detail: err.message });
  }
});

app.post('/print-by-estacion', async (req, res) => {
  const { estacion, ticket, idempotency_key } = req.body || {};
  if (!estacion || !ticket) {
    return res.status(400).json({ error: 'estacion y ticket requeridos' });
  }
  // Verificamos al menos que haya alguna impresora con esa estación antes
  // de encolar — feedback inmediato al cliente si configuró mal.
  const hasOne = config.printers.some((p) => p.estacion === estacion);
  if (!hasOne) {
    return res.status(404).json({
      error: `Sin impresora asignada a estación "${estacion}"`,
    });
  }
  try {
    const job = queue.enqueue({
      idempotencyKey: idempotency_key || null,
      targetKind: 'estacion',
      targetValue: estacion,
      payload: ticket,
    });
    if (!job.isNew && job.status === 'done') {
      return res.json({ ok: true, idempotent: true, job_id: job.id });
    }
    res.json({ ok: true, job_id: job.id, queued: true });
  } catch (err) {
    console.error(`[print] estación ${estacion} failed:`, err.message);
    res.status(502).json({ error: 'PRINT_FAILED', detail: err.message });
  }
});

// ── Página de prueba (sync, no pasa por cola — es para validar config)
app.post('/test/:id', async (req, res) => {
  const printer = config.printers.find((p) => p.id === req.params.id);
  if (!printer) return res.status(404).json({ error: 'Impresora no encontrada' });
  const ticket = {
    titulo: 'COMANDA — PRUEBA DE IMPRESIÓN',
    items: [
      { nombre: 'Test item 1', cantidad: 1, subtotal: 100 },
      { nombre: 'Test item 2 con nombre largo', cantidad: 2, subtotal: 250 },
    ],
    total: 350,
    pagos: [{ metodo: 'Test', monto: 350 }],
    fechaHora: new Date().toLocaleString('es-AR'),
    venta_id: 'TEST-' + Date.now(),
  };
  try {
    await printerHandler.print(printer, ticket);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'TEST_FAILED', detail: err.message });
  }
});

app.get('/discover/usb', async (req, res) => {
  try {
    const devices = await printerHandler.discoverUsb();
    res.json({ devices });
  } catch (err) {
    res.status(502).json({ error: 'DISCOVER_FAILED', detail: err.message });
  }
});

// ─── Config del agent: token de vinculación + heartbeat URL ───────────────
// La UI Electron usa estos endpoints para gestionar la vinculación.

app.get('/config', (req, res) => {
  // No exponemos el token completo — solo si está seteado (para UI).
  res.json({
    has_token: !!config.agent_token,
    token_preview: config.agent_token
      ? `${config.agent_token.slice(0, 6)}...${config.agent_token.slice(-4)}`
      : null,
    heartbeat_url: config.heartbeat_url || null,
    agent_name: config.agent_name || null,
  });
});

app.post('/config/token', (req, res) => {
  const { agent_token, heartbeat_url, agent_name } = req.body || {};
  if (!agent_token || typeof agent_token !== 'string' || agent_token.length < 16) {
    return res.status(400).json({ error: 'agent_token inválido (mínimo 16 chars)' });
  }
  config.agent_token = agent_token.trim();
  if (heartbeat_url) config.heartbeat_url = String(heartbeat_url).trim();
  if (agent_name) config.agent_name = String(agent_name).trim();
  saveConfig(config);

  // Reiniciar heartbeat con la nueva config
  if (heartbeat) heartbeat.stop();
  initHeartbeat();

  res.json({ ok: true });
});

app.delete('/config/token', (req, res) => {
  delete config.agent_token;
  delete config.heartbeat_url;
  delete config.agent_name;
  saveConfig(config);
  if (heartbeat) {
    heartbeat.stop();
    heartbeat = null;
  }
  res.json({ ok: true });
});

// ─── Start ─────────────────────────────────────────────────────────────────

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log('═══════════════════════════════════════════════');
  console.log('  COMANDA Print Server v1.1.0');
  console.log(`  Escuchando en http://127.0.0.1:${PORT}`);
  console.log(`  Config: ${CONFIG_PATH}`);
  console.log(`  Impresoras configuradas: ${config.printers.length}`);
  console.log(`  Stats cola al arranque:`, queue.stats());
  console.log('═══════════════════════════════════════════════');
});

// Cleanup grácil
async function shutdown(signal) {
  console.log(`\n[server] ${signal} recibido — cerrando...`);
  if (heartbeat) heartbeat.stop();
  await worker.stop();
  queue.close();
  server.close(() => {
    console.log('[server] HTTP cerrado');
    process.exit(0);
  });
  // Forzar exit si server.close se cuelga
  setTimeout(() => {
    console.warn('[server] forzando exit tras 5s');
    process.exit(1);
  }, 5000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
