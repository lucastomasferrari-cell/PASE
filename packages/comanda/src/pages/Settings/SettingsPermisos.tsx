import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Users, KeyRound } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  listUsuariosTenant, getPermisosUsuario, setPermisosUsuario, SLUGS_COMANDA,
  type UsuarioPermisos,
} from '@/services/permisosService';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/Badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export function SettingsPermisos() {
  const { user } = useAuth();
  const [usuarios, setUsuarios] = useState<UsuarioPermisos[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<UsuarioPermisos | null>(null);

  const reload = useCallback(async () => {
    if (!user?.tenant_id) return;
    setLoading(true);
    const { data } = await listUsuariosTenant(user.tenant_id);
    setUsuarios(data);
    setLoading(false);
  }, [user?.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted-foreground">
          Asigná permisos COMANDA a usuarios PASE. Los slugs viven en RLS policies — ver
          comentarios en migrations.
        </p>
      </div>

      {loading ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : usuarios.length === 0 ? (
        <Card><CardContent className="py-16 text-center">
          <Users className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="text-lg font-medium mb-1">Sin usuarios activos</h3>
          <p className="text-sm text-muted-foreground">Cargá usuarios desde PASE → Usuarios.</p>
        </CardContent></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[2fr_1fr_140px_120px_140px] gap-4 px-6 py-3 border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div>Usuario</div><div>Email</div><div>Rol PASE</div><div className="text-right">Permisos</div><div className="text-right">Acciones</div>
          </div>
          {usuarios.map((u, idx) => (
            <div key={u.id} className={`grid grid-cols-[2fr_1fr_140px_120px_140px] gap-4 px-6 py-3 items-center text-sm ${idx !== usuarios.length - 1 ? 'border-b border-border' : ''}`}>
              <div className="font-medium truncate">{u.nombre}</div>
              <div className="text-xs text-muted-foreground truncate">{u.email ?? '—'}</div>
              <div>
                <Badge variant={u.rol === 'dueno' || u.rol === 'superadmin' ? 'red' : u.rol === 'admin' ? 'violet' : 'gray'}>
                  {u.rol}
                </Badge>
              </div>
              <div className="text-right tabular-nums">
                {u.permisos_count > 0 ? <Badge variant="green">{u.permisos_count} permisos</Badge> : <span className="text-muted-foreground">—</span>}
              </div>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setEditing(u)}>
                  <KeyRound className="h-4 w-4 mr-2" />
                  Permisos
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      {editing && user?.tenant_id && (
        <PermisosDialog
          usuario={editing}
          tenantId={user.tenant_id}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

function PermisosDialog({ usuario, tenantId, onClose, onSaved }: {
  usuario: UsuarioPermisos;
  tenantId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getPermisosUsuario(usuario.id).then((r) => {
      setSeleccion(new Set(r.data));
      setLoading(false);
    });
  }, [usuario.id]);

  function toggle(slug: string) {
    setSeleccion((s) => {
      const next = new Set(s);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function guardar() {
    setSaving(true);
    const { error } = await setPermisosUsuario(usuario.id, tenantId, Array.from(seleccion));
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success('Permisos actualizados');
    onSaved();
  }

  // Agrupar slugs por modulo
  const grupos = SLUGS_COMANDA.reduce<Record<string, typeof SLUGS_COMANDA[number][]>>((acc, s) => {
    if (!acc[s.modulo]) acc[s.modulo] = [];
    acc[s.modulo]!.push(s);
    return acc;
  }, {});

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Permisos de {usuario.nombre}</DialogTitle>
          <DialogDescription>
            {usuario.rol === 'superadmin' || usuario.rol === 'dueno' ? (
              <span className="text-warning">
                Este usuario tiene rol "{usuario.rol}" — pasa por bypass en todo COMANDA.
                Asignar permisos acá no cambia nada para él.
              </span>
            ) : 'Tildá los permisos COMANDA que querés darle. Los permisos PASE no se ven acá.'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-muted-foreground">Cargando…</div>
        ) : (
          <div className="space-y-4">
            {Object.entries(grupos).map(([modulo, slugs]) => (
              <div key={modulo} className="space-y-2">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{modulo}</h4>
                <div className="space-y-1">
                  {slugs.map((s) => {
                    const sel = seleccion.has(s.slug);
                    return (
                      <button
                        key={s.slug}
                        type="button"
                        onClick={() => toggle(s.slug)}
                        className={`w-full text-left p-3 rounded-md border transition-colors ${sel ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'}`}
                      >
                        <div className="flex items-center gap-3">
                          <input type="checkbox" checked={sel} onChange={() => toggle(s.slug)} className="h-4 w-4 pointer-events-none" />
                          <div className="min-w-0">
                            <div className="text-sm font-medium">{s.label}</div>
                            <div className="text-xs text-muted-foreground font-mono">{s.slug}</div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={guardar} disabled={saving || loading}>
            {saving ? 'Guardando…' : `Guardar (${seleccion.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
