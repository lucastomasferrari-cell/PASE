/**
 * printESCPOS.ts — adapter para impresoras térmicas ESC/POS.
 *
 * Este archivo es la CAPA FRONTEND. Genera comandos ESC/POS que se mandan
 * al bridge instalado en la computadora del cliente (separado, no en este
 * repo). El bridge típicamente es:
 *   - Una app Electron / Tauri local que escucha en localhost:9100
 *   - O un servicio Windows con driver USB/Network ESC/POS
 *
 * Si el bridge no está disponible (404/timeout), mostramos al usuario un
 * fallback amable: "instalá el puente PASE Print en tu PC" + link a guía.
 *
 * Stack:
 *   - Comandos ESC/POS en bytes (constantes ESC_INIT, LF, BOLD_ON, etc).
 *   - Función render() que toma un ticket "lógico" (cabecera/items/total)
 *     y devuelve Uint8Array listo para mandar.
 *   - Función printTicket() POSTea al bridge en localhost.
 *
 * Decisión Lucas 2026-05-17: armar la capa frontend ya — el bridge físico
 * se instala cuando el cliente compre la impresora. Sin el bridge, el
 * botón "Imprimir" simula la impresión + ofrece bajar el PDF.
 */

// ─── Comandos ESC/POS ─────────────────────────────────────────────────
const ESC = 0x1B;
const GS = 0x1D;
const LF = 0x0A;

export const CMD = {
  INIT: [ESC, 0x40] as const,                  // ESC @ — reset
  ALIGN_LEFT: [ESC, 0x61, 0x00] as const,
  ALIGN_CENTER: [ESC, 0x61, 0x01] as const,
  ALIGN_RIGHT: [ESC, 0x61, 0x02] as const,
  BOLD_ON: [ESC, 0x45, 0x01] as const,
  BOLD_OFF: [ESC, 0x45, 0x00] as const,
  DOUBLE_ON: [GS, 0x21, 0x11] as const,         // doble alto + ancho
  DOUBLE_OFF: [GS, 0x21, 0x00] as const,
  CUT_FULL: [GS, 0x56, 0x00] as const,          // corte completo de papel
  CUT_PARTIAL: [GS, 0x56, 0x01] as const,
  CASH_DRAWER: [ESC, 0x70, 0x00, 0x32, 0xFA] as const,  // pulso cajón monedero
  FEED: (lines: number) => [ESC, 0x64, Math.max(1, Math.min(8, lines))] as const,
};

// ─── Modelo lógico del ticket ─────────────────────────────────────────

export interface TicketHeader {
  nombre_comercio: string;       // "NEKO SUSHI"
  sucursal?: string;             // "Villa Crespo"
  direccion?: string;            // dirección abreviada
  cuit?: string;                 // CUIT del comercio (no factura fiscal)
  telefono?: string;
}

export interface TicketItem {
  cantidad: number;
  descripcion: string;
  precio_unit: number;           // ARS
  subtotal?: number;             // si NO viene, se calcula
}

export interface TicketCobro {
  metodo: string;                // "Efectivo", "MP QR", "Tarjeta Visa", etc
  monto: number;
}

export interface Ticket {
  header: TicketHeader;
  fecha: string;                 // string ya formateado (ej. "17/05/2026 19:34")
  numero: string;                // nro de operación interno (no AFIP)
  mesa?: string;                 // "Mesa 4" / "Mostrador" / "Para llevar"
  mozo?: string;                 // "Atendido por Juan"
  items: TicketItem[];
  subtotal: number;
  descuento?: number;            // descuento en $ aplicado
  total: number;
  cobros?: TicketCobro[];        // medios de pago usados
  vuelto?: number;
  pie?: string;                  // "Gracias por su visita" o QR fiscal AFIP
  /** Si TRUE, después de imprimir abrimos el cajón monedero. */
  abrir_cajon?: boolean;
}

// ─── Render: Ticket lógico → bytes ESC/POS ─────────────────────────────

const PAPER_WIDTH = 32; // caracteres por línea (80mm a 12cpl. Ajustable a 48 si es 80mm full).

function pushAll(buf: number[], ...arrs: ReadonlyArray<number>[]) {
  for (const a of arrs) {
    for (const c of a) buf.push(c);
  }
}

function textBytes(s: string): number[] {
  // ESC/POS típicamente usa CP437 o Latin-1 (CP1252). Para acentos
  // españoles usamos un mapeo simple a Latin-1. Sin librería externa.
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 128) out.push(code);
    else if (code < 256) out.push(code);
    else out.push(0x3F); // ? para chars no representables
  }
  return out;
}

function lineSep(char = "-"): string {
  return char.repeat(PAPER_WIDTH);
}

function fmt$(n: number): string {
  return "$" + Math.abs(n).toFixed(2).replace(".", ",");
}

function padBetween(left: string, right: string, width = PAPER_WIDTH): string {
  const gap = width - left.length - right.length;
  if (gap < 1) return (left + " " + right).slice(0, width);
  return left + " ".repeat(gap) + right;
}

function wrap(s: string, width = PAPER_WIDTH): string[] {
  if (s.length <= width) return [s];
  const lines: string[] = [];
  let rest = s;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut < width / 2) cut = width;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
}

export function render(ticket: Ticket): Uint8Array {
  const buf: number[] = [];
  const push = (s: string) => buf.push(...textBytes(s), LF);

  // Reset
  pushAll(buf, [...CMD.INIT]);

  // ── Header centrado ──
  pushAll(buf, [...CMD.ALIGN_CENTER], [...CMD.BOLD_ON], [...CMD.DOUBLE_ON]);
  push(ticket.header.nombre_comercio);
  pushAll(buf, [...CMD.DOUBLE_OFF], [...CMD.BOLD_OFF]);

  if (ticket.header.sucursal) push(ticket.header.sucursal);
  if (ticket.header.direccion) push(ticket.header.direccion);
  if (ticket.header.cuit) push("CUIT: " + ticket.header.cuit);
  if (ticket.header.telefono) push("Tel: " + ticket.header.telefono);

  pushAll(buf, [...CMD.ALIGN_LEFT]);
  push(lineSep());
  push(padBetween(ticket.fecha, "Nº " + ticket.numero));
  if (ticket.mesa) push(ticket.mesa);
  if (ticket.mozo) push(ticket.mozo);
  push(lineSep());

  // ── Items ──
  for (const it of ticket.items) {
    const sub = it.subtotal ?? (it.cantidad * it.precio_unit);
    // Línea 1: cantidad x descripción (wrap si es larga)
    const lineas = wrap(`${it.cantidad}x ${it.descripcion}`, PAPER_WIDTH - 10);
    push(padBetween(lineas[0]!, fmt$(sub)));
    for (let i = 1; i < lineas.length; i++) push(lineas[i]!);
    // Línea 2: precio unit (sutil, indented)
    if (it.cantidad > 1) {
      push(`   ${fmt$(it.precio_unit)} c/u`);
    }
  }

  push(lineSep());

  // ── Totales ──
  push(padBetween("Subtotal", fmt$(ticket.subtotal)));
  if (ticket.descuento && ticket.descuento > 0) {
    push(padBetween("Descuento", "-" + fmt$(ticket.descuento)));
  }
  pushAll(buf, [...CMD.BOLD_ON], [...CMD.DOUBLE_ON]);
  push(padBetween("TOTAL", fmt$(ticket.total), PAPER_WIDTH / 2));
  pushAll(buf, [...CMD.DOUBLE_OFF], [...CMD.BOLD_OFF]);

  // ── Cobros ──
  if (ticket.cobros && ticket.cobros.length > 0) {
    push(lineSep());
    for (const c of ticket.cobros) {
      push(padBetween(c.metodo, fmt$(c.monto)));
    }
    if (ticket.vuelto && ticket.vuelto > 0) {
      push(padBetween("Vuelto", fmt$(ticket.vuelto)));
    }
  }

  // ── Pie ──
  if (ticket.pie) {
    push(lineSep());
    pushAll(buf, [...CMD.ALIGN_CENTER]);
    for (const linea of wrap(ticket.pie)) push(linea);
    pushAll(buf, [...CMD.ALIGN_LEFT]);
  }

  // Feed + corte
  pushAll(buf, CMD.FEED(3), [...CMD.CUT_PARTIAL]);

  // Cajón monedero si aplica (después del corte para que no joda al cliente)
  if (ticket.abrir_cajon) pushAll(buf, [...CMD.CASH_DRAWER]);

  return new Uint8Array(buf);
}

// ─── Envío al bridge local ─────────────────────────────────────────────

export type BridgeStatus = "ok" | "no_bridge" | "timeout" | "error";

export interface PrintResult {
  status: BridgeStatus;
  message?: string;
}

const BRIDGE_URL = "http://127.0.0.1:9100/print";
const BRIDGE_TIMEOUT_MS = 3000;

/**
 * Envía el ticket al bridge ESC/POS local. Maneja graciosamente la
 * ausencia del bridge: devuelve { status: "no_bridge" } sin throw.
 *
 * Configurable via localStorage "pase_print_bridge_url" (override).
 */
export async function printTicket(ticket: Ticket): Promise<PrintResult> {
  const bytes = render(ticket);
  const url = localStorage.getItem("pase_print_bridge_url") || BRIDGE_URL;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT_MS);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      // Body como ArrayBuffer (BodyInit acepta ArrayBuffer pero no
      // Uint8Array directo en algunas tipings de TS strict).
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { status: "error", message: `Bridge respondió ${res.status}` };
    }
    return { status: "ok" };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      return { status: "timeout", message: "El bridge no respondió en 3 segundos" };
    }
    // TypeError típico cuando el bridge no está corriendo (connection refused)
    if (err.message?.includes("fetch") || err.message?.includes("network")) {
      return { status: "no_bridge", message: "PASE Print no está corriendo en esta PC" };
    }
    return { status: "error", message: err.message };
  }
}

/**
 * Genera un PDF "preview" del ticket para mostrar en pantalla cuando el
 * bridge no está disponible. Por ahora simple: render() devuelve bytes
 * binarios, no son visualmente útiles directo — esto es placeholder.
 * Mejor approach: armar HTML idéntico al layout del ticket y abrir en
 * popup para print-via-browser.
 *
 * TODO: implementar previewHTML(ticket: Ticket) que devuelve string HTML.
 */
export function ticketToText(ticket: Ticket): string {
  const bytes = render(ticket);
  // Filtrar solo chars imprimibles (skip los comandos ESC/POS) para
  // mostrar como texto plano. No es exacto pero da una idea.
  const out: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b === ESC || b === GS) {
      // skip 2-4 bytes según el comando
      i += b === ESC ? 3 : 3;
      continue;
    }
    if (b === LF) {
      out.push("\n");
      i++;
      continue;
    }
    if (b >= 32) out.push(String.fromCharCode(b));
    i++;
  }
  return out.join("");
}
