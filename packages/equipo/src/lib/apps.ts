// Catálogo de apps del ecosistema Cocina. Lo usa Equipo para mostrar
// "accesos por app" y se guarda en usuarios.apps_permitidas (migración
// 202606250700). Cada app del ecosistema chequea esta lista al login.

export type AppKey = 'pase' | 'comanda' | 'mesa' | 'habitue' | 'equipo';

export interface AppDef {
  key: AppKey;
  nombre: string;
  emoji: string;
  desc: string;
  paraQuien: string;
  url: string;
}

export const APPS: AppDef[] = [
  { key: 'pase', nombre: 'PASE', emoji: '📊', desc: 'Back-office: EERR, RRHH, Caja, Conciliación, Facturas.', paraQuien: 'Dueño, admin, contadora', url: 'https://pase-yndx.vercel.app' },
  { key: 'comanda', nombre: 'COMANDA', emoji: '📱', desc: 'POS: ventas, salón, KDS, tienda online.', paraQuien: 'Cajeros, mozos, cocina', url: 'https://pase-comanda.vercel.app' },
  { key: 'mesa', nombre: 'MESA', emoji: '🗺️', desc: 'Reservas, plano del salón, comensales.', paraQuien: 'Encargados de reservas, anfitriones', url: 'https://mesa-orpin.vercel.app/admin' },
  { key: 'habitue', nombre: 'Habitué', emoji: '💛', desc: 'CRM y marketing: segmentos, campañas, fidelidad.', paraQuien: 'Marketing, dueño', url: 'https://habitue.vercel.app/admin' },
  { key: 'equipo', nombre: 'Equipo', emoji: '🛡️', desc: 'Gestión de usuarios y accesos (este panel).', paraQuien: 'Dueño', url: '' },
];

export function appDef(key: string): AppDef | null {
  return APPS.find((a) => a.key === (key as AppKey)) ?? null;
}
