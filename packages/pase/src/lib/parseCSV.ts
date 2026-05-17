/**
 * parseCSV — parser CSV simple para imports de migración de data.
 *
 * No usamos PapaParse (lib externa) porque queremos cero deps adicionales y
 * los CSVs de migración son chicos (cientos de filas, no millones). Esto
 * cubre el caso de Excel/Sheets export con UTF-8 + BOM + separador `,` o `;`.
 *
 * Soporta:
 *   - Auto-detect separador (priorizando `;` que es el default Excel-AR).
 *   - Comillas dobles `"..."` que envuelven valores con separadores o saltos.
 *   - Escape de comillas internas: `""` → `"`.
 *   - BOM UTF-8 al inicio (lo strip-ea).
 *   - CRLF / LF / CR como salto de línea.
 *   - Headers en la primera fila (siempre, no configurable).
 *
 * Devuelve `Array<Record<string, string>>` con claves = headers tal cual
 * vienen (no normaliza casing — el caller decide).
 */

export function parseCSV(text: string): Array<Record<string, string>> {
  // Strip BOM si está
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  // Detectar separador: contamos `;` y `,` en la primera línea. Si hay más
  // de un `;`, asumimos `;` (Excel-AR). Si no, `,`.
  const firstNewline = s.indexOf("\n");
  const firstLine = firstNewline === -1 ? s : s.slice(0, firstNewline);
  const semis = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const sep = semis > commas ? ";" : ",";

  const rows = splitCSV(s, sep);
  if (rows.length === 0) return [];

  const headers = rows[0]!.map(h => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.length === 1 && row[0]!.trim() === "") continue; // fila vacía
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]!] = (row[j] ?? "").trim();
    }
    out.push(obj);
  }
  return out;
}

/**
 * Split CSV en filas y celdas respetando comillas dobles + escapes.
 * Es un parser char-by-char — no usa regex porque las regex no manejan bien
 * los estados de "dentro de comillas" en CSVs reales.
 */
function splitCSV(s: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === sep) { row.push(cell); cell = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = []; cell = "";
      i++; continue;
    }
    cell += c; i++;
  }
  // Última celda + fila si no terminó con \n
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Genera y descarga un template CSV vacío con solo los headers. Útil para
 * "Descargar plantilla" antes de que el usuario empiece a cargar data.
 */
export function downloadCSVTemplate(filename: string, headers: string[], ejemplo?: Record<string, string>): void {
  const headerLine = headers.join(";");
  const ejemploLine = ejemplo
    ? headers.map(h => ejemplo[h] ?? "").join(";")
    : "";
  const csv = headerLine + (ejemploLine ? "\n" + ejemploLine : "");
  const bom = "﻿";
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
