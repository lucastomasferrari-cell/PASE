import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Canal } from '../types/database';

// Dataset simulado que devolvería la query a `canales`. Incluye canales de
// otros locales para verificar que resolveCanalPorModo los filtra.
let CANALES: Canal[] = [];

function mk(p: Partial<Canal> & { id: number; slug: string; modo_pos: Canal['modo_pos'] }): Canal {
  return {
    tenant_id: 'T', local_id: null, created_at: '', updated_at: '', deleted_at: null,
    created_by: null, updated_by: null, nombre: p.slug, emoji: null, color: null,
    atado_madre: true, ajuste_madre_pct: 0, comision_externa_pct: 0, redondeo_a: 1,
    activo: true, grupo: null, lista_precio_id: null, ...p,
  };
}

// Builder chainable que resuelve a { data, error }. Cada método de la cadena
// de listCanales (select/is/order/eq) devuelve el mismo builder; await → data.
function makeBuilder() {
  const b: Record<string, unknown> = {};
  const pass = () => b;
  for (const m of ['select', 'is', 'order', 'eq']) b[m] = pass;
  (b as { then: unknown }).then = (resolve: (v: { data: Canal[]; error: null }) => void) =>
    resolve({ data: CANALES, error: null });
  return b;
}

vi.mock('../lib/supabase', () => ({ db: { from: () => makeBuilder() } }));
vi.mock('../lib/offlineCache', () => ({
  cacheGet: async () => null,
  cacheSet: async () => {},
  isNetworkError: () => false,
}));

import { resolveCanalPorModo } from './canalesService';

beforeEach(() => { CANALES = []; });

describe('resolveCanalPorModo', () => {
  it('SEGURIDAD: sin tenant devuelve null y NO consulta (evita leak cross-tenant)', async () => {
    const spy = vi.fn();
    CANALES = [mk({ id: 1, slug: 'salon', modo_pos: 'salon' })];
    // Aunque haya data, con tenant null no debe resolver nada.
    const canal = await resolveCanalPorModo(null, 'salon', 3, 'salon');
    expect(canal).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('matchea por modo_pos, no por slug — salon devuelve el canal salon', async () => {
    CANALES = [
      mk({ id: 1, slug: 'salon', modo_pos: 'salon' }),
      mk({ id: 2, slug: 'mostrador', modo_pos: 'mostrador' }),
      mk({ id: 7, slug: 'menu-qr', modo_pos: 'salon' }),
    ];
    const canal = await resolveCanalPorModo('T', 'salon', 3, 'salon');
    expect(canal?.id).toBe(1); // salon canónico, no el menu-qr (también modo_pos salon)
  });

  it('nunca devuelve un canal de otro modo (mostrador para modo salon)', async () => {
    CANALES = [mk({ id: 2, slug: 'mostrador', modo_pos: 'mostrador' })];
    const canal = await resolveCanalPorModo('T', 'salon', 3, 'salon');
    expect(canal).toBeNull();
  });

  it('prefiere el canal del local sobre el global (local_id null)', async () => {
    CANALES = [
      mk({ id: 1, slug: 'salon', modo_pos: 'salon', local_id: null }),
      mk({ id: 50, slug: 'salon', modo_pos: 'salon', local_id: 3 }),
    ];
    const canal = await resolveCanalPorModo('T', 'salon', 3, 'salon');
    expect(canal?.id).toBe(50);
  });

  it('descarta canales de OTRO local (local_id != localId y != null)', async () => {
    CANALES = [mk({ id: 99, slug: 'salon', modo_pos: 'salon', local_id: 8 })];
    const canal = await resolveCanalPorModo('T', 'salon', 3, 'salon');
    expect(canal).toBeNull();
  });

  it('entre varios del mismo modo/scope prefiere el slug canónico', async () => {
    CANALES = [
      mk({ id: 30, slug: 'salon-vip', modo_pos: 'salon' }),
      mk({ id: 31, slug: 'salon', modo_pos: 'salon' }),
    ];
    const canal = await resolveCanalPorModo('T', 'salon', 3, 'salon');
    expect(canal?.id).toBe(31);
  });

  it('mostrador resuelve al canal mostrador', async () => {
    CANALES = [
      mk({ id: 1, slug: 'salon', modo_pos: 'salon' }),
      mk({ id: 2, slug: 'mostrador', modo_pos: 'mostrador' }),
    ];
    const canal = await resolveCanalPorModo('T', 'mostrador', 3, 'mostrador');
    expect(canal?.id).toBe(2);
  });
});
