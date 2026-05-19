// queue.js — cola persistente de print jobs con SQLite.
//
// Por qué SQLite (y no memoria + retry):
//   - Si la PC se reinicia a mitad de servicio, la cola sobrevive.
//   - Si la impresora está apagada, los jobs quedan en `queued` hasta que
//     vuelva. No se pierde una comanda.
//   - Idempotency keys persistidas: doble click del browser no genera 2
//     impresiones aunque la primera tarde 10s.
//
// Schema:
//   jobs(
//     id            INTEGER PK
//     idempotency_key TEXT UNIQUE NULL  -- evita duplicados
//     target_kind   TEXT  -- 'printer_id' | 'estacion'
//     target_value  TEXT
//     payload       TEXT  -- JSON del ticket
//     status        TEXT  -- queued | printing | done | failed | dead_letter
//     attempts      INTEGER DEFAULT 0
//     last_error    TEXT NULL
//     next_retry_at INTEGER NULL  -- epoch ms
//     created_at    INTEGER  -- epoch ms
//     updated_at    INTEGER
//     printed_at    INTEGER NULL
//   )
//
// Estados:
//   queued      → esperando turno. next_retry_at <= now() significa "listo".
//   printing    → worker lo levantó. Si pasa >30s sin transicionar, asumimos
//                 muerto y lo reseteamos a queued (recovery on boot).
//   done        → impreso OK. Se mantiene en DB para auditoría 7 días.
//   failed      → intento puntual falló, espera reintento.
//   dead_letter → falló N veces. No se reintenta más. Visible en UI para
//                 que el comerciante reimprima manualmente.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DB_PATH = process.env.PRINT_SERVER_DB_PATH
  || path.join(os.homedir(), '.comanda-print-server.sqlite');

const MAX_ATTEMPTS = 10;

// Backoff exponencial con jitter. Cap a 5min.
// attempts: 0→1s, 1→2s, 2→5s, 3→15s, 4→60s, 5+→300s
const BACKOFF_SECONDS = [1, 2, 5, 15, 60, 300, 300, 300, 300, 300];

function backoffMs(attempts) {
  const base = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length - 1)] * 1000;
  // Jitter ±20% para evitar thundering herd si se reintenta 10 jobs juntos.
  const jitter = base * (Math.random() * 0.4 - 0.2);
  return Math.floor(base + jitter);
}

export class PrintQueue {
  constructor(dbPath = DB_PATH) {
    // Asegurar dir
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL'); // mejor para concurrencia
    this.db.pragma('synchronous = NORMAL');
    this._initSchema();
    this._prepareStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        target_kind     TEXT NOT NULL CHECK(target_kind IN ('printer_id','estacion')),
        target_value    TEXT NOT NULL,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'queued'
                        CHECK(status IN ('queued','printing','done','failed','dead_letter')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        next_retry_at   INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        printed_at      INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_retry
        ON jobs(status, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_created
        ON jobs(created_at);
    `);

    // Migración soft: si en una versión vieja alguien encoló y dejó 'printing'
    // huérfanos, los reseteamos a queued al boot.
    const recovered = this.db.prepare(
      `UPDATE jobs SET status='queued', updated_at=?
       WHERE status='printing'`
    ).run(Date.now());
    if (recovered.changes > 0) {
      console.log(`[queue] Reset ${recovered.changes} jobs huérfanos 'printing' → 'queued'`);
    }
  }

  _prepareStatements() {
    this.stmts = {
      findByKey: this.db.prepare(
        `SELECT * FROM jobs WHERE idempotency_key = ? LIMIT 1`
      ),
      insertJob: this.db.prepare(`
        INSERT INTO jobs (
          idempotency_key, target_kind, target_value, payload,
          status, next_retry_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
      `),
      pickNext: this.db.prepare(`
        SELECT * FROM jobs
        WHERE status='queued' AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY created_at ASC
        LIMIT 1
      `),
      markPrinting: this.db.prepare(
        `UPDATE jobs SET status='printing', updated_at=? WHERE id=? AND status='queued'`
      ),
      markDone: this.db.prepare(
        `UPDATE jobs SET status='done', updated_at=?, printed_at=?, last_error=NULL WHERE id=?`
      ),
      markFailedRetry: this.db.prepare(`
        UPDATE jobs
        SET status='queued', attempts=attempts+1, last_error=?, next_retry_at=?, updated_at=?
        WHERE id=?
      `),
      markDeadLetter: this.db.prepare(`
        UPDATE jobs
        SET status='dead_letter', attempts=attempts+1, last_error=?, updated_at=?
        WHERE id=?
      `),
      list: this.db.prepare(`
        SELECT * FROM jobs
        WHERE (? IS NULL OR status=?)
        ORDER BY created_at DESC
        LIMIT ?
      `),
      getById: this.db.prepare(`SELECT * FROM jobs WHERE id=?`),
      retry: this.db.prepare(`
        UPDATE jobs
        SET status='queued', attempts=0, last_error=NULL, next_retry_at=?, updated_at=?
        WHERE id=? AND status IN ('failed','dead_letter','done')
      `),
      deleteDead: this.db.prepare(`DELETE FROM jobs WHERE status='dead_letter'`),
      countByStatus: this.db.prepare(
        `SELECT status, COUNT(*) as c FROM jobs GROUP BY status`
      ),
      pruneOldDone: this.db.prepare(`
        DELETE FROM jobs
        WHERE status='done' AND printed_at < ?
      `),
    };
  }

  /**
   * Encola un job. Si llega con idempotency_key existente, devuelve el job
   * existente SIN re-encolar (idempotency real).
   * @returns {{ id, idempotency_key, status, attempts, isNew }}
   */
  enqueue({ idempotencyKey, targetKind, targetValue, payload }) {
    if (!['printer_id', 'estacion'].includes(targetKind)) {
      throw new Error(`targetKind debe ser 'printer_id' o 'estacion', recibí: ${targetKind}`);
    }
    if (!targetValue || !payload) {
      throw new Error('targetValue y payload son requeridos');
    }

    const now = Date.now();
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

    // Idempotency: si llega misma key, devolver job existente sin duplicar.
    if (idempotencyKey) {
      const existing = this.stmts.findByKey.get(idempotencyKey);
      if (existing) {
        return { ...this._hydrate(existing), isNew: false };
      }
    }

    const result = this.stmts.insertJob.run(
      idempotencyKey ?? null,
      targetKind,
      targetValue,
      payloadStr,
      now, // next_retry_at = now (listo para drenar ya)
      now,
      now,
    );

    const job = this.stmts.getById.get(result.lastInsertRowid);
    return { ...this._hydrate(job), isNew: true };
  }

  /**
   * Levanta el siguiente job listo para imprimir. Lo marca como 'printing'
   * atómicamente. Devuelve null si la cola está vacía o todos esperan retry.
   */
  pickNext() {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const job = this.stmts.pickNext.get(now);
      if (!job) return null;
      // Verifica que sigue queued (por si otro worker lo levantó — defensivo)
      const updated = this.stmts.markPrinting.run(Date.now(), job.id);
      if (updated.changes === 0) return null;
      // Re-leemos para reflejar el status actualizado en el objeto devuelto.
      return this.stmts.getById.get(job.id);
    });
    const result = tx();
    return result ? this._hydrate(result) : null;
  }

  markDone(id) {
    const now = Date.now();
    this.stmts.markDone.run(now, now, id);
  }

  /**
   * Marca el job como fallido. Si attempts+1 >= MAX_ATTEMPTS, va a dead_letter.
   * Sino, calcula next_retry_at y vuelve a 'queued'.
   */
  markFailed(id, errorMsg) {
    const job = this.stmts.getById.get(id);
    if (!job) return;
    const nextAttempts = (job.attempts || 0) + 1;
    const now = Date.now();
    const errText = String(errorMsg || '').slice(0, 1000);

    if (nextAttempts >= MAX_ATTEMPTS) {
      this.stmts.markDeadLetter.run(errText, now, id);
      return { status: 'dead_letter', attempts: nextAttempts };
    }

    const retryAt = now + backoffMs(nextAttempts);
    this.stmts.markFailedRetry.run(errText, retryAt, now, id);
    return { status: 'queued', attempts: nextAttempts, next_retry_at: retryAt };
  }

  list({ status = null, limit = 100 } = {}) {
    const rows = this.stmts.list.all(status, status, limit);
    return rows.map((r) => this._hydrate(r));
  }

  getById(id) {
    const row = this.stmts.getById.get(id);
    return row ? this._hydrate(row) : null;
  }

  /** Reintentar manualmente un job (lo vuelve a queued con attempts=0). */
  retry(id) {
    const now = Date.now();
    const result = this.stmts.retry.run(now, now, id);
    return result.changes > 0;
  }

  /** Borrar todos los dead letters (acción explícita del usuario). */
  clearDeadLetters() {
    const result = this.stmts.deleteDead.run();
    return result.changes;
  }

  /** Stats para heartbeat + UI. */
  stats() {
    const rows = this.stmts.countByStatus.all();
    const out = { queued: 0, printing: 0, done: 0, failed: 0, dead_letter: 0 };
    for (const r of rows) out[r.status] = r.c;
    return out;
  }

  /** Limpiar jobs `done` viejos (auditoría 7 días). */
  pruneOldDone(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - olderThanMs;
    const result = this.stmts.pruneOldDone.run(cutoff);
    return result.changes;
  }

  _hydrate(row) {
    if (!row) return row;
    return {
      id: row.id,
      idempotency_key: row.idempotency_key,
      target_kind: row.target_kind,
      target_value: row.target_value,
      payload: typeof row.payload === 'string' ? safeParse(row.payload) : row.payload,
      status: row.status,
      attempts: row.attempts,
      last_error: row.last_error,
      next_retry_at: row.next_retry_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      printed_at: row.printed_at,
    };
  }

  close() {
    this.db.close();
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}
