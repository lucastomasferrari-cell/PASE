// Export del Estado de Resultados a PDF con diseño PASE (paleta celeste, sobrio,
// sin gradientes). Reemplaza al CSV pelado en el botón "Exportar" de Reportes.
//
// Técnica: armamos el reporte como HTML (estética PASE), lo renderizamos con
// html2canvas y lo metemos en un A4 con jsPDF. Ambas libs se importan dinámico
// (solo se bajan al exportar) → no pesan en la carga normal de la pantalla.

export interface EERRPdfData {
  localNombre: string;
  mes: string;          // "YYYY-MM"
  emitido: string;      // "DD/MM/YYYY"
  ventas: number;
  cmv: number;
  utilBruta: number;
  gastosFijosVar: number;
  sueldos: number;
  cargas: number;
  boletas: number;
  publicidad: number;
  comisiones: number;
  impuestos: number;
  otros: number;
  utilNeta: number;
}

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function mesLabel(mes: string): string {
  const [yr, mo] = mes.split("-").map(Number);
  return `${MESES[(mo ?? 1) - 1]} ${yr}`;
}

/** Formato AR: $1.234.567,89 (con signo − para negativos). */
function money(n: number, dec = 2): string {
  const neg = n < 0;
  const s = Math.abs(n).toLocaleString("es-AR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (neg ? "−$" : "$") + s;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** Arma el HTML del reporte (puro → testeable sin DOM). */
export function buildEERRReportHtml(d: EERRPdfData): string {
  const v = d.ventas || 0;
  const pct = (n: number) => (v > 0 ? (n / v * 100).toFixed(1).replace(".", ",") + "%" : "—");
  const costoLaboral = d.sueldos + d.cargas + d.boletas;
  const totalGastosOp = d.gastosFijosVar + d.sueldos + d.cargas + d.boletas + d.publicidad + d.comisiones + d.impuestos + d.otros;
  const primeCost = d.cmv + costoLaboral;
  const margenNeto = v > 0 ? (d.utilNeta / v * 100).toFixed(1).replace(".", ",") : "—";
  const margenBruto = v > 0 ? (d.utilBruta / v * 100).toFixed(1).replace(".", ",") : "—";

  // Líneas de gasto ordenadas de mayor a menor.
  const gastoLines = [
    { label: "Sueldos", amount: d.sueldos },
    { label: "Gastos fijos y variables", amount: d.gastosFijosVar },
    { label: "Impuestos", amount: d.impuestos },
    { label: "Cargas sociales", amount: d.cargas },
    { label: "Comisiones", amount: d.comisiones },
    { label: "Boletas sindicales", amount: d.boletas },
    { label: "Publicidad y marketing", amount: d.publicidad },
    ...(d.otros ? [{ label: "Otros gastos", amount: d.otros }] : []),
  ].filter((x) => x.amount !== 0 || x.label === "Publicidad y marketing").sort((a, b) => b.amount - a.amount);

  const maxGasto = Math.max(1, ...gastoLines.map((x) => x.amount));
  const gastoRows = gastoLines.map((x) => `
      <tr class="row">
        <td class="name">${esc(x.label)}</td>
        <td class="bar-cell"><div class="lbar"><div class="lfill" style="width:${Math.max(0, x.amount / maxGasto * 100)}%"></div></div></td>
        <td class="amt num">${money(-x.amount)}</td>
        <td class="pct num">${pct(x.amount)}</td>
      </tr>`).join("");

  // Barra "de cada $100" — solo si tiene sentido (ventas>0 y ganancia≥0).
  const showDist = v > 0 && d.utilNeta >= 0 && d.cmv >= 0 && totalGastosOp >= 0;
  const dCmv = v > 0 ? d.cmv / v * 100 : 0;
  const dGas = v > 0 ? totalGastosOp / v * 100 : 0;
  const dGan = v > 0 ? d.utilNeta / v * 100 : 0;
  const distHtml = showDist ? `
    <div class="dist">
      <div class="cap">De cada <b>$100</b> facturados, así se reparten:</div>
      <div class="bar">
        <div class="seg s1" style="width:${dCmv}%"><span class="p num">$${(dCmv).toFixed(1).replace(".", ",")}</span><span class="t">Mercadería</span></div>
        <div class="seg s2" style="width:${dGas}%"><span class="p num">$${(dGas).toFixed(1).replace(".", ",")}</span><span class="t">Gastos operativos</span></div>
        <div class="seg s3" style="width:${dGan}%"><span class="p num">$${(dGan).toFixed(1).replace(".", ",")}</span><span class="t">Ganancia</span></div>
      </div>
    </div>` : "";

  const primeNote = v > 0 ? ` El <b>costo primo</b> (mercadería + costo laboral) representa el ${(primeCost / v * 100).toFixed(1).replace(".", ",")}% de las ventas.` : "";

  return `<style>
  .eerr-pdf{ --c:#75AADB;--c1:#EAF3FB;--c2:#D7E8F5;--c3:#9DC3E2;--tx:#1A3A5E;--mu:#6E8CAB;--bd:#EAF3FB;--bds:#DCE8F4;--gold:#F5C518;
    width:794px; box-sizing:border-box; padding:46px 44px 36px; background:#fff;
    font-family:"Inter",system-ui,-apple-system,sans-serif; color:var(--tx); font-weight:400; font-variant-numeric:tabular-nums; }
  .eerr-pdf *{ box-sizing:border-box; margin:0; padding:0; }
  .eerr-pdf .num{ font-variant-numeric:tabular-nums; }
  .eerr-pdf .head{ display:flex; justify-content:space-between; align-items:flex-end; padding-bottom:13px; border-bottom:0.5px solid var(--bds); }
  .eerr-pdf .biz{ font-size:25px; font-weight:500; letter-spacing:-0.02em; line-height:1.05; }
  .eerr-pdf .doc{ font-size:13px; color:var(--mu); margin-top:5px; }
  .eerr-pdf .right{ text-align:right; }
  .eerr-pdf .period{ font-size:19px; font-weight:500; letter-spacing:-0.02em; }
  .eerr-pdf .meta{ font-size:10.5px; color:var(--mu); margin-top:6px; }
  .eerr-pdf .meta b{ font-weight:500; color:var(--tx); }
  .eerr-pdf .bento{ display:grid; grid-template-columns:1.4fr 1fr 1fr; grid-template-rows:auto auto; gap:10px; margin-top:16px; }
  .eerr-pdf .anchor{ grid-row:span 2; background:var(--c); border-radius:14px; padding:18px; position:relative; overflow:hidden; color:#fff; display:flex; flex-direction:column; justify-content:space-between; min-height:170px; }
  .eerr-pdf .anchor .deco{ position:absolute; width:170px; height:170px; border-radius:50%; background:rgba(255,255,255,0.14); right:-52px; bottom:-52px; }
  .eerr-pdf .anchor .lbl{ font-size:11px; font-weight:500; opacity:.82; position:relative; }
  .eerr-pdf .anchor .val{ font-size:31px; font-weight:500; letter-spacing:-0.03em; margin-top:6px; position:relative; }
  .eerr-pdf .anchor .ft{ display:flex; align-items:center; justify-content:space-between; position:relative; margin-top:14px; }
  .eerr-pdf .anchor .pill{ font-size:10.5px; font-weight:500; background:rgba(255,255,255,0.22); padding:3px 10px; border-radius:999px; }
  .eerr-pdf .card{ background:#fff; border:0.5px solid var(--bds); border-radius:14px; padding:14px 15px; }
  .eerr-pdf .card .lbl{ font-size:11px; font-weight:500; color:var(--mu); }
  .eerr-pdf .card .val{ font-size:21px; font-weight:500; letter-spacing:-0.02em; margin-top:7px; }
  .eerr-pdf .card .sub{ font-size:10.5px; color:var(--mu); margin-top:5px; }
  .eerr-pdf .dist{ margin-top:17px; }
  .eerr-pdf .dist .cap{ font-size:11.5px; color:var(--mu); margin-bottom:8px; }
  .eerr-pdf .dist .cap b{ font-weight:500; color:var(--tx); }
  .eerr-pdf .bar{ display:flex; height:36px; border-radius:8px; overflow:hidden; border:0.5px solid var(--bds); }
  .eerr-pdf .seg{ display:flex; flex-direction:column; align-items:center; justify-content:center; padding:0 6px; text-align:center; color:var(--tx); }
  .eerr-pdf .seg .p{ font-size:13px; font-weight:500; letter-spacing:-0.02em; }
  .eerr-pdf .seg .t{ font-size:8.7px; margin-top:1px; }
  .eerr-pdf .seg.s1{ background:var(--c2); } .eerr-pdf .seg.s2{ background:var(--c3); } .eerr-pdf .seg.s3{ background:var(--c); }
  .eerr-pdf .seg.s3 .p,.eerr-pdf .seg.s3 .t{ color:#fff; }
  .eerr-pdf table.st{ width:100%; border-collapse:collapse; margin-top:20px; }
  .eerr-pdf table.st td{ padding:8px 0; vertical-align:middle; }
  .eerr-pdf .sec td{ padding:15px 0 6px; }
  .eerr-pdf .sec .h{ font-size:11px; font-weight:500; color:var(--mu); }
  .eerr-pdf td.name{ font-size:12.5px; color:var(--tx); padding-left:2px; }
  .eerr-pdf td.bar-cell{ width:120px; padding-left:18px; padding-right:18px; }
  .eerr-pdf td.amt{ text-align:right; font-size:12.5px; width:165px; white-space:nowrap; }
  .eerr-pdf td.pct{ text-align:right; font-size:11px; color:var(--mu); width:62px; }
  .eerr-pdf .row td{ border-bottom:0.5px solid var(--bd); }
  .eerr-pdf .row td.amt{ color:var(--mu); }
  .eerr-pdf .lbar{ height:5px; background:var(--c1); border-radius:3px; overflow:hidden; }
  .eerr-pdf .lfill{ height:100%; background:var(--c3); border-radius:3px; }
  .eerr-pdf tr.subtotal td{ border-top:0.5px solid var(--bds); border-bottom:none; padding-top:11px; }
  .eerr-pdf tr.subtotal .name,.eerr-pdf tr.subtotal .amt,.eerr-pdf tr.subtotal .pct{ font-weight:500; color:var(--tx); }
  .eerr-pdf tr.total td{ background:var(--c1); padding-top:13px; padding-bottom:13px; }
  .eerr-pdf tr.total td:first-child{ border-top-left-radius:10px; border-bottom-left-radius:10px; padding-left:14px; }
  .eerr-pdf tr.total td:last-child{ border-top-right-radius:10px; border-bottom-right-radius:10px; padding-right:14px; }
  .eerr-pdf tr.total .name{ font-size:14px; font-weight:500; }
  .eerr-pdf tr.total .amt{ font-size:16px; font-weight:500; letter-spacing:-0.02em; }
  .eerr-pdf tr.total .pct{ font-size:12px; font-weight:500; color:var(--tx); }
  .eerr-pdf .note{ margin-top:18px; padding:11px 14px; background:#F4F9FD; border:0.5px solid var(--bd); border-radius:10px; font-size:9.5px; color:var(--mu); line-height:1.6; }
  .eerr-pdf .note b{ font-weight:500; color:var(--tx); }
  .eerr-pdf .sign{ display:flex; justify-content:space-between; align-items:center; margin-top:13px; padding-top:10px; border-top:0.5px solid var(--bd); font-size:10px; color:var(--mu); }
  .eerr-pdf .logo{ font-size:13px; font-weight:500; letter-spacing:-0.035em; color:var(--tx); }
  .eerr-pdf .logo .dot{ color:var(--gold); }
</style>
<div class="eerr-pdf">
  <div class="head">
    <div>
      <div class="biz">${esc(d.localNombre)}</div>
      <div class="doc">Estado de resultados</div>
    </div>
    <div class="right">
      <div class="period">${mesLabel(d.mes)}</div>
      <div class="meta">Moneda <b>ARS ($)</b> &nbsp;·&nbsp; Criterio <b>devengado</b> &nbsp;·&nbsp; Emitido <b>${esc(d.emitido)}</b></div>
    </div>
  </div>

  <div class="bento">
    <div class="anchor">
      <div class="deco"></div>
      <div>
        <div class="lbl">Utilidad neta</div>
        <div class="val num">${money(d.utilNeta, 0)}</div>
      </div>
      <div class="ft">
        <div class="pill">Margen ${margenNeto}%</div>
      </div>
    </div>
    <div class="card"><div class="lbl">Ventas brutas</div><div class="val num">${money(d.ventas, 0)}</div><div class="sub">Facturación del mes</div></div>
    <div class="card"><div class="lbl">Utilidad bruta</div><div class="val num">${money(d.utilBruta, 0)}</div><div class="sub">Margen ${margenBruto}%</div></div>
    <div class="card"><div class="lbl">Costo de mercadería</div><div class="val num">${money(d.cmv, 0)}</div><div class="sub">${pct(d.cmv)} sobre ventas</div></div>
    <div class="card"><div class="lbl">Costo laboral</div><div class="val num">${money(costoLaboral, 0)}</div><div class="sub">${pct(costoLaboral)} sobre ventas</div></div>
  </div>

  ${distHtml}

  <table class="st">
    <tr class="sec"><td class="h" colspan="4">Ingresos</td></tr>
    <tr class="row"><td class="name">Ventas brutas</td><td class="bar-cell"></td><td class="amt num">${money(d.ventas)}</td><td class="pct num">100,0%</td></tr>

    <tr class="sec"><td class="h" colspan="4">Costo de mercadería</td></tr>
    <tr class="row"><td class="name">Compras de mercadería</td><td class="bar-cell"></td><td class="amt num">${money(-d.cmv)}</td><td class="pct num">${pct(d.cmv)}</td></tr>
    <tr class="subtotal"><td class="name">Utilidad bruta</td><td class="bar-cell"></td><td class="amt num">${money(d.utilBruta)}</td><td class="pct num">${pct(d.utilBruta)}</td></tr>

    <tr class="sec"><td class="h" colspan="4">Gastos operativos</td></tr>${gastoRows}
    <tr class="subtotal"><td class="name">Total gastos operativos</td><td class="bar-cell"></td><td class="amt num">${money(-totalGastosOp)}</td><td class="pct num">${pct(totalGastosOp)}</td></tr>

    <tr class="total"><td class="name">Utilidad neta</td><td class="bar-cell"></td><td class="amt num">${money(d.utilNeta)}</td><td class="pct num">${pct(d.utilNeta)}</td></tr>
  </table>

  <div class="note"><b>Notas.</b> Informe en <b>base devengada</b>: refleja el resultado económico del mes por fecha del hecho, no el movimiento de caja. Los porcentajes se calculan sobre ventas brutas.${primeNote} Cifras en pesos argentinos.</div>

  <div class="sign">
    <div>${esc(d.localNombre)} · Estado de resultados · ${mesLabel(d.mes)}</div>
    <div>Generado por <span class="logo">pase<span class="dot">.</span></span></div>
  </div>
</div>`;
}

/** Renderiza el reporte y dispara la descarga del PDF. */
export async function exportEERRPdf(data: EERRPdfData): Promise<void> {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import("jspdf"),
    import("html2canvas"),
  ]);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;z-index:-1;";
  host.innerHTML = buildEERRReportHtml(data);
  document.body.appendChild(host);
  const node = host.querySelector(".eerr-pdf") as HTMLElement;
  try {
    if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* noop */ } }
    const canvas = await html2canvas(node, { scale: 3, backgroundColor: "#ffffff", useCORS: true, logging: false });
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const pageW = 210, pageH = 297;
    let w = pageW, h = canvas.height * pageW / canvas.width;
    if (h > pageH) { h = pageH; w = canvas.width * pageH / canvas.height; }
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", (pageW - w) / 2, 0, w, h);
    const nombre = `EERR_${data.localNombre.replace(/[^\w]+/g, "-")}_${data.mes}.pdf`;
    pdf.save(nombre);
  } finally {
    document.body.removeChild(host);
  }
}
