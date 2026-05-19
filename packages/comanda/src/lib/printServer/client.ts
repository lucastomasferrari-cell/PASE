// Cliente HTTP para hablar con el COMANDA Print Server local.
//
// El server corre en http://127.0.0.1:9100 por default. Lo detectamos con
// un ping al arranque. Si responde, todas las operaciones van por acá.
// Si no, el printerService cae back a WebUSB.

const DEFAULT_SERVER_URL = 'http://127.0.0.1:9100';

export interface PrintServerStatus {
  available: boolean;
  version?: string;
  printers_configured?: number;
  error?: string;
}

export interface PrintServerPrinter {
  id: string;
  nombre: string;
  estacion: string | null;
  transporte: 'usb' | 'network' | 'serial';
  config: Record<string, unknown>;
  status?: { ok: boolean; error?: string };
}

export interface UpsertPrinterArgs {
  id?: string;
  nombre: string;
  estacion: string | null;
  transporte: 'usb' | 'network' | 'serial';
  config: Record<string, unknown>;
}

export class PrintServerClient {
  private baseUrl: string;
  private cachedStatus: PrintServerStatus | null = null;
  private lastCheckAt = 0;

  constructor(baseUrl: string = DEFAULT_SERVER_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Ping al servidor con timeout corto. Si no responde en 2s, asumimos
   * que no está corriendo. Cacheamos resultado 30s para no spammear.
   */
  async ping(): Promise<PrintServerStatus> {
    if (this.cachedStatus && Date.now() - this.lastCheckAt < 30_000) {
      return this.cachedStatus;
    }
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(`${this.baseUrl}/ping`, { signal: ctrl.signal });
      clearTimeout(timeout);
      if (!resp.ok) {
        this.cachedStatus = { available: false, error: `HTTP ${resp.status}` };
      } else {
        const data = await resp.json();
        this.cachedStatus = {
          available: true,
          version: data.version,
          printers_configured: data.printers_configured,
        };
      }
    } catch (err) {
      this.cachedStatus = {
        available: false,
        error: err instanceof Error ? err.message : 'connection refused',
      };
    }
    this.lastCheckAt = Date.now();
    return this.cachedStatus;
  }

  /** Forzar re-check (despues de iniciar el server). */
  invalidatePingCache(): void {
    this.cachedStatus = null;
    this.lastCheckAt = 0;
  }

  async listPrinters(): Promise<PrintServerPrinter[]> {
    const resp = await fetch(`${this.baseUrl}/printers`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data.printers ?? [];
  }

  async upsertPrinter(args: UpsertPrinterArgs): Promise<PrintServerPrinter> {
    const resp = await fetch(`${this.baseUrl}/printers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return data.printer;
  }

  async deletePrinter(id: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/printers/${id}`, { method: 'DELETE' });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
  }

  /**
   * Imprime ticket en una impresora específica.
   * @param idempotencyKey — si llega, el server deduplica. Útil para reintentos.
   */
  async print(
    printerId: string,
    ticket: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printer_id: printerId,
        ticket,
        idempotency_key: idempotencyKey ?? null,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({}));
      throw new Error(detail.detail || detail.error || `HTTP ${resp.status}`);
    }
  }

  /**
   * Imprime ruteando por estación. Si no hay impresora asignada, error.
   * @param idempotencyKey — server-side dedupe para reintentos seguros.
   */
  async printByEstacion(
    estacion: string,
    ticket: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/print-by-estacion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        estacion,
        ticket,
        idempotency_key: idempotencyKey ?? null,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({}));
      throw new Error(detail.detail || detail.error || `HTTP ${resp.status}`);
    }
  }

  async testPrint(printerId: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/test/${printerId}`, { method: 'POST' });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({}));
      throw new Error(detail.detail || detail.error || `HTTP ${resp.status}`);
    }
  }

  async discoverUsb(): Promise<Array<{ vendor_id: string; product_id: string }>> {
    const resp = await fetch(`${this.baseUrl}/discover/usb`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.devices ?? [];
  }
}

// Singleton compartido en la app
export const printServer = new PrintServerClient();
