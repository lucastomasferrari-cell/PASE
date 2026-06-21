import type { CierreModel, ChartSlice, ListItem } from "./cierreData";

// Renderer del cierre a PowerPoint editable (.pptx) con charts nativos.
// PptxGenJS usa pulgadas; layout WIDE = 13.33×7.5 (16:9). Colores sin '#'.
const CEL = "75AADB", INK = "1A3A5E", MUT = "6E8CAB", BG = "F4F9FD", GREEN = "157A5B";
const hex = (c: string) => c.replace("#", "");

export async function exportCierrePptx(model: CierreModel): Promise<void> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const p = new PptxGenJS();
  p.layout = "LAYOUT_WIDE";

  type Slide = ReturnType<typeof p.addSlide>;
  const chartData = (slices: ChartSlice[]) => [{ name: "", labels: slices.map((s) => s.label), values: slices.map((s) => s.value) }];
  const chartColors = (slices: ChartSlice[]) => slices.map((s) => hex(s.color));
  const tablaMontos = (items: ListItem[]) => items.map((x) => [
    { text: x.label, options: { fontSize: 12, color: INK } },
    { text: x.valueFmt, options: { fontSize: 12, color: INK, align: "right" as const } },
  ]);

  // 1. Portada (fondo celeste).
  const s1 = p.addSlide();
  s1.background = { color: CEL };
  s1.addShape(p.ShapeType.rect, { x: 0.9, y: 2.4, w: 0.12, h: 1.5, fill: { color: "FFFFFF" } });
  s1.addText(`EERR · ${model.portada.localNombre}`, { x: 0.9, y: 3.9, w: 11.5, h: 1, fontSize: 40, bold: true, color: "FFFFFF", fontFace: "Inter" });
  s1.addText(model.portada.mesLabel, { x: 0.92, y: 4.9, w: 11.5, h: 0.6, fontSize: 22, color: "FFFFFF", fontFace: "Inter" });

  const titulo = (s: Slide, t: string, sub?: string) => {
    s.background = { color: BG };
    s.addText(t, { x: 0.6, y: 0.4, w: 12, h: 0.7, fontSize: 26, bold: true, color: INK, fontFace: "Inter" });
    if (sub) s.addText(sub, { x: 0.62, y: 1.18, w: 12, h: 0.4, fontSize: 13, color: MUT, fontFace: "Inter" });
    s.addShape(p.ShapeType.rect, { x: 0.62, y: 1.08, w: 0.6, h: 0.05, fill: { color: CEL } });
  };
  const tableOpts = { fontFace: "Inter", border: { type: "solid" as const, color: "E9EAEE", pt: 0.5 } };

  // 2. Ingresos (pie nativo).
  const s2 = p.addSlide();
  titulo(s2, "Ingresos");
  s2.addText(model.ingresos.totalFmt, { x: 0.6, y: 1.5, w: 6, h: 0.7, fontSize: 32, bold: true, color: INK, fontFace: "Inter" });
  if (model.ingresos.prevFmt) s2.addText(`${model.ingresos.prevLabel}: ${model.ingresos.prevFmt}`, { x: 0.62, y: 2.25, w: 6, h: 0.4, fontSize: 13, color: CEL, fontFace: "Inter" });
  s2.addTable(tablaMontos(model.ingresos.items), { x: 0.6, y: 2.8, w: 6, ...tableOpts });
  s2.addChart(p.ChartType.pie, chartData(model.ingresos.chart), { x: 7.1, y: 1.6, w: 5.6, h: 5.2, chartColors: chartColors(model.ingresos.chart), showLegend: true, legendPos: "r", showPercent: true });

  // 3. CMV (doughnut nativo).
  const s3 = p.addSlide();
  titulo(s3, "Egresos · Costo de mercadería (CMV)", `${model.cmv.pctVentas} sobre ventas` + (model.cmv.prevPct ? `  ·  ${model.ingresos.prevLabel}: ${model.cmv.prevPct}` : ""));
  s3.addTable(tablaMontos(model.cmv.items), { x: 0.6, y: 1.7, w: 6, ...tableOpts });
  s3.addText(`Utilidad bruta: ${model.cmv.utilBrutaPct}`, { x: 0.6, y: 6.6, w: 6, h: 0.4, fontSize: 14, color: CEL, fontFace: "Inter" });
  s3.addChart(p.ChartType.doughnut, chartData(model.cmv.chart), { x: 7.1, y: 1.5, w: 5.6, h: 5.4, chartColors: chartColors(model.cmv.chart), showLegend: true, legendPos: "r", showPercent: true, holeSize: 55 });

  // 4. Gastos fijos y varios (doughnut).
  const s4 = p.addSlide();
  titulo(s4, "Egresos · Gastos fijos y varios", `${model.gastos.pctVentas} sobre ventas` + (model.gastos.prevPct ? `  ·  ${model.ingresos.prevLabel}: ${model.gastos.prevPct}` : ""));
  s4.addTable(tablaMontos(model.gastos.items), { x: 0.6, y: 1.7, w: 6, ...tableOpts });
  s4.addChart(p.ChartType.doughnut, chartData(model.gastos.chart), { x: 7.1, y: 1.5, w: 5.6, h: 5.4, chartColors: chartColors(model.gastos.chart), showLegend: true, legendPos: "r", showPercent: true, holeSize: 55 });

  // 5. Resumen.
  const s5 = p.addSlide();
  titulo(s5, "Egresos · Resumen");
  const filas = model.resumen.lines.map((l) => [
    { text: `${l.label}: ${l.pct}`, options: { fontSize: 16, color: INK } },
    { text: l.montoFmt, options: { fontSize: 16, color: INK, align: "right" as const } },
  ]);
  s5.addTable(filas, { x: 1, y: 2, w: 11.3, fontFace: "Inter", rowH: 0.6 });
  s5.addText([{ text: "Total de gastos:  ", options: { color: INK } }, { text: model.resumen.totalGastosFmt, options: { color: INK } }], { x: 1, y: 5, w: 11.3, h: 0.5, fontSize: 19, bold: true, fontFace: "Inter" });
  s5.addText([{ text: `Rentabilidad final: ${model.resumen.rentabilidadPct}  `, options: { color: GREEN } }, { text: model.resumen.rentabilidadFmt, options: { color: GREEN } }], { x: 1, y: 5.7, w: 11.3, h: 0.5, fontSize: 22, bold: true, fontFace: "Inter" });

  // 6. División (si hay).
  if (model.division) {
    const s6 = p.addSlide();
    titulo(s6, "División de ganancias");
    s6.addText(`Rentabilidad: ${model.division.rentabilidadFmt}`, { x: 0.6, y: 1.5, w: 11, h: 0.5, fontSize: 17, color: GREEN, fontFace: "Inter" });
    const dfilas = model.division.items.map((d) => [
      { text: `${d.nombre}  (${d.pct})`, options: { fontSize: 18, color: INK } },
      { text: d.montoFmt, options: { fontSize: 18, color: INK, align: "right" as const } },
    ]);
    s6.addTable(dfilas, { x: 1, y: 2.4, w: 8, fontFace: "Inter", rowH: 0.55 });
    s6.addText("Nota: editá este texto con la propuesta de reparto (ej: 70% Neko / 30% socios).", { x: 1, y: 6.4, w: 11, h: 0.5, fontSize: 11, italic: true, color: MUT, fontFace: "Inter" });
  }

  await p.writeFile({ fileName: `Cierre_${model.portada.localNombre.replace(/[^\w]+/g, "-")}_${model.portada.mesLabel.replace(/\s/g, "-")}.pptx` });
}
