// printerHandler — abstrae los 3 transportes (USB/Network/Serial) en
// una API uniforme: ping, print, discover.
//
// Usa node-thermal-printer para los comandos ESC/POS (lib madura, soporta
// QR, code128, imágenes, alineación, etc).

import { ThermalPrinter, PrinterTypes, BreakLine, CharacterSet } from 'node-thermal-printer';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const execAsync = promisify(exec);

// Retorna el Name de la primera impresora Windows en puerto USB (ej: "Impresora Comanda").
async function findWindowsUsbPrinterName() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execAsync(
      `powershell.exe -NoProfile -Command "Get-Printer | Where-Object { $_.PortName -match '^USB' } | Select-Object -First 1 -ExpandProperty Name"`,
      { timeout: 5000 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Interface custom para USB en Windows.
// Usa la Windows Print API (winspool.drv) con tipo de datos RAW para enviar
// los bytes ESC/POS directamente al hardware sin que el driver "Generic/Text Only"
// los procese como texto y los corrompa.
// El flujo: escribir buffer a bin temp → generar ps1 temp con P/Invoke →
// ejecutar ps1 → limpiar ambos archivos.
function makeWindowsUsbInterface() {
  return {
    async isPrinterConnected() {
      const name = await findWindowsUsbPrinterName().catch(() => null);
      return !!name;
    },
    async execute(buffer) {
      const printerName = await findWindowsUsbPrinterName();
      if (!printerName) throw new Error('No se encontró impresora USB. Instalá el driver desde el Print Agent.');

      const ts = Date.now();
      const binFile = path.join(os.tmpdir(), `comanda_${ts}.bin`);
      const psFile  = path.join(os.tmpdir(), `comanda_${ts}.ps1`);

      await fs.promises.writeFile(binFile, buffer);

      // pDataType="RAW" → los bytes van directo al hardware sin que el driver
      // los toque. copy /b pasaba por "Generic/Text Only" y corrompía ESC/POS.
      const safeBin     = binFile.replace(/\\/g, '\\\\');
      const safePrinter = printerName.replace(/'/g, "''");
      const psScript = `
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public class EscPos {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Ansi)]
  public class DOC {
    public string pDocName;
    public string pOutputFile;
    public string pDataType;
  }
  [DllImport("winspool.drv",CharSet=CharSet.Ansi,SetLastError=true)]
  public static extern bool OpenPrinter(string n,out IntPtr h,IntPtr d);
  [DllImport("winspool.drv",SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv",CharSet=CharSet.Ansi,SetLastError=true)]
  public static extern int StartDocPrinter(IntPtr h,int l,[In,MarshalAs(UnmanagedType.LPStruct)] DOC di);
  [DllImport("winspool.drv",SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv",SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv",SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv",SetLastError=true)]
  public static extern bool WritePrinter(IntPtr h,IntPtr p,int c,out int w);
}
'@
$bytes = [IO.File]::ReadAllBytes('${safeBin}')
$h = [IntPtr]::Zero
if (-not [EscPos]::OpenPrinter('${safePrinter}', [ref]$h, [IntPtr]::Zero)) {
  throw "OpenPrinter fallo: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()
}
$d = New-Object EscPos+DOC
$d.pDocName  = 'COMANDA'
$d.pDataType = 'RAW'
$jobId = [EscPos]::StartDocPrinter($h, 1, $d)
if ($jobId -le 0) {
  [EscPos]::ClosePrinter($h)
  throw "StartDocPrinter fallo: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()
}
[EscPos]::StartPagePrinter($h) | Out-Null
$p = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $p, $bytes.Length)
$w = 0
[EscPos]::WritePrinter($h, $p, $bytes.Length, [ref]$w) | Out-Null
[Runtime.InteropServices.Marshal]::FreeCoTaskMem($p)
[EscPos]::EndPagePrinter($h) | Out-Null
[EscPos]::EndDocPrinter($h) | Out-Null
[EscPos]::ClosePrinter($h) | Out-Null
Write-Output "OK:$w"
`;

      await fs.promises.writeFile(psFile, psScript, 'utf8');
      try {
        const { stdout } = await execAsync(
          `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`,
          { timeout: 15000 }
        );
        const out = stdout.trim();
        if (!out.startsWith('OK:')) throw new Error(`Print error: ${out}`);
        return 'Print done';
      } finally {
        fs.unlink(binFile, () => {});
        fs.unlink(psFile, () => {});
      }
    },
  };
}

// ─── Crear instancia ThermalPrinter según transporte ───────────────────────

async function buildPrinter(printerCfg) {
  const t = printerCfg.transporte;
  const c = printerCfg.config || {};

  const type = c.tipo === 'star' ? PrinterTypes.STAR : PrinterTypes.EPSON;

  // En Windows USB: interface custom que escribe raw ESC/POS al device path.
  // node-thermal-printer acepta { isPrinterConnected, execute } como interface.
  // Esto evita depender de node-printer (que no está incluido) y la restricción
  // de que printer:auto agarra Microsoft PDF en vez de la térmica.
  let iface;
  if (t === 'usb') {
    iface = process.platform === 'win32'
      ? makeWindowsUsbInterface()
      : 'printer:auto'; // Linux/Mac: printer:auto funciona nativamente
  } else if (t === 'network') {
    if (!c.host) throw new Error('Network requiere config.host');
    iface = `tcp://${c.host}:${c.port || 9100}`;
  } else if (t === 'serial') {
    if (!c.path) throw new Error('Serial requiere config.path (ej "COM3" o "/dev/ttyUSB0")');
    iface = c.path; // File interface (\\.\COM3 en Windows, /dev/ttyUSB0 en Linux)
  } else {
    throw new Error(`Transporte desconocido: ${t}`);
  }

  return new ThermalPrinter({
    type,
    interface: iface,
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
    const printer = await buildPrinter(printerCfg);
    const isConnected = await printer.isPrinterConnected();
    return { ok: !!isConnected };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Print: arma el ticket y lo manda ──────────────────────────────────────

async function print(printerCfg, ticket) {
  const printer = await buildPrinter(printerCfg);

  // Verificar conexión antes de gastar bytes
  const connected = await printer.isPrinterConnected().catch(() => false);
  if (!connected) {
    throw new Error(`Impresora ${printerCfg.nombre} no responde`);
  }

  // Ticket de COCINA: sin precios, sin total, sin pie fiscal. Es una comanda
  // para la estación, no un comprobante. (Antes caía en el render de cliente
  // y salía "Ticket #undefined" + "$NaN" porque no trae número ni precios.)
  if (ticket.tipo === 'cocina') {
    return printKitchen(printer, ticket);
  }

  // Ancho útil de la impresora (32 col=58mm, 48 col=80mm). Usado para
  // truncar nombres de items para que qty+name+precio siempre entren en 1 línea.
  const cols = printerCfg?.config?.width || 32;

  // ── HEADER (título en doble ancho + alto, subtítulo normal)
  printer.alignCenter();
  printer.setTextDoubleHeight();
  printer.setTextDoubleWidth();
  printer.bold(true);
  // Truncar título si es demasiado largo — se doblan chars por doble ancho.
  const tituloMax = Math.floor(cols / 2);
  const titulo = (ticket.titulo || 'COMANDA').slice(0, tituloMax);
  printer.println(titulo);
  printer.setTextNormal();
  printer.bold(false);

  if (ticket.tipo_comprobante_letra && ticket.tipo_comprobante_letra !== 'X') {
    printer.println(`[ ${ticket.tipo_comprobante_letra} ]`);
  }
  if (ticket.cuit_emisor) printer.println(`CUIT ${ticket.cuit_emisor}`);
  if (ticket.direccion) printer.println(ticket.direccion);

  // ── ID + FECHA (en 1 sola línea si cabe, sino apilados)
  printer.newLine();
  let idStr;
  if (ticket.punto_venta != null && ticket.numero_comprobante != null) {
    const pv = String(ticket.punto_venta).padStart(5, '0');
    const num = String(ticket.numero_comprobante).padStart(8, '0');
    idStr = `${pv}-${num}`;
  } else {
    // Acortar IDs largos tipo TEST-1783623539936 → TEST-...39936
    idStr = String(ticket.venta_id || '').length > 12
      ? `#${String(ticket.venta_id).slice(-8)}`
      : `#${ticket.venta_id}`;
  }
  printer.alignLeft();
  printer.bold(true);
  printer.println(idStr);
  printer.bold(false);
  if (ticket.fechaHora) printer.println(ticket.fechaHora);

  // ── RECEPTOR (si no es CF)
  if (ticket.cliente_doc_tipo && ticket.cliente_doc_tipo !== 'CF' && ticket.cliente_doc_nro) {
    printer.newLine();
    printer.println(`Cliente: ${ticket.cliente_razon_social || ''}`);
    printer.println(`${ticket.cliente_doc_tipo}: ${ticket.cliente_doc_nro}`);
  }

  printer.drawLine();

  // ── ITEMS (qty + name + price en 1 línea, truncando name si hace falta)
  printer.alignLeft();
  for (const it of (ticket.items || [])) {
    const qty = `${it.cantidad}x `;
    const precio = formatMoney(it.subtotal);
    // Reserva: qty + espacio antes del precio (mínimo 1) + precio
    const espacioParaNombre = cols - qty.length - precio.length - 1;
    let nombre = it.nombre || '';
    if (nombre.length > espacioParaNombre) {
      nombre = nombre.slice(0, Math.max(1, espacioParaNombre - 1)) + '…';
    }
    printer.leftRight(`${qty}${nombre}`, precio);
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

  // ── SUBTOTALES
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

  // TOTAL en doble alto (no doble ancho para que la $ y el número entren)
  printer.bold(true);
  printer.setTextDoubleHeight();
  printer.leftRight('TOTAL', formatMoney(ticket.total));
  printer.setTextNormal();
  printer.bold(false);

  // ── PAGOS
  if ((ticket.pagos || []).length > 0) {
    printer.newLine();
    for (const p of ticket.pagos) {
      const cuotasStr = p.cuotas && p.cuotas > 1 ? ` (${p.cuotas} cuotas)` : '';
      printer.leftRight(`${p.metodo}${cuotasStr}`, formatMoney(p.monto));
    }
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
    printer.bold(true);
    printer.println('DOCUMENTO NO FISCAL');
    printer.bold(false);
    printer.alignLeft();
  }

  // ── CIERRE
  printer.newLine();
  printer.alignCenter();
  printer.println(ticket.mensaje_final || 'Gracias por su visita');
  printer.cut();

  await printer.execute();
}

// Comanda de cocina: encabezado de estación, mesa/curso, e items con
// cantidad + modificadores + notas. SIN precios, total ni pie fiscal.
async function printKitchen(printer, ticket) {
  printer.alignCenter();
  printer.setTextDoubleHeight();
  printer.setTextDoubleWidth();
  printer.bold(true);
  printer.println(ticket.estacion || 'COCINA');
  printer.setTextNormal();
  printer.bold(false);

  if (ticket.mesa) {
    printer.setTextDoubleHeight();
    printer.println(`Mesa ${ticket.mesa}`);
    printer.setTextNormal();
  }
  printer.println(`Curso ${ticket.curso != null ? ticket.curso : 1} - ${ticket.fechaHora || ''}`);
  printer.drawLine();

  printer.alignLeft();
  for (const it of (ticket.items || [])) {
    printer.bold(true);
    printer.setTextDoubleHeight();
    printer.println(`${it.cantidad}x ${it.nombre}`);
    printer.setTextNormal();
    printer.bold(false);
    if (it.modificadores && it.modificadores.length > 0) {
      for (const mod of it.modificadores) {
        printer.println(`   - ${mod.nombre || mod}`);
      }
    }
    if (it.notas) {
      printer.bold(true);
      printer.println(`   ** ${it.notas} **`);
      printer.bold(false);
    }
    printer.newLine();
  }

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
