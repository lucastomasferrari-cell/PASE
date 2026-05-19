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

  /**
   * Imprime un código QR usando comandos nativos ESC/POS GS ( k. Soportado
   * por la mayoría de las impresoras modernas (Epson TM-T20II+, Bixolon
   * SRP-350, Xprinter genéricas, Gainscha).
   *
   * Si la impresora no soporta GS ( k, los bytes se ignoran silenciosamente
   * (no rompe el ticket). Para garantizar QR visible en TODA impresora,
   * habría que renderizar bitmap y usar GS v 0 — sprint futuro.
   *
   * @param data el string a codificar (típicamente URL).
   * @param size módulo del QR (1-16, default 8 ≈ 2-3cm de lado).
   * @param ec   nivel de error correction: 'L'=7% | 'M'=15% | 'Q'=25% | 'H'=30%.
   *             Para QR fiscal AFIP, 'L' alcanza y deja el QR más chico.
   */
  qr(data: string, size = 8, ec: 'L' | 'M' | 'Q' | 'H' = 'L') {
    // 1) Function 165: select model (cn=49, fn=65). Modelo 2 = 50.
    this.push([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);
    // 2) Function 167: set size (cn=49, fn=67). size en [1,16].
    const sizeClamped = Math.max(1, Math.min(16, size));
    this.push([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, sizeClamped]);
    // 3) Function 169: set error correction (cn=49, fn=69). 48=L, 49=M, 50=Q, 51=H.
    const ecByte = ec === 'L' ? 48 : ec === 'M' ? 49 : ec === 'Q' ? 50 : 51;
    this.push([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, ecByte]);
    // 4) Function 180: store data (cn=49, fn=80, m=48 + data).
    const dataBytes = Array.from(strToBytes(data, 'utf8'));
    const len = dataBytes.length + 3;
    const pL = len & 0xff;
    const pH = (len >> 8) & 0xff;
    this.push([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30, ...dataBytes]);
    // 5) Function 181: print (cn=49, fn=81, m=48).
    this.push([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);
    return this;
  }

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

  /** Imprime un ticket de venta (cliente). Formato típico AR.
   *
   * Si vienen los campos AFIP (`tipo_comprobante`, `numero_comprobante`,
   * `cae`, `qr_afip`), el ticket lleva además:
   *   - Tipo factura (B/C/A) + razón social emisor + CUIT en el header
   *   - Bloque CAE + vencimiento + QR fiscal AR (Res. 4892/2020)
   *   - Datos del receptor (DocTipo/DocNro/Razón social) si no es CF
   *   - Discriminación de IVA cuando aplica (Responsable Inscripto)
   * Sin los campos AFIP, es un ticket no fiscal (X).
   */
  async printReceipt(args: {
    titulo: string;
    direccion?: string;
    cuit_emisor?: string;
    items: Array<{ nombre: string; cantidad: number; subtotal: number }>;
    descuento?: number;
    total: number;
    pagos: Array<{ metodo: string; monto: number; cuotas?: number | null }>;
    fechaHora: string;
    venta_id: string | number;
    propina?: number;
    // AFIP (opcional — si no viene, ticket "no fiscal" tipo X)
    tipo_comprobante_letra?: 'A' | 'B' | 'C' | 'X';
    punto_venta?: number;
    numero_comprobante?: number;
    importe_neto?: number;
    importe_iva?: number;
    cae?: string;
    cae_vto?: string; // YYYY-MM-DD
    qr_afip?: string; // URL completa al QR fiscal AFIP
    // Receptor (opcional)
    cliente_doc_tipo?: string;     // 'DNI' | 'CUIT' | 'CUIL' | 'CF'
    cliente_doc_nro?: string;
    cliente_razon_social?: string;
  }): Promise<void> {
    const tb = new TicketBuilder();
    tb.init();

    // ─── Header ───────────────────────────────────────────────────────
    const tipoLetra = args.tipo_comprobante_letra ?? 'X';
    if (tipoLetra !== 'X') {
      // Recuadro con la letra grande tipo factura AFIP (centrado al tope).
      tb.alignCenter().bold(true).size('both').line(`[ ${tipoLetra} ]`);
      tb.size('normal').bold(false);
      tb.line(`Codigo ${tipoCodigoNumerico(tipoLetra)}`);
      tb.newline();
    }

    tb.alignCenter().bold(true).size('both').line(args.titulo);
    tb.size('normal').bold(false);
    if (args.cuit_emisor) tb.line(`CUIT ${formatCuit(args.cuit_emisor)}`);
    if (args.direccion) tb.line(args.direccion);
    tb.newline();

    // ─── Identificación comprobante ──────────────────────────────────
    if (tipoLetra !== 'X' && args.punto_venta != null && args.numero_comprobante != null) {
      const pv = String(args.punto_venta).padStart(5, '0');
      const num = String(args.numero_comprobante).padStart(8, '0');
      tb.alignCenter().bold(true).line(`${pv}-${num}`);
      tb.bold(false);
      tb.line(args.fechaHora);
    } else {
      // No fiscal: solo nro interno
      tb.line(`Ticket #${args.venta_id} - ${args.fechaHora}`);
    }
    tb.alignLeft();

    // ─── Receptor (si no es CF) ───────────────────────────────────────
    if (args.cliente_doc_tipo && args.cliente_doc_tipo !== 'CF' && args.cliente_doc_nro) {
      tb.newline();
      tb.line(`Cliente: ${args.cliente_razon_social ?? ''}`);
      tb.line(`${args.cliente_doc_tipo}: ${args.cliente_doc_nro}`);
    } else if (tipoLetra !== 'X') {
      tb.newline();
      tb.line('A consumidor final');
    }

    tb.separator();

    // ─── Items ───────────────────────────────────────────────────────
    for (const it of args.items) {
      tb.text(`${it.cantidad}x ${it.nombre.slice(0, 22).padEnd(22)} `);
      tb.alignRight().text(formatMoney(it.subtotal)).newline();
      tb.alignLeft();
    }
    tb.separator();

    // ─── Subtotales ──────────────────────────────────────────────────
    if (args.descuento && args.descuento > 0) {
      tb.text('Descuento: ').alignRight().text(`-${formatMoney(args.descuento)}`).newline();
      tb.alignLeft();
    }
    if (args.propina && args.propina > 0) {
      tb.text('Propina: ').alignRight().text(formatMoney(args.propina)).newline();
      tb.alignLeft();
    }

    // Discriminación de IVA — solo factura A o B (Responsable Inscripto).
    // Para C (monotributista) NO se discrimina IVA por norma.
    if ((tipoLetra === 'A' || tipoLetra === 'B') && args.importe_iva && args.importe_iva > 0) {
      const neto = args.importe_neto ?? (args.total - args.importe_iva);
      tb.text('Neto:     ').alignRight().text(formatMoney(neto)).newline();
      tb.alignLeft();
      tb.text('IVA 21%:  ').alignRight().text(formatMoney(args.importe_iva)).newline();
      tb.alignLeft();
    }

    tb.bold(true).size('tall').text('TOTAL: ').alignRight().text(formatMoney(args.total)).newline();
    tb.size('normal').bold(false).alignLeft();
    tb.newline();

    // ─── Pagos ───────────────────────────────────────────────────────
    for (const p of args.pagos) {
      const cuotasStr = p.cuotas && p.cuotas > 1 ? ` (${p.cuotas} cuotas)` : '';
      tb.line(`${p.metodo}${cuotasStr}: ${formatMoney(p.monto)}`);
    }

    // ─── CAE + QR fiscal AFIP ────────────────────────────────────────
    if (args.cae) {
      tb.newline().separator();
      tb.alignCenter();
      tb.line(`CAE N°: ${args.cae}`);
      if (args.cae_vto) tb.line(`Vto CAE: ${formatVto(args.cae_vto)}`);
      tb.newline();
      if (args.qr_afip) {
        // QR ESC/POS nativo. Tamaño 6 ≈ 1.8cm de lado, suficiente para
        // que ARCA escanee desde un celular a 20cm.
        tb.qr(args.qr_afip, 6, 'L');
        tb.newline();
      }
      tb.alignLeft();
    } else if (tipoLetra === 'X') {
      tb.newline().alignCenter().line('** DOCUMENTO NO FISCAL **');
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

// Mapea letra de factura al código AFIP que se imprime debajo del recuadro.
function tipoCodigoNumerico(letra: 'A' | 'B' | 'C'): string {
  switch (letra) {
    case 'A': return '01'; case 'B': return '06'; case 'C': return '11';
  }
}

function formatCuit(cuit: string): string {
  // 11 dígitos → XX-XXXXXXXX-X
  const c = cuit.replace(/\D/g, '');
  if (c.length !== 11) return cuit;
  return `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`;
}

function formatVto(yyyymmdd: string): string {
  // AFIP devuelve CAEFchVto en YYYYMMDD o YYYY-MM-DD. Normalizo a DD/MM/YYYY.
  const clean = yyyymmdd.replace(/-/g, '');
  if (clean.length !== 8) return yyyymmdd;
  return `${clean.slice(6, 8)}/${clean.slice(4, 6)}/${clean.slice(0, 4)}`;
}

/** Helper: verifica si el browser soporta WebUSB. */
export function isWebUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}
