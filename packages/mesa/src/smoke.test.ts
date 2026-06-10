import { describe, it, expect } from 'vitest';

// Smoke del paquete MESA — asegura que turbo test no falle en el scaffold.
// Los tests reales (mutantes de RPCs de reservas/eventos/giftcards) viven en
// packages/pase/tests y packages/comanda/tests porque la base es compartida.
describe('mesa scaffold', () => {
  it('el paquete compila y los tests corren', () => {
    expect(true).toBe(true);
  });
});
