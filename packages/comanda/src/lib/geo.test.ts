import { describe, expect, it } from 'vitest';
import { haversineKm } from './geo';

describe('haversineKm', () => {
  it('devuelve 0 para el mismo punto', () => {
    expect(haversineKm(-34.6037, -58.3816, -34.6037, -58.3816)).toBe(0);
  });

  it('distancia Obelisco CABA → Plaza Mayor La Plata ≈ 50-60 km', () => {
    // Obelisco aprox: -34.6037, -58.3816
    // Plaza Mayor La Plata: -34.9214, -57.9544
    const d = haversineKm(-34.6037, -58.3816, -34.9214, -57.9544);
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(60);
  });

  it('distancia Villa Crespo → Belgrano ≈ 5-7 km', () => {
    // Villa Crespo aprox: -34.5985, -58.4396
    // Belgrano aprox: -34.5612, -58.4587
    const d = haversineKm(-34.5985, -58.4396, -34.5612, -58.4587);
    expect(d).toBeGreaterThan(3);
    expect(d).toBeLessThan(8);
  });

  it('es simétrico (d(A,B) === d(B,A))', () => {
    const a = haversineKm(-34.6, -58.4, -34.7, -58.5);
    const b = haversineKm(-34.7, -58.5, -34.6, -58.4);
    expect(a).toBeCloseTo(b, 6);
  });

  it('puntos en lados opuestos del globo dan ~20015 km (media circunferencia)', () => {
    const d = haversineKm(0, 0, 0, 180);
    expect(d).toBeGreaterThan(20000);
    expect(d).toBeLessThan(20100);
  });
});
