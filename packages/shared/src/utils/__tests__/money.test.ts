// Tests del módulo money — math en centavos para evitar floating point bugs.
//
// El bug clásico es 0.1 + 0.2 = 0.30000000000000004. moneyAdd(0.1, 0.2) → 0.30.
// Si esto rompe, pagos/EERR/saldos quedan con desbalances de 0.01 random.

import { describe, it, expect } from 'vitest';
import { moneyAdd, moneySub, moneyMul, moneyRound, moneyEq, moneyKey, moneySum } from '../money';

describe('moneyAdd', () => {
  it('0.1 + 0.2 = 0.30 (sin bug de floating point)', () => {
    expect(moneyAdd(0.1, 0.2)).toBe(0.30);
  });

  it('suma de varios', () => {
    expect(moneyAdd(100.50, 200.25, 50.10)).toBe(350.85);
  });

  it('lista vacía → 0', () => {
    expect(moneyAdd()).toBe(0);
  });

  it('null/NaN → 0 en la suma', () => {
    expect(moneyAdd(100, NaN as unknown as number)).toBe(100);
  });
});

describe('moneySub', () => {
  it('1000 - 100.50 = 899.50', () => {
    expect(moneySub(1000, 100.50)).toBe(899.50);
  });

  it('resta que da negativo', () => {
    expect(moneySub(50, 100)).toBe(-50);
  });
});

describe('moneyMul', () => {
  it('100 * 0.21 (21% IVA) = 21.00', () => {
    expect(moneyMul(100, 0.21)).toBe(21);
  });

  it('1000 * 0.105 = 105.00', () => {
    expect(moneyMul(1000, 0.105)).toBe(105);
  });

  it('redondea correctamente', () => {
    // 100 * 0.333 = 33.3 → redondea a centavos → 33.30
    expect(moneyMul(100, 0.333)).toBe(33.30);
  });
});

describe('moneyRound', () => {
  it('239.889999 → 239.89 (banker rounding aprox)', () => {
    expect(moneyRound(239.889999)).toBe(239.89);
  });

  it('0 → 0', () => expect(moneyRound(0)).toBe(0));

  it('100.005 → 100.01 (round half up)', () => {
    expect(moneyRound(100.005)).toBe(100.01);
  });
});

describe('moneyEq', () => {
  it('100.00 ≈ 100.000001 (tolerancia centavo)', () => {
    expect(moneyEq(100.00, 100.000001)).toBe(true);
  });

  it('100.00 ≠ 100.01', () => {
    expect(moneyEq(100.00, 100.01)).toBe(false);
  });

  it('manejo de signo', () => {
    expect(moneyEq(-50, -50.00)).toBe(true);
  });
});

describe('moneyKey', () => {
  it('100.50 → "10050" (centavos como string para Map keys)', () => {
    expect(moneyKey(100.50)).toBe('10050');
  });

  it('0 → "0"', () => expect(moneyKey(0)).toBe('0'));

  it('mismos centavos → misma key (útil para dedup)', () => {
    expect(moneyKey(0.1 + 0.2)).toBe(moneyKey(0.3));
  });
});

describe('moneySum', () => {
  it('suma con extractor', () => {
    const items = [{ x: 100 }, { x: 200.50 }, { x: 50.25 }];
    expect(moneySum(items, (i) => i.x)).toBe(350.75);
  });

  it('lista vacía → 0', () => {
    expect(moneySum([], (i: { x: number }) => i.x)).toBe(0);
  });
});
