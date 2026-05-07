import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tests del sprint 7 — verifican que los services pasan idempotencyKey
// y managerId a las RPCs correspondientes después del refactor.
//
// NO testean el comportamiento del SQL backend (eso requiere DB real).
// Solo verifican el contract frontend → RPC.

const mockRpc = vi.fn();
vi.mock('../lib/supabase', () => ({
  db: { rpc: (...args: unknown[]) => mockRpc(...args), from: () => ({}) },
}));

import { abrirTurno, registrarMovimiento } from './turnosCajaService';
import { aplicarDescuento } from './descuentosService';
import { anularItem, anularVenta } from './overridesService';
import { cobrar, refundVenta, agregarPago } from './pagosService';

beforeEach(() => mockRpc.mockReset());

describe('sprint 7 — idempotency_key se propaga al RPC', () => {
  it('abrirTurno con idempotencyKey lo pasa al RPC', async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    await abrirTurno(1, 'emp', 5000, null, 'idem-abrir-1');
    expect(mockRpc).toHaveBeenCalledWith('fn_abrir_turno_caja_comanda',
      expect.objectContaining({ p_idempotency_key: 'idem-abrir-1' }),
    );
  });

  it('registrarMovimiento con idempotencyKey + managerId', async () => {
    mockRpc.mockResolvedValue({ data: 99, error: null });
    await registrarMovimiento(1, 'emp', 'retiro', 6000, 'efectivo',
      'pago proveedor urgente', 'idem-mov-1', 'mgr-uuid');
    expect(mockRpc).toHaveBeenCalledWith('fn_movimiento_caja_comanda',
      expect.objectContaining({
        p_idempotency_key: 'idem-mov-1',
        p_manager_id: 'mgr-uuid',
      }),
    );
  });

  it('aplicarDescuento con idempotencyKey lo pasa al RPC', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await aplicarDescuento(
      { ventaId: 1, tipo: 'porcentaje', valor: 10, motivo: 'promo',
        managerId: null, idempotencyKey: 'idem-disc-1' },
      1000,
    );
    expect(mockRpc).toHaveBeenCalledWith('fn_aplicar_descuento_comanda',
      expect.objectContaining({ p_idempotency_key: 'idem-disc-1' }),
    );
  });

  it('anularItem con idempotencyKey lo pasa al RPC', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await anularItem(50, 'mgr', 'cliente reclamo', 'idem-anular-item-1');
    expect(mockRpc).toHaveBeenCalledWith('fn_anular_item_comanda',
      expect.objectContaining({ p_idempotency_key: 'idem-anular-item-1' }),
    );
  });

  it('anularVenta con idempotencyKey lo pasa al RPC', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await anularVenta(7, 'mgr', 'venta error', 'idem-anular-v-1');
    expect(mockRpc).toHaveBeenCalledWith('fn_anular_venta_comanda',
      expect.objectContaining({ p_idempotency_key: 'idem-anular-v-1' }),
    );
  });

  it('cobrar con idempotencyKey lo pasa al RPC', async () => {
    mockRpc.mockResolvedValue({ data: 1500, error: null });
    await cobrar(10, [{ metodo: 'efectivo', monto: 1500, idempotency_key: 'k1' }],
      0, 'emp-uuid', 'idem-cobro-1');
    expect(mockRpc).toHaveBeenCalledWith('fn_cobrar_venta_comanda',
      expect.objectContaining({ p_idempotency_key: 'idem-cobro-1' }),
    );
  });

  it('refundVenta con idempotencyKey lo pasa al RPC', async () => {
    mockRpc.mockResolvedValue({ data: 5000, error: null });
    await refundVenta(7, 'mgr', 'cliente devuelve', 'idem-refund-1');
    expect(mockRpc).toHaveBeenCalledWith('fn_refund_venta_comanda',
      expect.objectContaining({ p_idempotency_key: 'idem-refund-1' }),
    );
  });

  it('agregarPago siempre manda idempotencyKey (era required)', async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    await agregarPago({
      ventaId: 1, metodo: 'efectivo', monto: 100, idempotencyKey: 'idem-pago-1',
    });
    expect(mockRpc).toHaveBeenCalledWith('fn_agregar_pago_venta_comanda',
      expect.objectContaining({ p_idempotency_key: 'idem-pago-1' }),
    );
  });
});

describe('sprint 7 — services backward compatible (sin idempotencyKey)', () => {
  it('abrirTurno sin key manda null al RPC', async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    await abrirTurno(1, 'emp', 5000, null);
    expect(mockRpc).toHaveBeenCalledWith('fn_abrir_turno_caja_comanda',
      expect.objectContaining({ p_idempotency_key: null }),
    );
  });

  it('registrarMovimiento sin manager_id (retiros chicos) manda null', async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    await registrarMovimiento(1, 'emp', 'retiro', 100, 'efectivo', 'caf');
    expect(mockRpc).toHaveBeenCalledWith('fn_movimiento_caja_comanda',
      expect.objectContaining({ p_manager_id: null, p_idempotency_key: null }),
    );
  });
});

describe('sprint 7 — error pathways de RPC reportadas correctamente', () => {
  it('aplicarDescuento mapea error DESCUENTO_INVALIDO del backend', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'DESCUENTO_INVALIDO: el descuento (200) supera el subtotal+propina (100)' },
    });
    const res = await aplicarDescuento(
      { ventaId: 1, tipo: 'monto', valor: 200, motivo: 'x' }, 100);
    expect(res.error).toContain('DESCUENTO_INVALIDO');
  });

  it('agregarPago mapea error SOBREPAGO del backend (HIGH #1)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'SOBREPAGO: cobrarías 30 cuando faltan 0' },
    });
    const res = await agregarPago({
      ventaId: 1, metodo: 'efectivo', monto: 30, idempotencyKey: 'k',
    });
    expect(res.pagoId).toBeNull();
    expect(res.error).toContain('SOBREPAGO');
  });

  it('registrarMovimiento mapea error RETIRO_REQUIERE_MANAGER (HIGH #2)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'RETIRO_REQUIERE_MANAGER: retiros mayores a $5000 requieren autorización' },
    });
    const res = await registrarMovimiento(1, 'emp', 'retiro', 10000, 'efectivo', 'compra');
    expect(res.id).toBeNull();
    expect(res.error).toContain('RETIRO_REQUIERE_MANAGER');
  });

  it('cobrar mapea error LOCAL_NO_AUTORIZADO (BLOCKER #2 IDOR)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'LOCAL_NO_AUTORIZADO: local 99 no pertenece al tenant' },
    });
    const res = await cobrar(1, [{ metodo: 'efectivo', monto: 100, idempotency_key: 'k' }], 0, null);
    expect(res.error).toContain('LOCAL_NO_AUTORIZADO');
  });
});
