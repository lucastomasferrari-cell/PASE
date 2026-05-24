// ─────────────────────────────────────────────────────────────────────────
// UsuariosPosPage — Gestión de usuarios POS de COMANDA (DESDE COMANDA).
//
// Sprint COMANDA Autónomo Fase 2.b (Lucas 24-may noche): la gestión
// originalmente vivía en PASE pero Lucas pidió moverla a COMANDA para
// respetar la autonomía. Esta pantalla reemplaza la de PASE.
//
// Acceso: solo rol_pos='admin' (= dueño POS). El frontend chequea + RLS
// dual de comanda_usuarios bloquea modify a roles inferiores.
//
// Endpoint /api/auth-admin?action=create_comanda sigue viviendo en PASE
// (paquete pase) pero COMANDA lo proxyea via vercel.json (/api/* →
// pase-yndx.vercel.app/api/*). Backend compartido, UI separada.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useMemo } from 'react';
import { db } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Pencil } from 'lucide-react';
import type { RolPos } from '../../types/auth';

interface ComandaUsuario {
  id: string;
  auth_id: string | null;
  tenant_id: string;
  nombre: string;
  email: string;
  rol_pos: RolPos;
  locales: number[] | null;
  pin_pos: string | null;
  activo: boolean;
}

interface PermisoCatalogo {
  slug: string;
  descripcion: string;
  categoria: string;
  orden: number;
}

interface LocalRef { id: number; nombre: string }

const ROL_LABEL: Record<RolPos, string> = {
  mozo: 'Mozo',
  cajero: 'Cajero',
  manager: 'Manager',
  admin: 'Admin POS',
};

export default function UsuariosPosPage() {
  const { user } = useAuth();
  const [list, setList] = useState<ComandaUsuario[]>([]);
  const [catalogo, setCatalogo] = useState<PermisoCatalogo[]>([]);
  const [permisosPorUsuario, setPermisosPorUsuario] = useState<Map<string, Set<string>>>(new Map());
  const [locales, setLocales] = useState<LocalRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ComandaUsuario | 'nuevo' | null>(null);

  const esAdminPos = user?.rol_pos === 'admin';

  async function load() {
    setLoading(true);
    const [{ data: users }, { data: cat }, { data: perms }, { data: locs }] = await Promise.all([
      db.from('comanda_usuarios').select('*').order('rol_pos').order('nombre'),
      db.from('comanda_permisos_catalogo').select('*').order('categoria').order('orden'),
      db.from('comanda_usuario_permisos').select('comanda_usuario_id, modulo_slug'),
      db.from('locales').select('id, nombre').order('nombre'),
    ]);
    setList((users || []) as ComandaUsuario[]);
    setCatalogo((cat || []) as PermisoCatalogo[]);
    setLocales((locs || []) as LocalRef[]);
    const map = new Map<string, Set<string>>();
    (perms || []).forEach((p) => {
      const k = (p as { comanda_usuario_id: string }).comanda_usuario_id;
      const s = (p as { modulo_slug: string }).modulo_slug;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k)!.add(s);
    });
    setPermisosPorUsuario(map);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  if (!esAdminPos) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader><CardTitle>Sin acceso</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Solo el rol "Admin POS" puede gestionar usuarios POS. Pedile al dueño que te promueva.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Usuarios POS</h1>
          <p className="text-sm text-muted-foreground">
            {list.length} usuarios · {list.filter(u => u.activo).length} activos.
            Comparten email/password con PASE (auth único), perfiles separados.
          </p>
        </div>
        <Button onClick={() => setModal('nuevo')}>
          <Plus className="mr-2 h-4 w-4" /> Crear usuario POS
        </Button>
      </div>

      {loading ? (
        <div className="text-center text-muted-foreground py-8">Cargando…</div>
      ) : list.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">
          Sin usuarios POS. Cliclá "+ Crear usuario POS".
        </CardContent></Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Nombre</th>
                  <th className="p-3">Email</th>
                  <th className="p-3">Rol</th>
                  <th className="p-3">Locales</th>
                  <th className="p-3 text-center"># Permisos</th>
                  <th className="p-3">Estado</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {list.map(u => {
                  const nPerms = permisosPorUsuario.get(u.id)?.size ?? 0;
                  const localesNombres = u.locales == null
                    ? 'Todos'
                    : u.locales.map(lid => locales.find(l => l.id === lid)?.nombre ?? `#${lid}`).join(', ');
                  return (
                    <tr key={u.id} className={`border-b ${u.activo ? '' : 'opacity-50'}`}>
                      <td className="p-3 font-medium">{u.nombre}</td>
                      <td className="p-3 text-muted-foreground text-xs">{u.email}</td>
                      <td className="p-3"><Badge variant="secondary">{ROL_LABEL[u.rol_pos]}</Badge></td>
                      <td className="p-3 text-xs">{localesNombres}</td>
                      <td className="p-3 text-center">{u.rol_pos === 'admin' ? '—' : nPerms}</td>
                      <td className="p-3">
                        <Badge variant={u.activo ? 'default' : 'outline'}>
                          {u.activo ? 'Activo' : 'Inactivo'}
                        </Badge>
                      </td>
                      <td className="p-3">
                        <Button variant="ghost" size="sm" onClick={() => setModal(u)}>
                          <Pencil className="h-3 w-3 mr-1" /> Editar
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {modal && (
        <UsuarioPosModal
          modo={modal === 'nuevo' ? 'nuevo' : 'editar'}
          usuario={modal === 'nuevo' ? null : modal}
          permisosActuales={modal === 'nuevo' ? new Set() : (permisosPorUsuario.get(modal.id) ?? new Set())}
          catalogo={catalogo}
          locales={locales}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); void load(); }}
        />
      )}
    </div>
  );
}

// ─── Modal crear/editar ────────────────────────────────────────────────
interface ModalProps {
  modo: 'nuevo' | 'editar';
  usuario: ComandaUsuario | null;
  permisosActuales: Set<string>;
  catalogo: PermisoCatalogo[];
  locales: LocalRef[];
  onClose: () => void;
  onSaved: () => void;
}

function UsuarioPosModal({ modo, usuario, permisosActuales, catalogo, locales, onClose, onSaved }: ModalProps) {
  const [nombre, setNombre] = useState(usuario?.nombre ?? '');
  const [email, setEmail] = useState(usuario?.email ?? '');
  const [password, setPassword] = useState('');
  const [rolPos, setRolPos] = useState<RolPos>(usuario?.rol_pos ?? 'cajero');
  const [localesSel, setLocalesSel] = useState<number[] | null>(usuario?.locales ?? null);
  const [pinPos, setPinPos] = useState(usuario?.pin_pos ?? '');
  const [activo, setActivo] = useState(usuario?.activo ?? true);
  const [permisosSel, setPermisosSel] = useState<Set<string>>(new Set(permisosActuales));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const categorias = useMemo(() => {
    const map = new Map<string, PermisoCatalogo[]>();
    catalogo.forEach(p => {
      if (!map.has(p.categoria)) map.set(p.categoria, []);
      map.get(p.categoria)!.push(p);
    });
    return Array.from(map.entries());
  }, [catalogo]);

  function toggle(slug: string) {
    const next = new Set(permisosSel);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    setPermisosSel(next);
  }

  async function guardar() {
    setSaving(true); setErr(null);
    try {
      if (modo === 'nuevo') {
        const { data: sess } = await db.auth.getSession();
        const token = sess?.session?.access_token;
        const resp = await fetch('/api/auth-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            action: 'create_comanda',
            nombre, email, password,
            rol_pos: rolPos,
            locales: localesSel,
            pin_pos: pinPos || null,
            permisos: Array.from(permisosSel),
          }),
        });
        const json = await resp.json();
        if (!resp.ok || !json.ok) throw new Error(json.error || 'create_failed');
      } else if (usuario) {
        const { error: uErr } = await db.from('comanda_usuarios').update({
          nombre, rol_pos: rolPos, locales: localesSel,
          pin_pos: pinPos || null, activo,
        }).eq('id', usuario.id);
        if (uErr) throw new Error(uErr.message);

        await db.from('comanda_usuario_permisos').delete().eq('comanda_usuario_id', usuario.id);
        if (rolPos !== 'admin' && permisosSel.size > 0) {
          const rows = Array.from(permisosSel).map(slug => ({
            comanda_usuario_id: usuario.id,
            tenant_id: usuario.tenant_id,
            modulo_slug: slug,
          }));
          const { error: pErr } = await db.from('comanda_usuario_permisos').insert(rows);
          if (pErr) throw new Error(pErr.message);
        }
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const adminBypass = rolPos === 'admin';

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {modo === 'nuevo' ? 'Crear usuario POS' : `Editar — ${usuario?.nombre}`}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {err && (
            <div className="p-3 rounded bg-destructive/10 text-destructive text-sm">{err}</div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Nombre</Label>
              <Input value={nombre} onChange={(e) => setNombre(e.target.value)} />
            </div>
            <div>
              <Label>Email {modo === 'editar' && '(read-only)'}</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)}
                disabled={modo === 'editar'} placeholder="caro@neko.local" />
            </div>
          </div>

          {modo === 'nuevo' && (
            <div>
              <Label>Password inicial (solo si el email no existe ya en PASE)</Label>
              <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Si ya tiene cuenta PASE, dejá vacío" />
              <p className="text-xs text-muted-foreground mt-1">
                El user va a usar este password tanto en COMANDA como en PASE (auth compartido).
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Rol POS</Label>
              <Select value={rolPos} onValueChange={(v) => setRolPos(v as RolPos)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mozo">Mozo (solo agregar items)</SelectItem>
                  <SelectItem value="cajero">Cajero (cobrar + conteo)</SelectItem>
                  <SelectItem value="manager">Manager (anular + descuentos + mesas)</SelectItem>
                  <SelectItem value="admin">Admin POS (acceso total)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>PIN POS (4-6 dígitos, opcional)</Label>
              <Input value={pinPos} onChange={(e) => setPinPos(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="1234" inputMode="numeric" />
            </div>
          </div>

          <div>
            <Label>Locales asignados</Label>
            <div className="flex flex-wrap gap-3 mt-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={localesSel === null}
                  onChange={(e) => setLocalesSel(e.target.checked ? null : [])} />
                Todos los locales
              </label>
              {localesSel !== null && locales.map(l => (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={localesSel.includes(l.id)}
                    onChange={(e) => {
                      const next = new Set(localesSel);
                      if (e.target.checked) next.add(l.id); else next.delete(l.id);
                      setLocalesSel(Array.from(next));
                    }} />
                  {l.nombre}
                </label>
              ))}
            </div>
          </div>

          {modo === 'editar' && (
            <div className="flex items-center gap-3">
              <Switch checked={activo} onCheckedChange={setActivo} />
              <Label>Usuario activo</Label>
            </div>
          )}

          <div>
            <Label>Permisos POS</Label>
            {adminBypass ? (
              <div className="mt-2 p-3 rounded bg-muted text-sm">
                💡 El rol "Admin POS" tiene <strong>acceso total</strong>. No se asignan permisos individuales.
              </div>
            ) : (
              <div className="mt-2 space-y-4">
                {categorias.map(([cat, perms]) => (
                  <div key={cat}>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">{cat}</div>
                    <div className="space-y-2">
                      {perms.map(p => (
                        <label key={p.slug} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="checkbox" checked={permisosSel.has(p.slug)} onChange={() => toggle(p.slug)} />
                          <span className="flex-1">{p.descripcion}</span>
                          <code className="text-xs text-muted-foreground">{p.slug}</code>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={guardar} disabled={saving || !nombre.trim() || !email.trim()}>
            {saving ? 'Guardando...' : modo === 'nuevo' ? 'Crear' : 'Guardar cambios'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
