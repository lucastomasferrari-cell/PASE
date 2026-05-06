import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChefHat, RefreshCw, Eye, Copy } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { QrCanvas } from '@/components/QrCanvas';
import {
  ESTACIONES, listTokensLocal, generarOReemplazarToken,
  type EstacionKds, type KdsToken,
} from '@/services/kdsTokensService';

function masked(token: string): string {
  if (token.length < 8) return token;
  return token.slice(0, 4) + '…' + token.slice(-4);
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'nunca';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'hace segundos';
  if (ms < 3_600_000) return `hace ${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `hace ${Math.floor(ms / 3_600_000)}h`;
  return `hace ${Math.floor(ms / 86_400_000)}d`;
}

export function SettingsKds() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [tokens, setTokens] = useState<KdsToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [showQr, setShowQr] = useState<{ token: string; estacion: EstacionKds } | null>(null);

  const reload = useCallback(async () => {
    if (!localId || !user?.tenant_id) { setLoading(false); return; }
    setLoading(true);
    const { data } = await listTokensLocal(localId, user.tenant_id);
    setTokens(data);
    setLoading(false);
  }, [localId, user?.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  async function handleGenerar(estacion: EstacionKds, esRegenerar: boolean) {
    if (!localId || !user?.tenant_id) return;
    if (esRegenerar && !confirm(`El KDS actual de ${estacion} va a dejar de funcionar. ¿Seguro?`)) return;
    const { token, error } = await generarOReemplazarToken({ localId, tenantId: user.tenant_id, estacion });
    if (error) { toast.error(error); return; }
    if (token) { toast.success('Token generado'); reload(); }
  }

  function buildKdsUrl(token: string, estacion: EstacionKds): string {
    const origin = window.location.origin;
    return `${origin}/kds/${estacion}?token=${token}`;
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => toast.success('Copiado'));
  }

  if (!localId) return <div className="p-8 text-sm text-muted-foreground">Seleccioná un local activo.</div>;

  return (
    <Card>
      <CardContent className="p-6 space-y-3">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2"><ChefHat className="h-4 w-4" /> Tokens KDS</h2>
            <p className="text-xs text-muted-foreground">Cada estación tiene su propio QR. Las tablets escanean y quedan loggeadas.</p>
          </div>
        </header>
        {loading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {ESTACIONES.map(est => {
              const tok = tokens.find(t => t.estacion === est.id);
              return (
                <div key={est.id} className="rounded-md border border-border p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{est.emoji} {est.label}</div>
                    {tok ? (
                      <>
                        <div className="text-[11px] font-mono text-muted-foreground">{masked(tok.token)}</div>
                        <div className="text-[10px] text-muted-foreground">Último uso: {timeAgo(tok.last_used_at)}</div>
                      </>
                    ) : (
                      <div className="text-[11px] text-muted-foreground">Sin token generado</div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 flex-shrink-0">
                    {tok ? (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setShowQr({ token: tok.token, estacion: est.id })}>
                          <Eye className="h-3 w-3 mr-1" /> Ver QR
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleGenerar(est.id, true)}>
                          <RefreshCw className="h-3 w-3 mr-1" /> Regenerar
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" onClick={() => handleGenerar(est.id, false)}>Generar QR</Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={!!showQr} onOpenChange={open => !open && setShowQr(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>QR · {showQr ? ESTACIONES.find(e => e.id === showQr.estacion)?.label : ''}</DialogTitle>
          </DialogHeader>
          {showQr && (
            <div className="space-y-3">
              <div className="flex justify-center bg-white p-3 rounded-md">
                <QrCanvas value={buildKdsUrl(showQr.token, showQr.estacion)} size={280} />
              </div>
              <div className="text-[11px] font-mono break-all text-muted-foreground border border-border p-2 rounded-md">
                {buildKdsUrl(showQr.token, showQr.estacion)}
              </div>
              <Button variant="outline" className="w-full" onClick={() => copy(buildKdsUrl(showQr.token, showQr.estacion))}>
                <Copy className="h-3 w-3 mr-1" /> Copiar URL
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
