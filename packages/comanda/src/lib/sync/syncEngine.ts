// syncEngine — orquestador del sync bidireccional.
//
// Mantiene 1 instancia por sesión. Estado:
//   - idle    : nada en curso, todo sincronizado.
//   - pulling : pull initial o incremental en curso.
//   - pushing : push queue en curso.
//   - error   : último ciclo falló.
//   - offline : sin internet (delegamos en useOnlineStatus).
//
// Ciclo principal:
//   1. Login POS → pullInitialAll() para arrancar con DB local fresca.
//   2. Cada 30s mientras online: pullIncrementalAll() + processPushQueue().
//   3. Cuando se encola una op nueva: dispara processPushQueue() inmediato.
//   4. Cuando vuelve internet (was offline): pull incremental + push push.
//
// NOTA: este engine NO se monta automáticamente en la app hoy. Fase 4
// (operaciones offline) se encarga de wirearlo cuando todos los services
// estén refactorizados a "write local + enqueue".

import { pullInitialAll, type PullContext } from './pullInitial';
import { pullIncrementalAll } from './pullIncremental';
import { processPushQueue } from './pushQueue';
import { pendingCount, failedCount, resetSyncingOpsAtBoot } from './operations';

export type SyncState =
  | { kind: 'idle'; pendingOps: number; failedOps: number; lastSyncAt: string | null }
  | { kind: 'pulling'; pendingOps: number; failedOps: number }
  | { kind: 'pushing'; pendingOps: number; failedOps: number }
  | { kind: 'error'; message: string; pendingOps: number; failedOps: number }
  | { kind: 'offline'; pendingOps: number; failedOps: number };

type Listener = (state: SyncState) => void;

class SyncEngine {
  private state: SyncState = { kind: 'idle', pendingOps: 0, failedOps: 0, lastSyncAt: null };
  private listeners = new Set<Listener>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private ctx: PullContext | null = null;
  private inFlight = false;        // evita ciclos concurrentes
  private lastSyncAt: string | null = null;

  // Inicia el engine para el contexto (tenant + local). Llamar después del
  // login POS o al cambiar de local activo. Hace un pullInitial y arranca
  // el ciclo periódico.
  async start(ctx: PullContext): Promise<void> {
    this.ctx = ctx;
    // AUDIT F5B#1: resetear ops huérfanas en 'syncing' que quedaron del
    // crash anterior. Sin esto quedan permanente en ese estado y no se
    // reintentan nunca.
    try {
      const reset = await resetSyncingOpsAtBoot();
      if (reset > 0) console.log(`[syncEngine] reset ${reset} ops huérfanas en 'syncing'`);
    } catch (e) {
      console.warn('[syncEngine] resetSyncingOpsAtBoot falló:', e);
    }
    this.startPeriodicSync();
    await this.runFullCycle(true); // primer ciclo con pull initial
  }

  // Detiene el engine. Llamar en logout.
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.ctx = null;
    this.setState({ kind: 'idle', pendingOps: 0, failedOps: 0, lastSyncAt: this.lastSyncAt });
  }

  // Suscripción al estado. Devuelve fn para desuscribir.
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // Push inmediato del estado actual
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): SyncState {
    return this.state;
  }

  // Trigger manual de push (cuando una op se encola fresh y queremos
  // sincronizarla rápido).
  async triggerPush(): Promise<void> {
    if (!this.ctx || this.inFlight) return;
    await this.runFullCycle(false);
  }

  // Notifica que volvió la conexión — arranca un ciclo full.
  async notifyOnline(): Promise<void> {
    if (!this.ctx) return;
    await this.runFullCycle(false);
  }

  // Notifica que se perdió la conexión — actualiza el estado.
  notifyOffline(): void {
    const pending = this.state.pendingOps;
    const failed = this.state.failedOps;
    this.setState({ kind: 'offline', pendingOps: pending, failedOps: failed });
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  private startPeriodicSync(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => {
      // AUDIT F3C#14: pausar polling cuando la pestaña está oculta.
      // Antes: un cocinero/cajero con el POS en una pestaña oculta seguía
      // tirando 5 queries Supabase cada 30s (items + grupos + mesas + ventas
      // + items) por terminal. Multiplicado por N terminales era ruido puro.
      if (typeof document !== 'undefined' && document.hidden) return;
      void this.runFullCycle(false);
    }, 30_000);
  }

  private async runFullCycle(isInitial: boolean): Promise<void> {
    if (!this.ctx || this.inFlight) return;
    this.inFlight = true;

    // AUDIT F5B#4: pull y push tienen try/catch independientes — antes si
    // pull fallaba (típico cuando se cae internet a mitad), el push NO
    // corría aunque hubiera ops pending → quedaban encoladas indefinidamente
    // hasta que el usuario hiciera algo que disparara otro ciclo.
    let pullErr: unknown = null;
    let pushErr: unknown = null;

    try {
      this.setState({
        kind: 'pulling',
        pendingOps: await pendingCount(),
        failedOps: await failedCount(),
      });
      if (isInitial) {
        await pullInitialAll(this.ctx);
      } else {
        await pullIncrementalAll(this.ctx);
      }
    } catch (e) {
      pullErr = e;
    }

    try {
      this.setState({
        kind: 'pushing',
        pendingOps: await pendingCount(),
        failedOps: await failedCount(),
      });
      await processPushQueue();
    } catch (e) {
      pushErr = e;
    }

    try {
      this.lastSyncAt = new Date().toISOString();
      const pending = await pendingCount().catch(() => 0);
      const failed = await failedCount().catch(() => 0);
      if (pullErr || pushErr) {
        const message = pullErr
          ? `pull: ${pullErr instanceof Error ? pullErr.message : String(pullErr)}`
          : `push: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`;
        this.setState({ kind: 'error', message, pendingOps: pending, failedOps: failed });
      } else {
        this.setState({
          kind: 'idle',
          pendingOps: pending,
          failedOps: failed,
          lastSyncAt: this.lastSyncAt,
        });
      }
    } finally {
      this.inFlight = false;
    }
  }

  private setState(next: SyncState): void {
    this.state = next;
    for (const l of this.listeners) {
      try { l(next); } catch { /* listener errors no rompen el engine */ }
    }
  }
}

// Singleton por sesión del browser.
export const syncEngine = new SyncEngine();
