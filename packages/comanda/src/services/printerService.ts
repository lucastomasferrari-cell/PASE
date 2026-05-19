// printerService — fachada de impresión con failover automático.
//
// Estrategia (en orden de preferencia):
//   1. Print Server local (http://127.0.0.1:9100) — soporta USB / Network /
//      Serial / Bluetooth-via-COM. Multi-impresora real con routing por
//      estación. Es el camino recomendado para producción.
//   2. WebUSB (browser-side) — fallback si no hay print server. Solo USB
//      en Chrome/Edge, una sola impresora cacheada.
//
// API pública:
//   - imprimirTicket(args)            → imprime ticket cliente
//   - imprimirTicketCocina(args)      → ticket de cocina sin total
//   - imprimirPorEstacion(estacion, args) → routing automático según estación
//   - abrirCajon()                    → abre cajón de dinero
//
// Failover silencioso: si el server falla durante una impresión, intenta
// WebUSB. Si los dos fallan, devuelve error pero NO crashea el POS — el
// ticket queda igualmente en KDS digital.

import { Printer, isWebUsbSupported } from '@/lib/escpos/printer';
import { printServer } from '@/lib/printServer/client';

let _cachedWebUsb: Printer | null = null;

// ── Detección del modo de impresión ───────────────────────────────────────

export type PrintMode = 'server' | 'webusb' | 'none';

let _mode: PrintMode | null = null;
let _modeCheckedAt = 0;

async function detectMode(force = false): Promise<PrintMode> {
  if (!force && _mode && Date.now() - _modeCheckedAt < 60_000) return _mode;
  _modeCheckedAt = Date.now();

  // 1) Print server local
  const status = await printServer.ping();
  if (status.available) {
    _mode = 'server';
    return _mode;
  }

  // 2) WebUSB browser
  if (isWebUsbSupported()) {
    _mode = 'webusb';
    return _mode;
  }

  _mode = 'none';
  return _mode;
}

export async function getPrintMode(): Promise<PrintMode> {
  return detectMode();
}

export function resetPrintModeCache(): void {
  _mode = null;
  _modeCheckedAt = 0;
  _cachedWebUsb = null;
}

// ── WebUSB internal helper ────────────────────────────────────────────────

async function getWebUsbPrinter(): Promise<Printer | null> {
  if (!isWebUsbSupported()) return null;
  if (_cachedWebUsb) return _cachedWebUsb;
  const saved = await Printer.getSavedDevices();
  if (saved.length > 0 && saved[0]) {
    _cachedWebUsb = await Printer.openSaved(saved[0]);
    return _cachedWebUsb;
  }
  _cachedWebUsb = await Printer.connect();
  return _cachedWebUsb;
}

// ── Tipos compartidos ─────────────────────────────────────────────────────

type TicketArgs = Parameters<Printer['printReceipt']>[0];
type KitchenTicketArgs = Parameters<Printer['printKitchenTicket']>[0];

export interface PrintResult {
  ok: boolean;
  error?: string;
  mode?: PrintMode;
  printerName?: string;
}

// ── Impresión genérica con failover ───────────────────────────────────────

/**
 * Imprime ticket de cliente. Si hay print server: lo manda al primer
 * impresora SIN estacion (típicamente la del cajero). Si no hay,
 * fallback a WebUSB.
 */
export async function imprimirTicket(args: TicketArgs): Promise<PrintResult> {
  const mode = await detectMode();
  if (mode === 'server') {
    try {
      const printers = await printServer.listPrinters();
      const cajero = printers.find((p) => p.estacion === null || p.estacion === 'cliente');
      if (!cajero) {
        // No hay impresora marcada como "cliente" — usa la primera disponible
        if (printers.length === 0) {
          return { ok: false, error: 'Sin impresoras configuradas en el print server', mode };
        }
        await printServer.print(printers[0]!.id, args as unknown as Record<string, unknown>);
        return { ok: true, mode, printerName: printers[0]!.nombre };
      }
      await printServer.print(cajero.id, args as unknown as Record<string, unknown>);
      return { ok: true, mode, printerName: cajero.nombre };
    } catch (err) {
      console.warn('[printerService] print server falló, fallback a WebUSB:', err);
      return imprimirTicketWebUsb(args);
    }
  }
  if (mode === 'webusb') return imprimirTicketWebUsb(args);
  return { ok: false, error: 'No hay impresora disponible. Iniciá el print server o conectá USB.', mode: 'none' };
}

async function imprimirTicketWebUsb(args: TicketArgs): Promise<PrintResult> {
  try {
    const printer = await getWebUsbPrinter();
    if (!printer) return { ok: false, error: 'Sin impresora WebUSB', mode: 'webusb' };
    await printer.printReceipt(args);
    return { ok: true, mode: 'webusb' };
  } catch (err) {
    _cachedWebUsb = null;
    return { ok: false, error: err instanceof Error ? err.message : String(err), mode: 'webusb' };
  }
}

/** Imprime ticket de cocina ruteado por estación. */
export async function imprimirPorEstacion(
  estacion: string,
  args: KitchenTicketArgs,
): Promise<PrintResult> {
  const mode = await detectMode();
  if (mode === 'server') {
    try {
      await printServer.printByEstacion(estacion, args as unknown as Record<string, unknown>);
      return { ok: true, mode };
    } catch (err) {
      // Si no hay impresora asignada a esta estación: fallback a WebUSB
      console.warn(`[printerService] print por estación "${estacion}" falló, fallback WebUSB:`, err);
      return imprimirTicketCocinaWebUsb(args);
    }
  }
  if (mode === 'webusb') return imprimirTicketCocinaWebUsb(args);
  return { ok: false, error: 'No hay impresora disponible', mode: 'none' };
}

export async function imprimirTicketCocina(args: KitchenTicketArgs): Promise<PrintResult> {
  const mode = await detectMode();
  if (mode === 'server') {
    try {
      const printers = await printServer.listPrinters();
      // Si vino con estación específica, ruteamos; sino primera no-cliente
      const target = printers.find((p) => p.estacion === args.estacion) ||
                     printers.find((p) => p.estacion !== null && p.estacion !== 'cliente') ||
                     printers[0];
      if (!target) return { ok: false, error: 'Sin impresoras configuradas', mode };
      await printServer.print(target.id, args as unknown as Record<string, unknown>);
      return { ok: true, mode, printerName: target.nombre };
    } catch (err) {
      console.warn('[printerService] kitchen ticket print server falló, fallback:', err);
      return imprimirTicketCocinaWebUsb(args);
    }
  }
  if (mode === 'webusb') return imprimirTicketCocinaWebUsb(args);
  return { ok: false, error: 'No hay impresora disponible', mode: 'none' };
}

async function imprimirTicketCocinaWebUsb(args: KitchenTicketArgs): Promise<PrintResult> {
  try {
    const printer = await getWebUsbPrinter();
    if (!printer) return { ok: false, error: 'Sin impresora WebUSB', mode: 'webusb' };
    await printer.printKitchenTicket(args);
    return { ok: true, mode: 'webusb' };
  } catch (err) {
    _cachedWebUsb = null;
    return { ok: false, error: err instanceof Error ? err.message : String(err), mode: 'webusb' };
  }
}

export async function abrirCajon(): Promise<PrintResult> {
  // El cajón típicamente está en la impresora del cajero (sin estación o
  // estación='cliente'). Sin print server, va via WebUSB.
  const mode = await detectMode();
  if (mode === 'webusb') {
    try {
      const printer = await getWebUsbPrinter();
      if (!printer) return { ok: false, error: 'Sin impresora WebUSB', mode };
      await printer.openCashDrawer();
      return { ok: true, mode };
    } catch (err) {
      _cachedWebUsb = null;
      return { ok: false, error: err instanceof Error ? err.message : String(err), mode };
    }
  }
  // TODO sprint próximo: endpoint /open-drawer en el print server.
  return { ok: false, error: 'Abrir cajón solo soportado vía WebUSB todavía', mode };
}

/** Legacy export — mantener compat con código existente. */
export function resetPrinterCache(): void {
  resetPrintModeCache();
}
