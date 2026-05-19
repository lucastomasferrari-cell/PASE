// HardwareRiders — gestión de repartidores del local.
//
// Patrón similar a HardwareAgentes (PCs con print-server):
//   - Lista con status (online/offline/etc)
//   - "Vincular nueva moto" → crea rider + token → copia link al portapapeles
//   - "Revocar" → soft delete

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Bike, Plus, RefreshCw, Copy, Trash2, CheckCircle2,
  AlertCircle, Clock, MessageCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import {
  listRidersStatus, crearRider, revocarRider, type Rider,
} from '@/services/ridersService';

function statusBadge(s: Rider['status']) {
  switch (s) {
    case 'en_linea': return { label: 'En línea', color: 'text-green-700 bg-green-100', Icon: CheckCircle2 };
    case 'reciente': return { label: 'Reciente', color: 'text-amber-700 bg-amber-100', Icon: Clock };
    case 'offline':  return { label: 'Offline', color: 'text-gray-700 bg-gray-100', Icon: AlertCircle };
    case 'desconectado': return { label: 'Desconectado', color: 'text-red-700 bg-red-100', Icon: AlertCircle };
    case 'sin_reportar': return { label: 'Sin reportar', color: 'text-gray-700 bg-gray-100', Icon: AlertCircle };
    case 'inactivo':
    default: return { label: 'Inactivo', color: 'text-gray-700 bg-gray-100', Icon: AlertCircle };
  }
}

function fmtRel(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}min`;
  const h = Math.floor(m / 60);
  return `hace ${h}h`;
}

export function HardwareRiders() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nuevoOpen, setNuevoOpen] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoTel, setNuevoTel] = useState('');
  const [linkGenerado, setLinkGenerado] = useState<{ url: string; token: string; nombre: string; tel: string } | null>(null);

  const reload = useCallback(async () => {
    setRefreshing(true);
    const { data, error } = await listRidersStatus(localActivo ?? undefined);
    if (error) toast.error(error);
    else setRiders(data);
    setRefreshing(false);
    setLoading(false);
  }, [localActivo]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => { void reload(); }, 15000);
    return () => clearInterval(t);
  }, [reload]);

  async function handleCrear() {
    if (!localActivo) { toast.error('Sin local activo'); return; }
    if (!nuevoNombre.trim()) { toast.error('El nombre es requerido'); return; }
    const { data, error } = await crearRider({
      localId: localActivo,
      nombre: nuevoNombre.trim(),
      telefono: nuevoTel.trim() || undefined,
    });
    if (error || !data) {
      toast.error(error || 'Error desconocido');
      return;
    }
    // URL para el rider — usamos location.origin para que funcione en cualquier deploy
    const url = `${window.location.origin}/r/${data.rider_token}`;
    setLinkGenerado({ url, token: data.rider_token, nombre: nuevoNombre.trim(), tel: nuevoTel.trim() });
    void navigator.clipboard.writeText(url).catch(() => {});
    toast.success('Repartidor creado, link copiado al portapapeles');
    void reload();
  }

  function handleCopiar(url: string) {
    void navigator.clipboard.writeText(url).then(() => toast.success('Link copiado'));
  }

  function handleWhatsApp(tel: string, url: string, nombre: string) {
    const clean = tel.replace(/\D/g, '');
    const withCountry = clean.startsWith('54') ? clean : `54${clean}`;
    const msg = `Hola ${nombre}! 🛵\nEste es tu link de COMANDA para empezar a recibir pedidos. Abrilo en tu celular, dale permisos de ubicación y tocá "Empezar turno":\n\n${url}`;
    window.open(`https://wa.me/${withCountry}?text=${encodeURIComponent(msg)}`, '_blank');
  }

  async function handleRevocar(r: Rider) {
    if (!confirm(`¿Revocar a "${r.nombre}"?\n\nSu link va a dejar de funcionar. Podés crear uno nuevo después.`)) return;
    const { error } = await revocarRider(r.id);
    if (error) toast.error(error);
    else {
      toast.success('Repartidor revocado');
      void reload();
    }
  }

  if (loading) return <div className="p-12 text-center text-foreground/60">Cargando repartidores…</div>;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium flex items-center gap-2">
            <Bike className="h-6 w-6" />
            Repartidores
          </h1>
          <p className="text-sm text-foreground/60 mt-1">
            Cada moto tiene un link único que abre en su celular. Cuando toca
            "Empezar turno", postea su ubicación cada 30s al despacho.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => reload()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refrescar
          </Button>
          <Button size="sm" onClick={() => { setNuevoNombre(''); setNuevoTel(''); setLinkGenerado(null); setNuevoOpen(true); }}>
            <Plus className="h-4 w-4 mr-1.5" />
            Agregar moto
          </Button>
        </div>
      </div>

      {riders.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Bike className="h-12 w-12 mx-auto text-foreground/30 mb-3" />
            <p className="text-base font-medium">Ningún repartidor cargado</p>
            <p className="text-sm text-foreground/60 mt-2 max-w-md mx-auto">
              Vinculá tu primera moto: ponele un nombre, copiás el link y se lo
              mandás por WhatsApp al rider. Él abre el link en su celu y listo.
            </p>
            <Button className="mt-6" onClick={() => setNuevoOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" />
              Agregar primera moto
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {riders.map((r) => {
            const st = statusBadge(r.status);
            const Icon = st.Icon;
            return (
              <Card key={r.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full text-white text-base font-semibold flex items-center justify-center ${
                        r.status === 'en_linea' ? 'bg-sky-500' : 'bg-gray-400'
                      }`}>
                        {r.nombre.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <CardTitle className="text-base">{r.nombre}</CardTitle>
                        {r.telefono && <p className="text-xs text-foreground/60">{r.telefono}</p>}
                      </div>
                    </div>
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md font-medium ${st.color}`}>
                      <Icon className="h-3.5 w-3.5" />
                      {st.label}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 pb-4">
                  <div className="text-xs text-foreground/70 flex items-center gap-3">
                    <span>Último GPS: <strong>{fmtRel(r.last_seen_at)}</strong></span>
                    {r.last_battery_pct != null && <span>🔋 {r.last_battery_pct}%</span>}
                  </div>
                  {r.current_venta_id && r.pedido_numero && (
                    <div className="text-xs px-2 py-1.5 bg-sky-50 text-sky-800 rounded-md">
                      Entregando #{r.pedido_numero} — {r.pedido_cliente}
                    </div>
                  )}
                  <div className="pt-2 border-t border-gray-100 flex justify-between items-center">
                    {r.telefono ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => handleWhatsApp(
                          r.telefono!,
                          `${window.location.origin}/r/${'<token>'}`,  // token no expuesto, mostrar reload link
                          r.nombre,
                        )}
                        disabled
                        title="El link solo se muestra al crear. Pedí crear uno nuevo si lo perdió."
                      >
                        <MessageCircle className="h-3 w-3 mr-1" />
                        Link
                      </Button>
                    ) : <span />}
                    <Button variant="ghost" size="sm" className="text-red-700 hover:bg-red-50 h-7 text-xs"
                            onClick={() => handleRevocar(r)}>
                      <Trash2 className="h-3 w-3 mr-1" />
                      Revocar
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Dialog crear */}
      <Dialog open={nuevoOpen} onOpenChange={setNuevoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vincular nueva moto</DialogTitle>
            <DialogDescription>
              Cargá el nombre y teléfono del repartidor. Te damos un link único
              que mandás por WhatsApp.
            </DialogDescription>
          </DialogHeader>

          {!linkGenerado ? (
            <div className="space-y-3">
              <div>
                <Label htmlFor="nombre">Nombre del repartidor</Label>
                <Input id="nombre" value={nuevoNombre} onChange={(e) => setNuevoNombre(e.target.value)}
                       placeholder="Ej: Juan, Pedro, etc."
                       className="mt-1" autoFocus />
              </div>
              <div>
                <Label htmlFor="tel">Teléfono (opcional, para mandar el link)</Label>
                <Input id="tel" value={nuevoTel} onChange={(e) => setNuevoTel(e.target.value)}
                       placeholder="Ej: 1156781234"
                       className="mt-1" />
                <p className="text-xs text-foreground/60 mt-1">
                  Si lo cargás, te ofrecemos un botón "Mandar por WhatsApp".
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setNuevoOpen(false)}>Cancelar</Button>
                <Button onClick={handleCrear} disabled={!nuevoNombre.trim() || !localActivo}>
                  Crear repartidor
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-md">
                <p className="text-sm font-medium text-amber-900">⚠️ Guardalo ahora</p>
                <p className="text-xs text-amber-800 mt-1">
                  Este link no se vuelve a mostrar. Si lo perdés, revocá el rider y creá uno nuevo.
                </p>
              </div>

              <div>
                <Label>Link para el repartidor</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={linkGenerado.url} readOnly className="font-mono text-xs" />
                  <Button variant="outline" onClick={() => handleCopiar(linkGenerado.url)} title="Copiar">
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {linkGenerado.tel && (
                <Button
                  className="w-full"
                  onClick={() => handleWhatsApp(linkGenerado.tel, linkGenerado.url, linkGenerado.nombre)}
                >
                  <MessageCircle className="h-4 w-4 mr-1.5" />
                  Mandar por WhatsApp a {linkGenerado.nombre}
                </Button>
              )}

              <div className="text-xs text-foreground/70 p-3 bg-gray-50 rounded-md">
                El repartidor abre el link en su celular, le da permisos de ubicación
                y toca "Empezar turno". Aparece en el despacho como "En línea" en
                menos de 1 minuto.
              </div>

              <DialogFooter>
                <Button onClick={() => setNuevoOpen(false)}>Listo</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
