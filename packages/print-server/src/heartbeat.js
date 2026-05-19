// heartbeat.js — manda stats del agent al backend cada N segundos.
//
// El agent NO tiene usuario logueado. Auth es por agent_token único
// pre-vinculado (el dueño lo generó desde COMANDA y lo pegó en el
// instalador en el primer arranque).
//
// Si el token es inválido (revocado), dejamos de mandar para no spammear
// — pero seguimos imprimiendo igual. El servidor de Lucas perdería
// visibilidad sobre este local pero el funcionamiento local es intacto.
//
// Endpoint backend: POST {HEARTBEAT_URL}/api/tienda-mp?action=agent-heartbeat
//
// Config (en ~/.comanda-print-server.json):
//   {
//     "agent_token": "abc123...",        // requerido
//     "heartbeat_url": "https://...",    // opcional, default abajo
//     "agent_name": "PC Cocina"          // visible en UI admin
//   }

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_HEARTBEAT_URL = 'https://pase-yndx.vercel.app';
const HEARTBEAT_INTERVAL_MS = 60_000; // 1 min
const HEARTBEAT_TIMEOUT_MS = 8_000;
const PKG_VERSION = '1.1.0';

export class Heartbeat {
  /**
   * @param {object} args
   * @param {() => Array<object>} args.getPrinters    — lista de impresoras configuradas
   * @param {() => Promise<Record<string, boolean>>} args.checkPrintersOnline — fn que devuelve { printer_id: online }
   * @param {() => object} args.getQueueStats         — stats actuales de la cola
   * @param {string} args.agentToken                  — token único
   * @param {string} [args.heartbeatUrl]              — base URL del backend
   */
  constructor({ getPrinters, checkPrintersOnline, getQueueStats, agentToken, heartbeatUrl }) {
    this.getPrinters = getPrinters;
    this.checkPrintersOnline = checkPrintersOnline;
    this.getQueueStats = getQueueStats;
    this.agentToken = agentToken;
    this.heartbeatUrl = heartbeatUrl || DEFAULT_HEARTBEAT_URL;
    this._timer = null;
    this._consecutiveErrors = 0;
    this._disabled = false;
  }

  start() {
    if (this._timer || !this.agentToken) {
      if (!this.agentToken) {
        console.warn('[heartbeat] sin agent_token configurado — heartbeat deshabilitado');
      }
      return;
    }
    console.log(`[heartbeat] arrancando — ${this.heartbeatUrl} cada ${HEARTBEAT_INTERVAL_MS/1000}s`);
    // Primer beat inmediato (para que aparezca en UI rápido)
    this._tick().catch(() => {});
    this._timer = setInterval(() => this._tick().catch(() => {}), HEARTBEAT_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _tick() {
    if (this._disabled) return;
    try {
      const printers = this.getPrinters();
      const onlineMap = await this.checkPrintersOnline().catch(() => ({}));
      const printersPayload = printers.map((p) => ({
        id: p.id,
        nombre: p.nombre,
        estacion: p.estacion,
        transporte: p.transporte,
        online: !!onlineMap[p.id],
      }));

      const url = `${this.heartbeatUrl}/api/tienda-mp?action=agent-heartbeat`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), HEARTBEAT_TIMEOUT_MS);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_token: this.agentToken,
          agent_version: PKG_VERSION,
          hostname: os.hostname(),
          os_platform: process.platform,
          printers: printersPayload,
          queue: this.getQueueStats(),
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);

      if (resp.status === 401) {
        console.error('[heartbeat] token inválido / revocado — deshabilitando heartbeat. Re-vincular desde COMANDA.');
        this._disabled = true;
        this.stop();
        return;
      }
      if (!resp.ok) {
        this._consecutiveErrors++;
        if (this._consecutiveErrors <= 3 || this._consecutiveErrors % 10 === 0) {
          console.warn(`[heartbeat] HTTP ${resp.status} (consecutive errors: ${this._consecutiveErrors})`);
        }
        return;
      }
      if (this._consecutiveErrors > 0) {
        console.log('[heartbeat] reconectado — recovered tras', this._consecutiveErrors, 'errores');
      }
      this._consecutiveErrors = 0;
    } catch (err) {
      this._consecutiveErrors++;
      if (this._consecutiveErrors <= 3 || this._consecutiveErrors % 10 === 0) {
        console.warn(`[heartbeat] error: ${err.message} (consecutive: ${this._consecutiveErrors})`);
      }
    }
  }
}

/**
 * Lee config y devuelve { agentToken, heartbeatUrl }. Si no hay config o
 * falta token, devuelve nulls — el caller decide qué hacer.
 */
export function loadHeartbeatConfig(configPath) {
  try {
    if (!fs.existsSync(configPath)) return { agentToken: null, heartbeatUrl: null };
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      agentToken: cfg.agent_token || null,
      heartbeatUrl: cfg.heartbeat_url || null,
      agentName: cfg.agent_name || null,
    };
  } catch (err) {
    console.error('[heartbeat] error leyendo config:', err.message);
    return { agentToken: null, heartbeatUrl: null };
  }
}
