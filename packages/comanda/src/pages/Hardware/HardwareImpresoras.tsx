// Pantalla /hardware/impresoras — configuración de impresoras térmicas.
//
// Modo de uso:
// 1. El operador instala el COMANDA Print Server local (Node.js) en la
//    PC del local. Lo arranca con `npm start`.
// 2. Abrís esta pantalla y aparece "Print Server: ✓ conectado".
// 3. Agregás impresoras: cada una con nombre + tipo de conexión (USB,
//    Network, Serial/COM) + asignación a estación (cocina/barra/etc).
// 4. Click "Imprimir prueba" para verificar.
// 5. A partir de ahí: cobrar → ticket cliente sale auto. Mandar curso a
//    cocina → ticket sale a la impresora con esa estación.
//
// Si NO está corriendo el Print Server: la UI lo muestra y ofrece
// instrucciones. Fallback automático a WebUSB browser.

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Printer as PrinterIcon, Plus, Trash2, RefreshCw, CheckCircle2,
  AlertCircle, Server, Wifi, Cable, Usb, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { printServer, type PrintServerPrinter, type UpsertPrinterArgs } from '@/lib/printServer/client';
import { getPrintMode, resetPrintModeCache, type PrintMode } from '@/services/printerService';

const ESTACIONES = [
  { value: 'cliente', label: 'Cliente / Caja (tickets de venta)' },
  { value: 'cocina_caliente', label: 'Cocina caliente' },
  { value: 'cocina_fria', label: 'Cocina fría' },
  { value: 'barra', label: 'Barra (bebidas)' },
  { value: 'postres', label: 'Postres' },
];

const TRANSPORTES = [
  { value: 'usb', label: 'USB (conectada por cable)', icon: Usb },
  { value: 'network', label: 'Network / IP (en red local)', icon: Wifi },
  { value: 'serial', label: 'Serial / COM (Bluetooth con pair previo)', icon: Cable },
];

interface FormState {
  id?: string;
  nombre: string;
  /** Multi-select: una impresora puede cubrir varias estaciones a la vez. */
  estaciones: string[];
  transporte: 'usb' | 'network' | 'serial';
  // USB
  vendor_id: string;
  product_id: string;
  windows_printer_name: string;
  // Network
  host: string;
  port: string;
  // Serial
  path: string;
  // Genérico
  tipo: 'epson' | 'star';
  width: number;
}

const EMPTY: FormState = {
  nombre: '',
  estaciones: ['cliente'],
  transporte: 'usb',
  vendor_id: '',
  product_id: '',
  windows_printer_name: '',
  host: '',
  port: '9100',
  path: '',
  tipo: 'epson',
  width: 32,
};

export function HardwareImpresoras() {
  const [mode, setMode] = useState<PrintMode | null>(null);
  const [printers, setPrinters] = useState<PrintServerPrinter[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const [testing, setTesting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function detectAndLoad() {
    setLoading(true);
    resetPrintModeCache();
    const m = await getPrintMode();
    setMode(m);
    if (m === 'server') {
      try {
        const list = await printServer.listPrinters();
        setPrinters(list);
      } catch (err) {
        console.error('list printers failed:', err);
        setPrinters([]);
      }
    } else {
      setPrinters([]);
    }
    setLoading(false);
  }

  useEffect(() => { detectAndLoad(); }, []);

  async function handleRefresh() {
    setRefreshing(true);
    await detectAndLoad();
    setRefreshing(false);
  }

  function abrirModalNuevo() {
    setForm(EMPTY);
    setModalOpen(true);
  }

  function abrirModalEditar(p: PrintServerPrinter) {
    const cfg = p.config as Record<string, string | number>;
    // Nuevo modelo: `estaciones` (array). Fallback al legacy `estacion` (single).
    const estacionesIniciales = Array.isArray(p.estaciones) && p.estaciones.length > 0
      ? p.estaciones
      : (p.estacion ? [p.estacion] : ['cliente']);
    setForm({
      id: p.id,
      nombre: p.nombre,
      estaciones: estacionesIniciales,
      transporte: p.transporte,
      vendor_id: String(cfg.vendor_id ?? ''),
      product_id: String(cfg.product_id ?? ''),
      windows_printer_name: String(cfg.windows_printer_name ?? ''),
      host: String(cfg.host ?? ''),
      port: String(cfg.port ?? '9100'),
      path: String(cfg.path ?? ''),
      tipo: (cfg.tipo as 'epson' | 'star') ?? 'epson',
      width: Number(cfg.width ?? 32),
    });
    setModalOpen(true);
  }

  async function handleGuardar() {
    if (savingRef.current) return;
    if (!form.nombre.trim()) { toast.error('Poné un nombre a la impresora'); return; }

    // Armar config según transporte
    const config: Record<string, unknown> = { tipo: form.tipo, width: form.width };
    if (form.transporte === 'usb') {
      if (form.vendor_id) config.vendor_id = form.vendor_id;
      if (form.product_id) config.product_id = form.product_id;
      // Nombre exacto de la impresora en Windows — clave cuando hay múltiples
      // USB para que cada printer entry apunte a un hardware distinto.
      if (form.windows_printer_name.trim()) {
        config.windows_printer_name = form.windows_printer_name.trim();
      }
    } else if (form.transporte === 'network') {
      if (!form.host.trim()) { toast.error('IP/host requerido para Network'); return; }
      config.host = form.host.trim();
      config.port = parseInt(form.port) || 9100;
    } else if (form.transporte === 'serial') {
      if (!form.path.trim()) { toast.error('Path/COM requerido para Serial'); return; }
      config.path = form.path.trim();
    }

    if (form.estaciones.length === 0) {
      toast.error('Elegí al menos una categoría de impresión');
      return;
    }
    const args: UpsertPrinterArgs = {
      id: form.id,
      nombre: form.nombre.trim(),
      // Nuevo formato: array de estaciones. `estacion` (single) queda en null;
      // el server lo derivará por back-compat.
      estaciones: form.estaciones,
      estacion: null,
      transporte: form.transporte,
      config,
    };

    savingRef.current = true;
    setSaving(true);
    try {
      await printServer.upsertPrinter(args);
      toast.success(form.id ? 'Impresora actualizada' : 'Impresora agregada');
      setModalOpen(false);
      await detectAndLoad();
    } catch (err) {
      toast.error('Error guardando', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function handleTest(id: string) {
    setTesting(id);
    try {
      await printServer.testPrint(id);
      toast.success('Página de prueba enviada — verificá la impresora');
    } catch (err) {
      toast.error('Falló la impresión', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(null);
    }
  }

  async function handleEliminar(p: PrintServerPrinter) {
    if (!confirm(`¿Eliminar "${p.nombre}"? Esto la desconfigura del print server pero no toca la impresora física.`)) return;
    setDeleting(p.id);
    try {
      await printServer.deletePrinter(p.id);
      toast.success('Impresora eliminada');
      await detectAndLoad();
    } catch (err) {
      toast.error('Error eliminando', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setDeleting(null);
    }
  }

  if (loading) return <div className="py-12 text-center text-muted-foreground">Detectando print server…</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <PrinterIcon className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-xl font-semibold">Impresoras térmicas</h1>
          <p className="text-sm text-muted-foreground">
            Configurá tus comanderas. Soporta USB, Network/IP y Serial/COM (incluye Bluetooth via pair previo).
          </p>
        </div>
        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refrescar
          </Button>
        </div>
      </div>

      {/* Estado del print server */}
      <Card className={
        mode === 'server' ? 'border-success/50' :
        mode === 'webusb' ? 'border-warning/50' :
        'border-destructive/50'
      }>
        <CardContent className="py-4 flex items-center gap-3">
          {mode === 'server' ? (
            <>
              <Server className="h-5 w-5 text-success" />
              <div className="flex-1">
                <div className="font-medium text-sm">Print Server conectado</div>
                <div className="text-xs text-muted-foreground">
                  Multi-impresora completo (USB / Network / Serial) en http://127.0.0.1:9100
                </div>
              </div>
              <CheckCircle2 className="h-5 w-5 text-success" />
            </>
          ) : mode === 'webusb' ? (
            <>
              <Usb className="h-5 w-5 text-warning" />
              <div className="flex-1">
                <div className="font-medium text-sm">Modo WebUSB (single-printer)</div>
                <div className="text-xs text-muted-foreground">
                  El Print Server no responde — operando solo USB en el browser. Para multi-impresora,
                  iniciá el Print Server local (ver instrucciones abajo).
                </div>
              </div>
              <AlertCircle className="h-5 w-5 text-warning" />
            </>
          ) : (
            <>
              <AlertCircle className="h-5 w-5 text-destructive" />
              <div className="flex-1">
                <div className="font-medium text-sm">Sin sistema de impresión</div>
                <div className="text-xs text-muted-foreground">
                  WebUSB no está soportado en este browser (usá Chrome o Edge). Y el Print Server local
                  tampoco responde. Los tickets quedan solo en el KDS digital.
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Instalación del Print Agent (Electron) si el server no está */}
      {mode !== 'server' && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" />
              Instalá COMANDA Print Agent en esta PC
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-3">
            <p>
              Es una app que corre en segundo plano y conecta tus impresoras
              térmicas con COMANDA. Doble click → siguiente → listo.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <a
                  href="https://pase-yndx.vercel.app/print-agent-releases/win/COMANDA-Print-Agent-Setup.exe"
                  download
                >
                  <Zap className="h-4 w-4 mr-1.5" />
                  Descargar para Windows
                </a>
              </Button>
              <Button asChild size="sm" variant="outline">
                <a
                  href="https://pase-yndx.vercel.app/print-agent-releases/mac/COMANDA-Print-Agent.dmg"
                  download
                >
                  Descargar para Mac
                </a>
              </Button>
            </div>
            <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t border-border/50">
              <p className="font-medium text-foreground">Después de instalarlo:</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Generá un token desde <strong>Hardware → Print Agents → Vincular nueva PC</strong></li>
                <li>Pegalo en la ventana del agent que se abre al instalar.</li>
                <li>Volvé acá y refrescá — el server debería aparecer "conectado".</li>
                <li>Configurá tus impresoras desde esta misma pantalla.</li>
              </ol>
              <p className="pt-1 text-foreground/50">
                ⚠️ Windows va a mostrar "Windows protegió su PC" la primera vez —
                click en "Más información" → "Ejecutar de todas formas".
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lista de impresoras */}
      {mode === 'server' && (
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-base">Impresoras configuradas</CardTitle>
            <Button onClick={abrirModalNuevo} size="sm">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Agregar impresora
            </Button>
          </CardHeader>
          <CardContent>
            {printers.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Sin impresoras configuradas todavía. Tocá "Agregar impresora" para empezar.
              </div>
            ) : (
              <div className="space-y-2">
                {printers.map((p) => {
                  const TransporteIcon = TRANSPORTES.find((t) => t.value === p.transporte)?.icon ?? Usb;
                  // Nuevo modelo: array. Fallback al legacy `estacion`.
                  const estacionesRaw = Array.isArray(p.estaciones) && p.estaciones.length > 0
                    ? p.estaciones
                    : (p.estacion ? [p.estacion] : []);
                  const estacionLabel = estacionesRaw.length > 0
                    ? estacionesRaw
                        .map((e) => ESTACIONES.find((x) => x.value === e)?.label ?? e)
                        .join(' · ')
                    : 'Sin estación asignada';
                  return (
                    <div key={p.id} className="flex items-center gap-3 p-3 rounded-md border border-border hover:bg-accent/30 transition-colors">
                      <TransporteIcon className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{p.nombre}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {estacionLabel} · {p.transporte.toUpperCase()}
                          {p.transporte === 'network' && (p.config as { host?: string }).host
                            ? ` · ${(p.config as { host?: string }).host}`
                            : ''}
                          {p.transporte === 'serial' && (p.config as { path?: string }).path
                            ? ` · ${(p.config as { path?: string }).path}`
                            : ''}
                        </div>
                      </div>
                      {p.status?.ok ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/10 text-success text-[10px]">
                          <CheckCircle2 className="h-3 w-3" /> Conectada
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-destructive/10 text-destructive text-[10px]" title={p.status?.error}>
                          <AlertCircle className="h-3 w-3" /> Sin responder
                        </span>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => handleTest(p.id)} disabled={testing === p.id} title="Imprimir página de prueba">
                        <Zap className="h-3.5 w-3.5 mr-1" />
                        {testing === p.id ? 'Imprimiendo…' : 'Probar'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => abrirModalEditar(p)}>
                        Editar
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleEliminar(p)} disabled={deleting === p.id} className="text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Modal agregar / editar */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Editar impresora' : 'Nueva impresora'}</DialogTitle>
            <DialogDescription>
              Configurá nombre + estación + cómo se conecta físicamente al print server.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>Nombre</Label>
              <Input value={form.nombre} onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))} placeholder="Ej: Cocina principal" />
            </div>
            <div className="space-y-1.5">
              <Label>Categorías que imprime</Label>
              <div className="rounded-md border border-input p-2 space-y-1.5">
                {ESTACIONES.map((e) => {
                  const checked = form.estaciones.includes(e.value);
                  return (
                    <label key={e.value} className="flex items-center gap-2 cursor-pointer hover:bg-accent/50 rounded px-1.5 py-1 select-none">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(ev) => {
                          const on = ev.target.checked;
                          setForm((f) => ({
                            ...f,
                            estaciones: on
                              ? [...f.estaciones.filter((x) => x !== e.value), e.value]
                              : f.estaciones.filter((x) => x !== e.value),
                          }));
                        }}
                        className="h-4 w-4 accent-primary"
                      />
                      <span className="text-sm">{e.label}</span>
                    </label>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted-foreground">
                Marcá <strong>todas</strong> las categorías que imprime esta impresora. Ej: una comandera de barra puede hacer "Cocina caliente" + "Cocina fría" a la vez. "Cliente" son los tickets de venta al cobrar.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Tipo de conexión</Label>
              <Select value={form.transporte} onValueChange={(v) => setForm((f) => ({ ...f, transporte: v as FormState['transporte'] }))}>
                <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TRANSPORTES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* Campos específicos por transporte */}
            {form.transporte === 'usb' && (
              <div className="rounded-md border border-border p-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Si tenés <strong>varias impresoras USB</strong>, pegá el nombre exacto de Windows (ej. "Epson TM-T20III") para que cada entry apunte a un hardware distinto. Sino, dejá vacío y usa la primera USB.
                </p>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Label className="text-xs flex-1">Nombre en Windows</Label>
                    <button
                      type="button"
                      className="text-[11px] text-primary hover:underline"
                      onClick={async () => {
                        try {
                          const resp = await fetch('http://127.0.0.1:9100/discover/windows-printers');
                          const data = await resp.json();
                          const list = data.printers ?? [];
                          if (list.length === 0) {
                            toast.info('No se encontraron impresoras USB en Windows');
                            return;
                          }
                          const nombres = list.map((p: { nombre: string; puerto: string }) => `• ${p.nombre} (${p.puerto})`).join('\n');
                          const elegido = window.prompt(
                            `Impresoras USB detectadas en Windows:\n\n${nombres}\n\nCopiá el nombre exacto (sin el "• " y sin el puerto) y pegalo abajo.`,
                            list[0].nombre,
                          );
                          if (elegido) setForm((f) => ({ ...f, windows_printer_name: elegido }));
                        } catch {
                          toast.error('No se pudo consultar el Print Agent. ¿Está corriendo?');
                        }
                      }}
                    >
                      Detectar
                    </button>
                  </div>
                  <Input
                    value={form.windows_printer_name}
                    onChange={(e) => setForm((f) => ({ ...f, windows_printer_name: e.target.value }))}
                    placeholder="Epson TM-T20III"
                    className="h-9 text-xs"
                  />
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Opcional: identificar por Vendor/Product ID</summary>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Vendor ID</Label>
                      <Input value={form.vendor_id} onChange={(e) => setForm((f) => ({ ...f, vendor_id: e.target.value }))} placeholder="0x04b8" className="h-9 font-mono text-xs" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Product ID</Label>
                      <Input value={form.product_id} onChange={(e) => setForm((f) => ({ ...f, product_id: e.target.value }))} placeholder="0x0202" className="h-9 font-mono text-xs" />
                    </div>
                  </div>
                </details>
              </div>
            )}

            {form.transporte === 'network' && (
              <div className="rounded-md border border-border p-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  IP de la impresora en tu LAN. Puerto típico 9100 (RAW ESC/POS).
                </p>
                <div className="grid grid-cols-[1fr_100px] gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">IP / host</Label>
                    <Input value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} placeholder="192.168.1.50" className="h-9 font-mono text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Puerto</Label>
                    <Input value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} className="h-9 font-mono text-xs" />
                  </div>
                </div>
              </div>
            )}

            {form.transporte === 'serial' && (
              <div className="rounded-md border border-border p-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Path del puerto serial. Windows: COM3, COM4… (verificalo en Administrador de dispositivos).
                  Linux/Mac: /dev/ttyUSB0, /dev/tty.usbserial-XXX.
                  Para Bluetooth: hacé pair primero, Windows crea un COM virtual.
                </p>
                <div className="space-y-1">
                  <Label className="text-xs">Path</Label>
                  <Input value={form.path} onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))} placeholder="COM3" className="h-9 font-mono text-xs" />
                </div>
              </div>
            )}

            {/* Avanzados */}
            <details className="rounded-md border border-border p-3 group">
              <summary className="cursor-pointer text-xs font-medium select-none">
                Opciones avanzadas
              </summary>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Modelo / comandos</Label>
                  <Select value={form.tipo} onValueChange={(v) => setForm((f) => ({ ...f, tipo: v as 'epson' | 'star' }))}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="epson">Epson / Genérica ESC/POS</SelectItem>
                      <SelectItem value="star">Star Micronics</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Ancho (caracteres)</Label>
                  <Select value={String(form.width)} onValueChange={(v) => setForm((f) => ({ ...f, width: Number(v) }))}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="32">32 (papel 58mm)</SelectItem>
                      <SelectItem value="42">42 (papel 76mm)</SelectItem>
                      <SelectItem value="48">48 (papel 80mm)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </details>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={handleGuardar} disabled={saving}>
              {saving ? 'Guardando…' : form.id ? 'Actualizar' : 'Agregar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
