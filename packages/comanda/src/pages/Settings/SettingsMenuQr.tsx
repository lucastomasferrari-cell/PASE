import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Smartphone, Eye, Copy, RefreshCw, Printer } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { QrCanvas } from '@/components/QrCanvas';
import {
  listMesasConToken, generarTokenMesa, setModoToken, type MesaConToken,
} from '@/services/menuQrTokensService';
import type { MenuQrModo } from '@/services/menuQrService';

const MODOS: { value: MenuQrModo; label: string; descr: string }[] = [
  { value: 'readonly', label: 'Solo lectura', descr: 'El cliente ve la carta pero no pide.' },
  { value: 'asistido', label: 'Asistido',     descr: 'Cliente arma pedido, mozo aprueba.' },
  { value: 'autonomo', label: 'Autónomo',     descr: 'Cliente envía directo a cocina.' },
];

export function SettingsMenuQr() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [mesas, setMesas] = useState<MesaConToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [showQr, setShowQr] = useState<{ token: string; numero: string } | null>(null);

  const reload = useCallback(async () => {
    if (!localId) { setLoading(false); return; }
    setLoading(true);
    const { data } = await listMesasConToken(localId);
    setMesas(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  async function handleGenerar(mesaId: number, modo: MenuQrModo) {
    if (!localId || !user?.tenant_id) return;
    const { error } = await generarTokenMesa({ mesaId, localId, tenantId: user.tenant_id, modo });
    if (error) { toast.error(error); return; }
    toast.success('QR generado');
    reload();
  }

  async function handleCambiarModo(tokenId: number, modo: MenuQrModo) {
    const { error } = await setModoToken(tokenId, modo);
    if (error) { toast.error(error); return; }
    toast.success('Modo actualizado');
    reload();
  }

  function buildUrl(token: string): string {
    return `${window.location.origin}/menu/${token}`;
  }
  function copy(t: string) { navigator.clipboard.writeText(t).then(() => toast.success('Copiado')); }
  function imprimirQr() {
    // window.print con CSS print-only en el dialog (clase .print-area).
    window.print();
  }

  if (!localId) return <div className="p-8 text-sm text-muted-foreground">Seleccioná un local activo.</div>;

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <header>
          <h2 className="text-base font-semibold flex items-center gap-2"><Smartphone className="h-4 w-4" /> Menú QR por mesa</h2>
          <p className="text-xs text-muted-foreground">Cada mesa tiene su propio QR. Modo según escenario.</p>
        </header>
        {loading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : mesas.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin mesas. Agregá mesas en la pestaña Mesas.</p>
        ) : (
          <div className="space-y-2">
            {mesas.map(m => (
              <div key={m.mesa_id} className="rounded-md border border-border p-3 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[120px]">
                  <div className="text-sm font-medium">Mesa {m.numero}{m.zona ? ` · ${m.zona}` : ''}</div>
                  {m.token ? (
                    <div className="text-[11px] font-mono text-muted-foreground">{m.token.token.slice(0, 4)}…{m.token.token.slice(-4)}</div>
                  ) : (
                    <div className="text-[11px] text-muted-foreground">Sin token generado</div>
                  )}
                </div>
                <Select
                  value={m.token?.modo ?? 'asistido'}
                  onValueChange={(v) => {
                    if (m.token) handleCambiarModo(m.token.id, v as MenuQrModo);
                    else handleGenerar(m.mesa_id, v as MenuQrModo);
                  }}
                >
                  <SelectTrigger className="w-[150px] h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MODOS.map(mo => <SelectItem key={mo.value} value={mo.value}>{mo.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {m.token ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setShowQr({ token: m.token!.token, numero: m.numero })}>
                      <Eye className="h-3 w-3 mr-1" /> Ver
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleGenerar(m.mesa_id, m.token!.modo)}>
                      <RefreshCw className="h-3 w-3 mr-1" /> Regenerar
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={() => handleGenerar(m.mesa_id, 'asistido')}>Generar</Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={!!showQr} onOpenChange={open => !open && setShowQr(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Mesa {showQr?.numero}</DialogTitle>
          </DialogHeader>
          {showQr && (
            <div className="space-y-3">
              <div className="flex justify-center bg-white p-3 rounded-md print-area">
                <div>
                  <QrCanvas value={buildUrl(showQr.token)} size={300} />
                  <p className="text-center text-xs mt-2 text-black font-medium">Mesa {showQr.numero}</p>
                </div>
              </div>
              <div className="text-[11px] font-mono break-all text-muted-foreground border border-border p-2 rounded-md">
                {buildUrl(showQr.token)}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => copy(buildUrl(showQr.token))}>
                  <Copy className="h-3 w-3 mr-1" /> Copiar
                </Button>
                <Button variant="outline" className="flex-1" onClick={imprimirQr}>
                  <Printer className="h-3 w-3 mr-1" /> Imprimir
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
