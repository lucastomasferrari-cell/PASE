// SettingsAfip — pantalla para cargar credenciales AFIP y activar/desactivar
// la emisión de facturas electrónicas del tenant.
//
// Flujo típico del dueño:
//   1. Generar cert en auth.afip.gob.ar (CUIT + clave fiscal nivel 3+).
//   2. Adherir servicio WSAA + WSFEv1.
//   3. Bajar cert.crt + private.key.
//   4. Acá: pegar ambos PEM en sus textareas, llenar metadata, marcar
//      "Activa" → Guardar. Empezar SIEMPRE en ambiente "testing" hasta
//      verificar que la primer factura sale OK; después pasar a "produccion".
//
// SEGURIDAD:
//   - La clave privada NUNCA se muestra al user después de guardada
//     (column-level GRANT en afip_credenciales bloquea SELECT a authenticated).
//   - Solo dueño / admin puede ver y editar esta pantalla (RPCs validan).
//   - Persistir via fn_upsert_afip_credenciales (server-side, valida formato).

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, ShieldAlert, Trash2, Eye, EyeOff, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  getCredencialesAFIP, upsertCredencialesAFIP, eliminarCredencialesAFIP, parsearCertVencimiento,
} from '@/lib/afip/service';
import type { AfipAmbiente, AfipCredencialesPublic } from '@/lib/afip/types';

interface FormState {
  cuit: string;
  ambiente: AfipAmbiente;
  punto_venta: number;
  tipo_contribuyente: 'monotributo' | 'responsable_inscripto' | 'exento';
  cert_pem: string;
  key_pem: string;
  activa: boolean;
}

const EMPTY: FormState = {
  cuit: '',
  ambiente: 'testing',
  punto_venta: 1,
  tipo_contribuyente: 'monotributo',
  cert_pem: '',
  key_pem: '',
  activa: false,
};

export function SettingsAfip() {
  const [actuales, setActuales] = useState<AfipCredencialesPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [mostrarKey, setMostrarKey] = useState(false);
  const [eliminando, setEliminando] = useState(false);

  // Cargar credenciales existentes al montar
  useEffect(() => {
    getCredencialesAFIP().then((r) => {
      if (r.data) {
        setActuales(r.data);
        // No prellenamos cert + key (no llegan al browser). El user puede
        // re-subir o solo editar metadata. Si re-subes ambas vacías, falla
        // validación server-side.
        setForm({
          cuit: r.data.cuit,
          ambiente: r.data.ambiente,
          punto_venta: r.data.punto_venta,
          tipo_contribuyente: r.data.tipo_contribuyente,
          cert_pem: '',
          key_pem: '',
          activa: r.data.activa,
        });
      }
      setLoading(false);
    });
  }, []);

  function setField<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // Detectar vencimiento del cert al pegarlo
  const certVence = form.cert_pem ? parsearCertVencimiento(form.cert_pem) : null;
  const certPorVencer = certVence
    ? (new Date(certVence).getTime() - Date.now()) / (1000 * 60 * 60 * 24) < 90
    : false;

  async function handleSubmit() {
    if (savingRef.current) return;

    // Validaciones cliente
    if (!/^\d{11}$/.test(form.cuit)) {
      toast.error('CUIT inválido', { description: '11 dígitos numéricos sin guiones.' });
      return;
    }
    if (form.punto_venta <= 0) {
      toast.error('Punto de venta inválido');
      return;
    }
    if (!form.cert_pem.trim() || !form.key_pem.trim()) {
      toast.error('Cargá el certificado y la clave privada', {
        description: 'Ambos son obligatorios al guardar. Si ya están cargados, pegalos de nuevo (no los podemos leer por seguridad).',
      });
      return;
    }
    if (!form.cert_pem.includes('BEGIN CERTIFICATE')) {
      toast.error('Cert PEM inválido', { description: 'Empieza con "-----BEGIN CERTIFICATE-----".' });
      return;
    }
    if (!form.key_pem.match(/BEGIN (RSA )?PRIVATE KEY/)) {
      toast.error('Clave privada PEM inválida', { description: 'Empieza con "-----BEGIN PRIVATE KEY-----" o "-----BEGIN RSA PRIVATE KEY-----".' });
      return;
    }

    savingRef.current = true;
    setSaving(true);
    try {
      const r = await upsertCredencialesAFIP({
        cuit: form.cuit,
        ambiente: form.ambiente,
        punto_venta: form.punto_venta,
        tipo_contribuyente: form.tipo_contribuyente,
        cert_pem: form.cert_pem,
        key_pem: form.key_pem,
        activa: form.activa,
        cert_vence_at: certVence,
      });
      if (!r.ok) {
        toast.error(`Error guardando: ${r.error}`);
        return;
      }
      toast.success('Credenciales AFIP guardadas');
      // Recargar (sin cert + key)
      const fresh = await getCredencialesAFIP();
      if (fresh.data) setActuales(fresh.data);
      setForm((f) => ({ ...f, cert_pem: '', key_pem: '' }));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function handleEliminar() {
    if (!confirm('¿Eliminar las credenciales AFIP del tenant? Esto bloquea la emisión de facturas hasta que vuelvas a cargar cert + key.')) return;
    setEliminando(true);
    try {
      const r = await eliminarCredencialesAFIP();
      if (!r.ok) {
        toast.error(`Error eliminando: ${r.error}`);
        return;
      }
      toast.success('Credenciales eliminadas');
      setActuales(null);
      setForm(EMPTY);
    } finally {
      setEliminando(false);
    }
  }

  if (loading) {
    return <div className="py-12 text-center text-muted-foreground">Cargando…</div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Receipt className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-xl font-semibold">Factura electrónica AFIP</h1>
          <p className="text-sm text-muted-foreground">
            Configurá las credenciales para emitir facturas A, B o C con CAE oficial.
          </p>
        </div>
      </div>

      {/* Estado actual */}
      {actuales && (
        <Card className={actuales.activa ? 'border-success/50' : 'border-warning/50'}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                {actuales.activa ? (
                  <><ShieldCheck className="h-5 w-5 text-success" /> AFIP activo</>
                ) : (
                  <><ShieldAlert className="h-5 w-5 text-warning" /> AFIP configurado pero NO activo</>
                )}
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={handleEliminar} disabled={eliminando} className="text-destructive">
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                {eliminando ? 'Eliminando…' : 'Eliminar'}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <Row label="CUIT" value={actuales.cuit} />
            <Row label="Ambiente" value={actuales.ambiente === 'produccion' ? '🟢 Producción' : '🟡 Testing (Homologación)'} />
            <Row label="Punto de venta" value={String(actuales.punto_venta)} />
            <Row label="Tipo contribuyente" value={
              actuales.tipo_contribuyente === 'monotributo' ? 'Monotributista' :
              actuales.tipo_contribuyente === 'responsable_inscripto' ? 'Responsable inscripto' :
              'Exento'
            } />
            {actuales.cert_vence_at && (
              <Row
                label="Cert vence"
                value={new Date(actuales.cert_vence_at).toLocaleDateString('es-AR')}
                warn={(new Date(actuales.cert_vence_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24) < 90}
              />
            )}
            {actuales.ultimo_token_at && (
              <Row label="Último token WSAA" value={new Date(actuales.ultimo_token_at).toLocaleString('es-AR')} />
            )}
          </CardContent>
        </Card>
      )}

      {!actuales && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm space-y-2">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlert className="h-4 w-4" />
            Sin credenciales AFIP
          </div>
          <p className="text-foreground/80">
            Todavía no podés emitir factura electrónica. Generá el certificado en
            <a href="https://auth.afip.gob.ar/" target="_blank" rel="noopener noreferrer" className="underline mx-1">
              auth.afip.gob.ar
            </a>
            (necesitás CUIT + clave fiscal nivel 3 o superior), adherí los servicios
            <strong className="mx-1">WSAA</strong>+<strong className="mx-1">WSFEv1</strong>
            asociados al certificado, y subí abajo los PEM.
          </p>
        </div>
      )}

      {/* Formulario */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {actuales ? 'Actualizar credenciales' : 'Cargar credenciales nuevas'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="cuit">CUIT *</Label>
              <Input
                id="cuit"
                value={form.cuit}
                onChange={(e) => setField('cuit', e.target.value.replace(/\D/g, '').slice(0, 11))}
                placeholder="20123456789"
                className="h-10 font-mono"
                inputMode="numeric"
                maxLength={11}
              />
              <p className="text-[10px] text-muted-foreground">11 dígitos sin guiones.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="punto_venta">Punto de venta *</Label>
              <Input
                id="punto_venta"
                type="number"
                min={1}
                max={99999}
                value={form.punto_venta}
                onChange={(e) => setField('punto_venta', parseInt(e.target.value) || 1)}
                className="h-10 font-mono"
              />
              <p className="text-[10px] text-muted-foreground">Típicamente 1. Confirmar contra los PV habilitados en AFIP.</p>
            </div>
            <div className="space-y-2">
              <Label>Ambiente *</Label>
              <Select value={form.ambiente} onValueChange={(v) => setField('ambiente', v as AfipAmbiente)}>
                <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="testing">🟡 Testing (Homologación) — sin valor fiscal</SelectItem>
                  <SelectItem value="produccion">🟢 Producción — facturas reales</SelectItem>
                </SelectContent>
              </Select>
              {form.ambiente === 'produccion' && (
                <p className="text-[10px] text-warning">⚠ Empezá SIEMPRE en testing hasta verificar que la primera factura sale OK.</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Tipo de contribuyente *</Label>
              <Select value={form.tipo_contribuyente} onValueChange={(v) => setField('tipo_contribuyente', v as FormState['tipo_contribuyente'])}>
                <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="monotributo">Monotributista (factura C, sin IVA discriminado)</SelectItem>
                  <SelectItem value="responsable_inscripto">Responsable inscripto (factura A o B, IVA discriminado)</SelectItem>
                  <SelectItem value="exento">Exento</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cert_pem">Certificado X.509 (cert.crt) *</Label>
            <Textarea
              id="cert_pem"
              value={form.cert_pem}
              onChange={(e) => setField('cert_pem', e.target.value)}
              rows={6}
              placeholder={'-----BEGIN CERTIFICATE-----\nMIIE…\n-----END CERTIFICATE-----'}
              className="font-mono text-[10px] leading-tight"
            />
            {certVence && (
              <p className={`text-xs ${certPorVencer ? 'text-warning' : 'text-success'}`}>
                {certPorVencer ? '⚠ ' : '✓ '}
                Cert vence el {new Date(certVence).toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' })}
                {certPorVencer ? ' — renová pronto en AFIP.' : '.'}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="key_pem">Clave privada (private.key) *</Label>
              <Button variant="ghost" size="sm" onClick={() => setMostrarKey((v) => !v)} className="h-7 px-2">
                {mostrarKey ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
                {mostrarKey ? 'Ocultar' : 'Ver'}
              </Button>
            </div>
            <Textarea
              id="key_pem"
              value={form.key_pem}
              onChange={(e) => setField('key_pem', e.target.value)}
              rows={6}
              placeholder={'-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE KEY-----'}
              className={`font-mono text-[10px] leading-tight ${mostrarKey ? '' : 'blur-sm focus:blur-none'}`}
            />
            <p className="text-[10px] text-muted-foreground">
              La clave nunca llega de vuelta al browser — si querés actualizarla, pegala de nuevo.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <Label className="cursor-pointer">Activa</Label>
              <p className="text-xs text-muted-foreground">
                Si está apagado, las credenciales quedan guardadas pero NO se pueden emitir facturas.
              </p>
            </div>
            <Switch checked={form.activa} onCheckedChange={(v) => setField('activa', v)} />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button onClick={handleSubmit} disabled={saving} className="h-10">
              {saving ? 'Guardando…' : actuales ? 'Actualizar credenciales' : 'Guardar credenciales'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm space-y-2">
        <div className="font-medium">Cómo obtener el certificado AFIP (resumen)</div>
        <ol className="list-decimal list-inside space-y-1 mt-2 text-xs text-muted-foreground">
          <li>Entrá a auth.afip.gob.ar con CUIT + clave fiscal nivel 3+.</li>
          <li>Adherí el servicio <strong>Administración de Certificados Digitales</strong> (gratis).</li>
          <li>En <strong>WSAA</strong> → "Nuevo certificado" → completá los datos.</li>
          <li>
            Generá par de claves con OpenSSL (terminal):
            <pre className="mt-1 p-2 bg-background rounded text-[10px] font-mono leading-tight overflow-x-auto">
{`openssl genrsa -out private.key 2048
openssl req -new -key private.key -subj "/C=AR/O=Tu Razon Social/CN=COMANDA/serialNumber=CUIT 20XXXXXXXXX" -out request.csr`}
            </pre>
          </li>
          <li>Subí <code>request.csr</code> a AFIP → bajá <code>cert.crt</code>.</li>
          <li>Adherí <strong>Facturación Electrónica WSFEv1</strong> asociado al certificado.</li>
          <li>Volvé acá y pegá <code>cert.crt</code> + <code>private.key</code>.</li>
        </ol>
      </div>
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium ${warn ? 'text-warning' : ''}`}>{value}</span>
    </div>
  );
}
