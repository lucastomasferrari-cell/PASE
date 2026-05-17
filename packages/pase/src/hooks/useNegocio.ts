// Hooks de datos para la pantalla Negocio.
//
// Vista ejecutiva del dueño/gerente: foco en plata, rentabilidad y objetivos.
// Por ahora retornan data MOCK realista (números). LOS NOMBRES DE LOCALES
// son reales — vienen del prop `locales` del tenant. Segunda iteración:
//   - useNegocioConsolidado: agrega ventas + costos + margen cross-local.
//   - useNegocioLocal(localId): mismo agregado filtrado por local.
//   - useObjetivos: lectura de la tabla objetivos_mes (a crear) — facturación,
//     costo de mercadería, ticket promedio, costo MP, margen, configurados
//     por dueño mes a mes.

export type LocalCtx = "consolidado" | string;

export interface LocalRef { id: number; nombre: string }

export interface NegocioKpis {
  facturacionMes: number;
  proyectadoFinMes: number;
  diaActual: number;
  diasDelMes: number;
  /** % del objetivo cumplido (0-100+) */
  pctObjetivo: number;
  /** Objetivo de facturación del mes */
  objetivoFacturacion: number;
  /** Frase ejecutiva: "vamos por encima del ritmo" / "atrasados" */
  ritmo: string;
  /** Delta % vs mes anterior */
  deltaMesAnterior: number;

  margenBruto: { value: string; delta: string; spark: number[]; tone: "up" | "muted" };
  costoMercaderia: { value: string; delta: string; spark: number[]; tone: "up" | "muted" };
  rentabilidadNeta: { value: number; delta: string; spark: number[]; tone: "up" | "muted" };
  ticketPromedio: { value: number; delta: string; spark: number[]; tone: "up" | "muted" };

  proyeccion: {
    facturacion: { value: number; sub: string };
    costos: { value: number; sub: string };
    rentabilidad: { value: number; sub: string };
  };

  /** Performance por local — ranking del mes */
  performanceLocales: Array<{
    nombre: string;
    facturacion: number;
    /** width 0-100 para la barra (% relativo al mejor) */
    pctBar: number;
  }>;
  /** Frase ejecutiva del ranking */
  performanceFooter: { texto: string; valoresDestacados: string[] };
}

export interface ObjetivoMes {
  id: string;
  /** "ok" celeste · "warn" dorado · "lejos" celeste-300 */
  tone: "ok" | "warn" | "lejos";
  nombre: string;
  detalle: string;
  valorActual: string;
  valorObjetivo: string;
}

/** Datos consolidados del tenant para el mes actual. Mock numérico, NOMBRES
 * REALES desde el prop `locales`. Cuando se conecte al backend real,
 * `performanceLocales` saldrá de una query agrupada por local_id. */
export function useNegocioConsolidado(
  _ctx: LocalCtx = "consolidado",
  locales: LocalRef[] = [],
): NegocioKpis {
  // Performance por local: usa los locales reales del tenant. Repartimos
  // la facturación mock entre ellos en proporción decreciente (primer
  // local lidera). Cuando lleguen los números reales de DB, esto se
  // reemplaza con la query agregada.
  const facturacionTotal = 28_450_000;
  const sortedLocales = [...locales]; // copia para no mutar
  // Pesos arbitrarios para distribuir mock (decreciente). Total = 100.
  const pesos = sortedLocales.length === 0
    ? []
    : sortedLocales.length === 1
      ? [100]
      : sortedLocales.length === 2
        ? [57, 43]
        : sortedLocales.length === 3
          ? [42, 33, 25]
          : sortedLocales.length === 4
            ? [35, 28, 22, 15]
            : Array.from({ length: sortedLocales.length }, (_, i) =>
                Math.max(5, Math.round(100 / sortedLocales.length * (sortedLocales.length - i) / sortedLocales.length * 2)),
              );
    // Normalizar pesos para que sumen ~100
  const totalPesos = pesos.reduce((s, p) => s + p, 0) || 1;
  const maxPeso = Math.max(...pesos, 1);

  const performanceLocales = sortedLocales.map((l, i) => {
    const peso = pesos[i] ?? 1;
    const facturacion = Math.round((facturacionTotal * peso) / totalPesos);
    const pctBar = Math.round((peso / maxPeso) * 100);
    return { nombre: l.nombre, facturacion, pctBar };
  });

  // Footer: si hay >= 2 locales, comparamos los 2 primeros; si no, mensaje genérico.
  const performanceFooter = sortedLocales.length >= 2
    ? {
        texto: `${sortedLocales[0]!.nombre} lidera con __1__ de diferencia. ${sortedLocales[1]!.nombre} viene mejorando: __2__ vs. abril.`,
        valoresDestacados: ["+32.8%", "+14%"],
      }
    : {
        texto: `Único local activo este mes. Compará contra el ritmo del mes anterior.`,
        valoresDestacados: [],
      };

  return {
    facturacionMes: facturacionTotal,
    proyectadoFinMes: 42_100_000,
    diaActual: 13,
    diasDelMes: 31,
    pctObjetivo: 68,
    objetivoFacturacion: 42_000_000,
    ritmo: "Vamos por encima del ritmo",
    deltaMesAnterior: 8.2,

    margenBruto:     { value: "31.4%",  delta: "+1.8 pts vs. abril", spark: [22, 26, 28, 30, 32, 33, 35], tone: "up" },
    costoMercaderia: { value: "34.8%",  delta: "Objetivo 32%",       spark: [38, 36, 35, 36, 35, 34, 35], tone: "muted" },
    rentabilidadNeta: { value: 4_620_000, delta: "+12.1% vs. abril",  spark: [28, 32, 36, 40, 44, 50, 56], tone: "up" },
    ticketPromedio:   { value: 8_380,     delta: "+3.4%",             spark: [62, 64, 66, 68, 70, 72, 75], tone: "up" },

    proyeccion: {
      facturacion:   { value: 42_100_000, sub: "Objetivo: $40M · +5.3%" },
      costos:        { value: 28_900_000, sub: "Mercadería + fijos + sueldos" },
      rentabilidad:  { value: 13_200_000, sub: "Margen final 31.4%" },
    },

    performanceLocales,
    performanceFooter,
  };
}

/** Objetivos del mes — config en backend, presente en pantalla. Mock. */
export function useObjetivos(_ctx: LocalCtx = "consolidado"): ObjetivoMes[] {
  return [
    {
      id: "o1",
      tone: "ok",
      nombre: "Facturación mensual",
      detalle: "Por encima del ritmo",
      valorActual: "105%",
      valorObjetivo: "100%",
    },
    {
      id: "o2",
      tone: "warn",
      nombre: "Costo de mercadería",
      detalle: "2.8 pts arriba del objetivo",
      valorActual: "34.8%",
      valorObjetivo: "32%",
    },
    {
      id: "o3",
      tone: "ok",
      nombre: "Ticket promedio",
      detalle: "Llegó a la meta",
      valorActual: "$8.380",
      valorObjetivo: "$8.000",
    },
    {
      id: "o4",
      tone: "lejos",
      nombre: "Reducir costo MP",
      detalle: "Falta camino: 0.7 pts",
      valorActual: "4.2%",
      valorObjetivo: "3.5%",
    },
    {
      id: "o5",
      tone: "ok",
      nombre: "Margen bruto",
      detalle: "Mejoró 1.8 pts",
      valorActual: "31.4%",
      valorObjetivo: "30%",
    },
  ];
}
