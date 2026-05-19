// printerService — fachada para imprimir tickets desde la UI sin tener que
// manejar la conexión WebUSB en cada caller. Mantiene una conexión cacheada
// en memoria (se pierde al refresh — el browser obliga a re-autorizar la
// impresora si se desconecta).
//
// Uso:
//   await printerService.imprimirTicket({ titulo: 'Neko', items: [...] })
// Si la impresora está conectada → imprime.
// Si no → muestra el prompt de selección la primera vez.

import { Printer, isWebUsbSupported } from '@/lib/escpos/printer';

let _cached: Printer | null = null;

async function getPrinter(): Promise<Printer | null> {
  if (!isWebUsbSupported()) {
    throw new Error('Tu navegador no soporta WebUSB. Usá Chrome o Edge.');
  }
  if (_cached) return _cached;
  // 1) Intentar reusar impresoras ya autorizadas
  const saved = await Printer.getSavedDevices();
  if (saved.length > 0 && saved[0]) {
    _cached = await Printer.openSaved(saved[0]);
    return _cached;
  }
  // 2) Pedir autorización
  _cached = await Printer.connect();
  return _cached;
}

/** Reset cache — útil si la impresora se desconectó físicamente. */
export function resetPrinterCache(): void {
  _cached = null;
}

/** Imprime un ticket de venta. Acepta los mismos args que Printer.printReceipt. */
export async function imprimirTicket(args: Parameters<Printer['printReceipt']>[0]): Promise<{ ok: boolean; error?: string }> {
  try {
    const printer = await getPrinter();
    if (!printer) return { ok: false, error: 'Sin impresora conectada' };
    await printer.printReceipt(args);
    return { ok: true };
  } catch (err) {
    _cached = null; // reset por si la impresora se desconectó
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Imprime un ticket de cocina. */
export async function imprimirTicketCocina(args: Parameters<Printer['printKitchenTicket']>[0]): Promise<{ ok: boolean; error?: string }> {
  try {
    const printer = await getPrinter();
    if (!printer) return { ok: false, error: 'Sin impresora conectada' };
    await printer.printKitchenTicket(args);
    return { ok: true };
  } catch (err) {
    _cached = null;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function abrirCajon(): Promise<{ ok: boolean; error?: string }> {
  try {
    const printer = await getPrinter();
    if (!printer) return { ok: false, error: 'Sin impresora conectada' };
    await printer.openCashDrawer();
    return { ok: true };
  } catch (err) {
    _cached = null;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
