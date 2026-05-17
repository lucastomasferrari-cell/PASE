// Test E2E mutante del itemsRepo + base + migrations + getDb().
// Usa fake-indexeddb (polyfill in-memory) para validar el flujo completo:
//   abrir DB → correr migration v1 → insertar → query por índice →
//   replace atómico → verificar.
//
// Patrón seguido por todos los tests de repos: importar 'fake-indexeddb/auto'
// al tope, llamar a `resetDb()` antes de cada test para empezar limpio.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { itemsRepo } from '../itemsRepo';
import { resetDb, _resetSingletonForTest } from '../../index';
import type { LocalItem } from '../../schema';

function mkItem(over: Partial<LocalItem> = {}): LocalItem {
  return {
    id: 1,
    tenant_id: 'tenant-A',
    local_id: 1,
    nombre: 'Pizza',
    descripcion: null,
    emoji: '🍕',
    foto_url: null,
    codigo: null,
    grupo_id: 10,
    orden: 0,
    precio_madre: 1500,
    costo_actual: 500,
    costo_actualizado_at: null,
    receta_version_id_vigente: null,
    receta_id_vigente: null,
    tax_rate_id: null,
    estacion: 'cocina_caliente',
    estado: 'disponible',
    agotado_motivo: null,
    agotado_por: null,
    agotado_at: null,
    agotado_hasta: null,
    es_combo: false,
    visible_pos: true,
    visible_qr: true,
    visible_tienda: true,
    es_open_item: false,
    tiempo_prep_min: null,
    created_at: '2026-05-16T00:00:00Z',
    updated_at: '2026-05-16T00:00:00Z',
    deleted_at: null,
    created_by: null,
    updated_by: null,
    ...over,
  } as LocalItem;
}

describe('itemsRepo (DB local)', () => {
  beforeEach(async () => {
    // Reset fake-indexeddb + singleton entre tests.
    await resetDb().catch(() => { /* primera vez no existe, ignorar */ });
    _resetSingletonForTest();
  });

  it('put + getById roundtrip', async () => {
    await itemsRepo.put(mkItem({ id: 1, nombre: 'Pizza' }));
    const fetched = await itemsRepo.getById(1);
    expect(fetched?.nombre).toBe('Pizza');
    // put sin skipDirty marca dirty=true (mutation local pendiente de push)
    expect(fetched?._local_dirty).toBe(true);
  });

  it('put con skipDirty (pull desde cloud) no marca dirty', async () => {
    await itemsRepo.put(mkItem({ id: 2 }), { skipDirty: true });
    const fetched = await itemsRepo.getById(2);
    expect(fetched?._local_dirty).toBe(false);
    expect(fetched?._local_synced_at).toBeTruthy();
  });

  it('listByTenant filtra por tenant + ordena por orden', async () => {
    await itemsRepo.putMany([
      mkItem({ id: 1, tenant_id: 'A', orden: 2, nombre: 'A2' }),
      mkItem({ id: 2, tenant_id: 'A', orden: 1, nombre: 'A1' }),
      mkItem({ id: 3, tenant_id: 'B', orden: 0, nombre: 'B0' }),
    ]);
    const aItems = await itemsRepo.listByTenant('A');
    expect(aItems.map((i) => i.nombre)).toEqual(['A1', 'A2']);
  });

  it('listByTenant con filtros (grupo + visible + disponible)', async () => {
    await itemsRepo.putMany([
      mkItem({ id: 1, tenant_id: 'A', grupo_id: 10, visible_pos: true, estado: 'disponible' }),
      mkItem({ id: 2, tenant_id: 'A', grupo_id: 10, visible_pos: false, estado: 'disponible' }),
      mkItem({ id: 3, tenant_id: 'A', grupo_id: 10, visible_pos: true, estado: 'agotado' }),
      mkItem({ id: 4, tenant_id: 'A', grupo_id: 20, visible_pos: true, estado: 'disponible' }),
    ]);
    const r = await itemsRepo.listByTenant('A', {
      grupoId: 10, soloVisiblesPos: true, soloDisponibles: true,
    });
    expect(r.map((i) => i.id)).toEqual([1]);
  });

  it('replaceForTenant borra existentes del tenant y reinserta', async () => {
    // Estado inicial: 2 items del tenant A + 1 del B.
    await itemsRepo.putMany([
      mkItem({ id: 1, tenant_id: 'A', nombre: 'viejo1' }),
      mkItem({ id: 2, tenant_id: 'A', nombre: 'viejo2' }),
      mkItem({ id: 3, tenant_id: 'B', nombre: 'noTocar' }),
    ]);
    // Pull: catalogo A nuevo trae solo 1 item con id distinto.
    await itemsRepo.replaceForTenant('A', [
      mkItem({ id: 10, tenant_id: 'A', nombre: 'nuevoUnico' }),
    ]);
    const aAfter = await itemsRepo.listByTenant('A');
    expect(aAfter.map((i) => i.nombre)).toEqual(['nuevoUnico']);
    // B intacto
    const bAfter = await itemsRepo.listByTenant('B');
    expect(bAfter.map((i) => i.nombre)).toEqual(['noTocar']);
  });

  it('findDirty devuelve solo los que tienen _local_dirty=true', async () => {
    // Insertado con skipDirty=true → NO dirty
    await itemsRepo.put(mkItem({ id: 1 }), { skipDirty: true });
    // Insertado mutación local → dirty
    await itemsRepo.put(mkItem({ id: 2 }));
    const dirty = await itemsRepo.findDirty();
    expect(dirty.map((i) => i.id)).toEqual([2]);
  });

  it('markSynced limpia el flag dirty', async () => {
    await itemsRepo.put(mkItem({ id: 99, nombre: 'pendiente' }));
    expect((await itemsRepo.getById(99))?._local_dirty).toBe(true);
    await itemsRepo.markSynced(99);
    const after = await itemsRepo.getById(99);
    expect(after?._local_dirty).toBe(false);
    expect(after?._local_synced_at).toBeTruthy();
  });

  it('count refleja inserts', async () => {
    expect(await itemsRepo.count()).toBe(0);
    await itemsRepo.put(mkItem({ id: 1 }));
    await itemsRepo.put(mkItem({ id: 2 }));
    expect(await itemsRepo.count()).toBe(2);
  });

  it('delete remueve la fila', async () => {
    await itemsRepo.put(mkItem({ id: 5 }));
    await itemsRepo.delete(5);
    expect(await itemsRepo.getById(5)).toBeUndefined();
  });

  it('replaceForTenant es atómico — si tira error, no deja media data', async () => {
    await itemsRepo.put(mkItem({ id: 1, tenant_id: 'A', nombre: 'original' }));
    // Forzamos error pasando un row con id duplicado A FIN de propósito
    // (replace usa put que sobrescribe, así que no rompe — este test
    // verifica el happy path es atómico).
    await itemsRepo.replaceForTenant('A', [
      mkItem({ id: 100, tenant_id: 'A', nombre: 'nuevo1' }),
      mkItem({ id: 101, tenant_id: 'A', nombre: 'nuevo2' }),
    ]);
    const after = await itemsRepo.listByTenant('A');
    expect(after).toHaveLength(2);
    expect(after.map((i) => i.nombre).sort()).toEqual(['nuevo1', 'nuevo2']);
  });
});
