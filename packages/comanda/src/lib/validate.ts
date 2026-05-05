// Validadores reusables. Devuelven null si OK, string con mensaje si error.

export function validarNombre(s: string | null | undefined, label = 'Nombre'): string | null {
  if (!s || !s.trim()) return `${label} no puede estar vacío`;
  if (s.trim().length > 200) return `${label} máximo 200 caracteres`;
  return null;
}

export function validarPrecio(n: number | null | undefined): string | null {
  if (n === null || n === undefined || Number.isNaN(n)) return 'Precio inválido';
  if (n < 0) return 'Precio no puede ser negativo';
  if (n > 99_999_999.99) return 'Precio fuera de rango';
  return null;
}

export function validarPorcentaje(n: number | null | undefined): string | null {
  if (n === null || n === undefined || Number.isNaN(n)) return 'Porcentaje inválido';
  if (n < -100 || n > 1000) return 'Porcentaje fuera de rango (-100% a 1000%)';
  return null;
}

export function validarSlug(s: string | null | undefined): string | null {
  if (!s || !s.trim()) return 'Slug requerido';
  if (!/^[a-z0-9-]+$/.test(s)) return 'Slug: solo minúsculas, números y guiones';
  if (s.length > 50) return 'Slug máximo 50 caracteres';
  return null;
}

export function validarMinMax(min: number, max: number | null): string | null {
  if (min < 0) return 'Mín no puede ser negativo';
  if (max !== null && max < min) return 'Máx no puede ser menor que mín';
  return null;
}
