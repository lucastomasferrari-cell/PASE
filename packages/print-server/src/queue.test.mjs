// Test stand-alone de PrintQueue. Corre con: node src/queue.test.mjs
// No usa vitest porque print-server vive aislado del monorepo de COMANDA.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrintQueue } from './queue.js';

const TEST_DB = path.join(os.tmpdir(), `print-queue-test-${Date.now()}.sqlite`);
let passed = 0;
let failed = 0;

function ok(name) { console.log(`  ✓ ${name}`); passed++; }
function ko(name, err) { console.error(`  ✗ ${name}: ${err}`); failed++; }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function run() {
  // ── 1. enqueue básico
  let q = new PrintQueue(TEST_DB);
  try {
    const j = q.enqueue({
      idempotencyKey: 'idem-1',
      targetKind: 'printer_id',
      targetValue: 'p1',
      payload: { titulo: 'Hello' },
    });
    assert(j.id > 0, 'job sin id');
    assert(j.status === 'queued', `status era ${j.status}`);
    assert(j.isNew === true, 'isNew should be true');
    assert(deepEq(j.payload, { titulo: 'Hello' }), 'payload mismatch');
    ok('enqueue básico');
  } catch (e) { ko('enqueue básico', e.message); }

  // ── 2. idempotency: misma key, no duplica
  try {
    const j1 = q.enqueue({
      idempotencyKey: 'idem-2',
      targetKind: 'printer_id', targetValue: 'p1',
      payload: { titulo: 'A' },
    });
    const j2 = q.enqueue({
      idempotencyKey: 'idem-2',
      targetKind: 'printer_id', targetValue: 'p1',
      payload: { titulo: 'B (debería ignorarse)' },
    });
    assert(j1.id === j2.id, 'IDs no matchean');
    assert(j2.isNew === false, 'isNew debería ser false');
    assert(j2.payload.titulo === 'A', 'payload original perdido');
    ok('idempotency dedupe');
  } catch (e) { ko('idempotency dedupe', e.message); }

  // ── 3. pickNext respeta orden de creación
  try {
    q.enqueue({ idempotencyKey: 'k3a', targetKind: 'printer_id', targetValue: 'p1', payload: { x: 1 } });
    q.enqueue({ idempotencyKey: 'k3b', targetKind: 'printer_id', targetValue: 'p1', payload: { x: 2 } });
    const first = q.pickNext();
    assert(first.idempotency_key === 'idem-1', `era ${first.idempotency_key}`);
    assert(first.status === 'printing', `status era ${first.status}`);
    ok('pickNext orden FIFO');
  } catch (e) { ko('pickNext orden FIFO', e.message); }

  // ── 4. pickNext no devuelve mismo job 2 veces (atomicidad)
  try {
    const first = q.pickNext(); // 'idem-2'
    assert(first.idempotency_key === 'idem-2');
    const second = q.pickNext();
    assert(second.idempotency_key === 'k3a', `era ${second.idempotency_key}`);
    ok('pickNext atómico (no duplicado)');
  } catch (e) { ko('pickNext atómico', e.message); }

  // ── 5. markDone
  try {
    const job = q.pickNext(); // k3b
    q.markDone(job.id);
    const after = q.getById(job.id);
    assert(after.status === 'done');
    assert(after.printed_at != null);
    ok('markDone');
  } catch (e) { ko('markDone', e.message); }

  // ── 6. pickNext devuelve null si vacío
  try {
    const n = q.pickNext();
    assert(n === null, `esperaba null, recibí ${JSON.stringify(n)}`);
    ok('pickNext vacío devuelve null');
  } catch (e) { ko('pickNext vacío', e.message); }

  // ── 7. markFailed con retry exponencial
  try {
    // Limpio y empiezo de cero
    q.close();
    fs.unlinkSync(TEST_DB);
    q = new PrintQueue(TEST_DB);

    const j = q.enqueue({
      idempotencyKey: 'fail-1',
      targetKind: 'printer_id', targetValue: 'p1',
      payload: { x: 1 },
    });
    q.pickNext(); // marca printing
    const r1 = q.markFailed(j.id, 'timeout USB');
    assert(r1.status === 'queued', `status: ${r1.status}`);
    assert(r1.attempts === 1);
    assert(r1.next_retry_at > Date.now(), 'next_retry_at debería ser futuro');
    // Tras 1 intento, backoff debe ser ~2s (con jitter ±20%)
    const delta = r1.next_retry_at - Date.now();
    assert(delta >= 1500 && delta <= 2600, `delta ${delta}ms fuera de rango`);
    ok('markFailed retry con backoff');
  } catch (e) { ko('markFailed retry', e.message); }

  // ── 8. pickNext respeta next_retry_at (no devuelve un job que no es hora)
  try {
    const n = q.pickNext();
    assert(n === null, 'no debería estar listo el job en retry');
    ok('pickNext respeta next_retry_at');
  } catch (e) { ko('pickNext respeta next_retry_at', e.message); }

  // ── 9. Después de MAX_ATTEMPTS → dead_letter
  try {
    // Force-set attempts a 9 simulando 9 fallos previos.
    q.db.prepare(`UPDATE jobs SET attempts=9, next_retry_at=? WHERE idempotency_key='fail-1'`)
      .run(Date.now());
    const job = q.pickNext();
    assert(job, 'debería haber job');
    const r = q.markFailed(job.id, 'enésima vez');
    assert(r.status === 'dead_letter', `status: ${r.status}`);
    assert(r.attempts === 10);
    ok('dead_letter después de MAX_ATTEMPTS');
  } catch (e) { ko('dead_letter', e.message); }

  // ── 10. retry manual
  try {
    const dead = q.list({ status: 'dead_letter' });
    assert(dead.length === 1);
    const ok1 = q.retry(dead[0].id);
    assert(ok1);
    const after = q.getById(dead[0].id);
    assert(after.status === 'queued');
    assert(after.attempts === 0);
    ok('retry manual resetea attempts');
  } catch (e) { ko('retry manual', e.message); }

  // ── 11. clearDeadLetters
  try {
    // Forzar un dead
    q.db.prepare(`UPDATE jobs SET status='dead_letter' WHERE idempotency_key='fail-1'`).run();
    const removed = q.clearDeadLetters();
    assert(removed === 1, `removed: ${removed}`);
    ok('clearDeadLetters');
  } catch (e) { ko('clearDeadLetters', e.message); }

  // ── 12. stats
  try {
    q.enqueue({ idempotencyKey: 's1', targetKind: 'printer_id', targetValue: 'p1', payload: {} });
    q.enqueue({ idempotencyKey: 's2', targetKind: 'printer_id', targetValue: 'p1', payload: {} });
    const s = q.stats();
    assert(s.queued >= 2, `queued: ${s.queued}`);
    ok('stats');
  } catch (e) { ko('stats', e.message); }

  // ── 13. recovery boot: jobs huérfanos 'printing' → 'queued'
  try {
    q.db.prepare(`UPDATE jobs SET status='printing' WHERE idempotency_key='s1'`).run();
    q.close();
    // Re-abrir: el constructor resetea printing huérfanos
    q = new PrintQueue(TEST_DB);
    const job = q.list({ status: 'queued' }).find((j) => j.idempotency_key === 's1');
    assert(job, 's1 debería haber vuelto a queued');
    ok('recovery boot reset huérfanos');
  } catch (e) { ko('recovery boot', e.message); }

  q.close();
  fs.unlinkSync(TEST_DB);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
