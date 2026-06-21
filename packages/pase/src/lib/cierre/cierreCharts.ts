// Helpers compartidos del export de cierre: formato, paleta y SVG de charts.

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
export function mesLabel(mes: string): string {
  const [yr, mo] = mes.split("-").map(Number);
  return `${MESES[(mo ?? 1) - 1]} ${yr}`;
}

/** $1.234.567,89 con − para negativos. */
export function money(n: number, dec = 2): string {
  const neg = n < 0;
  const s = Math.abs(n).toLocaleString("es-AR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (neg ? "−$" : "$") + s;
}
/** Porcentaje de n sobre base; "—" si base ≤ 0. */
export function pctOf(n: number, base: number): string {
  if (base <= 0) return "—";
  return (n / base * 100).toFixed(1).replace(".", ",") + "%";
}

// Paleta anclada en celeste PASE, legible para charts con muchas categorías.
export const CHART_COLORS = [
  "#75AADB", "#3F8F9D", "#5B6B85", "#E0795F", "#E3B23C", "#5BA67A",
  "#8B7BB0", "#C95B7B", "#4F7CAC", "#9DC3E2", "#B0855B", "#6E8CAB",
];

export interface ColoredSlice { label: string; value: number; color: string; }

/**
 * Asigna colores estables por orden. Si hay más de `maxSlices`, agrupa el
 * sobrante en un segmento "Otros" (gris). Espera items ya ordenados desc.
 */
export function asignarColores(items: { label: string; value: number }[], maxSlices = 8): ColoredSlice[] {
  if (items.length <= maxSlices) {
    return items.map((it, i) => ({ ...it, color: CHART_COLORS[i % CHART_COLORS.length]! }));
  }
  const keep: ColoredSlice[] = items.slice(0, maxSlices - 1).map((it, i) => ({ ...it, color: CHART_COLORS[i % CHART_COLORS.length]! }));
  const restoValue = items.slice(maxSlices - 1).reduce((s, x) => s + x.value, 0);
  keep.push({ label: "Otros", value: restoValue, color: "#B6C2D1" });
  return keep;
}

/** SVG de dona (ring). `size` = lado del viewBox. Sin labels (van en la lista al lado). */
export function svgDonut(slices: ColoredSlice[], size = 260, innerRatio = 0.58): string {
  return svgPieBase(slices, size, innerRatio);
}
/** SVG de torta llena. */
export function svgPie(slices: ColoredSlice[], size = 260): string {
  return svgPieBase(slices, size, 0);
}

function svgPieBase(slices: ColoredSlice[], size: number, innerRatio: number): string {
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  const cx = size / 2, cy = size / 2, r = size / 2 - 2;
  if (total <= 0) return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  let a0 = -Math.PI / 2; // arranca arriba
  const paths = slices.map((s) => {
    const frac = Math.max(0, s.value) / total;
    const a1 = a0 + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const d = `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${s.color}"/>`;
  }).join("");
  const hole = innerRatio > 0
    ? `<circle cx="${cx}" cy="${cy}" r="${(r * innerRatio).toFixed(2)}" fill="#FFFFFF"/>`
    : "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${paths}${hole}</svg>`;
}
