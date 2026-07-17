// Auditoría — últimos cambios sensibles (alta, baja, cambio de permisos,
// reset PIN, etc.). Tabla accesos_audit (migración 202606250700). Graceful.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ScrollText, UserPlus, UserMinus, Power, KeyRound, ShieldCheck, MapPin } from 'lucide-react';
import { listAudit, type AuditEntry, type AuditAccion } from '@/lib/auditService';
import { listUsuarios, type Usuario } from '@/lib/usuariosService';

const ICONO: Record<AuditAccion, React.ReactNode> = {
  crear: <UserPlus className="h-4 w-4" />,
  editar: <ShieldCheck className="h-4 w-4" />,
  activar: <Power className="h-4 w-4 text-live" />,
  desactivar: <UserMinus className="h-4 w-4 text-amber-600" />,
  reset_password: <KeyRound className="h-4 w-4" />,
  cambio_rol: <ShieldCheck className="h-4 w-4" />,
  cambio_apps: <ShieldCheck className="h-4 w-4" />,
  cambio_locales: <MapPin className="h-4 w-4" />,
  cambio_permisos: <ShieldCheck className="h-4 w-4" />,
  reset_pin: <KeyRound className="h-4 w-4" />,
};

const LABEL: Record<AuditAccion, string> = {
  crear: 'Creó',
  editar: 'Editó',
  activar: 'Activó',
  desactivar: 'Desactivó',
  reset_password: 'Reseteó password de',
  cambio_rol: 'Cambió el rol de',
  cambio_apps: 'Cambió apps de',
  cambio_locales: 'Cambió locales de',
  cambio_permisos: 'Cambió permisos de',
  reset_pin: 'Reseteó PIN de',
};

function fechaCorta(iso: string) {
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function Auditoria() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [users, setUsers] = useState<Usuario[]>([]);
  const [sinTabla, setSinTabla] = useState(false);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    void (async () => {
      const [a, u] = await Promise.all([listAudit(200), listUsuarios()]);
      if (a.error) toast.error(a.error);
      setEntries(a.data); setSinTabla(a.sinTabla); setUsers(u.data);
      setCargando(false);
    })();
  }, []);

  function nombre(id: number) {
    const u = users.find((x) => x.id === id);
    return u ? (u.nombre || u.email) : `#${id}`;
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-brand-400 tracking-widest2">05 //</span>
        <h1 className="text-2xl font-semibold text-dim-50 tracking-tight">Actividad</h1>
      </div>
      <p className="text-sm text-dim-300">Quién hizo qué, cuándo. Los cambios sensibles del equipo quedan registrados acá.</p>

      {sinTabla && (
        <div className="rounded-sm bg-amber-50 border border-amber-200 text-amber-800 text-sm p-3">
          La auditoría necesita aplicar la migración <span className="font-mono text-xs">202606250700_accesos_app_access.sql</span> (en tus pendientes).
        </div>
      )}

      {cargando ? (
        <div className="py-16 text-center text-dim-300">Cargando…</div>
      ) : entries.length === 0 ? (
        <div className="border-t border-b border-carbon-600 bg-transparent py-14 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-sm bg-brand-400/10 text-brand-400 mb-3"><ScrollText className="h-7 w-7" /></div>
          <p className="font-medium">Sin movimientos por ahora</p>
          <p className="text-sm text-dim-300 mt-1">Cuando hagas cambios al equipo, aparecen acá.</p>
        </div>
      ) : (
        <div className="border-t border-b border-carbon-600 bg-transparent divide-y divide-carbon-600">
          {entries.map((e) => (
            <div key={e.id} className="px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-sm bg-brand-400/10 text-brand-400 grid place-items-center shrink-0">
                {ICONO[e.accion]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm">
                  <span className="font-medium">{nombre(e.actor_id)}</span>
                  <span className="text-dim-200"> {LABEL[e.accion].toLowerCase()} </span>
                  <span className="font-medium">{nombre(e.usuario_id)}</span>
                </div>
              </div>
              <div className="text-[11px] text-dim-300 shrink-0">{fechaCorta(e.created_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
