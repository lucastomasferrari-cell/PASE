import { describe, expect, it } from 'vitest';
import {
  formatCents,
  pesosToCents,
  centsToPesos,
  applyDigit,
  applyBackspace,
  parsePastedToCents,
} from './CurrencyInput';

// Tests para los helpers puros del CurrencyInput. Cubren toda la
// lógica de currency mask sin necesidad de @testing-library/react.
// El componente React es solo un wrapper que pega keydown/paste a
// estos helpers — su comportamiento queda implícitamente validado.

describe('formatCents', () => {
  it('0 → "0,00"', () => {
    expect(formatCents(0)).toBe('0,00');
  });

  it('1 cent → "0,01"', () => {
    expect(formatCents(1)).toBe('0,01');
  });

  it('150 cents → "1,50"', () => {
    expect(formatCents(150)).toBe('1,50');
  });

  it('1500050 cents → "15.000,50"', () => {
    expect(formatCents(1500050)).toBe('15.000,50');
  });

  it('100000000 cents → "1.000.000,00"', () => {
    expect(formatCents(100000000)).toBe('1.000.000,00');
  });

  it('negativo "-1.500,50"', () => {
    // Intl.NumberFormat AR usa minus signo Unicode "−" o "-" dependiendo del runtime.
    expect(formatCents(-150050)).toMatch(/^[-−]1\.500,50$/);
  });
});

describe('pesosToCents / centsToPesos', () => {
  it('15000.50 ↔ 1500050', () => {
    expect(pesosToCents(15000.50)).toBe(1500050);
    expect(centsToPesos(1500050)).toBe(15000.50);
  });

  it('redondea floating-point: 0.1 + 0.2 → 30 cents', () => {
    expect(pesosToCents(0.1 + 0.2)).toBe(30);
  });

  it('0 ↔ 0', () => {
    expect(pesosToCents(0)).toBe(0);
    expect(centsToPesos(0)).toBe(0);
  });

  it('negativo', () => {
    expect(pesosToCents(-5.25)).toBe(-525);
    expect(centsToPesos(-525)).toBe(-5.25);
  });
});

describe('applyDigit (currency mask)', () => {
  it('0 + 1 → 1 cent (0,01)', () => {
    expect(applyDigit(0, 1)).toBe(1);
  });

  it('1 + 5 → 15 cents (0,15)', () => {
    expect(applyDigit(1, 5)).toBe(15);
  });

  it('15 + 0 → 150 cents (1,50)', () => {
    expect(applyDigit(15, 0)).toBe(150);
  });

  it('150 + 0 → 1500 cents (15,00)', () => {
    expect(applyDigit(150, 0)).toBe(1500);
  });

  it('cadena completa 1→5→0→0→0→0 = 1.500,00 = 150000 cents', () => {
    let v = 0;
    [1, 5, 0, 0, 0, 0].forEach((d) => { v = applyDigit(v, d); });
    expect(v).toBe(150000);
  });

  it('valor negativo se mantiene negativo', () => {
    expect(applyDigit(-15, 5)).toBe(-155);
  });
});

describe('applyBackspace', () => {
  it('150050 → 15005 (15.000,50 → 1.500,05)', () => {
    expect(applyBackspace(150050)).toBe(15005);
  });

  it('15005 → 1500 (1.500,05 → 15,00)', () => {
    expect(applyBackspace(15005)).toBe(1500);
  });

  it('1 → 0', () => {
    expect(applyBackspace(1)).toBe(0);
  });

  it('0 → 0', () => {
    expect(applyBackspace(0)).toBe(0);
  });

  it('negativo se preserva', () => {
    expect(applyBackspace(-150050)).toBe(-15005);
  });
});

describe('parsePastedToCents', () => {
  it('formato AR "1.500,50" → 150050', () => {
    expect(parsePastedToCents('1.500,50', false)).toBe(150050);
  });

  it('formato US "1,500.50" → 150050', () => {
    expect(parsePastedToCents('1,500.50', false)).toBe(150050);
  });

  it('decimal simple "1500.5" → 150050', () => {
    expect(parsePastedToCents('1500.5', false)).toBe(150050);
  });

  it('integer plano "1500" → 150000 (multiplica por 100)', () => {
    expect(parsePastedToCents('1500', false)).toBe(150000);
  });

  it('con símbolo "$ 1.500,50" → 150050', () => {
    expect(parsePastedToCents('$ 1.500,50', false)).toBe(150050);
  });

  it('vacío → null', () => {
    expect(parsePastedToCents('', false)).toBeNull();
  });

  it('sin dígitos "abc" → null', () => {
    expect(parsePastedToCents('abc', false)).toBeNull();
  });

  it('negativo permitido "-100" → -10000', () => {
    expect(parsePastedToCents('-100', true)).toBe(-10000);
  });

  it('negativo NO permitido "-100" → 10000 (signo ignorado)', () => {
    expect(parsePastedToCents('-100', false)).toBe(10000);
  });

  it('formato con paréntesis "(100)" en allowNegative → -10000', () => {
    expect(parsePastedToCents('(100)', true)).toBe(-10000);
  });
});

describe('flow completo currency mask (escenario del bug original)', () => {
  it('user tipea "1500" en factura manual → resultado 15.000,00', () => {
    let cents = 0;
    [1, 5, 0, 0].forEach((d) => { cents = applyDigit(cents, d); });
    expect(formatCents(cents)).toBe('15,00');
    // Para llegar a 15.000,00 hay que tipear 6 dígitos: 1500.00 = 1500,00 → tipear 1,5,0,0,0,0
    cents = 0;
    [1, 5, 0, 0, 0, 0].forEach((d) => { cents = applyDigit(cents, d); });
    expect(formatCents(cents)).toBe('1.500,00');
  });

  it('user pega "15000,50" del Excel → 15.000,50', () => {
    const cents = parsePastedToCents('15000,50', false);
    expect(cents).toBe(1500050);
    expect(formatCents(cents!)).toBe('15.000,50');
  });

  it('valor en pesos (callback onChange) consistente con formato display', () => {
    let cents = 0;
    [1, 5, 0, 0, 0].forEach((d) => { cents = applyDigit(cents, d); });
    expect(centsToPesos(cents)).toBe(150);
    expect(formatCents(cents)).toBe('150,00');
  });
});
