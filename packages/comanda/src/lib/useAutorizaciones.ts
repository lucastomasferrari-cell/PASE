import { useEffect, useState } from 'react';
import { getLocalSettings } from '@/services/localSettingsService';

// Config de autorizaciones de manager por local. Espejo de las columnas
// req_auth_* de comanda_local_settings (default OFF). Los diálogos del POS
// (MovimientoCajaDialog, DiscountDialog, cambio de precio) la leen para
// decidir si piden PIN de manager. Fail-safe: si no carga o no hay fila,
// queda TODO apagado (no pide autorización) — que es el estado por default.
export interface Autorizaciones {
  reqMovimiento: boolean;
  umbralMovimiento: number;
  reqDescuento: boolean;
  pctDescuento: number;
  reqCambioPrecio: boolean;
}

const OFF: Autorizaciones = {
  reqMovimiento: false,
  umbralMovimiento: 5000,
  reqDescuento: false,
  pctDescuento: 15,
  reqCambioPrecio: false,
};

export function useAutorizaciones(localId: number | null): Autorizaciones {
  const [cfg, setCfg] = useState<Autorizaciones>(OFF);

  useEffect(() => {
    if (localId == null) { setCfg(OFF); return; }
    let cancelled = false;
    getLocalSettings(localId).then(({ data }) => {
      if (cancelled) return;
      if (!data) { setCfg(OFF); return; }
      setCfg({
        reqMovimiento: !!data.req_auth_movimiento,
        umbralMovimiento: Number(data.req_auth_movimiento_umbral ?? 5000),
        reqDescuento: !!data.req_auth_descuento,
        pctDescuento: Number(data.req_auth_descuento_pct ?? 15),
        reqCambioPrecio: !!data.req_auth_cambio_precio,
      });
    }).catch(() => { if (!cancelled) setCfg(OFF); });
    return () => { cancelled = true; };
  }, [localId]);

  return cfg;
}
