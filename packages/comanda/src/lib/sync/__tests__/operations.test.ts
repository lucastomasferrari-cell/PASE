// Tests del módulo operations (cola de PendingOps).
//
// Validamos: enqueue genera UUID + persiste, listPendingOps ordena FIFO,
// markSynced/markFailed transicionan correcto, backoff exponencial sube
// con cada retry.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  enqueueOperation, listPendingOps, markSyncing, markSynced, markFailed,
  pendingCount, failedCount, backoffMs, cleanupOldSynced, resetSyncingOpsAtBoot,
} from '../operations';
import { resetDb, _resetSingletonForTest } from '../../db/index';
import { getDb } from '../../db/index';

describe('sync/operations', () => {
  beforeEach(async () => {
    await resetDb().catch(() => {});
    _resetSingletonForTest();
  });

  it('enqueueOperation genera UUID + persiste como pending', async () => {
    const id = await enqueueOperation({
      target: 'fn_abrir_venta_comanda',
      op_type: 'rpc',
      payload: { p_local_id: 1 },
    });
    expect(id).toMatch(/^[0-9a-f]{8}-/);
    const db = await getDb();
    const op = await db.get('pending_ops', id);
    expect(op?.status).toBe('pending');
    expect(op?.retries).toBe(0);
  });

  it('listPendingOps ordena por created_at ASC', async () => {
    const a = await enqueueOperation({ target: 'a', op_type: 'rpc', payload: null });
    await new Promise((r) => setTimeout(r, 5));
    const b = await enqueueOperation({ target: 'b', op_type: 'rpc', payload: null });
    await new Promise((r) => setTimeout(r, 5));
    const c = await enqueueOperation({ target: 'c', op_type: 'rpc', payload: null });
    const list = await listPendingOps();
    expect(list.map((o) => o.id)).toEqual([a, b, c]);
  });

  it('markSyncing → markSynced flujo happy path', async () => {
    const id = await enqueueOperation({ target: 'x', op_type: 'rpc', payload: null });
    await markSyncing(id);
    const db = await getDb();
    let op = await db.get('pending_ops', id);
    expect(op?.status).toBe('syncing');
    await markSynced(id);
    op = await db.get('pending_ops', id);
    expect(op?.status).toBe('synced');
    expect(op?.last_error).toBeNull();
  });

  it('markFailed retry < MAX queda pending, en MAX queda failed', async () => {
    const id = await enqueueOperation({ target: 'x', op_type: 'rpc', payload: null });
    for (let i = 0; i < 4; i++) await markFailed(id, `intento ${i}`);
    const db = await getDb();
    let op = await db.get('pending_ops', id);
    expect(op?.status).toBe('pending');
    expect(op?.retries).toBe(4);
    await markFailed(id, 'intento 5');
    op = await db.get('pending_ops', id);
    expect(op?.status).toBe('failed');
    expect(op?.retries).toBe(5);
    expect(op?.last_error).toBe('intento 5');
  });

  it('listPendingOps excluye synced y failed', async () => {
    const a = await enqueueOperation({ target: 'a', op_type: 'rpc', payload: null });
    const b = await enqueueOperation({ target: 'b', op_type: 'rpc', payload: null });
    const c = await enqueueOperation({ target: 'c', op_type: 'rpc', payload: null });
    await markSynced(a);
    for (let i = 0; i < 5; i++) await markFailed(b, 'err');
    const list = await listPendingOps();
    expect(list.map((o) => o.id)).toEqual([c]);
  });

  it('pendingCount y failedCount son consistentes', async () => {
    const a = await enqueueOperation({ target: 'a', op_type: 'rpc', payload: null });
    const b = await enqueueOperation({ target: 'b', op_type: 'rpc', payload: null });
    await markSynced(a);
    for (let i = 0; i < 5; i++) await markFailed(b, 'err');
    expect(await pendingCount()).toBe(0);
    expect(await failedCount()).toBe(1);
  });

  it('backoffMs crece exponencial', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(30_000);
    expect(backoffMs(3)).toBe(300_000);
    expect(backoffMs(4)).toBe(1_800_000);
    expect(backoffMs(5)).toBe(3_600_000);
    expect(backoffMs(99)).toBe(3_600_000); // cap
  });

  it('cleanupOldSynced borra synced viejos pero deja pending', async () => {
    const a = await enqueueOperation({ target: 'a', op_type: 'rpc', payload: null });
    await markSynced(a);
    // Antedatar 8 días para que entre en el cleanup
    const db = await getDb();
    const op = await db.get('pending_ops', a);
    op!.created_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await db.put('pending_ops', op!);
    const b = await enqueueOperation({ target: 'b', op_type: 'rpc', payload: null });
    const removed = await cleanupOldSynced();
    expect(removed).toBe(1);
    expect(await db.get('pending_ops', a)).toBeUndefined();
    expect(await db.get('pending_ops', b)).toBeDefined();
  });

  it('dependencias preservadas: depends_on se guarda', async () => {
    const parent = await enqueueOperation({ target: 'parent', op_type: 'rpc', payload: null });
    const child = await enqueueOperation({
      target: 'child', op_type: 'rpc', payload: null, depends_on: parent,
    });
    const db = await getDb();
    const op = await db.get('pending_ops', child);
    expect(op?.depends_on).toBe(parent);
  });

  // AUDIT F5B#1 (regression): resetSyncingOpsAtBoot debe resetear ops huérfanas
  // en estado 'syncing' a 'pending' al iniciar el engine. Sin esto quedaban
  // permanente en ese estado si el browser moría a mitad de un push.
  describe('resetSyncingOpsAtBoot (F5B#1)', () => {
    it('resetea ops en syncing a pending', async () => {
      const a = await enqueueOperation({ target: 'a', op_type: 'rpc', payload: null });
      const b = await enqueueOperation({ target: 'b', op_type: 'rpc', payload: null });
      await markSyncing(a);
      await markSyncing(b);
      // listPendingOps trae pending Y syncing — pero ambos están como syncing.
      // Verificamos via getDb directamente.
      const db = await getDb();
      expect((await db.get('pending_ops', a))?.status).toBe('syncing');
      expect((await db.get('pending_ops', b))?.status).toBe('syncing');

      const reset = await resetSyncingOpsAtBoot();
      expect(reset).toBe(2);

      const aOp = await db.get('pending_ops', a);
      const bOp = await db.get('pending_ops', b);
      expect(aOp?.status).toBe('pending');
      expect(bOp?.status).toBe('pending');
      expect(aOp?.last_error).toContain('reset_at_boot');
    });

    it('no toca ops en pending/synced/failed', async () => {
      const pendingOp = await enqueueOperation({ target: 'p', op_type: 'rpc', payload: null });
      const syncedOp = await enqueueOperation({ target: 's', op_type: 'rpc', payload: null });
      const failedOp = await enqueueOperation({ target: 'f', op_type: 'rpc', payload: null });
      await markSynced(syncedOp);
      for (let i = 0; i < 5; i++) await markFailed(failedOp, 'err'); // → status='failed'

      const reset = await resetSyncingOpsAtBoot();
      expect(reset).toBe(0); // ninguno estaba en syncing

      const db = await getDb();
      expect((await db.get('pending_ops', pendingOp))?.status).toBe('pending');
      expect((await db.get('pending_ops', syncedOp))?.status).toBe('synced');
      expect((await db.get('pending_ops', failedOp))?.status).toBe('failed');
    });

    it('retorna 0 cuando no hay ops huérfanas', async () => {
      const reset = await resetSyncingOpsAtBoot();
      expect(reset).toBe(0);
    });
  });
});
