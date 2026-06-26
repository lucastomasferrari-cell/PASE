// WarningIntegracionFalta — banner que avisa "te falta conectar X integración"
// con CTA a /configuracion/integraciones.
//
// Uso típico:
//   {tienda_activa && <WarningIntegracionFalta provider="email"
//     mensaje="Para que el cliente reciba confirmación del pedido, conectá email." />}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Plug } from 'lucide-react';
import { estadoIntegracion, type ProviderId } from '@/lib/integracionesService';

interface Props {
  provider: ProviderId;
  mensaje: string;
  /** Opcional: tono del aviso (warn vs info). Default warn. */
  tono?: 'warn' | 'info';
}

const NOMBRES: Record<ProviderId, string> = {
  whatsapp_api: 'WhatsApp Business API',
  email: 'Email (Resend)',
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  search_console: 'Search Console',
  instagram: 'Instagram',
  google_maps: 'Google Maps',
  stripe: 'Stripe',
  mp_point: 'MercadoPago Point',
};

export function WarningIntegracionFalta({ provider, mensaje, tono = 'warn' }: Props) {
  const [estado, setEstado] = useState<'desconectado' | 'conectado' | 'error' | 'probando' | 'cargando'>('cargando');

  useEffect(() => {
    let cancelado = false;
    void estadoIntegracion(provider).then((e) => { if (!cancelado) setEstado(e); });
    return () => { cancelado = true; };
  }, [provider]);

  if (estado === 'cargando' || estado === 'conectado') return null;

  const colorClasses = tono === 'warn'
    ? 'bg-amber-50 border-amber-200 text-amber-900'
    : 'bg-blue-50 border-blue-200 text-blue-900';

  return (
    <div className={`rounded-xl border p-3 text-sm ${colorClasses} flex items-start gap-3`}>
      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="font-medium">Te falta conectar {NOMBRES[provider]}</div>
        <div className="text-xs mt-0.5 opacity-90">{mensaje}</div>
      </div>
      <Link
        to="/configuracion/integraciones"
        className="text-xs px-3 py-1.5 rounded-lg bg-white border border-current/30 hover:bg-current/5 font-medium inline-flex items-center gap-1.5 shrink-0"
      >
        <Plug className="h-3.5 w-3.5" /> Conectar
      </Link>
    </div>
  );
}
