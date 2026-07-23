import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock del cliente Supabase antes de importar el service.
// Las llamadas .from(...).select(...) las stubeamos con un encadenable.

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('../lib/supabase', () => ({
  db: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

// Importar DESPUÉS del mock
import {
  abrirTurno, cerrarTurno, registrarMovimiento, totalesPorMetodo,
} from './turnosCajaService';

beforeEach(() => {
  mockRpc.mockReset();
  mockFrom.mockReset();
});

describe('abrirTurno', () => {
  it('llama fn_abrir_turno_caja_comanda con args correctos', async () => {
    mockRpc.mockResolvedValue({ data: 42, error: null });
    const res = await abrirTurno(1, 'emp-uuid', 5000, 'apertura matutina');
    expect(mockRpc).toHaveBeenCalledWith('fn_abrir_turno_caja_comanda', {
      p_local_id: 1, p_cajero_id: 'emp-uuid', p_monto_inicial: 5000, p_notas: 'apertura matutina',
      p_idempotency_key: null,
    });
    expect(res).toEqual({ turnoId: 42, error: null });
  });
  it('mapea error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'TURNO_YA_ABIERTO' } });
    const res = await abrirTurno(1, 'emp', 0, null);
    expect(res.turnoId).toBeNull();
    expect(res.error).toMatch(/turno.*abierto/i);
  });
});

describe('cerrarTurno', () => {
  it('parsea data como SETOF (calculado, diferencia)', async () => {
    mockRpc.mockResolvedValue({
      data: [{ monto_calculado: 12500, diferencia: -200 }],
      error: null,
    });
    const res = await cerrarTurno(1, 'emp', 12300, 'cierre');
    expect(res.data).toEqual({ calculado: 12500, diferencia: -200 });
    expect(res.error).toBeNull();
  });
  it('si SETOF vacío, devuelve ceros', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const res = await cerrarTurno(1, 'emp', 0, null);
    expect(res.data).toEqual({ calculado: 0, diferencia: 0 });
  });
});

describe('registrarMovimiento', () => {
  it('mapea tipo retiro/deposito/ajuste', async () => {
    mockRpc.mockResolvedValue({ data: 99, error: null });
    const res = await registrarMovimiento(1, 'emp', 'retiro', 1000, 'efectivo', 'pago proveedor');
    expect(mockRpc).toHaveBeenCalledWith('fn_movimiento_caja_comanda', expect.objectContaining({
      p_tipo: 'retiro', p_monto: 1000,
    }));
    expect(res.id).toBe(99);
  });
});

describe('totalesPorMetodo', () => {
  it('agrupa por método, suma con signos y marca esEfectivo por medio', async () => {
    // Dos consultas: movimientos_caja (select().eq()) y medios_cobro (select().is()).
    mockFrom.mockImplementation((table: string) => {
      if (table === 'movimientos_caja') {
        const eq = vi.fn().mockResolvedValue({
          data: [
            { metodo: 'efectivo', monto: 1000, tipo: 'venta' },
            { metodo: 'efectivo', monto: 500, tipo: 'venta' },
            { metodo: 'efectivo', monto: 200, tipo: 'retiro' },
            { metodo: 'peya_efectivo', monto: 300, tipo: 'venta' },
            { metodo: 'tarjeta_debito', monto: 800, tipo: 'venta' },
            { metodo: 'efectivo', monto: 5000, tipo: 'cierre' },  // ignorado
          ],
          error: null,
        });
        return { select: vi.fn().mockReturnValue({ eq }) };
      }
      // medios_cobro: select().is() resuelve a {data, error}
      const is = vi.fn().mockResolvedValue({
        data: [
          { slug: 'efectivo', es_efectivo: true },
          { slug: 'peya_efectivo', es_efectivo: true },
          { slug: 'tarjeta_debito', es_efectivo: false },
        ],
        error: null,
      });
      return { select: vi.fn().mockReturnValue({ is }) };
    });

    const res = await totalesPorMetodo(1);
    expect(res.error).toBeNull();
    const efectivo = res.data.find((t) => t.metodo === 'efectivo');
    expect(efectivo?.total).toBe(1000 + 500 - 200);
    expect(efectivo?.cantidad).toBe(3);
    expect(efectivo?.esEfectivo).toBe(true);
    // peya_efectivo también es plata física → esEfectivo true (el fix de B).
    const peya = res.data.find((t) => t.metodo === 'peya_efectivo');
    expect(peya?.total).toBe(300);
    expect(peya?.esEfectivo).toBe(true);
    // tarjeta NO es efectivo.
    const tarjeta = res.data.find((t) => t.metodo === 'tarjeta_debito');
    expect(tarjeta?.total).toBe(800);
    expect(tarjeta?.esEfectivo).toBe(false);
  });
});
