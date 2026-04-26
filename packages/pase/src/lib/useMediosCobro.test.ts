import { describe, it, expect } from "vitest";

// Reimporta las funciones puras de useMediosCobro.ts para testearlas sin
// arrastrar el import de ./supabase (que rompe vitest porque hace fetch a
// https en module-scope). Mismo patrón que useCategorias.test.ts.

interface MedioCobro {
  id: number;
  nombre: string;
  local_id: number | null;
  cuenta_destino: string | null;
  activo: boolean;
  orden: number;
}

function pickDisponibles(medios: MedioCobro[], localId: number | null): MedioCobro[] {
  const visibles = medios.filter(m => m.activo && (m.local_id === null || m.local_id === localId));
  const byNombre = new Map<string, MedioCobro>();
  for (const m of visibles) {
    const existing = byNombre.get(m.nombre);
    if (!existing) { byNombre.set(m.nombre, m); continue; }
    if (existing.local_id === null && m.local_id !== null) byNombre.set(m.nombre, m);
  }
  return [...byNombre.values()].sort((a, b) => (a.orden || 0) - (b.orden || 0));
}

function pickCuentaDestino(medios: MedioCobro[], nombre: string, localId: number | null): string | null {
  const candidatos = medios.filter(m => m.activo && m.nombre === nombre && (m.local_id === null || m.local_id === localId));
  if (candidatos.length === 0) return null;
  const ganador = candidatos.find(m => m.local_id !== null) || candidatos[0];
  return ganador.cuenta_destino;
}

const mk = (over: Partial<MedioCobro>): MedioCobro => ({
  id: 0, nombre: "X", local_id: null, cuenta_destino: null, activo: true, orden: 0, ...over,
});

describe("pickDisponibles", () => {
  it("incluye globales (local_id NULL) y los del local activo", () => {
    const medios: MedioCobro[] = [
      mk({ id: 1, nombre: "EFECTIVO", local_id: null, orden: 1 }),
      mk({ id: 2, nombre: "QR LOCAL2", local_id: 2, orden: 2 }),
      mk({ id: 3, nombre: "QR LOCAL3", local_id: 3, orden: 3 }),
    ];
    const r = pickDisponibles(medios, 2);
    expect(r.map(m => m.nombre)).toEqual(["EFECTIVO", "QR LOCAL2"]);
  });

  it("excluye inactivos", () => {
    const medios: MedioCobro[] = [
      mk({ id: 1, nombre: "EFECTIVO", local_id: null, activo: true, orden: 1 }),
      mk({ id: 2, nombre: "RAPPI ONLINE", local_id: null, activo: false, orden: 2 }),
    ];
    expect(pickDisponibles(medios, 1).map(m => m.nombre)).toEqual(["EFECTIVO"]);
  });

  it("ordena por orden ascendente", () => {
    const medios: MedioCobro[] = [
      mk({ id: 1, nombre: "B", local_id: null, orden: 2 }),
      mk({ id: 2, nombre: "A", local_id: null, orden: 1 }),
      mk({ id: 3, nombre: "C", local_id: null, orden: 3 }),
    ];
    expect(pickDisponibles(medios, 1).map(m => m.nombre)).toEqual(["A", "B", "C"]);
  });

  it("local-specific gana sobre global con mismo nombre (override del dueño)", () => {
    const medios: MedioCobro[] = [
      mk({ id: 1, nombre: "EFECTIVO", local_id: null, cuenta_destino: "Caja Chica", orden: 1 }),
      mk({ id: 2, nombre: "EFECTIVO", local_id: 5, cuenta_destino: "Caja Mayor", orden: 1 }),
    ];
    const r = pickDisponibles(medios, 5);
    expect(r).toHaveLength(1);
    expect(r[0].cuenta_destino).toBe("Caja Mayor");
    expect(r[0].local_id).toBe(5);
  });

  it("con localId NULL devuelve solo globales", () => {
    const medios: MedioCobro[] = [
      mk({ id: 1, nombre: "EFECTIVO", local_id: null, orden: 1 }),
      mk({ id: 2, nombre: "QR LOCAL", local_id: 2, orden: 2 }),
    ];
    expect(pickDisponibles(medios, null).map(m => m.nombre)).toEqual(["EFECTIVO"]);
  });

  it("array vacío si no hay matches", () => {
    expect(pickDisponibles([], 1)).toEqual([]);
  });
});

describe("pickCuentaDestino", () => {
  it("devuelve cuenta del medio global cuando no hay override local", () => {
    const medios: MedioCobro[] = [
      mk({ id: 1, nombre: "EFECTIVO SALON", local_id: null, cuenta_destino: "Caja Chica" }),
    ];
    expect(pickCuentaDestino(medios, "EFECTIVO SALON", 1)).toBe("Caja Chica");
  });

  it("local-specific override sobre global", () => {
    const medios: MedioCobro[] = [
      mk({ id: 1, nombre: "EFECTIVO", local_id: null, cuenta_destino: "Caja Chica" }),
      mk({ id: 2, nombre: "EFECTIVO", local_id: 7, cuenta_destino: "Caja Mayor" }),
    ];
    expect(pickCuentaDestino(medios, "EFECTIVO", 7)).toBe("Caja Mayor");
  });

  it("devuelve null si el medio no existe", () => {
    expect(pickCuentaDestino([], "INEXISTENTE", 1)).toBeNull();
  });

  it("devuelve null si la cuenta_destino del medio es null (medios no-efectivo)", () => {
    const medios: MedioCobro[] = [
      mk({ id: 1, nombre: "TARJETA CREDITO", local_id: null, cuenta_destino: null }),
    ];
    expect(pickCuentaDestino(medios, "TARJETA CREDITO", 1)).toBeNull();
  });

  it("ignora medios inactivos", () => {
    const medios: MedioCobro[] = [
      mk({ id: 1, nombre: "EFECTIVO", local_id: null, cuenta_destino: "Caja Chica", activo: false }),
    ];
    expect(pickCuentaDestino(medios, "EFECTIVO", 1)).toBeNull();
  });

  it("ignora rows de otros locales que no sean el activo", () => {
    const medios: MedioCobro[] = [
      mk({ id: 1, nombre: "EFECTIVO", local_id: 2, cuenta_destino: "Caja Chica" }),
    ];
    expect(pickCuentaDestino(medios, "EFECTIVO", 5)).toBeNull();
  });
});
