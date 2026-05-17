// Hooks de datos para la pantalla Finanzas.
//
// Por ahora retornan data MOCK realista (gastronomía argentina tipo Neko).
// La segunda iteración conectará a:
//   - useFinanzasConsolidado: agrega ventas + facturas + gastos + saldos_caja
//     cruzando todos los locales del tenant (RLS + applyLocalScope sin local).
//   - useLocalFinanzas: misma agregación pero filtrada por local_id.
//   - useVencimientos: facturas no pagadas + servicios recurrentes con
//     fecha de vencimiento <= hoy + N días.
//
// NO incluir Mercado Pago ni cuentas bancarias en estos hooks hasta que la
// conciliación esté operativa. Solo efectivo en caja (saldos_caja con
// cuenta="Caja Efectivo" o equivalente).

import type { LocalCardProps } from "../components/ui/LocalCard";

export interface LocalRef { id: number; nombre: string }

export interface FinanzasConsolidado {
  efectivoTotal: number;
  flow: { entro: number; salio: number; resultado: number };
  porPagar30d: { total: number; estaSemana: number; spark: number[] };
  cierreProyectado: { total: number; sub: string; spark: number[] };
  margenBruto: { value: string; delta: string; spark: number[] };
}

export interface Vencimiento {
  id: string;
  dia: number;
  mes: string;
  /** true si vence en <=7 días (date box pintada celeste) */
  inminente: boolean;
  nombre: string;
  descripcion: string;
  local: { nombre: string; tone: "primary" | "muted" };
  monto: number;
  diasRestantes: number;
}

/** Datos consolidados (cross-local) del tenant. Mock. */
export function useFinanzasConsolidado(): FinanzasConsolidado {
  return {
    efectivoTotal: 1_240_000,
    flow: { entro: 28_450_000, salio: 26_110_000, resultado: 2_340_000 },
    porPagar30d: {
      total: 4_820_000,
      estaSemana: 1_100_000,
      spark: [22, 28, 36, 30, 48, 42, 58],
    },
    cierreProyectado: {
      total: 3_180_000,
      sub: "Resultado proyectado fin de mes",
      spark: [40, 38, 44, 42, 50, 54, 62],
    },
    margenBruto: {
      value: "41.6%",
      delta: "+ 1.8 pts vs. abril",
      spark: [34, 36, 38, 36, 40, 41, 42],
    },
  };
}

/** Lista de locales con sus datos financieros del mes.
 * MOCK numérico, NOMBRES REALES desde el prop `locales` del tenant.
 * El primer local del array es el "líder" mock, los demás se distribuyen
 * proporcionalmente. Cuando se conecte al backend real, esto va a ser una
 * query agrupada por local_id sumando ventas + saldos + vencimientos. */
export function useLocalFinanzas(locales: LocalRef[] = []): LocalCardProps[] {
  if (locales.length === 0) return [];

  // Templates mock: el "líder" (variant=leading) y el resto (variant=behind).
  // Distribuyo magnitudes decreciente — el primer local lidera.
  const baseFacturacion = 14_800_000;
  const baseStep = 0.78; // cada local siguiente factura ~78% del anterior

  return locales.map((local, i) => {
    const factor = Math.pow(baseStep, i);
    const facturacion = Math.round(baseFacturacion * factor);
    const entro = Math.round(facturacion * 1.16);
    const salio = Math.round(entro * 0.85);
    const isLeader = i === 0;
    return {
      name: local.nombre,
      badge: isLeader
        ? { text: "líder", variant: "default" }
        : i === locales.length - 1 && locales.length > 1
          ? { text: "debajo del ritmo", variant: "warn" }
          : { text: "en ritmo", variant: "default" },
      variant: isLeader ? "leading" : "behind",
      metaInfo: `42 días operados · ${12 - i} personas`,
      facturacionMes: facturacion,
      flow: { entro, salio, resultado: entro - salio },
      kpis: {
        margen: {
          value: `${(44.2 - i * 1.8).toFixed(1)}%`,
          delta: isLeader ? "+2.1 pts" : "−1.4 pts",
          tone: isLeader ? "up" : "warn",
        },
        ticketProm: {
          value: Math.round(4_820 * factor),
          delta: "+1.1% vs. abril",
          tone: "up",
        },
        tickets: {
          value: Math.round(1_842 * factor),
          delta: isLeader ? "+6.2% vs. abril" : "−3.8% vs. abril",
          tone: isLeader ? "up" : "warn",
        },
      },
      spark7d: [38, 42, 50, 46, 58, 64, 72].map((v) => Math.round(v * factor)),
      spark7dLastAmount: Math.round(612_400 * factor),
      efectivoCaja: Math.round(780_000 * factor),
      venceSemana: isLeader
        ? { amount: 0, warn: false }
        : { amount: Math.round(1_120_000 * factor), warn: true },
    };
  });
}

/** Próximos vencimientos (facturas / servicios recurrentes). MOCK
 * numérico, nombres de locales reales rotando. */
export function useVencimientos(locales: LocalRef[] = []): Vencimiento[] {
  // Si no hay locales pasados, devolvemos mock con "—" como placeholder.
  const nombres = locales.length > 0 ? locales.map((l) => l.nombre) : ["—"];
  const ambosLabel = locales.length >= 2 ? "Todos los locales" : nombres[0]!;
  // Rotador para asignar locales a cada vencimiento sin hardcodear.
  const pick = (i: number) => nombres[i % nombres.length]!;

  return [
    {
      id: "v1",
      dia: 16, mes: "MAY",
      inminente: true,
      nombre: "Provid SA",
      descripcion: `Insumos cocina · ${pick(0)}`,
      local: { nombre: pick(0), tone: "primary" },
      monto: 412_300,
      diasRestantes: 3,
    },
    {
      id: "v2",
      dia: 18, mes: "MAY",
      inminente: true,
      nombre: "Edesur",
      descripcion: `Servicio eléctrico · ${ambosLabel}`,
      local: { nombre: ambosLabel, tone: "muted" },
      monto: 286_500,
      diasRestantes: 5,
    },
    {
      id: "v3",
      dia: 20, mes: "MAY",
      inminente: true,
      nombre: "Don Carmelo",
      descripcion: `Frutas y verduras · ${pick(1)}`,
      local: { nombre: pick(1), tone: "muted" },
      monto: 184_700,
      diasRestantes: 7,
    },
    {
      id: "v4",
      dia: 25, mes: "MAY",
      inminente: false,
      nombre: "AFIP — IVA",
      descripcion: `Posición mensual · ${ambosLabel}`,
      local: { nombre: ambosLabel, tone: "muted" },
      monto: 1_240_000,
      diasRestantes: 12,
    },
    {
      id: "v5",
      dia: 28, mes: "MAY",
      inminente: false,
      nombre: "Aguas Argentinas",
      descripcion: `Servicio · ${pick(0)}`,
      local: { nombre: pick(0), tone: "primary" },
      monto: 68_900,
      diasRestantes: 15,
    },
    {
      id: "v6",
      dia: 31, mes: "MAY",
      inminente: false,
      nombre: `Alquiler ${pick(0)}`,
      descripcion: "Mensualidad",
      local: { nombre: pick(0), tone: "primary" },
      monto: 1_850_000,
      diasRestantes: 18,
    },
  ];
}
