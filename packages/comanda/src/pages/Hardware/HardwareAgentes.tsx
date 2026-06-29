// Pantalla /hardware/agentes — gestión de los Print Agents instalados.
//
// Diferencia vs /hardware/impresoras:
//   - /impresoras: configura LAS impresoras físicas que ESTA PC ve.
//                  Cada PC tiene su pantalla, propia config local.
//   - /agentes:    el dueño / admin desde CUALQUIER lugar ve TODAS las PCs
//                  del/los local/es con su status. Reporta heartbeat al
//                  backend cada 60s.
//
// Acciones disponibles:
//   - Vincular nueva PC: genera un agent_token + lo copia al portapapeles.
//     El comerciante lo pega en el instalador del agent.
//   - Revocar agent: soft delete. La PC dejará de aparecer cuando intente
//     próximo heartbeat (token inválido).
//   - Ver detalle: hostname, OS, versión, impresoras conectadas y cola.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Monitor, Plus, RefreshCw, Copy, Trash2, CheckCircle2,
  AlertCircle, Clock, Printer as PrinterIcon, ListChecks, Download,
} from 'lucide-react';

const PRINT_AGENT_DOWNLOAD_URL = 'https://github.com/lucastomasferrari-cell/PASE/releases/download/print-agent-v1.0.0/COMANDA.Print.Agent.Setup.1.0.0.exe';
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
  listAgents, crearAgentToken, revocarAgent, type PrintAgent,
} from '@/services/printAgentsService';

function statusLabel(s: PrintAgent['status']): { label: string; color: string; icon: typeof CheckCircle2 } {
  switch (s) {
    case 'online': return { label: 'En línea', color: 'text-green-700 bg-green-100', icon: CheckCircle2 };
    case 'stale':  return { label: 'Lento (3-15min)', color: 'text-amber-700 bg-amber-100', icon: Clock };
    case 'offline':return { label: 'Desconectado', color: 'text-red-700 bg-red-100', icon: AlertCircle };
    case 'never':  return { label: 'Sin reportar', color: 'text-gray-700 bg-gray-100', icon: AlertCircle };
  }
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

export function HardwareAgentes() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const [agents, setAgents] = useState<PrintAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nuevoOpen, setNuevoOpen] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState('PC Cocina');
  const [tokenGenerado, setTokenGenerado] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setRefreshing(true);
    // Si el usuario tiene local activo, filtra por ese; si es dueño/admin
    // sin local activo, ve todos los del tenant.
    const { data, error } = await listAgents(localActivo ?? undefined);
    if (error) {
      toast.error(error);
    } else {
      setAgents(data);
    }
    setRefreshing(false);
    setLoading(false);
  }, [localActivo]);

  useEffect(() => {
    void reload();
    // Auto-refresh cada 15s para que el dueño vea status en vivo
    const t = setInterval(() => { void reload(); }, 15000);
    return () => clearInterval(t);
  }, [reload]);

  const handleGenerarToken = async () => {
    if (!localActivo) {
      toast.error('Seleccioná un local primero');
      return;
    }
    const nombre = nuevoNombre.trim() || 'PC sin nombre';
    const { data, error } = await crearAgentToken(localActivo, nombre);
    if (error) {
      toast.error(error);
      return;
    }
    if (data) {
      setTokenGenerado(data.agent_token);
      void navigator.clipboard.writeText(data.agent_token).catch(() => {});
      toast.success('Token generado y copiado al portapapeles');
      void reload();
    }
  };

  const handleCopiarToken = (token: string) => {
    void navigator.clipboard.writeText(token).then(() => {
      toast.success('Token copiado');
    });
  };

  const handleRevocar = async (agent: PrintAgent) => {
    if (!confirm(`¿Revocar el agent "${agent.nombre}" (${agent.hostname || 'sin hostname'})?\n\nLa PC dejará de reportar y deberás vincular una nueva.`)) {
      return;
    }
    const { error } = await revocarAgent(agent.id);
    if (error) toast.error(error);
    else {
      toast.success('Agent revocado');
      void reload();
    }
  };

  if (loading) {
    return <div className="p-12 text-center text-foreground/60">Cargando agentes…</div>;
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium flex items-center gap-2">
            <Monitor className="h-6 w-6" />
            Print Agents (PCs)
          </h1>
          <p className="text-sm text-foreground/60 mt-1">
            Cada PC del local que tiene el COMANDA Print Agent instalado.
            Se conecta a las impresoras térmicas y reporta status cada minuto.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => reload()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refrescar
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={PRINT_AGENT_DOWNLOAD_URL} download>
              <Download className="h-4 w-4 mr-1.5" />
              Descargar Print Agent
            </a>
          </Button>
          <Button size="sm" onClick={() => { setNuevoNombre('PC Cocina'); setTokenGenerado(null); setNuevoOpen(true); }}>
            <Plus className="h-4 w-4 mr-1.5" />
            Vincular nueva PC
          </Button>
        </div>
      </div>

      {agents.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Monitor className="h-12 w-12 mx-auto text-foreground/30 mb-3" />
            <p className="text-base font-medium">Ningún agent vinculado todavía</p>
            <p className="text-sm text-foreground/60 mt-2 max-w-md mx-auto">
              Para empezar: instalá el COMANDA Print Agent en la PC del local,
              después clickeá <strong>"Vincular nueva PC"</strong> para generar el
              token que necesita el instalador.
            </p>
            <Button className="mt-6" onClick={() => setNuevoOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" />
              Vincular nueva PC
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agents.map((a) => {
            const st = statusLabel(a.status);
            const Icon = st.icon;
            return (
              <Card key={a.id} className="overflow-hidden">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-base">{a.nombre}</CardTitle>
                      <p className="text-xs text-foreground/60 mt-0.5">
                        {a.hostname ?? '(sin hostname)'} · {a.os_platform ?? '?'} · v{a.agent_version ?? '?'}
                      </p>
                    </div>
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md font-medium ${st.color}`}>
                      <Icon className="h-3.5 w-3.5" />
                      {st.label}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pb-4">
                  <div className="text-xs text-foreground/70">
                    Último reporte: <span className="font-medium">{fmtRelative(a.last_seen_at)}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-gray-50 rounded-md">
                      <PrinterIcon className="h-3.5 w-3.5 text-foreground/60" />
                      <span className="text-foreground/70">Impresoras:</span>
                      <span className="font-medium">{a.printers_online}/{a.printers_total}</span>
                    </div>
                    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-gray-50 rounded-md">
                      <ListChecks className="h-3.5 w-3.5 text-foreground/60" />
                      <span className="text-foreground/70">Cola:</span>
                      <span className="font-medium">{a.queue_queued + a.queue_printing}</span>
                    </div>
                  </div>

                  {a.queue_dead_letter > 0 && (
                    <div className="text-xs px-2 py-1.5 bg-red-50 text-red-700 rounded-md">
                      ⚠ {a.queue_dead_letter} job(s) fallidos definitivamente — revisar manualmente.
                    </div>
                  )}
                  {a.queue_failed > 0 && (
                    <div className="text-xs px-2 py-1.5 bg-amber-50 text-amber-700 rounded-md">
                      {a.queue_failed} job(s) en retry.
                    </div>
                  )}

                  {a.metadata?.printers && a.metadata.printers.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-foreground/70 hover:text-foreground select-none">
                        Ver impresoras ({a.metadata.printers.length})
                      </summary>
                      <div className="mt-2 space-y-1">
                        {a.metadata.printers.map((p) => (
                          <div key={p.id} className="flex items-center justify-between px-2 py-1 bg-gray-50 rounded">
                            <span>
                              <span className="font-medium">{p.nombre}</span>
                              <span className="text-foreground/50 ml-1.5">({p.transporte})</span>
                              {p.estacion && <span className="text-foreground/50 ml-1">· {p.estacion}</span>}
                            </span>
                            <span className={p.online ? 'text-green-700' : 'text-red-700'}>
                              {p.online ? '● online' : '○ offline'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  <div className="pt-2 border-t border-gray-100 flex justify-end">
                    <Button variant="ghost" size="sm" className="text-red-700 hover:text-red-800 hover:bg-red-50 h-8"
                            onClick={() => handleRevocar(a)}>
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Revocar
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Dialog vincular nueva PC */}
      <Dialog open={nuevoOpen} onOpenChange={setNuevoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vincular nueva PC</DialogTitle>
            <DialogDescription>
              Generá un token único, después lo pegás en el instalador del agent.
              Cada PC que imprime necesita su propio token.
            </DialogDescription>
          </DialogHeader>

          {!tokenGenerado ? (
            <div className="space-y-4">
              <div>
                <Label htmlFor="nombre">Nombre identificable de esta PC</Label>
                <Input
                  id="nombre"
                  value={nuevoNombre}
                  onChange={(e) => setNuevoNombre(e.target.value)}
                  placeholder="Ej: PC Cocina, PC Caja, PC Mesa Tablet"
                  className="mt-1"
                />
                <p className="text-xs text-foreground/60 mt-1">
                  Solo visual — te ayuda a identificar cuál PC es esta cuando ves varias.
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setNuevoOpen(false)}>Cancelar</Button>
                <Button onClick={handleGenerarToken} disabled={!localActivo}>
                  Generar token
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-md">
                <p className="text-sm font-medium text-amber-900">⚠️ Guardalo ahora</p>
                <p className="text-xs text-amber-800 mt-1">
                  Este token NO se vuelve a mostrar. Si lo perdés, tenés que revocarlo y generar uno nuevo.
                </p>
              </div>

              <div>
                <Label>Agent token</Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    value={tokenGenerado}
                    readOnly
                    className="font-mono text-xs"
                  />
                  <Button variant="outline" onClick={() => handleCopiarToken(tokenGenerado)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="text-xs text-foreground/70 space-y-2 p-3 bg-gray-50 rounded-md">
                <p className="font-medium text-foreground">Próximos pasos:</p>
                <ol className="list-decimal ml-4 space-y-1">
                  <li><a href={PRINT_AGENT_DOWNLOAD_URL} download className="text-brand-600 underline">Descargá el COMANDA Print Agent</a> e instalalo en la PC del local.</li>
                  <li>Al primer arranque te va a pedir este token — pegalo.</li>
                  <li>Si la impresora es USB térmica: click en "Instalar driver USB" en el agent.</li>
                  <li>Después de unos segundos esta PC aparece acá como "En línea".</li>
                </ol>
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
