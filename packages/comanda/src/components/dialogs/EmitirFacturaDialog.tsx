// EmitirFacturaDialog — modal post-cobro para emitir factura electrónica
// AFIP. Se monta auto cuando la venta se cobra Y el tenant tiene AFIP
// activo. El cajero puede:
//   - Aceptar y emitir con defaults (factura B/C para consumidor final).
//   - Editar datos del cliente (CUIT/DNI/razón social) si hace falta.
//   - Saltar la emisión (solo ticket no fiscal).
//
// Una vez emitida la factura, muestra el CAE + QR fiscal y ofrece
// imprimir ticket fiscal en la impresora térmica configurada.

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Receipt, X, Printer, CheckCircle2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { emitirFactura } from '@/lib/afip/client';
import { getCredencialesAFIP } from '@/lib/afip/service';
import { imprimirTicket } from '@/services/printerService';
import { listVentasItems } from '@/services/ventasService';
import { listLocalesAccesibles } from '@/services/configService';
import type { AfipCredencialesPublic, AfipFacturaResult, AfipTipoComprobante, AfipDocTipo } from '@/lib/afip/types';
import type { VentaPos } from '@/types/database';
import { formatARS } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venta: VentaPos;
  /** Se llama cuando el user cierra el modal sin emitir o después de emitir. */
  onClose: () => void;
}

interface FormState {
  tipo_comprobante: AfipTipoComprobante;
  doc_tipo: AfipDocTipo;
  doc_nro: string;
  cliente_razon_social: string;
  importe_iva_pct: 0 | 10.5 | 21; // monotributo usa 0
}

export function EmitirFacturaDialog({ open, onOpenChange, venta, onClose }: Props) {
  const [creds, setCreds] = useState<AfipCredencialesPublic | null>(null);
  const [loadingCreds, setLoadingCreds] = useState(true);
  const [form, setForm] = useState<FormState>({
    tipo_comprobante: 11, // Factura C (monotributo default)
    doc_tipo: 99,         // Consumidor final
    doc_nro: '',
    cliente_razon_social: venta.cliente_nombre ?? '',
    importe_iva_pct: 0,
  });
  const [emitting, setEmitting] = useState(false);
  const emittingRef = useRef(false);
  const [resultado, setResultado] = useState<AfipFacturaResult | null>(null);
  const [imprimiendo, setImprimiendo] = useState(false);

  // Cargar credenciales y setear defaults según tipo_contribuyente
  useEffect(() => {
    if (!open) return;
    setResultado(null);
    setEmitting(false);
    emittingRef.current = false;
    getCredencialesAFIP().then((r) => {
      if (r.data) {
        setCreds(r.data);
        // Tipo comprobante por default según tipo_contribuyente
        let tipo: AfipTipoComprobante = 11;
        let ivaPct: FormState['importe_iva_pct'] = 0;
        if (r.data.tipo_contribuyente === 'responsable_inscripto') {
          tipo = 6; // Factura B para consumidor final
          ivaPct = 21;
        } else if (r.data.tipo_contribuyente === 'exento') {
          tipo = 11;
          ivaPct = 0;
        }
        setForm((f) => ({ ...f, tipo_comprobante: tipo, importe_iva_pct: ivaPct }));
      }
      setLoadingCreds(false);
    });
  }, [open]);

  const total = Number(venta.total);
  // Si IVA discriminado: neto = total / (1 + iva/100). Si no, neto = total, iva = 0.
  const importeIva = form.importe_iva_pct > 0
    ? +(total - total / (1 + form.importe_iva_pct / 100)).toFixed(2)
    : 0;
  const importeNeto = +(total - importeIva).toFixed(2);

  async function handleEmitir() {
    if (emittingRef.current) return;
    if (!creds?.activa) {
      toast.error('AFIP no está activo en este tenant');
      return;
    }
    if (form.doc_tipo !== 99 && !form.doc_nro.trim()) {
      toast.error('Falta el número de documento del cliente');
      return;
    }

    emittingRef.current = true;
    setEmitting(true);
    try {
      const result = await emitirFactura({
        tenant_id: creds.tenant_id,
        venta_pos_id: venta.id,
        tipo_comprobante: form.tipo_comprobante,
        importe_neto: importeNeto,
        importe_iva: importeIva,
        importe_total: total,
        concepto: 1, // Productos
        doc_tipo: form.doc_tipo,
        doc_nro: form.doc_nro || undefined,
        cliente_razon_social: form.cliente_razon_social || undefined,
        request_uuid: crypto.randomUUID(),
      });
      setResultado(result);
      toast.success(`Factura ${tipoLabel(form.tipo_comprobante)} #${result.numero} emitida`);
    } catch (err) {
      toast.error('Error emitiendo factura', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      emittingRef.current = false;
      setEmitting(false);
    }
  }

  function handleSaltar() {
    onOpenChange(false);
    onClose();
  }

  function handleCerrarPostExito() {
    onOpenChange(false);
    onClose();
  }

  async function handleImprimir() {
    if (!resultado || !creds) return;
    setImprimiendo(true);
    try {
      // Cargar items + local en paralelo
      const [itemsR, locales] = await Promise.all([
        listVentasItems(venta.id),
        listLocalesAccesibles(),
      ]);
      const local = locales.data.find((l) => l.id === venta.local_id);

      // Buscar pagos en venta (no los traemos desde la DB acá — usamos los
      // datos que la propia venta_pos tiene en total). Si querés el detalle
      // de método, hacer otra query a ventas_pos_pagos.
      const pagos: Array<{ metodo: string; monto: number; cuotas?: number | null }> = [
        { metodo: 'Pagado', monto: Number(venta.total) },
      ];

      const letra: 'A' | 'B' | 'C' =
        form.tipo_comprobante === 1 ? 'A' :
        form.tipo_comprobante === 6 ? 'B' :
        'C';

      const r = await imprimirTicket({
        titulo: local?.nombre ?? 'COMANDA',
        cuit_emisor: creds.cuit,
        items: itemsR.data.map((it) => ({
          nombre: 'Item ' + it.item_id,
          cantidad: Number(it.cantidad),
          subtotal: Number(it.subtotal),
        })),
        total: Number(venta.total),
        pagos,
        fechaHora: new Date().toLocaleString('es-AR'),
        venta_id: venta.numero_local ?? venta.id,
        tipo_comprobante_letra: letra,
        punto_venta: creds.punto_venta,
        numero_comprobante: resultado.numero,
        importe_neto: importeNeto,
        importe_iva: importeIva,
        cae: resultado.cae,
        cae_vto: resultado.cae_vence_at,
        qr_afip: resultado.qr_fiscal_url,
        cliente_doc_tipo: form.doc_tipo === 99 ? 'CF' :
                          form.doc_tipo === 96 ? 'DNI' :
                          form.doc_tipo === 80 ? 'CUIT' :
                          form.doc_tipo === 86 ? 'CUIL' : undefined,
        cliente_doc_nro: form.doc_nro || undefined,
        cliente_razon_social: form.cliente_razon_social || undefined,
      });
      if (!r.ok) {
        toast.error(`No se pudo imprimir: ${r.error}`);
      } else {
        toast.success('Ticket fiscal enviado a la impresora');
      }
    } finally {
      setImprimiendo(false);
    }
  }

  // Pantalla post-éxito
  if (resultado) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-success" />
              <DialogTitle>Factura emitida</DialogTitle>
            </div>
            <DialogDescription>
              {tipoLabel(form.tipo_comprobante)} #{resultado.numero} aprobada por AFIP.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm py-2">
            <Row label="CAE" value={resultado.cae} mono />
            <Row label="Vence" value={resultado.cae_vence_at ?? '—'} />
            <Row label="Número" value={`${tipoLabel(form.tipo_comprobante)} #${resultado.numero}`} />
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
            <Button onClick={handleCerrarPostExito}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Pantalla pre-emisión
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" />
            <DialogTitle>¿Emitir factura electrónica?</DialogTitle>
          </div>
          <DialogDescription>
            La venta ya fue cobrada. Podés emitir la factura ahora o saltarla y
            solo imprimir ticket no fiscal.
          </DialogDescription>
        </DialogHeader>

        {loadingCreds ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Cargando…</div>
        ) : !creds?.activa ? (
          <div className="py-8 text-center text-sm">
            <p className="text-warning">⚠ AFIP no está activo en este tenant.</p>
            <p className="text-muted-foreground mt-1">
              Configurá las credenciales en <strong>/configuracion/afip</strong>.
            </p>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Resumen de la venta */}
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1 text-sm">
              <Row label="Venta #" value={String(venta.numero_local ?? venta.id)} />
              <Row label="Total" value={formatARS(total)} />
              {form.importe_iva_pct > 0 && (
                <>
                  <Row label={`IVA ${form.importe_iva_pct}%`} value={formatARS(importeIva)} subtle />
                  <Row label="Neto" value={formatARS(importeNeto)} subtle />
                </>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Tipo factura</Label>
                <Select value={String(form.tipo_comprobante)} onValueChange={(v) => setForm((f) => ({ ...f, tipo_comprobante: Number(v) as AfipTipoComprobante }))}>
                  <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {creds.tipo_contribuyente === 'responsable_inscripto' && (
                      <>
                        <SelectItem value="1">Factura A</SelectItem>
                        <SelectItem value="6">Factura B</SelectItem>
                      </>
                    )}
                    {creds.tipo_contribuyente === 'monotributo' && (
                      <SelectItem value="11">Factura C</SelectItem>
                    )}
                    {creds.tipo_contribuyente === 'exento' && (
                      <SelectItem value="11">Factura C</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

              {creds.tipo_contribuyente === 'responsable_inscripto' && form.tipo_comprobante !== 11 && (
                <div className="space-y-1.5">
                  <Label>IVA</Label>
                  <Select value={String(form.importe_iva_pct)} onValueChange={(v) => setForm((f) => ({ ...f, importe_iva_pct: Number(v) as FormState['importe_iva_pct'] }))}>
                    <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Exento (0%)</SelectItem>
                      <SelectItem value="10.5">10,5%</SelectItem>
                      <SelectItem value="21">21%</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Doc tipo</Label>
                <Select value={String(form.doc_tipo)} onValueChange={(v) => setForm((f) => ({ ...f, doc_tipo: Number(v) as AfipDocTipo }))}>
                  <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="99">Consumidor final</SelectItem>
                    <SelectItem value="96">DNI</SelectItem>
                    <SelectItem value="80">CUIT</SelectItem>
                    <SelectItem value="86">CUIL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.doc_tipo !== 99 && (
                <div className="space-y-1.5 col-span-2">
                  <Label>Nro</Label>
                  <Input
                    value={form.doc_nro}
                    onChange={(e) => setForm((f) => ({ ...f, doc_nro: e.target.value.replace(/\D/g, '') }))}
                    placeholder={form.doc_tipo === 80 ? '20XXXXXXXXX' : '12345678'}
                    inputMode="numeric"
                    className="h-10 font-mono"
                  />
                </div>
              )}
            </div>

            {form.doc_tipo !== 99 && (
              <div className="space-y-1.5">
                <Label>Razón social / Nombre</Label>
                <Input
                  value={form.cliente_razon_social}
                  onChange={(e) => setForm((f) => ({ ...f, cliente_razon_social: e.target.value }))}
                  placeholder="Apellido Nombre o Razón Social"
                  className="h-10"
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={handleSaltar} disabled={emitting}>
            <X className="h-4 w-4 mr-2" />
            Solo ticket no fiscal
          </Button>
          {creds?.activa && (
            <Button onClick={handleEmitir} disabled={emitting}>
              <Receipt className="h-4 w-4 mr-2" />
              {emitting ? 'Emitiendo CAE…' : 'Emitir factura'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, mono, subtle }: { label: string; value: string; mono?: boolean; subtle?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${subtle ? 'text-muted-foreground text-xs' : ''}`}>
      <span className={subtle ? '' : 'text-muted-foreground'}>{label}</span>
      <span className={mono ? 'font-mono text-xs' : 'font-medium'}>{value}</span>
    </div>
  );
}

function tipoLabel(t: AfipTipoComprobante): string {
  switch (t) {
    case 1: return 'Factura A';
    case 6: return 'Factura B';
    case 11: return 'Factura C';
    case 51: return 'Factura M';
    case 56: return 'Comprobante M';
    case 61: return 'Recibo C';
    case 81: return 'Tique factura A';
    case 86: return 'Tique factura B';
    default: return `Comprobante ${t}`;
  }
}
