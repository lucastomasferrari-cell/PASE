// worker.js — drena la cola y manda jobs a la impresora.
//
// Política:
//   - Drena cada DRAIN_INTERVAL_MS (500ms default). Suficientemente rápido
//     para que el cliente perciba inmediato sin saturar SQLite.
//   - Procesa de a 1 job (no paralelo). Las impresoras térmicas no aguantan
//     bien comandos concurrentes — mejor secuencial.
//   - Si printerHandler.print() lanza, markFailed con backoff. Después de
//     MAX_ATTEMPTS → dead_letter.
//   - Loop graceful: SIGINT espera al job en curso a terminar antes de salir.

import { printers as printerHandler } from './printerHandler.js';

const DRAIN_INTERVAL_MS = 500;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1h
const STATUS_LOG_INTERVAL_MS = 30 * 1000; // log stats cada 30s

export class PrintWorker {
  /**
   * @param {object} args
   * @param {import('./queue.js').PrintQueue} args.queue
   * @param {() => Array<object>} args.getPrinters
   *        callback que devuelve la lista de impresoras configuradas. Lo
   *        recibimos como fn (no array) para que el worker siempre vea la
   *        config fresca después de un /printers POST.
   */
  constructor({ queue, getPrinters }) {
    this.queue = queue;
    this.getPrinters = getPrinters;
    this._running = false;
    this._drainTimer = null;
    this._pruneTimer = null;
    this._statusTimer = null;
    this._stopping = false;
    this._currentJobId = null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    console.log('[worker] arrancando — drain cada', DRAIN_INTERVAL_MS, 'ms');
    this._scheduleDrain();
    this._scheduleStatusLog();
    this._schedulePrune();
  }

  async stop() {
    this._stopping = true;
    if (this._drainTimer) clearTimeout(this._drainTimer);
    if (this._pruneTimer) clearInterval(this._pruneTimer);
    if (this._statusTimer) clearInterval(this._statusTimer);
    // Si hay un job en vuelo, esperarlo (máx 30s)
    const start = Date.now();
    while (this._currentJobId !== null && Date.now() - start < 30_000) {
      await sleep(100);
    }
    this._running = false;
    console.log('[worker] detenido');
  }

  _scheduleDrain() {
    if (this._stopping) return;
    this._drainTimer = setTimeout(async () => {
      try {
        await this._drainOne();
      } catch (err) {
        console.error('[worker] drain error inesperado:', err.message);
      }
      this._scheduleDrain();
    }, DRAIN_INTERVAL_MS);
  }

  _scheduleStatusLog() {
    this._statusTimer = setInterval(() => {
      const s = this.queue.stats();
      // Solo logear si hay actividad relevante para no spammear consola.
      if (s.queued + s.printing + s.failed + s.dead_letter > 0) {
        console.log('[worker] stats:', s);
      }
    }, STATUS_LOG_INTERVAL_MS);
  }

  _schedulePrune() {
    this._pruneTimer = setInterval(() => {
      const removed = this.queue.pruneOldDone();
      if (removed > 0) console.log('[worker] prune: borrados', removed, 'jobs done viejos');
    }, PRUNE_INTERVAL_MS);
  }

  async _drainOne() {
    const job = this.queue.pickNext();
    if (!job) return;
    this._currentJobId = job.id;
    try {
      const printer = this._resolvePrinter(job);
      if (!printer) {
        // Sin impresora asignada/configurada → falla, irá a retry.
        const reason = job.target_kind === 'estacion'
          ? `Sin impresora asignada a estación "${job.target_value}"`
          : `Impresora ${job.target_value} no encontrada`;
        const result = this.queue.markFailed(job.id, reason);
        console.warn(`[worker] job ${job.id} sin impresora — ${result?.status}`);
        return;
      }

      await printerHandler.print(printer, job.payload);
      this.queue.markDone(job.id);
      console.log(`[worker] job ${job.id} impreso OK en "${printer.nombre}"`);
    } catch (err) {
      const result = this.queue.markFailed(job.id, err.message);
      const tag = result?.status === 'dead_letter' ? 'DEAD' : `retry${result?.attempts}`;
      console.warn(`[worker] job ${job.id} FAILED (${tag}): ${err.message}`);
    } finally {
      this._currentJobId = null;
    }
  }

  _resolvePrinter(job) {
    const printers = this.getPrinters();
    if (job.target_kind === 'printer_id') {
      return printers.find((p) => p.id === job.target_value);
    }
    // estacion — matcheamos por array nuevo o campo legacy.
    // Si múltiples impresoras cubren la misma estación, agarra la primera
    // (típicamente esto no pasa; el usuario asigna 1 impresora por estación).
    return printers.find((p) =>
      (Array.isArray(p.estaciones) && p.estaciones.includes(job.target_value)) ||
      p.estacion === job.target_value,
    );
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
