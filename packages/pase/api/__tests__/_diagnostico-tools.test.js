import { describe, it, expect } from 'vitest';
import { executeTool, TOOLS } from '../_diagnostico-tools.js';

// Mock chainable del cliente Supabase: cualquier método encadenado devuelve el
// builder; al await, resuelve con las filas de `rowsByTable[tabla]`. No valida
// la construcción de la query (eso lo cubre el smoke contra la base real) —
// acá lo que importa es el control de acceso por local, que ocurre ANTES de
// tocar la base.
function makeAdmin(rowsByTable) {
  function builder(table) {
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve, reject) =>
            Promise.resolve({ data: rowsByTable[table] ?? [], error: null }).then(resolve, reject);
        }
        return () => b;
      },
    });
    return b;
  }
  return { from: builder };
}

const scope = { tenantId: 'T1', locales: [5, 6] };

describe('executeTool — control de acceso (aislamiento)', () => {
  it('rechaza un local fuera del alcance del usuario', async () => {
    const admin = makeAdmin({ gastos: [{ id: 1 }] }); // aunque haya data, no debe tocarla
    const out = await executeTool(admin, scope, 'buscar_gasto', { local_id: 99 });
    expect(out.error).toBe('LOCAL_FUERA_DE_ALCANCE');
    expect(out.filas).toBeUndefined();
  });

  it('rechaza si no se especifica local', async () => {
    const admin = makeAdmin({});
    const out = await executeTool(admin, scope, 'buscar_gasto', {});
    expect(out.error).toBe('LOCAL_FUERA_DE_ALCANCE');
  });

  it('una herramienta desconocida no hace nada y devuelve error', async () => {
    const admin = makeAdmin({});
    const out = await executeTool(admin, scope, 'borrar_todo', { local_id: 5 });
    expect(out.error).toBe('TOOL_DESCONOCIDA');
  });
});

describe('executeTool — buscar_gasto', () => {
  it('devuelve filas para un local dentro del alcance', async () => {
    const admin = makeAdmin({
      gastos: [
        { id: 1, fecha: '2026-06-20', monto: 50000, categoria: 'VARIOS', subcategoria: null, detalle: 'cafe', cuenta: 'Efectivo', estado: null },
      ],
    });
    const out = await executeTool(admin, scope, 'buscar_gasto', { local_id: 5, monto_aprox: 50000 });
    expect(out.error).toBeUndefined();
    expect(out.filas).toHaveLength(1);
    expect(out.filas[0].monto).toBe(50000);
  });

  it('sin coincidencias devuelve lista vacía (no rompe)', async () => {
    const admin = makeAdmin({ gastos: [] });
    const out = await executeTool(admin, scope, 'buscar_gasto', { local_id: 6, fecha_desde: '2026-01-01' });
    expect(out.filas).toEqual([]);
    expect(out.truncado).toBe(false);
  });
});

describe('TOOLS (schema)', () => {
  it('buscar_gasto exige local_id', () => {
    const t = TOOLS.find((x) => x.name === 'buscar_gasto');
    expect(t).toBeTruthy();
    expect(t.input_schema.required).toContain('local_id');
  });
});
