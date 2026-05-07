import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockBuilder = vi.fn();

vi.mock('../lib/supabase', () => ({
  db: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => mockBuilder(),
  },
}));

import { setRolPos, setPosActivo, setPin, verificarPin } from './empleadosService';

beforeEach(() => {
  mockRpc.mockReset();
  mockBuilder.mockReset();
});

describe('setRolPos', () => {
  it('actualiza rol_pos del empleado', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    mockBuilder.mockReturnValue({ update });
    await setRolPos('emp-uuid', 'manager');
    expect(update).toHaveBeenCalledWith({ rol_pos: 'manager' });
    expect(eq).toHaveBeenCalledWith('id', 'emp-uuid');
  });

  it('null limpia el rol', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    mockBuilder.mockReturnValue({ update });
    await setRolPos('emp-uuid', null);
    expect(update).toHaveBeenCalledWith({ rol_pos: null });
  });
});

describe('setPosActivo', () => {
  it('toggle pos_activo', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    mockBuilder.mockReturnValue({ update });
    await setPosActivo('emp', true);
    expect(update).toHaveBeenCalledWith({ pos_activo: true });
  });
});

describe('setPin', () => {
  it('rechaza PIN no de 4 dígitos sin llamar RPC', async () => {
    const r1 = await setPin('emp', '123');
    expect(r1.error).toContain('4 dígitos');
    const r2 = await setPin('emp', '12345');
    expect(r2.error).toContain('4 dígitos');
    const r3 = await setPin('emp', 'abcd');
    expect(r3.error).toContain('4 dígitos');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('PIN de 4 dígitos llama fn_set_pin_pos', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const res = await setPin('emp-uuid', '1234');
    expect(mockRpc).toHaveBeenCalledWith('fn_set_pin_pos', {
      p_empleado_id: 'emp-uuid',
      p_pin: '1234',
    });
    expect(res.error).toBeNull();
  });

  it('mapea error del RPC', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'SIN_PERMISO_EMPLEADOS_EDITAR' },
    });
    const res = await setPin('emp', '1234');
    expect(res.error).toContain('SIN_PERMISO');
  });
});

describe('verificarPin', () => {
  it('rechaza PIN inválido sin llamar RPC', async () => {
    const r = await verificarPin(1, 'abc');
    expect(r.empleadoId).toBeNull();
    expect(r.error).toBe('PIN inválido');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('PIN correcto retorna empleado_id', async () => {
    mockRpc.mockResolvedValue({ data: 'emp-uuid', error: null });
    const r = await verificarPin(1, '1234');
    expect(r.empleadoId).toBe('emp-uuid');
    expect(r.error).toBeNull();
  });

  it('PIN incorrecto retorna null sin error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const r = await verificarPin(1, '9999');
    expect(r.empleadoId).toBeNull();
    expect(r.error).toBeNull();
  });

  it('error de RPC mapea correctamente', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'PIN_BLOQUEADO' } });
    const r = await verificarPin(1, '1234');
    expect(r.empleadoId).toBeNull();
    expect(r.error).toBe('PIN_BLOQUEADO');
  });
});
