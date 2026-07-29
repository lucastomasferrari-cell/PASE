// EmitirFacturaDialog — emisión de factura electrónica AFIP desde el POS.
//
// Se abre con el botón "Factura" del footer (o auto post-cobro). Dos caminos:
//   1. Consumidor final → emite al instante, sin cargar datos (el 90% de los
//      casos). Factura B (RI) o C (monotributo/exento).
//   2. Cliente con datos → formulario (CUIT/DNI, factura A o B) → confirmar.
//
// Al emitir con la mesa abierta, la venta queda CONGELADA (no se puede
// sumar/restar ítems). Para modificarla después hay que generar una nota de
// crédito. Ver trigger fn_bloquear_edicion_mesa_facturada + VentaScreen.
//
// Una vez emitida, muestra el CAE + QR fiscal y ofrece imprimir el ticket
// fiscal en la impresora térmica configurada.

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Receipt, X, Printer, CheckCircle2, User, IdCard, ArrowLeft, AlertTriangle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { emitirFactura, type FacturaVentaRow } from '@/lib/afip/client';
import { getCredencialesAFIP } from '@/lib/afip/service';
import { imprimirTicket } from '@/services/printerService';
import { listVentasItems } from '@/services/ventasService';
import { listLocalesAccesibles } from '@/services/configService';
import { listItems } from '@/services/itemsService';
import type { AfipCredencialesPublic, AfipFacturaResult, AfipTipoComprobante, AfipDocTipo } from '@/lib/afip/types';
import type { VentaPos } from '@/types/database';
import { formatARS } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venta: VentaPos;
  /** Se llama al cerrar el modal (con o sin emitir). Si emitió, refrescar. */
  onClose: (emitio: boolean) => void;
  /** Si la venta ya tiene factura activa, se abre directo en modo ver/reimprimir. */
  facturaExistente?: FacturaVentaRow | null;
}

type Paso = 'eleccion' | 'form' | 'exito';

interface DatosCliente {
  tipo_comprobante: AfipTipoComprobante;
  doc_tipo: AfipDocTipo;
  doc_nro: string;
  cliente_razon_social: string;
  // Condición IVA del receptor (RG 5616, obligatoria). Códigos AFIP:
  // 1=Resp. Inscripto, 4=Exento, 5=Consumidor Final, 6=Monotributo.
  condicion_iva: number;
}

// Opciones de condición IVA del cliente según la clase de comprobante.
// Factura A → el receptor DEBE ser un contribuyente inscripto (RI/Monotributo);
// Consumidor Final (5) es INVÁLIDO para A (error AFIP 10243).
const CONDICIONES_IVA = [
  { id: 1, label: 'Responsable Inscripto' },
  { id: 6, label: 'Monotributo' },
  { id: 4, label: 'Exento' },
  { id: 5, label: 'Consumidor Final' },
];
// Default de condición IVA según el tipo de comprobante.
function condicionDefault(tipo: AfipTipoComprobante): number {
  return tipo === 1 ? 1 : 5; // A → Resp. Inscripto ; B/C → Consumidor Final
}

export function EmitirFacturaDialog({ open, onOpenChange, venta, onClose, facturaExistente }: Props) {
  const [creds, setCreds] = useState<AfipCredencialesPublic | null>(null);
  const [loadingCreds, setLoadingCreds] = useState(true);
  const [paso, setPaso] = useState<Paso>('eleccion');
  const [form, setForm] = useState<DatosCliente>({
    tipo_comprobante: 6,
    doc_tipo: 80, // CUIT (default para "cliente con datos")
    doc_nro: '',
    cliente_razon_social: venta.cliente_nombre ?? '',
    condicion_iva: 5, // se ajusta al elegir tipo (A→RI, B→CF)
  });
  const [emitting, setEmitting] = useState(false);
  const emittingRef = useRef(false);
  const [resultado, setResultado] = useState<AfipFacturaResult | null>(null);
  // Guarda cómo se emitió (para el print + labels de la pantalla de éxito).
  const [emitido, setEmitido] = useState<{ tipo: AfipTipoComprobante; neto: number; iva: number; docTipo: AfipDocTipo; docNro: string; razon: string } | null>(null);
  const [imprimiendo, setImprimiendo] = useState(false);

  const total = Number(venta.total);
  const mesaAbierta = venta.estado !== 'cobrada';
  const esRI = creds?.tipo_contribuyente === 'responsable_inscripto';
  // Tipo + IVA por default según el contribuyente.
  const tipoDefault: AfipTipoComprobante = esRI ? 6 : 11; // B (RI) o C (mono/exento)
  const ivaPctDefault = esRI ? 21 : 0;

  useEffect(() => {
    if (!open) return;
    setEmitting(false);
    emittingRef.current = false;
    setLoadingCreds(true);
    // Si la venta ya tiene factura activa → abrir directo en ver/reimprimir.
    if (facturaExistente) {
      setResultado({
        factura_id: facturaExistente.id,
        cae: facturaExistente.cae ?? '',
        cae_vence_at: facturaExistente.cae_vence_at ?? '',
        numero: facturaExistente.numero,
        qr_fiscal_url: facturaExistente.qr_fiscal_url ?? '',
        estado: 'aprobada',
        rechazo_motivo: null,
      });
      setEmitido({
        tipo: facturaExistente.tipo_comprobante,
        neto: Number(facturaExistente.importe_neto),
        iva: Number(facturaExistente.importe_iva),
        docTipo: (facturaExistente.doc_tipo ?? 99) as AfipDocTipo,
        docNro: facturaExistente.doc_nro ?? '',
        razon: facturaExistente.cliente_razon_social ?? '',
      });
      setPaso('exito');
    } else {
      setPaso('eleccion');
      setResultado(null);
      setEmitido(null);
    }
    getCredencialesAFIP().then((r) => {
      if (r.data) {
        setCreds(r.data);
        const ri = r.data.tipo_contribuyente === 'responsable_inscripto';
        setForm((f) => ({ ...f, tipo_comprobante: ri ? 6 : 11 }));
      }
      setLoadingCreds(false);
    });
  }, [open, facturaExistente]);

  // Descompone el total en neto + IVA según el % (RI). Mono/exento: iva 0.
  function calcularImportes(ivaPct: number): { neto: number; iva: number } {
    const iva = ivaPct > 0 ? +(total - total / (1 + ivaPct / 100)).toFixed(2) : 0;
    return { neto: +(total - iva).toFixed(2), iva };
  }

  async function emitir(opts: {
    tipo: AfipTipoComprobante;
    ivaPct: number;
    docTipo: AfipDocTipo;
    docNro?: string;
    razon?: string;
    condicionIva?: number;
  }) {
    if (emittingRef.current) return;
    if (!creds?.activa) { toast.error('AFIP no está activo en este tenant'); return; }
    if (opts.docTipo !== 99 && !opts.docNro?.trim()) {
      toast.error('Falta el número de documento del cliente');
      return;
    }
    const { neto, iva } = calcularImportes(opts.ivaPct);

    emittingRef.current = true;
    setEmitting(true);
    try {
      const result = await emitirFactura({
        tenant_id: creds.tenant_id,
        venta_pos_id: venta.id,
        tipo_comprobante: opts.tipo,
        importe_neto: neto,
        importe_iva: iva,
        importe_total: total,
        concepto: 1, // Productos
        doc_tipo: opts.docTipo,
        doc_nro: opts.docNro || undefined,
        cliente_razon_social: opts.razon || undefined,
        condicion_iva_receptor: opts.condicionIva ?? condicionDefault(opts.tipo),
        request_uuid: crypto.randomUUID(),
      });
      setResultado(result);
      setEmitido({ tipo: opts.tipo, neto, iva, docTipo: opts.docTipo, docNro: opts.docNro || '', razon: opts.razon || '' });
      setPaso('exito');
      toast.success(`Factura ${tipoLabel(opts.tipo)} #${result.numero} emitida`);
    } catch (err) {
      toast.error('Error emitiendo factura', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      emittingRef.current = false;
      setEmitting(false);
    }
  }

  function cerrar(emitio: boolean) {
    onOpenChange(false);
    onClose(emitio);
  }

  async function handleImprimir() {
    if (!resultado || !creds || !emitido) return;
    setImprimiendo(true);
    try {
      const [itemsR, locales, catR] = await Promise.all([
        listVentasItems(venta.id),
        listLocalesAccesibles(),
        listItems({ tenantId: creds.tenant_id, localId: venta.local_id }),
      ]);
      const local = locales.data.find((l) => l.id === venta.local_id);
      const catalogo = catR.data;
      const pagos: Array<{ metodo: string; monto: number; cuotas?: number | null }> = [
        { metodo: 'Pagado', monto: total },
      ];
      const letra: 'A' | 'B' | 'C' =
        emitido.tipo === 1 ? 'A' : emitido.tipo === 6 ? 'B' : 'C';

      const r = await imprimirTicket({
        titulo: local?.nombre ?? 'COMANDA',
        cuit_emisor: creds.cuit,
        items: itemsR.data.map((it) => ({
          nombre: it.nombre_display ?? catalogo.find((c) => c.id === it.item_id)?.nombre ?? `Item #${it.item_id}`,
          cantidad: Number(it.cantidad),
          subtotal: Number(it.subtotal),
        })),
        total,
        pagos,
        fechaHora: new Date().toLocaleString('es-AR'),
        venta_id: venta.numero_local ?? venta.id,
        tipo_comprobante_letra: letra,
        punto_venta: creds.punto_venta,
        numero_comprobante: resultado.numero,
        importe_neto: emitido.neto,
        importe_iva: emitido.iva,
        cae: resultado.cae,
        cae_vto: resultado.cae_vence_at,
        qr_afip: resultado.qr_fiscal_url,
        cliente_doc_tipo: emitido.docTipo === 99 ? 'CF' :
                          emitido.docTipo === 96 ? 'DNI' :
                          emitido.docTipo === 80 ? 'CUIT' :
                          emitido.docTipo === 86 ? 'CUIL' : undefined,
        cliente_doc_nro: emitido.docNro || undefined,
        cliente_razon_social: emitido.razon || undefined,
      });
      if (!r.ok) toast.error(`No se pudo imprimir: ${r.error}`);
      else toast.success('Ticket fiscal enviado a la impresora');
    } finally {
      setImprimiendo(false);
    }
  }

  // ── Pantalla ÉXITO ────────────────────────────────────────────────────
  if (paso === 'exito' && resultado && emitido) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-success" />
              <DialogTitle>Factura emitida</DialogTitle>
            </div>
            <DialogDescription>
              {tipoLabel(emitido.tipo)} #{resultado.numero} aprobada por AFIP.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm py-2">
            <Row label="CAE" value={resultado.cae} mono />
            <Row label="Vence" value={resultado.cae_vence_at ?? '—'} />
            <Row label="Número" value={`${tipoLabel(emitido.tipo)} #${resultado.numero}`} />
            <Row label="Total" value={formatARS(total)} />
            {resultado.qr_fiscal_url && (
              <div className="pt-2">
                <a href={resultado.qr_fiscal_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline break-all">
                  Ver QR fiscal AFIP →
                </a>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={handleImprimir} disabled={imprimiendo}>
              <Printer className="h-4 w-4 mr-2" />
              {imprimiendo ? 'Imprimiendo…' : 'Imprimir ticket fiscal'}
            </Button>
            <Button onClick={() => cerrar(true)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── AFIP no configurado / cargando ────────────────────────────────────
  if (!loadingCreds && !creds?.activa) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Factura electrónica</DialogTitle>
          </DialogHeader>
          <div className="py-8 text-center text-sm">
            <p className="text-warning">⚠ AFIP no está activo en este tenant.</p>
            <p className="text-muted-foreground mt-1">
              Configurá las credenciales en <strong>Configuración → AFIP</strong>.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => cerrar(false)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Paso FORM (cliente con datos) ─────────────────────────────────────
  if (paso === 'form') {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setPaso('eleccion')} className="text-muted-foreground hover:text-foreground" aria-label="Volver">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <DialogTitle>Datos del cliente</DialogTitle>
            </div>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              {esRI && (
                <div className="space-y-1.5">
                  <Label>Tipo factura</Label>
                  <Select value={String(form.tipo_comprobante)} onValueChange={(v) => {
                    const t = Number(v) as AfipTipoComprobante;
                    setForm((f) => ({ ...f, tipo_comprobante: t, condicion_iva: condicionDefault(t) }));
                  }}>
                    <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">Factura A</SelectItem>
                      <SelectItem value="6">Factura B</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Tipo doc</Label>
                <Select value={String(form.doc_tipo)} onValueChange={(v) => setForm((f) => ({ ...f, doc_tipo: Number(v) as AfipDocTipo }))}>
                  <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="80">CUIT</SelectItem>
                    <SelectItem value="96">DNI</SelectItem>
                    <SelectItem value="86">CUIL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Número</Label>
              <Input
                value={form.doc_nro}
                onChange={(e) => setForm((f) => ({ ...f, doc_nro: e.target.value.replace(/\D/g, '') }))}
                placeholder={form.doc_tipo === 80 ? '20XXXXXXXXX' : '12345678'}
                inputMode="numeric"
                className="h-10 font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Razón social / Nombre</Label>
              <Input
                value={form.cliente_razon_social}
                onChange={(e) => setForm((f) => ({ ...f, cliente_razon_social: e.target.value }))}
                placeholder="Apellido Nombre o Razón Social"
                className="h-10"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Condición IVA del cliente</Label>
              <Select value={String(form.condicion_iva)} onValueChange={(v) => setForm((f) => ({ ...f, condicion_iva: Number(v) }))}>
                <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CONDICIONES_IVA
                    // Para Factura A el receptor NO puede ser Consumidor Final.
                    .filter((o) => !(form.tipo_comprobante === 1 && o.id === 5))
                    .map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {form.tipo_comprobante === 1 && (
                <p className="text-xs text-muted-foreground">Una Factura A requiere un cliente inscripto (RI o Monotributo).</p>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPaso('eleccion')} disabled={emitting}>Volver</Button>
            <Button
              onClick={() => emitir({
                tipo: form.tipo_comprobante,
                // Factura A siempre discrimina IVA 21%; B a consumidor con datos también.
                ivaPct: esRI ? 21 : 0,
                docTipo: form.doc_tipo,
                docNro: form.doc_nro,
                razon: form.cliente_razon_social,
                condicionIva: form.condicion_iva,
              })}
              disabled={emitting}
            >
              <CheckCircle2 className="h-4 w-4 mr-2" />
              {emitting ? 'Emitiendo CAE…' : 'Confirmar y emitir'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Paso ELECCIÓN (default) ───────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" />
            <DialogTitle>¿Emitir factura?</DialogTitle>
          </div>
          <DialogDescription>
            Venta #{venta.numero_local ?? venta.id} · {formatARS(total)}
          </DialogDescription>
        </DialogHeader>

        {loadingCreds ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Cargando…</div>
        ) : (
          <div className="space-y-3 py-2">
            {mesaAbierta && (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-foreground">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning mt-0.5" />
                <span>Al emitir, la mesa queda congelada. Si después falta un ítem, hay que generar una nota de crédito.</span>
              </div>
            )}

            <button
              type="button"
              onClick={() => emitir({ tipo: tipoDefault, ivaPct: ivaPctDefault, docTipo: 99, condicionIva: 5 })}
              disabled={emitting}
              className="w-full flex items-center gap-3 rounded-xl bg-primary text-primary-foreground p-4 text-left hover:opacity-95 disabled:opacity-60 transition"
            >
              <User className="h-6 w-6 shrink-0" />
              <span>
                <span className="block text-base font-medium">Consumidor final</span>
                <span className="block text-xs opacity-85">{tipoLabel(tipoDefault)} · {emitting ? 'emitiendo…' : 'sale al instante, sin cargar datos'}</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => setPaso('form')}
              disabled={emitting}
              className="w-full flex items-center gap-3 rounded-xl bg-muted/40 border border-border p-4 text-left hover:bg-muted/60 disabled:opacity-60 transition"
            >
              <IdCard className="h-6 w-6 shrink-0 text-muted-foreground" />
              <span>
                <span className="block text-base font-medium">Cliente con datos</span>
                <span className="block text-xs text-muted-foreground">CUIT / DNI · {esRI ? 'factura A o B' : 'factura C'}</span>
              </span>
            </button>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => cerrar(false)} disabled={emitting}>
            <X className="h-4 w-4 mr-2" />
            Solo ticket no fiscal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs' : 'font-medium'}>{value}</span>
    </div>
  );
}

function tipoLabel(t: AfipTipoComprobante): string {
  switch (t) {
    case 1: return 'Factura A';
    case 6: return 'Factura B';
    case 11: return 'Factura C';
    case 3: return 'NC A';
    case 8: return 'NC B';
    case 13: return 'NC C';
    default: return `Comprobante ${t}`;
  }
}
