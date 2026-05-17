/**
 * exportCSV — helper para descargar una tabla como CSV.
 *
 * Diseñado para abrirse limpio en Excel + Google Sheets + LibreOffice:
 *   - BOM UTF-8 al inicio (Excel lo necesita para acentos).
 *   - Separador: punto y coma (Excel-AR usa esto por la config regional;
 *     en Sheets/LibreOffice se autodetecta).
 *   - Comillas dobles para valores con ; o " o saltos de línea.
 *   - Números con coma decimal (formato AR) y sin separador de miles
 *     para que Excel los pueda parsear.
 *
 * Uso:
 *   exportCSV(
 *     "facturas_2026-05.csv",
 *     ["Fecha", "Proveedor", "Total"],
 *     facturas.map(f => [f.fecha, f.proveedor, f.total])
 *   );
 */

type CellValue = string | number | null | undefined;

function escapeCell(v: CellValue): string {
  if (v == null) return "";
  let s = typeof v === "number" ? formatNumber(v) : String(v);
  // Si tiene caracteres especiales, envolvemos en comillas dobles y escapamos
  // las comillas internas duplicándolas (RFC 4180).
  if (/[;"\n\r]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatNumber(n: number): string {
  // Excel-AR usa coma decimal. Sin separador de miles para evitar parsing errors.
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(".", ",");
}

export function exportCSV(filename: string, headers: string[], rows: CellValue[][]): void {
  const headerLine = headers.map(escapeCell).join(";");
  const dataLines = rows.map(r => r.map(escapeCell).join(";")).join("\n");
  const csv = headerLine + "\n" + dataLines;
  // BOM UTF-8 para que Excel lea bien los acentos.
  const bom = "﻿";
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Liberar el blob después de un tick para que el browser termine la descarga.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
