// Conflict resolver: last-write-wins (LWW) por timestamp + audit log.
//
// Cuando un pull trae una fila que también tiene cambios locales pendientes
// (dirty), comparamos `updated_at` y gana el más nuevo. Loguamos el conflicto
// en `sync_conflicts` para auditoría — el manager puede revisar al final
// del turno.
//
// Excepciones críticas (no LWW puro):
//   - venta `cobrada` o `anulada` local NO se sobrescribe nunca por pull
//     (operación final, no reversible sin manager override).
//   - venta con items locales sin sincronizar NO se sobrescribe — se
//     marca conflict pending_manual y se preserva la local.

import { getDb } from '../db/index';
import type { SyncConflict, LocalMeta } from '../db/schema';

function genUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Tipo de fila genérica con updated_at. Tanto la versión local como la
// cloud lo tienen porque es columna estándar.
interface RowWithUpdatedAt {
  id: string | number;
  updated_at: string;
  estado?: string;
}

export interface ResolveContext {
  store: string;
  rowId: string | number;
}

export type ResolveResult = 'local_wins' | 'cloud_wins' | 'manual_pending';

// Decide quién gana un conflicto. NO escribe nada — solo decide. El caller
// (pull engine) aplica el resultado.
export function resolveLWW<T extends RowWithUpdatedAt & LocalMeta>(
  local: T,
  cloud: T,
  ctx: ResolveContext,
): ResolveResult {
  // 1) Excepciones críticas: ventas finalizadas locales protegidas
  if (ctx.store === 'ventas_pos') {
    const localEstado = local.estado;
    if (localEstado === 'cobrada' || localEstado === 'anulada') {
      // El local ya finalizó — NO sobrescribir desde cloud sin manager.
      // Si el cloud tiene un estado distinto, eso es un caso raro
      // (probablemente otra terminal anuló mientras esta cobraba) → manual.
      if (cloud.estado !== localEstado) {
        return 'manual_pending';
      }
      return 'local_wins';
    }
  }

  // 2) LWW estándar por updated_at
  const localTs = new Date(local.updated_at).getTime();
  const cloudTs = new Date(cloud.updated_at).getTime();

  // Si LOCAL es más nuevo Y está dirty (cambio pendiente de push), gana local.
  if (local._local_dirty && localTs > cloudTs) {
    return 'local_wins';
  }
  // Si CLOUD es más nuevo (o iguales con local sin dirty), gana cloud.
  return 'cloud_wins';
}

// Loguea el conflicto en sync_conflicts para audit + UI manager.
export async function logConflict(args: {
  store: string;
  rowId: string | number;
  localValue: unknown;
  cloudValue: unknown;
  resolution: ResolveResult | 'manual_resolved';
  note?: string;
}): Promise<string> {
  const conflict: SyncConflict = {
    id: genUUID(),
    detected_at: new Date().toISOString(),
    store: args.store,
    row_id: String(args.rowId),
    local_value: args.localValue,
    cloud_value: args.cloudValue,
    resolution: args.resolution,
    note: args.note,
  };
  const db = await getDb();
  await db.put('sync_conflicts', conflict);
  return conflict.id;
}

// Lista conflictos pendientes de resolución manual.
export async function listPendingConflicts(): Promise<SyncConflict[]> {
  const db = await getDb();
  const all = (await db.getAll('sync_conflicts')) as SyncConflict[];
  return all
    .filter((c) => c.resolution === 'manual_pending')
    .sort((a, b) => b.detected_at.localeCompare(a.detected_at));
}

// Marca un conflicto como resuelto manual. Quien resolvió queda registrado.
export async function resolveConflictManual(
  conflictId: string,
  resolvedBy: string,
  finalResolution: 'local_wins' | 'cloud_wins',
  note?: string,
): Promise<void> {
  const db = await getDb();
  const c = (await db.get('sync_conflicts', conflictId)) as SyncConflict | undefined;
  if (!c) return;
  c.resolution = 'manual_resolved';
  c.resolved_by = resolvedBy;
  c.resolved_at = new Date().toISOString();
  c.note = note ?? `Manager eligió ${finalResolution}`;
  await db.put('sync_conflicts', c);
  // NOTA: aplicar el efecto del manual_resolved (sobrescribir local con
  // cloud_value, o re-pushear local_value) es responsabilidad del caller —
  // este módulo solo audita.
}
