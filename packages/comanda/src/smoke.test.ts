// Smoke test minimal — solo para que vitest tenga al menos 1 test que correr
// y CI no falle por "no test files found". Se reemplaza por tests reales
// cuando comanda crezca.
import { describe, it, expect } from 'vitest';

describe('comanda scaffold', () => {
  it('vitest funciona en este package', () => {
    expect(1 + 1).toBe(2);
  });
});
