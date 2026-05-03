import { describe, it, expect } from 'vitest';
import { computeSaldoMP, pickEffectiveLocalId } from './saldoMP';

describe('computeSaldoMP', () => {
  const baseMov = { local_id: 1, monto: 0, fecha: '2026-04-15T12:00:00-03:00' };

  it('sin saldo_inicial_at → total null + motivo sin_corte', () => {
    const r = computeSaldoMP({
      saldoInicial: 50000,
      saldoInicialAt: null,
      movs: [{ ...baseMov, monto: 1000 }],
      localId: 1,
    });
    expect(r.total).toBeNull();
    expect(r.motivo).toBe('sin_corte');
    expect(r.movsContados).toBe(0);
  });

  it('saldo_inicial sin movs posteriores → total = saldo_inicial', () => {
    const r = computeSaldoMP({
      saldoInicial: 50000,
      saldoInicialAt: '2026-05-01T00:00:00-03:00',
      movs: [],
      localId: 1,
    });
    expect(r.total).toBe(50000);
    expect(r.motivo).toBe('ok');
    expect(r.movsContados).toBe(0);
  });

  it('suma ingreso post-corte y resta egreso post-corte', () => {
    const r = computeSaldoMP({
      saldoInicial: 100000,
      saldoInicialAt: '2026-04-30T00:00:00-03:00',
      movs: [
        { local_id: 1, monto: 5000, fecha: '2026-05-01T10:00:00-03:00' },   // ingreso
        { local_id: 1, monto: -2000, fecha: '2026-05-01T11:00:00-03:00' },  // egreso
        { local_id: 1, monto: 1500, fecha: '2026-05-02T09:00:00-03:00' },   // ingreso
      ],
      localId: 1,
    });
    expect(r.total).toBe(104500);  // 100000 + 5000 - 2000 + 1500
    expect(r.movsContados).toBe(3);
  });

  it('ignora movs con fecha <= corte (no doble conteo)', () => {
    const r = computeSaldoMP({
      saldoInicial: 50000,
      saldoInicialAt: '2026-05-01T12:00:00-03:00',
      movs: [
        { local_id: 1, monto: 1000, fecha: '2026-05-01T11:00:00-03:00' },  // antes — descartar
        { local_id: 1, monto: 2000, fecha: '2026-05-01T12:00:00-03:00' },  // == corte — descartar (estricto)
        { local_id: 1, monto: 3000, fecha: '2026-05-01T12:00:01-03:00' },  // después — sumar
      ],
      localId: 1,
    });
    expect(r.total).toBe(53000);
    expect(r.movsContados).toBe(1);
  });

  it('ignora movs de otro local', () => {
    const r = computeSaldoMP({
      saldoInicial: 0,
      saldoInicialAt: '2026-04-30T00:00:00-03:00',
      movs: [
        { local_id: 1, monto: 1000, fecha: '2026-05-01T10:00:00-03:00' },
        { local_id: 2, monto: 99999, fecha: '2026-05-01T10:00:00-03:00' },  // otro local — descartar
        { local_id: 1, monto: 500, fecha: '2026-05-02T10:00:00-03:00' },
      ],
      localId: 1,
    });
    expect(r.total).toBe(1500);
    expect(r.movsContados).toBe(2);
  });

  it('ignora movs anulados', () => {
    const r = computeSaldoMP({
      saldoInicial: 0,
      saldoInicialAt: '2026-04-30T00:00:00-03:00',
      movs: [
        { local_id: 1, monto: 1000, fecha: '2026-05-01T10:00:00-03:00' },
        { local_id: 1, monto: 9999, fecha: '2026-05-01T11:00:00-03:00', anulado: true },  // chargeback — descartar
      ],
      localId: 1,
    });
    expect(r.total).toBe(1000);
    expect(r.movsContados).toBe(1);
  });

  it('saldo inicial 0 con movs es válido (no es undefined)', () => {
    const r = computeSaldoMP({
      saldoInicial: 0,
      saldoInicialAt: '2026-04-30T00:00:00-03:00',
      movs: [
        { local_id: 1, monto: 12345.67, fecha: '2026-05-01T10:00:00-03:00' },
      ],
      localId: 1,
    });
    expect(r.total).toBe(12345.67);
  });

  it('redondea a 2 decimales (evita floating point drift)', () => {
    const r = computeSaldoMP({
      saldoInicial: 100,
      saldoInicialAt: '2026-04-30T00:00:00-03:00',
      movs: [
        { local_id: 1, monto: 0.1, fecha: '2026-05-01T10:00:00-03:00' },
        { local_id: 1, monto: 0.2, fecha: '2026-05-01T11:00:00-03:00' },
      ],
      localId: 1,
    });
    expect(r.total).toBe(100.3);  // sin redondeo daría 100.30000000000001
  });
});

describe('pickEffectiveLocalId', () => {
  it('localActivo set y visible → devuelve ese', () => {
    expect(pickEffectiveLocalId(2, [1, 2, 3])).toBe(2);
  });

  it('localActivo null + un único local visible → devuelve ese', () => {
    expect(pickEffectiveLocalId(null, [5])).toBe(5);
  });

  it('localActivo null + múltiples visibles → null (UI pide selección)', () => {
    expect(pickEffectiveLocalId(null, [1, 2, 3])).toBeNull();
  });

  it('localActivo set pero NO visible (scope cambió) → null', () => {
    expect(pickEffectiveLocalId(99, [1, 2, 3])).toBeNull();
  });

  it('sin locales visibles → null', () => {
    expect(pickEffectiveLocalId(1, [])).toBeNull();
    expect(pickEffectiveLocalId(null, [])).toBeNull();
  });
});
