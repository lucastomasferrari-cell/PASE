// printerHandler — abstrae los 3 transportes (USB/Network/Serial) en
// una API uniforme: ping, print, discover.
//
// Usa node-thermal-printer para los comandos ESC/POS (lib madura, soporta
// QR, code128, imágenes, alineación, etc).

import { ThermalPrinter, PrinterTypes, BreakLine, CharacterSet } from 'node-thermal-printer';

// ─── Crear instancia ThermalPrinter según transporte ───────────────────────

function buildPrinter(printerCfg) {
  const t = printerCfg.transporte;
  const c = printerCfg.config || {};

  // Tipo de printer: por default Epson (más compatible).
  // Si la impresora es Star, mejor especificarlo en config porque comandos
  // de corte y dirección de papel difieren.
  const type = c.tipo === 'star' ? PrinterTypes.STAR : PrinterTypes.EPSON;

  let interfaceStr;
  if (t === 'usb') {
    // Formato: usb (autodetect) o usb://<vendor>:<product> para específica.
    if (c.vendor_id && c.product_id) {
      interfaceStr = `printer:USB${c.vendor_id}/${c.product_id}`;
    } else {
      // Auto-detect: usa la primera USB que encuentre.
      interfaceStr = 'printer:auto';
    }
  } else if (t === 'network') {
    // Formato: tcp://192.168.1.100:9100
    if (!c.host) throw new Error('Network requiere config.host');
    const port = c.port || 9100;
    interfaceStr = `tcp://${c.host}:${port}`;
  } else if (t === 'serial') {
    // Formato: COM3 o /dev/ttyUSB0
    if (!c.path) throw new Error('Serial requiere config.path (ej "COM3" o "/dev/ttyUSB0")');
    interfaceStr = `printer:${c.path}`;
  } else {
    throw new Error(`Transporte desconocido: ${t}`);
  }

  return new ThermalPrinter({
    type,
    interface: interfaceStr,
    characterSet: CharacterSet.PC850_MULTILINGUAL, // soporta acentos AR
    removeSpecialCharacters: false,
    lineCharacter: '-',
    breakLine: BreakLine.WORD,
    options: { timeout: 5000 },
    width: c.width || 32, // 32 cols (58mm) o 48 cols (80mm)
  });
}

// ─── Ping: verifica que la impresora responde ──────────────────────────────

async function ping(printerCfg) {
  try {
    const printer = buildPrinter(printerCfg);
    const isConnected = await printer.isPrinterConnected();
    return { ok: !!isConnected };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Print: arma el ticket y lo manda ──────────────────────────────────────

async function print(printerCfg, ticket) {
  const printer = buildPrinter(printerCfg);

  // Verificar conexión antes de gastar bytes
  const connected = await printer.isPrinterConnected().catch(() => false);
  if (!connected) {
    throw new Error(`Impresora ${printerCfg.nombre} no responde`);
  }

  // ── Header
  printer.alignCenter();
  printer.setTextDoubleHeight();
  printer.setTextDoubleWidth();
  printer.bold(true);
  printer.println(ticket.titulo || 'COMANDA');
  printer.setTextNormal();
  printer.bold(false);

  if (ticket.tipo_comprobante_letra && ticket.tipo_comprobante_letra !== 'X') {
    printer.println(`[ ${ticket.tipo_comprobante_letra} ]`);
  }
  if (ticket.cuit_emisor) printer.println(`CUIT ${ticket.cuit_emisor}`);
  if (ticket.direccion) printer.println(ticket.direccion);
  printer.newLine();

  // Identificación
  if (ticket.punto_venta != null && ticket.numero_comprobante != null) {
    const pv = String(ticket.punto_venta).padStart(5, '0');
    const num = String(ticket.numero_comprobante).padStart(8, '0');
    printer.bold(true);
    printer.println(`${pv}-${num}`);
    printer.bold(false);
  } else {
    printer.println(`Ticket #${ticket.venta_id}`);
  }
  printer.println(ticket.fechaHora);
  printer.drawLine();

  // ── Receptor (si no es CF)
  if (ticket.cliente_doc_tipo && ticket.cliente_doc_tipo !== 'CF' && ticket.cliente_doc_nro) {
    printer.alignLeft();
    printer.println(`Cliente: ${ticket.cliente_razon_social || ''}`);
    printer.println(`${ticket.cliente_doc_tipo}: ${ticket.cliente_doc_nro}`);
    printer.newLine();
  }

  // ── Items
  printer.alignLeft();
  for (const it of (ticket.items || [])) {
    const line = `${it.cantidad}x ${truncate(it.nombre, 22).padEnd(22)} ${formatMoney(it.subtotal).padStart(7)}`;
    printer.println(line);
    if (it.modificadores && it.modificadores.length > 0) {
      for (const mod of it.modificadores) {
        printer.println(`   + ${mod.nombre || mod}`);
      }
    }
    if (it.notas) {
      printer.println(`   ** ${it.notas} **`);
    }
  }
  printer.drawLine();

  // ── Subtotales
  if (ticket.descuento && ticket.descuento > 0) {
    printer.leftRight('Descuento', `-${formatMoney(ticket.descuento)}`);
  }
  if (ticket.propina && ticket.propina > 0) {
    printer.leftRight('Propina', formatMoney(ticket.propina));
  }
  if ((ticket.tipo_comprobante_letra === 'A' || ticket.tipo_comprobante_letra === 'B')
      && ticket.importe_iva && ticket.importe_iva > 0) {
    printer.leftRight('Neto', formatMoney(ticket.importe_neto ?? (ticket.total - ticket.importe_iva)));
    printer.leftRight('IVA 21%', formatMoney(ticket.importe_iva));
  }
  printer.bold(true);
  printer.setTextDoubleHeight();
  printer.leftRight('TOTAL', formatMoney(ticket.total));
  printer.setTextNormal();
  printer.bold(false);

  // ── Pagos
  printer.newLine();
  for (const p of (ticket.pagos || [])) {
    const cuotasStr = p.cuotas && p.cuotas > 1 ? ` (${p.cuotas} cuotas)` : '';
    printer.println(`${p.metodo}${cuotasStr}: ${formatMoney(p.monto)}`);
  }

  // ── CAE + QR fiscal AFIP
  if (ticket.cae) {
    printer.drawLine();
    printer.alignCenter();
    printer.println(`CAE N°: ${ticket.cae}`);
    if (ticket.cae_vto) printer.println(`Vto CAE: ${ticket.cae_vto}`);
    if (ticket.qr_afip) {
      printer.newLine();
      await printer.printQR(ticket.qr_afip, { cellSize: 6, correction: 'L', model: 2 });
    }
    printer.alignLeft();
  } else if (ticket.tipo_comprobante_letra === 'X' || !ticket.tipo_comprobante_letra) {
    printer.newLine();
    printer.alignCenter();
    printer.println('** DOCUMENTO NO FISCAL **');
    printer.alignLeft();
  }

  // ── Cierre
  printer.newLine();
  printer.alignCenter();
  printer.println(ticket.mensaje_final || 'Gracias por su visita');
  printer.cut();

  await printer.execute();
}

// ─── Discover: lista impresoras USB conectadas (best-effort) ──────────────

async function discoverUsb() {
  // node-thermal-printer no expone discovery puro. Usamos node-usb directo
  // si está instalada, sino devolvemos lista vacía con mensaje.
  try {
    const usb = await import('usb').catch(() => null);
    if (!usb || !usb.getDeviceList) {
      return { error: 'USB discovery requiere paquete "usb" instalado.', devices: [] };
    }
    const devices = usb.getDeviceList();
    const known = devices.map((d) => ({
      vendor_id: '0x' + d.deviceDescriptor.idVendor.toString(16),
      product_id: '0x' + d.deviceDescriptor.idProduct.toString(16),
      // Algunos vendor IDs típicos térmicas
      probable_termica: [
        0x04b8, // Epson
        0x0519, // Star
        0x0fe6, // ICS Advent
        0x1504, // Bixolon
        0x0dd4, // Custom Engineering
        0x28e9, // Xprinter
      ].includes(d.deviceDescriptor.idVendor),
    }));
    return { devices: known.filter((d) => d.probable_termica) };
  } catch (err) {
    return { error: err.message, devices: [] };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatMoney(n) {
  return '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export const printers = { ping, print, discoverUsb };
