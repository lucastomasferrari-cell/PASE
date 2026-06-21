import type { CierreModel, ChartSlice, ListItem } from "./cierreData";
import { svgPie, svgDonut } from "./cierreCharts";

const W = 1280, H = 720; // 16:9 px
const SLIDE_BG = "background:#F4F9FD;padding:54px 64px";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function leyenda(chart: ChartSlice[]): string {
  return chart.map((s) => `<div style="display:flex;align-items:center;gap:6px;font-size:13px;color:#1A3A5E">
    <span style="width:10px;height:10px;border-radius:2px;background:${s.color};display:inline-block"></span>
    <span style="flex:1">${esc(s.label)}</span><span style="color:#6E8CAB">${s.pct}</span></div>`).join("");
}
function listaMontos(items: ListItem[]): string {
  return items.map((x) => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;color:#1A3A5E">
    <span>${esc(x.label)}</span><span style="font-variant-numeric:tabular-nums">${x.valueFmt}</span></div>`).join("");
}
function headTitle(t: string, sub?: string): string {
  return `<div style="margin-bottom:18px">
    <div style="font-size:30px;font-weight:500;letter-spacing:-0.02em;color:#1A3A5E">${esc(t)}</div>
    ${sub ? `<div style="font-size:15px;color:#6E8CAB;margin-top:4px">${sub}</div>` : ""}
    <div style="width:54px;height:4px;background:#75AADB;border-radius:2px;margin-top:10px"></div></div>`;
}

function slidesHtml(m: CierreModel): string[] {
  const prevL = m.ingresos.prevLabel || "mes ant.";

  const s1 = `<div class="slide" style="background:#75AADB;color:#fff;display:flex;flex-direction:column;justify-content:center;padding:0 90px">
    <div style="width:8px;height:120px;background:#fff;opacity:.85;border-radius:3px;margin-bottom:26px"></div>
    <div style="font-size:58px;font-weight:500;letter-spacing:-0.02em;line-height:1.05">EERR · ${esc(m.portada.localNombre)}</div>
    <div style="font-size:26px;opacity:.9;margin-top:14px">${esc(m.portada.mesLabel)}</div></div>`;

  const s2 = `<div class="slide" style="${SLIDE_BG};display:flex;flex-direction:column">
    ${headTitle("Ingresos")}
    <div style="display:flex;gap:50px;flex:1">
      <div style="flex:1.05">
        <div style="font-size:40px;font-weight:500;letter-spacing:-0.03em;color:#1A3A5E">${m.ingresos.totalFmt}</div>
        ${m.ingresos.prevFmt ? `<div style="font-size:15px;color:#75AADB;margin-top:4px">${esc(prevL)}: ${m.ingresos.prevFmt}</div>` : ""}
        <div style="margin-top:22px">${listaMontos(m.ingresos.items)}</div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
        ${svgPie(m.ingresos.chart, 300)}
        <div style="width:100%;margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:4px 18px">${leyenda(m.ingresos.chart)}</div>
      </div>
    </div></div>`;

  const s3 = `<div class="slide" style="${SLIDE_BG};display:flex;flex-direction:column">
    ${headTitle("Egresos · Costo de mercadería (CMV)", `${m.cmv.pctVentas} sobre ventas${m.cmv.prevPct ? ` &nbsp;·&nbsp; ${esc(prevL)}: ${m.cmv.prevPct}` : ""}`)}
    <div style="display:flex;gap:50px;flex:1">
      <div style="flex:1.05">${listaMontos(m.cmv.items)}
        <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:500;border-top:0.5px solid #DCE8F4;margin-top:8px;padding-top:8px;color:#1A3A5E"><span>Total CMV</span><span>${m.cmv.totalFmt}</span></div>
        <div style="font-size:15px;color:#75AADB;margin-top:12px">Utilidad bruta: ${m.cmv.utilBrutaPct}</div></div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
        ${svgDonut(m.cmv.chart, 300)}
        <div style="width:100%;margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:4px 18px">${leyenda(m.cmv.chart)}</div>
      </div>
    </div></div>`;

  const s4 = `<div class="slide" style="${SLIDE_BG};display:flex;flex-direction:column">
    ${headTitle("Egresos · Gastos fijos y varios", `${m.gastos.pctVentas} sobre ventas${m.gastos.prevPct ? ` &nbsp;·&nbsp; ${esc(prevL)}: ${m.gastos.prevPct}` : ""}`)}
    <div style="display:flex;gap:50px;flex:1">
      <div style="flex:1.05">${listaMontos(m.gastos.items)}
        <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:500;border-top:0.5px solid #DCE8F4;margin-top:8px;padding-top:8px;color:#1A3A5E"><span>Total</span><span>${m.gastos.totalFmt}</span></div></div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
        ${svgDonut(m.gastos.chart, 300)}
        <div style="width:100%;margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:4px 18px">${leyenda(m.gastos.chart)}</div>
      </div>
    </div></div>`;

  const s5 = `<div class="slide" style="${SLIDE_BG};display:flex;flex-direction:column">
    ${headTitle("Egresos · Resumen")}
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:16px">
      ${m.resumen.lines.map((l) => `<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:19px;color:#1A3A5E">
        <span>${esc(l.label)}: <b style="font-weight:500;color:#75AADB">${l.pct}</b></span><span style="font-variant-numeric:tabular-nums">${l.montoFmt}</span></div>`).join("")}
      <div style="border-top:0.5px solid #DCE8F4;margin-top:10px;padding-top:16px;display:flex;justify-content:space-between;font-size:21px;font-weight:500;color:#1A3A5E"><span>Total de gastos</span><span>${m.resumen.totalGastosFmt}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:24px;font-weight:500;color:#157a5b"><span>Rentabilidad final: ${m.resumen.rentabilidadPct}</span><span>${m.resumen.rentabilidadFmt}</span></div>
    </div></div>`;

  const s6 = m.division ? `<div class="slide" style="${SLIDE_BG};display:flex;flex-direction:column">
    ${headTitle("División de ganancias")}
    <div style="font-size:17px;color:#157a5b;margin-bottom:10px">Rentabilidad: ${m.division.rentabilidadFmt}</div>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:12px;max-width:560px">
      ${m.division.items.map((d) => `<div style="display:flex;justify-content:space-between;font-size:20px;color:#1A3A5E">
        <span>${esc(d.nombre)} <span style="color:#6E8CAB;font-size:15px">(${d.pct})</span></span><span style="font-variant-numeric:tabular-nums">${d.montoFmt}</span></div>`).join("")}
    </div></div>` : "";

  return [s1, s2, s3, s4, s5, s6].filter(Boolean);
}

export async function exportCierrePdf(model: CierreModel): Promise<void> {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([import("jspdf"), import("html2canvas")]);
  const pdf = new jsPDF({ unit: "px", format: [W, H], orientation: "landscape" });
  const slides = slidesHtml(model);
  for (let idx = 0; idx < slides.length; idx++) {
    const host = document.createElement("div");
    host.style.cssText = `position:fixed;left:-10000px;top:0;width:${W}px;height:${H}px;font-family:'Inter',system-ui,sans-serif;`;
    host.innerHTML = `<div style="width:${W}px;height:${H}px;box-sizing:border-box;overflow:hidden">${slides[idx]}</div>`;
    document.body.appendChild(host);
    try {
      if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* noop */ } }
      const canvas = await html2canvas(host.firstElementChild as HTMLElement, { scale: 2, backgroundColor: "#ffffff", logging: false, width: W, height: H });
      if (idx > 0) pdf.addPage([W, H], "landscape");
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, W, H);
    } finally {
      document.body.removeChild(host);
    }
  }
  pdf.save(`Cierre_${model.portada.localNombre.replace(/[^\w]+/g, "-")}_${model.portada.mesLabel.replace(/\s/g, "-")}.pdf`);
}

// Export interno para verificación visual offline (no usado en runtime).
export const __slidesHtml = slidesHtml;
