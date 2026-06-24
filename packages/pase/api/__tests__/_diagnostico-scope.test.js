import { describe, it, expect } from 'vitest';
import { localesVisibles, tienePermisoDiagnostico } from '../_diagnostico-scope.js';

// Mock chainable del cliente Supabase. `handler(table, filters)` devuelve las
// filas crudas; el builder es thenable y soporta select / eq / limit /
// maybeSingle (las únicas operaciones que usa _diagnostico-scope.js).
function makeAdmin(handler) {
  function builder(table) {
    const filters = {};
    let single = false;
    const b = {
      select() { return b; },
      eq(col, val) { filters[col] = val; return b; },
      limit() { return b; },
      maybeSingle() { single = true; return b; },
      then(resolve, reject) {
        const rows = handler(table, filters) || [];
        const data = single ? (rows[0] ?? null) : rows;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  }
  return { from: builder };
}

describe('localesVisibles', () => {
  it('dueño ve todos los locales del tenant', async () => {
    const admin = makeAdmin((t, f) => {
      if (t === 'locales' && f.tenant_id === 'T1') return [{ id: 1 }, { id: 2 }, { id: 3 }];
      return [];
    });
    const out = await localesVisibles(admin, {
      row: { rol: 'dueno', tenant_id: 'T1' },
      user: { id: 'a' },
    });
    expect([...out].sort()).toEqual([1, 2, 3]);
  });

  it('encargado ve SOLO sus locales — nunca los de otro usuario (aislamiento)', async () => {
    const admin = makeAdmin((t, f) => {
      if (t === 'usuario_locales' && f.usuario_id === 10) return [{ local_id: 5 }, { local_id: 6 }];
      if (t === 'usuario_locales' && f.usuario_id === 99) return [{ local_id: 7 }]; // otro usuario
      return [];
    });
    const out = await localesVisibles(admin, {
      row: { rol: 'encargado', id: 10, tenant_id: 'T1' },
      user: { id: 'a' },
    });
    expect(out).toEqual([5, 6]);
    expect(out).not.toContain(7); // el local de otro usuario NUNCA aparece
  });

  it('cajero solo-COMANDA (sin usuario_locales) cae al fallback comanda_usuarios.locales', async () => {
    const admin = makeAdmin((t, f) => {
      if (t === 'usuario_locales') return [];
      if (t === 'comanda_usuarios' && f.auth_id === 'auth-xyz' && f.activo === true) {
        return [{ locales: [8, 9] }];
      }
      return [];
    });
    const out = await localesVisibles(admin, {
      row: { rol: 'cajero', id: 20, tenant_id: 'T1' },
      user: { id: 'auth-xyz' },
    });
    expect(out).toEqual([8, 9]);
  });

  it('encargado sin locales en ningún lado → array vacío (no ve nada)', async () => {
    const admin = makeAdmin(() => []);
    const out = await localesVisibles(admin, {
      row: { rol: 'encargado', id: 30, tenant_id: 'T1' },
      user: { id: 'a' },
    });
    expect(out).toEqual([]);
  });
});

describe('tienePermisoDiagnostico', () => {
  const dummyUser = { id: 'a' };

  it('dueño siempre tiene el permiso (sin consultar la base)', async () => {
    const admin = makeAdmin(() => { throw new Error('no debería consultar para dueño'); });
    const ok = await tienePermisoDiagnostico(admin, { row: { rol: 'dueno', id: 1 }, user: dummyUser });
    expect(ok).toBe(true);
  });

  it('encargado sin el permiso → false', async () => {
    const admin = makeAdmin(() => []);
    const ok = await tienePermisoDiagnostico(admin, {
      row: { rol: 'encargado', id: 10, rol_id: 3 }, user: dummyUser,
    });
    expect(ok).toBe(false);
  });

  it('encargado con el permiso suelto en usuario_permisos → true', async () => {
    const admin = makeAdmin((t, f) => {
      if (t === 'usuario_permisos' && f.usuario_id === 10 && f.modulo_slug === 'diagnostico_ia') {
        return [{ modulo_slug: 'diagnostico_ia' }];
      }
      return [];
    });
    const ok = await tienePermisoDiagnostico(admin, {
      row: { rol: 'encargado', id: 10, rol_id: null }, user: dummyUser,
    });
    expect(ok).toBe(true);
  });

  it('encargado con el permiso vía rol RBAC (rol_permisos) → true', async () => {
    const admin = makeAdmin((t, f) => {
      if (t === 'rol_permisos' && f.rol_id === 3 && f.modulo_slug === 'diagnostico_ia') {
        return [{ modulo_slug: 'diagnostico_ia' }];
      }
      return [];
    });
    const ok = await tienePermisoDiagnostico(admin, {
      row: { rol: 'encargado', id: 10, rol_id: 3 }, user: dummyUser,
    });
    expect(ok).toBe(true);
  });
});
