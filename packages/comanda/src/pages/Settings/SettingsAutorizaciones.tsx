import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { getLocalSettings, updateLocalSettings } from '@/services/localSettingsService';
import type { ComandaLocalSettings } from '@/types/database';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

// Configuración → Autorizaciones. Prende/apaga los pedidos de PIN de manager.
// Arrancan APAGADOS (default en DB). Los RPCs (fn_movimiento_caja_comanda,
// fn_aplicar_descuento_comanda) leen los mismos flags; el cambio de precio se
// gatea en el POS (VentaScreen). Ver migración 202607221800.
interface FormState {
  mov: boolean;
  movUmbral: string;
  desc: boolean;
  descPct: string;
  precio: boolean;
}

function toForm(s: ComandaLocalSettings): FormState {
  return {
    mov: s.req_auth_movimiento ?? false,
    movUmbral: String(s.req_auth_movimiento_umbral ?? 5000),
    desc: s.req_auth_descuento ?? false,
    descPct: String(s.req_auth_descuento_pct ?? 15),
    precio: s.req_auth_cambio_precio ?? false,
  };
}

export function SettingsAutorizaciones() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [settings, setSettings] = useState<ComandaLocalSettings | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data } = await getLocalSettings(localId);
    setSettings(data);
    setForm(data ? toForm(data) : null);
    setLoading(false);
  }, [localId]);

  useEffect(() => { void reload(); }, [reload]);

  async function guardar() {
    if (!settings || !form) return;
    setSaving(true);
    const { error } = await updateLocalSettings(settings.id, {
      req_auth_movimiento: form.mov,
      req_auth_movimiento_umbral: Number(form.movUmbral) || 5000,
      req_auth_descuento: form.desc,
      req_auth_descuento_pct: Number(form.descPct) || 15,
      req_auth_cambio_precio: form.precio,
    });
    setSaving(false);
    if (error) toast.error('Error al guardar: ' + error);
    else toast.success('Autorizaciones guardadas');
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (localId === null || !form) {
    return (
      <div className="container py-6 text-sm text-muted-foreground">
        Elegí un local para configurar sus autorizaciones.
      </div>
    );
  }

  return (
    <div className="container py-6 max-w-2xl">
      <header className="mb-5 flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Autorizaciones</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Cuándo el POS pide PIN de manager. Por default está todo apagado.
          </p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Movimientos de caja / gastos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="mov">Pedir autorización en movimientos grandes</Label>
            <Switch id="mov" checked={form.mov} onCheckedChange={(v) => setForm({ ...form, mov: v })} />
          </div>
          {form.mov && (
            <div className="flex items-center gap-2">
              <Label htmlFor="movUmbral" className="text-sm text-muted-foreground">A partir de $</Label>
              <Input id="movUmbral" type="number" inputMode="numeric" className="w-40"
                value={form.movUmbral} onChange={(e) => setForm({ ...form, movUmbral: e.target.value })} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Descuentos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="desc">Pedir autorización en descuentos grandes</Label>
            <Switch id="desc" checked={form.desc} onCheckedChange={(v) => setForm({ ...form, desc: v })} />
          </div>
          {form.desc && (
            <div className="flex items-center gap-2">
              <Label htmlFor="descPct" className="text-sm text-muted-foreground">Cuando supera el</Label>
              <Input id="descPct" type="number" inputMode="numeric" className="w-24"
                value={form.descPct} onChange={(e) => setForm({ ...form, descPct: e.target.value })} />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Cambio de precio en la venta</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="precio">Pedir autorización para cambiar el precio de un ítem</Label>
            <Switch id="precio" checked={form.precio} onCheckedChange={(v) => setForm({ ...form, precio: v })} />
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 flex justify-end">
        <Button onClick={guardar} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </div>
  );
}
