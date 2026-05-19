// WebUSB types subset (no incluidos en lib.dom.d.ts vanilla en TS strict).
// Suficiente para nuestro uso.
interface USBEndpoint { endpointNumber: number; direction: 'in' | 'out'; type: string; }
interface USBAlternateInterface { alternateSetting: number; endpoints: USBEndpoint[]; }
interface USBInterface { interfaceNumber: number; alternate: USBAlternateInterface; }
interface USBConfiguration { configurationValue: number; interfaces: USBInterface[]; }
interface USBDevice {
  configuration: USBConfiguration | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(c: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(endpointNumber: number, data: Uint8Array): Promise<{ status: 'ok' | 'stall' | 'babble' }>;
}
interface USBDeviceFilter { vendorId?: number; productId?: number; }
interface USB {
  requestDevice(opts: { filters: USBDeviceFilter[] }): Promise<USBDevice>;
  getDevices(): Promise<USBDevice[]>;
}

/**
 * Driver ESC/POS genérico para impresoras térmicas via WebUSB.
 *
 * Diseñado para ser COMPATIBLE con TODA impresora del mercado AR
 * (Lucas 2026-05-18) usando el protocolo ESC/POS estándar que soportan
 * casi todas las térmicas chinas, japonesas y americanas (Epson TM-T20/T88,
 * Star TSP, Bixolon, Gainscha, Custom, etc.).
 *
 * Limitaciones del approach:
 *  - WebUSB solo funciona en Chrome/Edge/Opera (no Firefox/Safari).
 *  - Requiere HTTPS o localhost.
 *  - El usuario debe AUTORIZAR la impresora la primera vez (prompt browser).
 *  - Impresoras Bluetooth necesitan helper aparte (Web Bluetooth API).
 *
 * Patron de uso:
 *   const printer = await Printer.connect();
 *   await printer.printReceipt({ titulo: 'NEKO SUSHI', items: [...], total: ... });
 *
 * Si querés probarlo: en consola → `navigator.usb.getDevices()` debería
 * estar disponible. Si no → browser no soporta WebUSB.
 */

// ─── Comandos ESC/POS estándar ─────────────────────────────────────────
const ESC = 0x1b;
const GS  = 0x1d;
const LF  = 0x0a;

const CMD = {
  INIT: [ESC, 0x40],                        // ESC @ — reset printer
  CUT_FULL: [GS, 0x56, 0x00],               // GS V 0 — cut completo
  CUT_PARTIAL: [GS, 0x56, 0x01],            // GS V 1 — cut parcial (deja 1 punto)
  ALIGN_LEFT: [ESC, 0x61, 0x00],
  ALIGN_CENTER: [ESC, 0x61, 0x01],
  ALIGN_RIGHT: [ESC, 0x61, 0x02],
  BOLD_ON: [ESC, 0x45, 0x01],
  BOLD_OFF: [ESC, 0x45, 0x00],
  TEXT_NORMAL: [GS, 0x21, 0x00],            // ancho normal
  TEXT_DOUBLE_HEIGHT: [GS, 0x21, 0x01],     // 2x alto
  TEXT_DOUBLE_WIDTH: [GS, 0x21, 0x10],      // 2x ancho
  TEXT_DOUBLE_BOTH: [GS, 0x21, 0x11],       // 2x alto y ancho
  CASH_DRAWER: [ESC, 0x70, 0x00, 0x32, 0xfa], // Pulse pin 2 → abre cajón
} as const;

// ─── Conversión texto → bytes (encoding CP437 / CP850 / UTF-8) ──────────
// CP437 es lo más universal para latín. Para acentos AR, CP850 anda mejor.
// Si tu impresora no soporta CP850, los acentos salen como basura.

function strToBytes(s: string, encoding: 'cp437' | 'utf8' = 'cp437'): Uint8Array {
  if (encoding === 'utf8') {
    return new TextEncoder().encode(s);
  }
  // CP437 simplificado: ASCII directo, reemplazar caracteres especiales
  const replaced = s
    .replace(/[áÁ]/g, 'a').replace(/[éÉ]/g, 'e').replace(/[íÍ]/g, 'i')
    .replace(/[óÓ]/g, 'o').replace(/[úÚ]/g, 'u').replace(/[ñÑ]/g, 'n')
    .replace(/[¿¡]/g, '');
  const out = new Uint8Array(replaced.length);
  for (let i = 0; i < replaced.length; i++) {
    const code = replaced.charCodeAt(i);
    out[i] = code < 128 ? code : 63; // '?' para no-ASCII restante
  }
  return out;
}

// ─── Builder de tickets ─────────────────────────────────────────────────

class TicketBuilder {
  private buffer: number[] = [];

  init() { this.push(CMD.INIT); return this; }
  cut(partial = false) { this.push(partial ? CMD.CUT_PARTIAL : CMD.CUT_FULL); return this; }
  alignLeft() { this.push(CMD.ALIGN_LEFT); return this; }
  alignCenter() { this.push(CMD.ALIGN_CENTER); return this; }
  alignRight() { this.push(CMD.ALIGN_RIGHT); return this; }
  bold(on: boolean) { this.push(on ? CMD.BOLD_ON : CMD.BOLD_OFF); return this; }
  size(mode: 'normal' | 'tall' | 'wide' | 'both') {
    const cmd = mode === 'tall' ? CMD.TEXT_DOUBLE_HEIGHT
              : mode === 'wide' ? CMD.TEXT_DOUBLE_WIDTH
              : mode === 'both' ? CMD.TEXT_DOUBLE_BOTH
              : CMD.TEXT_NORMAL;
    this.push(cmd);
    return this;
  }
  text(s: string) { this.push(Array.from(strToBytes(s))); return this; }
  newline(n = 1) { for (let i = 0; i < n; i++) this.buffer.push(LF); return this; }
  feed(n: number) { this.push([ESC, 0x64, n]); return this; }
  openDrawer() { this.push(CMD.CASH_DRAWER); return this; }
  line(s: string) { return this.text(s).newline(); }
  separator(char = '-', width = 32) { return this.line(char.repeat(width)); }

  build(): Uint8Array {
    return new Uint8Array(this.buffer);
  }

  private push(bytes: readonly number[] | number[]) {
    for (const b of bytes) this.buffer.push(b);
  }
}

// ─── Cliente WebUSB ─────────────────────────────────────────────────────

// Vendor IDs típicos de fabricantes de impresoras térmicas. WebUSB usa
// estos como filter al pedir autorización. Lista no-exhaustiva — el
// browser muestra TODOS los dispositivos USB conectados al usuario y
// este filter solo sirve para destacar los conocidos.
const VENDOR_IDS_TERMICAS = [
  0x04b8,  // Epson
  0x0519,  // Star Micronics
  0x0fe6,  // ICS Advent (común en HP/Gainscha)
  0x1504,  // Bixolon
  0x0dd4,  // Custom Engineering
  0x28e9,  // Generic ESC/POS chinas (Xprinter, Gainscha rebrand)
  0x1d6b,  // Linux Foundation (algunas térmicas se identifican así)
];

export class Printer {
  private device: USBDevice;
  private endpointOut: number;

  private constructor(device: USBDevice, endpointOut: number) {
    this.device = device;
    this.endpointOut = endpointOut;
  }

  /**
   * Solicita al usuario que elija una impresora USB. La primera vez
   * muestra el prompt nativo del browser. Después, queda guardada y se
   * puede recuperar con `getSavedDevices()`.
   */
  static async connect(): Promise<Printer> {
    if (typeof navigator === 'undefined' || !('usb' in navigator)) {
      throw new Error('Tu navegador no soporta WebUSB. Usá Chrome o Edge.');
    }
    const usb = (navigator as Navigator & { usb: USB }).usb;
    const device = await usb.requestDevice({
      filters: VENDOR_IDS_TERMICAS.map(vid => ({ vendorId: vid })),
    });
    return Printer.openDevice(device);
  }

  /**
   * Lista las impresoras que el usuario YA autorizó previamente. Si tiene
   * una sola, se puede conectar sin prompt.
   */
  static async getSavedDevices(): Promise<USBDevice[]> {
    if (typeof navigator === 'undefined' || !('usb' in navigator)) return [];
    const usb = (navigator as Navigator & { usb: USB }).usb;
    return await usb.getDevices();
  }

  static async openSaved(device: USBDevice): Promise<Printer> {
    return Printer.openDevice(device);
  }

  private static async openDevice(device: USBDevice): Promise<Printer> {
    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }
    // Buscar interface y endpoint OUT (típicamente bulk)
    const config = device.configuration!;
    const iface = config.interfaces[0];
    if (!iface) throw new Error('Impresora sin interfaces USB válidas');
    await device.claimInterface(iface.interfaceNumber);

    const alt = iface.alternate;
    const endpoint = alt.endpoints.find((e: USBEndpoint) => e.direction === 'out');
    if (!endpoint) throw new Error('Impresora sin endpoint OUT (no se puede escribir)');

    return new Printer(device, endpoint.endpointNumber);
  }

  async send(bytes: Uint8Array): Promise<void> {
    await this.device.transferOut(this.endpointOut, bytes);
  }

  async disconnect(): Promise<void> {
    try { await this.device.close(); } catch { /* idempotente */ }
  }

  // ─── Helpers de alto nivel ───────────────────────────────────────────

  /** Imprime un ticket de venta (cliente). Formato típico AR. */
  async printReceipt(args: {
    titulo: string;
    direccion?: string;
    items: Array<{ nombre: string; cantidad: number; subtotal: number }>;
    descuento?: number;
    total: number;
    pagos: Array<{ metodo: string; monto: number; cuotas?: number | null }>;
    fechaHora: string;
    venta_id: string | number;
    propina?: number;
    cae?: string;  // futuro: AFIP CAE
    cae_vto?: string;
    qr_afip?: string;  // url QR fiscal AR
  }): Promise<void> {
    const tb = new TicketBuilder();
    tb.init();
    tb.alignCenter().bold(true).size('both').line(args.titulo);
    tb.size('normal').bold(false);
    if (args.direccion) tb.line(args.direccion);
    tb.newline();
    tb.line(`Venta #${args.venta_id} - ${args.fechaHora}`);
    tb.separator();
    tb.alignLeft();
    for (const it of args.items) {
      tb.text(`${it.cantidad}x ${it.nombre.slice(0, 22).padEnd(22)} `);
      tb.alignRight().text(formatMoney(it.subtotal)).newline();
      tb.alignLeft();
    }
    tb.separator();
    if (args.descuento && args.descuento > 0) {
      tb.text('Descuento: ').alignRight().text(`-${formatMoney(args.descuento)}`).newline();
      tb.alignLeft();
    }
    if (args.propina && args.propina > 0) {
      tb.text('Propina: ').alignRight().text(formatMoney(args.propina)).newline();
      tb.alignLeft();
    }
    tb.bold(true).size('tall').text('TOTAL: ').alignRight().text(formatMoney(args.total)).newline();
    tb.size('normal').bold(false).alignLeft();
    tb.newline();
    for (const p of args.pagos) {
      const cuotasStr = p.cuotas && p.cuotas > 1 ? ` (${p.cuotas} cuotas)` : '';
      tb.line(`${p.metodo}${cuotasStr}: ${formatMoney(p.monto)}`);
    }
    if (args.cae) {
      tb.newline().separator();
      tb.alignCenter().line(`CAE: ${args.cae}`);
      if (args.cae_vto) tb.line(`Vto: ${args.cae_vto}`);
      tb.alignLeft();
    }
    tb.newline().alignCenter().line('Gracias por su visita');
    tb.feed(4);
    tb.cut();
    await this.send(tb.build());
  }

  /** Imprime un ticket de cocina (kitchen ticket) — texto grande, sin total. */
  async printKitchenTicket(args: {
    estacion: string;
    mesa?: string;
    items: Array<{ cantidad: number; nombre: string; notas?: string | null; modificadores?: string[] | null }>;
    curso: number;
    fechaHora: string;
  }): Promise<void> {
    const tb = new TicketBuilder();
    tb.init();
    tb.alignCenter().bold(true).size('both').line(args.estacion);
    tb.size('normal').bold(false);
    if (args.mesa) tb.size('tall').line(`Mesa ${args.mesa}`).size('normal');
    tb.line(`Curso ${args.curso} - ${args.fechaHora}`);
    tb.separator();
    tb.alignLeft();
    for (const it of args.items) {
      tb.bold(true).size('tall').text(`${it.cantidad}x ${it.nombre}`).newline();
      tb.size('normal').bold(false);
      if (it.modificadores) {
        for (const mod of it.modificadores) tb.line(`   - ${mod}`);
      }
      if (it.notas) tb.bold(true).line(`** ${it.notas} **`).bold(false);
      tb.newline();
    }
    tb.feed(4);
    tb.cut();
    await this.send(tb.build());
  }

  /** Abre el cajón de dinero conectado por RJ12 a la impresora. */
  async openCashDrawer(): Promise<void> {
    const tb = new TicketBuilder();
    tb.openDrawer();
    await this.send(tb.build());
  }
}

function formatMoney(n: number): string {
  return '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/** Helper: verifica si el browser soporta WebUSB. */
export function isWebUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}
