// Simulador de escenarios del EERR — función pura, sin estado ni I/O.
// Recalcula el Estado de Resultados aplicando ajustes por línea ($ o %).
// Las líneas son independientes: cambiar una NO escala a las otras (decisión
// de producto, Lucas 16-jun). Ver spec 2026-06-16-simulador-escenarios-eerr-design.md.

export interface LineasEERR {
  ventas: number;
  cmv: number;
  gastosFijos: number;
  gastosVar: number;
  sueldos: number;
  cargasSociales: number;   // incluye boletas sindicales (igual que MesResumen del EERR)
  publicidad: number;
  comisiones: number;
  impuestos: number;
  otrosGastos: number;
}

export type AjusteLinea =
  | { tipo: "abs"; valor: number }   // nuevo monto absoluto en $
  | { tipo: "pct"; valor: number };  // ajuste relativo en % (ej. -10 = bajar 10%)

export interface ResultadoEERR {
  lineas: LineasEERR;   // los montos resultantes tras aplicar los ajustes
  utilBruta: number;    // ventas - cmv
  utilNeta: number;     // utilBruta - gastos operativos
  margenNeto: number;   // utilNeta / ventas (0 si ventas <= 0)
}

const KEYS_GASTO: (keyof LineasEERR)[] = [
  "gastosFijos", "gastosVar", "sueldos", "cargasSociales",
  "publicidad", "comisiones", "impuestos", "otrosGastos",
];

/** Aplica un ajuste a un valor base. Sin ajuste → devuelve la base. */
export function aplicarAjuste(base: number, ajuste: AjusteLinea | undefined): number {
  if (!ajuste) return base;
  if (ajuste.tipo === "abs") return ajuste.valor;
  return base * (1 + ajuste.valor / 100);
}

/** Recalcula el EERR aplicando los ajustes por línea. Función pura. */
export function simularEERR(
  base: LineasEERR,
  ajustes: Partial<Record<keyof LineasEERR, AjusteLinea>>,
): ResultadoEERR {
  const lineas = {} as LineasEERR;
  (Object.keys(base) as (keyof LineasEERR)[]).forEach((k) => {
    lineas[k] = aplicarAjuste(base[k], ajustes[k]);
  });
  const utilBruta = lineas.ventas - lineas.cmv;
  const gastosOperativos = KEYS_GASTO.reduce((s, k) => s + lineas[k], 0);
  const utilNeta = utilBruta - gastosOperativos;
  const margenNeto = lineas.ventas > 0 ? utilNeta / lineas.ventas : 0;
  return { lineas, utilBruta, utilNeta, margenNeto };
}
