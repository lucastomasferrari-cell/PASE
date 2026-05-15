import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
vi.mock('../lib/supabase', () => ({
  db: { from: (...args: unknown[]) => mockFrom(...args) },
}));

import { calcularCostoPorPorcion } from './recetasService';
import type { RecetaConInsumos } from './recetasService';

beforeEach(() => { mockFrom.mockReset(); });

describe('calcularCostoPorPorcion', () => {
  const recetaBase = (insumos: Array<{ costo: number | null; cantidad: number; merma: number }>): RecetaConInsumos => ({
    id: 1, tenant_id: 't', local_id: null,
    created_at: '', updated_at: '', deleted_at: null,
    created_by: null, updated_by: null,
    item_id: 100, nombre: 'Test', rendimiento: 1, notas: null, activa: true,
    insumos: insumos.map((i, idx) => ({
      id: idx, tenant_id: 't',
      created_at: '', updated_at: '', deleted_at: null,
      created_by: null, updated_by: null,
      receta_id: 1, insumo_id: 200 + idx,
      cantidad: i.cantidad, merma_pct: i.merma, notas: null, orden: idx,
      insumo: { id: 200 + idx, nombre: 'X', unidad: 'kg', emoji: null, costo_actual: i.costo },
    })),
  });

  it('receta vacía → costo 0', () => {
    const r = recetaBase([]);
    expect(calcularCostoPorPorcion(r)).toBe(0);
  });

  it('1 insumo sin merma + rendimiento 1', () => {
    const r = recetaBase([{ costo: 1000, cantidad: 0.5, merma: 0 }]);
    expect(calcularCostoPorPorcion(r)).toBe(500); // 1000 × 0.5 × 1.0 / 1
  });

  it('1 insumo con merma 10% + rendimiento 1', () => {
    const r = recetaBase([{ costo: 1000, cantidad: 1, merma: 10 }]);
    expect(calcularCostoPorPorcion(r)).toBe(1100); // 1000 × 1 × 1.10 / 1
  });

  it('rendimiento 10 → cada porción cuesta 1/10', () => {
    const r = { ...recetaBase([{ costo: 1000, cantidad: 1, merma: 0 }]), rendimiento: 10 };
    expect(calcularCostoPorPorcion(r)).toBe(100); // 1000 / 10
  });

  it('2 insumos suman', () => {
    const r = recetaBase([
      { costo: 1000, cantidad: 0.5, merma: 0 }, // 500
      { costo: 200, cantidad: 2, merma: 0 },    // 400
    ]);
    expect(calcularCostoPorPorcion(r)).toBe(900);
  });

  it('algún insumo sin costo_actual → null (no se puede calcular)', () => {
    const r = recetaBase([
      { costo: 1000, cantidad: 1, merma: 0 },
      { costo: null, cantidad: 1, merma: 0 },
    ]);
    expect(calcularCostoPorPorcion(r)).toBeNull();
  });
});

// NOTA: `upsertReceta` no se testea unit-mocked porque hace múltiples llamadas
// encadenadas a Supabase JS y mockear toda la secuencia es frágil. El flow real
// se cubrirá con un test E2E mutante futuro en packages/pase/tests/
// (siguiendo el patrón cmv_insumos_recetas_mutante.spec.ts de F1.1).
