import { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, Users } from 'lucide-react';
import type { Usuario } from '../../types/auth';
import type { EmpleadoPos, RolPos } from '../../types/database';
import {
  listEmpleadosLocal, setRolPos, setPosActivo,
} from '../../services/empleadosService';
import { listLocalesAccesibles, type LocalSimple } from '../../services/configService';
import { useLocalActivo } from '../../lib/localActivo';
import { useRealtimeTable } from '../../lib/useRealtimeTable';
import { Badge } from '../../components/Badge';
import { PinDialog } from './PinDialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';

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

  // Sprint Realtime: cambios remotos en rrhh_empleados (rol_pos, pos_activo,
  // PIN, etc) del mismo tenant. Si otro admin cambia el rol POS de un
  // empleado, se ve sin F5.
  useRealtimeTable({ table: 'rrhh_empleados', onChange: () => reload() });

  if (localId === null) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          No hay local seleccionado.
        </CardContent>
      </Card>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <Label className="text-sm font-semibold">Local:</Label>
        <Select value={String(localId)} onValueChange={(v) => setLocalActivo(Number(v))}>
          <SelectTrigger className="w-[280px] h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {locales.map((l) => (
              <SelectItem key={l.id} value={String(l.id)}>{l.nombre}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground ml-auto">
          Asigná rol POS y PIN a los empleados que van a operar la caja.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading ? (
        <Card><CardContent className="py-16 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : empleados.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
              <Users className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">Sin empleados en este local</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Cargalos desde PASE → RRHH para que aparezcan acá y puedan operar el POS.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[2fr_1fr_220px_140px_120px_180px] gap-4 px-6 py-3 border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div>Empleado</div>
            <div>Puesto</div>
            <div>Rol POS</div>
            <div>PIN</div>
            <div>Activo POS</div>
            <div className="text-right">Acciones</div>
          </div>
          {empleados.map((e, idx) => {
            const tienePin = !!e.pin_actualizado_at;
            const rolBadge = ROLES.find((r) => r.value === e.rol_pos);
            return (
              <div
                key={e.id}
                className={`grid grid-cols-[2fr_1fr_220px_140px_120px_180px] gap-4 px-6 py-4 items-center transition-colors hover:bg-muted/30 ${
                  idx !== empleados.length - 1 ? 'border-b border-border' : ''
                }`}
              >
                <div className="font-medium truncate">{e.apellido} {e.nombre}</div>
                <div className="text-sm text-muted-foreground truncate">{e.puesto}</div>
                <div className="flex items-center gap-2">
                  <Select
                    value={e.rol_pos ?? ''}
                    onValueChange={async (v) => {
                      const next = (v === '_none' ? null : v) as RolPos | null;
                      const { error: err } = await setRolPos(e.id, next);
                      if (err) setError(err); else reload();
                    }}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue placeholder="— sin rol —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">— sin rol —</SelectItem>
                      {ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {rolBadge && <Badge variant={rolBadge.color}>{rolBadge.label}</Badge>}
                </div>
                <div>
                  {tienePin ? (
                    <Badge variant="green">
                      <CheckCircle2 className="h-3 w-3 mr-1 inline" />
                      Seteado
                    </Badge>
                  ) : (
                    <Badge variant="gray">—</Badge>
                  )}
                </div>
                <div>
                  <Switch
                    checked={e.pos_activo}
                    onCheckedChange={async (checked) => {
                      const { error: err } = await setPosActivo(e.id, checked);
                      if (err) setError(err); else reload();
                    }}
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPinDialog(e)}
                    disabled={!e.rol_pos}
                    title={!e.rol_pos ? 'Asigná un rol POS primero' : ''}
                  >
                    {tienePin ? 'Cambiar PIN' : 'Asignar PIN'}
                  </Button>
                </div>
              </div>
            );
          })}
        </Card>
      )}

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
