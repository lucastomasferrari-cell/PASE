// Auditoría — últimos cambios sensibles (alta, baja, cambio de permisos,
// reset PIN, etc.). Tabla accesos_audit (migración 202606250700). Graceful.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ScrollText, UserPlus, UserMinus, Power, KeyRound, ShieldCheck, MapPin } from 'lucide-react';
import { listAudit, type AuditEntry, type AuditAccion } from '@/lib/auditService';
import { listUsuarios, type Usuario } from '@/lib/usuariosService';
import { SectionHeader, IconBox, Chip, MiniNote } from '@/components/primitives';

const ICONO: Record<AuditAccion, React.ReactNode> = {
  crear: <UserPlus className="h-4 w-4" />,
  editar: <ShieldCheck className="h-4 w-4" />,
  activar: <Power className="h-4 w-4 text-live" />,
  desactivar: <UserMinus className="h-4 w-4 text-warn" />,
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

// Etiqueta corta mono para el chip de tipo de acción.
const TIPO: Record<AuditAccion, string> = {
  crear: 'ALTA',
  editar: 'EDIT',
  activar: 'ON',
  desactivar: 'OFF',
  reset_password: 'PWD',
  cambio_rol: 'ROL',
  cambio_apps: 'APPS',
  cambio_locales: 'LOCAL',
  cambio_permisos: 'PERMS',
  reset_pin: 'PIN',
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
    <div className="max-w-3xl">
      <SectionHeader label="Registro de actividad" count={entries.length || undefined} />

      <p className="text-sm text-dim-300 mb-6">Quién hizo qué, cuándo. Los cambios sensibles del equipo quedan registrados acá.</p>

      {sinTabla && (
        <MiniNote tone="warn" className="mb-4">
          La auditoría necesita aplicar la migración <span className="font-mono text-xs">202606250700_accesos_app_access.sql</span> (en tus pendientes).
        </MiniNote>
      )}

      {cargando ? (
        <div className="py-16 text-center text-dim-300 mono text-xs uppercase tracking-widest2">Cargando…</div>
      ) : entries.length === 0 ? (
        <div className="border-t border-b border-carbon-600 py-14 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded bg-brand-400/10 text-brand-400 border border-brand-400/20 mb-3"><ScrollText className="h-7 w-7" /></div>
          <p className="font-medium text-dim-50">Sin movimientos por ahora</p>
          <p className="text-sm text-dim-300 mt-1">Cuando hagas cambios al equipo, aparecen acá.</p>
        </div>
      ) : (
        <div className="border-t border-carbon-600">
          {entries.map((e) => (
            <div key={e.id} className="border-b border-carbon-600 px-1 py-3.5 flex items-center gap-3 sm:gap-4">
              <IconBox>{ICONO[e.accion]}</IconBox>
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">
                  <span className="font-medium text-dim-50">{nombre(e.actor_id)}</span>
                  <span className="text-dim-200"> {LABEL[e.accion].toLowerCase()} </span>
                  <span className="font-medium text-dim-50">{nombre(e.usuario_id)}</span>
                </div>
              </div>
              <div className="hidden sm:block shrink-0">
                <Chip>{TIPO[e.accion]}</Chip>
              </div>
              <div className="mono text-[11px] tabular-nums text-dim-300 shrink-0">{fechaCorta(e.created_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
