import { describe, it, expect } from 'vitest';
import { executeTool, TOOLS } from '../_diagnostico-tools.js';

// Mock chainable del cliente Supabase: cualquier método encadenado devuelve el
// builder; al await resuelve con las filas de `rowsByTable[tabla]`. Soporta
// maybeSingle (devuelve la primera fila). No valida la construcción de la query
// (eso lo cubre el smoke real) — acá importa el control de acceso por local.
function makeAdmin(rowsByTable) {
  function builder(table) {
    let single = false;
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'maybeSingle') return () => { single = true; return b; };
        if (prop === 'then') {
          return (resolve, reject) => {
            const rows = rowsByTable[table] ?? [];
            const data = single ? (Array.isArray(rows) ? (rows[0] ?? null) : rows) : rows;
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          };
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
  it('buscar_gasto: rechaza un local fuera del alcance', async () => {
    const out = await executeTool(makeAdmin({ gastos: [{ id: 1 }] }), scope, 'buscar_gasto', { local_id: 99 });
    expect(out.error).toBe('LOCAL_FUERA_DE_ALCANCE');
    expect(out.filas).toBeUndefined();
  });
  it('buscar_movimiento: rechaza local fuera del alcance', async () => {
    const out = await executeTool(makeAdmin({}), scope, 'buscar_movimiento', { local_id: 1 });
    expect(out.error).toBe('LOCAL_FUERA_DE_ALCANCE');
  });
  it('saldo_cuentas: rechaza local fuera del alcance', async () => {
    const out = await executeTool(makeAdmin({}), scope, 'saldo_cuentas', { local_id: 99 });
    expect(out.error).toBe('LOCAL_FUERA_DE_ALCANCE');
  });
  it('buscar_factura: rechaza local fuera del alcance', async () => {
    const out = await executeTool(makeAdmin({}), scope, 'buscar_factura', { local_id: 7 });
    expect(out.error).toBe('LOCAL_FUERA_DE_ALCANCE');
  });
  it('sin especificar local → rechaza', async () => {
    const out = await executeTool(makeAdmin({}), scope, 'buscar_gasto', {});
    expect(out.error).toBe('LOCAL_FUERA_DE_ALCANCE');
  });
  it('herramienta desconocida → error sin tocar la base', async () => {
    const out = await executeTool(makeAdmin({}), scope, 'borrar_todo', { local_id: 5 });
    expect(out.error).toBe('TOOL_DESCONOCIDA');
  });
});

describe('executeTool — herramientas con local en alcance', () => {
  it('buscar_gasto devuelve filas', async () => {
    const admin = makeAdmin({ gastos: [{ id: 'g1', fecha: '2026-06-20', monto: 50000, estado: null }] });
    const out = await executeTool(admin, scope, 'buscar_gasto', { local_id: 5, monto_aprox: 50000 });
    expect(out.error).toBeUndefined();
    expect(out.filas).toHaveLength(1);
  });
  it('buscar_movimiento devuelve filas', async () => {
    const admin = makeAdmin({ movimientos: [{ id: 'm1', importe: -9900, cuenta: 'Caja Efectivo' }] });
    const out = await executeTool(admin, scope, 'buscar_movimiento', { local_id: 6, monto_aprox: 9900 });
    expect(out.filas).toHaveLength(1);
  });
  it('saldo_cuentas devuelve las cuentas', async () => {
    const admin = makeAdmin({ saldos_caja: [{ cuenta: 'Caja Efectivo', saldo: 12345 }] });
    const out = await executeTool(admin, scope, 'saldo_cuentas', { local_id: 5 });
    expect(out.cuentas).toHaveLength(1);
    expect(out.cuentas[0].saldo).toBe(12345);
  });
  it('buscar_factura resuelve el nombre del proveedor', async () => {
    const admin = makeAdmin({
      facturas: [{ id: 'f1', nro: 'A-1', total: 100000, prov_id: 81, estado: 'pendiente' }],
      proveedores: [{ id: 81, nombre: 'POSTA EXPRESS SRL' }],
    });
    const out = await executeTool(admin, scope, 'buscar_factura', { local_id: 5 });
    expect(out.filas).toHaveLength(1);
    expect(out.filas[0].proveedor).toBe('POSTA EXPRESS SRL');
  });
});

describe('executeTool — detalle_registro (valida local DESPUÉS de traer el registro)', () => {
  it('devuelve el registro si su local está en alcance', async () => {
    const admin = makeAdmin({ gastos: [{ id: 'g1', local_id: 5, monto: 100 }] });
    const out = await executeTool(admin, scope, 'detalle_registro', { tipo: 'gasto', id: 'g1' });
    expect(out.registro).toBeTruthy();
    expect(out.registro.local_id).toBe(5);
  });
  it('NIEGA el registro si su local NO está en alcance (aislamiento)', async () => {
    const admin = makeAdmin({ gastos: [{ id: 'gX', local_id: 99, monto: 100 }] });
    const out = await executeTool(admin, scope, 'detalle_registro', { tipo: 'gasto', id: 'gX' });
    expect(out.error).toBe('LOCAL_FUERA_DE_ALCANCE');
    expect(out.registro).toBeUndefined();
  });
  it('tipo inválido → error', async () => {
    const out = await executeTool(makeAdmin({}), scope, 'detalle_registro', { tipo: 'empleado', id: '1' });
    expect(out.error).toBe('TIPO_INVALIDO');
  });
  it('id inexistente → NO_ENCONTRADO', async () => {
    const out = await executeTool(makeAdmin({ gastos: [] }), scope, 'detalle_registro', { tipo: 'gasto', id: 'zzz' });
    expect(out.error).toBe('NO_ENCONTRADO');
  });
});

describe('TOOLS (schema)', () => {
  it('tiene las 5 herramientas v1', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      ['buscar_factura', 'buscar_gasto', 'buscar_movimiento', 'detalle_registro', 'saldo_cuentas'],
    );
  });
  it('las de búsqueda exigen local_id', () => {
    for (const n of ['buscar_gasto', 'buscar_movimiento', 'saldo_cuentas', 'buscar_factura']) {
      expect(TOOLS.find((t) => t.name === n).input_schema.required).toContain('local_id');
    }
  });
});
