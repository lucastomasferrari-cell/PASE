import { useEffect, useState, useCallback } from 'react';
import type { Usuario } from '../../types/auth';
import type { EmpleadoPos, RolPos } from '../../types/database';
import {
  listEmpleadosLocal, setRolPos, setPosActivo,
} from '../../services/empleadosService';
import { listLocalesAccesibles, type LocalSimple } from '../../services/configService';
import { useLocalActivo } from '../../lib/localActivo';
import { Badge } from '../../components/Badge';
import { PinDialog } from './PinDialog';

interface Props { user: Usuario }

const ROLES: Array<{ value: RolPos; label: string; color: 'gray' | 'blue' | 'violet' | 'red' }> = [
  { value: 'cajero',    label: 'Cajero',    color: 'gray' },
  { value: 'encargado', label: 'Encargado', color: 'blue' },
  { value: 'manager',   label: 'Manager',   color: 'violet' },
  { value: 'dueno',     label: 'Dueño',     color: 'red' },
];

export function SettingsEmpleados({ user }: Props) {
  const [localId, setLocalActivo] = useLocalActivo(user);
  const [locales, setLocales] = useState<LocalSimple[]>([]);
  const [empleados, setEmpleados] = useState<EmpleadoPos[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pinDialog, setPinDialog] = useState<EmpleadoPos | null>(null);

  useEffect(() => {
    listLocalesAccesibles().then((res) => setLocales(res.data));
  }, []);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data, error: err } = await listEmpleadosLocal(localId);
    if (err) setError(err);
    setEmpleados(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  if (localId === null) {
    return <div style={{ padding: 24 }}>No hay local seleccionado.</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>Local:</strong>
        <select
          value={localId}
          onChange={(e) => setLocalActivo(Number(e.target.value))}
          style={{ padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14 }}
        >
          {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0, marginLeft: 'auto' }}>
          Asigná rol POS y PIN a los empleados que van a operar la caja.
        </p>
      </div>

      {error && <div style={{ padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, marginBottom: 12 }}>{error}</div>}

      <div style={{ border: '1px solid #E5E7EB', borderRadius: 8, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead style={{ background: '#F9FAFB' }}>
            <tr>
              <th style={th}>Empleado</th>
              <th style={th}>Puesto</th>
              <th style={th}>Rol POS</th>
              <th style={th}>PIN</th>
              <th style={th}>Activo POS</th>
              <th style={th}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>Cargando…</td></tr>}
            {!loading && empleados.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>
                No hay empleados activos en este local. Cargalos desde PASE → RRHH.
              </td></tr>
            )}
            {empleados.map((e) => {
              const tienePin = !!e.pin_actualizado_at;
              const rolBadge = ROLES.find((r) => r.value === e.rol_pos);
              return (
                <tr key={e.id} style={{ borderTop: '1px solid #E5E7EB' }}>
                  <td style={td}><strong>{e.apellido} {e.nombre}</strong></td>
                  <td style={td}>{e.puesto}</td>
                  <td style={td}>
                    <select
                      value={e.rol_pos ?? ''}
                      onChange={async (ev) => {
                        const v = ev.target.value as RolPos | '';
                        const { error: err } = await setRolPos(e.id, v || null);
                        if (err) setError(err); else reload();
                      }}
                      style={{ padding: '4px 8px', border: '1px solid #D1D5DB', borderRadius: 4, fontSize: 13 }}
                    >
                      <option value="">— sin rol —</option>
                      {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    {rolBadge && <span style={{ marginLeft: 8 }}><Badge variant={rolBadge.color}>{rolBadge.label}</Badge></span>}
                  </td>
                  <td style={td}>
                    {tienePin ? <Badge variant="green">✓ Seteado</Badge> : <Badge variant="gray">—</Badge>}
                  </td>
                  <td style={td}>
                    <input
                      type="checkbox"
                      checked={e.pos_activo}
                      onChange={async (ev) => {
                        const { error: err } = await setPosActivo(e.id, ev.target.checked);
                        if (err) setError(err); else reload();
                      }}
                    />
                  </td>
                  <td style={td}>
                    <button
                      type="button"
                      onClick={() => setPinDialog(e)}
                      disabled={!e.rol_pos}
                      title={!e.rol_pos ? 'Asigná un rol POS primero' : ''}
                      style={btnSm}
                    >
                      {tienePin ? 'Cambiar PIN' : 'Asignar PIN'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pinDialog && (
        <PinDialog
          empleadoId={pinDialog.id}
          empleadoNombre={`${pinDialog.apellido} ${pinDialog.nombre}`}
          onClose={() => setPinDialog(null)}
          onDone={() => { setPinDialog(null); reload(); }}
        />
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#374151', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: '10px 12px', verticalAlign: 'middle' };
const btnSm: React.CSSProperties = { padding: '4px 10px', border: '1px solid #D1D5DB', borderRadius: 4, background: '#FFFFFF', cursor: 'pointer', fontSize: 12 };
