// Tests del catálogo de features.ts.
//
// Las helpers son pure → testeamos sin mocks. Cubrimos:
//
//   - tenantTieneFeature: override gana, sin override usa default,
//     slug desconocido → false (defensivo).
//   - getFeatureDef: existente/no existente.
//   - featuresPorCategoria: agrupa todas y no pierde ninguna.
//   - Invariantes del catálogo: slugs únicos, categorías válidas.
//
// El catálogo es leído por el sidebar de PASE para gatear módulos enteros.
// Un slug duplicado o mal escrito acá rompe el acceso al módulo en prod.

import { describe, it, expect } from 'vitest';
import {
  FEATURES,
  tenantTieneFeature,
  getFeatureDef,
  featuresPorCategoria,
  CATEGORIAS_ORDEN,
} from '../features';

describe('tenantTieneFeature', () => {
  it('override true gana sobre default false', () => {
    expect(tenantTieneFeature('modulo.mensajeria', { 'modulo.mensajeria': true })).toBe(true);
  });

  it('override false gana sobre default true', () => {
    expect(tenantTieneFeature('modulo.caja', { 'modulo.caja': false })).toBe(false);
  });

  it('sin override usa default_habilitado del catálogo (caja=true)', () => {
    expect(tenantTieneFeature('modulo.caja', {})).toBe(true);
    expect(tenantTieneFeature('modulo.caja', null)).toBe(true);
    expect(tenantTieneFeature('modulo.caja', undefined)).toBe(true);
  });

  it('sin override usa default_habilitado del catálogo (mensajeria=false)', () => {
    expect(tenantTieneFeature('modulo.mensajeria', {})).toBe(false);
    expect(tenantTieneFeature('modulo.mensajeria', null)).toBe(false);
  });

  it('slug desconocido → false (defensivo: no exponer feature accidentalmente)', () => {
    expect(tenantTieneFeature('feature.que.no.existe', { 'feature.que.no.existe': true })).toBe(true);
    // Con override sí honra; sin override (no en catálogo) → false
    expect(tenantTieneFeature('feature.inexistente', {})).toBe(false);
    expect(tenantTieneFeature('feature.inexistente', null)).toBe(false);
  });

  it('override con valor truthy distinto de true → false (estricto con ===)', () => {
    // Por contrato sólo "true literal" cuenta como habilitado
    expect(tenantTieneFeature('modulo.caja', { 'modulo.caja': 1 as unknown as boolean })).toBe(false);
    expect(tenantTieneFeature('modulo.caja', { 'modulo.caja': 'true' as unknown as boolean })).toBe(false);
  });

  it('features beta tienen default=false', () => {
    const betas = FEATURES.filter((f) => f.beta);
    expect(betas.length).toBeGreaterThan(0);
    for (const f of betas) {
      expect(tenantTieneFeature(f.slug, {})).toBe(false);
    }
  });
});

describe('getFeatureDef', () => {
  it('devuelve la def cuando el slug existe', () => {
    const def = getFeatureDef('modulo.caja');
    expect(def).not.toBeNull();
    expect(def?.label).toBe('Caja');
    expect(def?.categoria).toBe('Operación');
    expect(def?.default_habilitado).toBe(true);
  });

  it('devuelve null cuando el slug no existe', () => {
    expect(getFeatureDef('no.existe.este.slug')).toBeNull();
  });
});

describe('featuresPorCategoria', () => {
  it('agrupa todas las features sin perder ninguna', () => {
    const grouped = featuresPorCategoria();
    const total = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
    expect(total).toBe(FEATURES.length);
  });

  it('todas las categorías del catálogo están en CATEGORIAS_ORDEN', () => {
    const grouped = featuresPorCategoria();
    for (const cat of Object.keys(grouped)) {
      expect(CATEGORIAS_ORDEN).toContain(cat);
    }
  });

  it('cada feature aparece exactamente en una categoría', () => {
    const grouped = featuresPorCategoria();
    const allSlugs = Object.values(grouped).flat().map((f) => f.slug);
    const uniqueSlugs = new Set(allSlugs);
    expect(uniqueSlugs.size).toBe(allSlugs.length);
  });
});

describe('invariantes del catálogo (regression)', () => {
  it('todos los slugs son únicos', () => {
    const slugs = FEATURES.map((f) => f.slug);
    const unique = new Set(slugs);
    if (unique.size !== slugs.length) {
      // Reportar el duplicado para que el dev sepa qué arreglar
      const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
      throw new Error(`Slugs duplicados en FEATURES: ${dupes.join(', ')}`);
    }
    expect(unique.size).toBe(slugs.length);
  });

  it('todos los slugs son lowercase + dot-separated (no espacios, no /, no UPPERCASE)', () => {
    for (const f of FEATURES) {
      expect(f.slug, `slug "${f.slug}" no cumple convención`).toMatch(/^[a-z][a-z0-9_.]*$/);
    }
  });

  it('toda feature tiene label y descripcion no vacíos', () => {
    for (const f of FEATURES) {
      expect(f.label.trim().length, `feature ${f.slug} sin label`).toBeGreaterThan(0);
      expect(f.descripcion.trim().length, `feature ${f.slug} sin descripcion`).toBeGreaterThan(0);
    }
  });

  it('toda categoría usada está en CATEGORIAS_ORDEN', () => {
    for (const f of FEATURES) {
      expect(CATEGORIAS_ORDEN, `categoria "${f.categoria}" no en CATEGORIAS_ORDEN`).toContain(f.categoria);
    }
  });

  it('toda feature con beta=true está en categoría "Beta" o tiene default_habilitado=false', () => {
    // Convención: betas arrancan apagadas para no romper tenants en prod
    for (const f of FEATURES) {
      if (f.beta) {
        expect(f.default_habilitado, `beta ${f.slug} debería arrancar default=false`).toBe(false);
      }
    }
  });
});
