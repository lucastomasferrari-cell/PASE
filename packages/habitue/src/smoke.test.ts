import { describe, it, expect } from 'vitest';

// Smoke del paquete Habitué — asegura que turbo test no falle en el scaffold.
describe('habitue scaffold', () => {
  it('el paquete compila y los tests corren', () => {
    expect(true).toBe(true);
  });
});
