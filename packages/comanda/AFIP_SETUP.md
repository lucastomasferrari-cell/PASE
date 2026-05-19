# AFIP Facturación Electrónica — Setup

Estado al 2026-05-18: **infraestructura lista, endpoint server-side pendiente de deploy.**

## Qué tenés ya

- ✅ **Migration `202605190400_afip_facturas_credenciales.sql`** aplicada en prod. Crea 2 tablas:
  - `afip_credenciales` (1 fila por tenant: CUIT + cert + key + ambiente)
  - `afip_facturas` (registro inmutable de cada CAE emitido)
- ✅ **Cliente JS browser-side** en `src/lib/afip/`: `client.ts` + `types.ts`. Llama al endpoint server-side.
- ✅ **RLS configurado**: la clave privada PEM solo es accesible por `service_role`, NUNCA al browser (revoke + column-level grant).

## Qué te falta antes de poder facturar

### 1. Generar el certificado AFIP (solo el dueño)

Una sola vez por CUIT:

1. Entrar a https://auth.afip.gob.ar/ con CUIT + clave fiscal nivel 3+ (sin esto, no se puede)
2. Adherir el servicio **"Administración de Certificados Digitales"** (gratis)
3. En **WSAA** → crear nuevo certificado:
   - Generar par de claves (key.pem + csr.pem) con OpenSSL:
     ```bash
     openssl genrsa -out private.key 2048
     openssl req -new -key private.key -subj "/C=AR/O=Tu Razon Social/CN=COMANDA-Neko/serialNumber=CUIT 20XXXXXXXXX" -out request.csr
     ```
   - Subir `request.csr` a AFIP
   - Bajar el certificado firmado (`cert.crt`)
4. **Adherir el servicio "Facturación Electrónica WSFEv1"** asociado al certificado
5. Guardar `cert.crt` + `private.key` — los necesitás para el siguiente paso

### 2. Cargar credenciales en PASE

Pantalla NUEVA pendiente (TODO): **/configuracion/afip** en el admin de COMANDA. Forma:
- CUIT (validado contra cert)
- Ambiente: testing / producción (empezar SIEMPRE en testing)
- Punto de venta (típicamente 1, validar contra AFIP cuáles habilitaste)
- Tipo contribuyente: monotributo / responsable_inscripto / exento
- Upload del `cert.crt` (texto PEM)
- Upload del `private.key` (texto PEM) — INPUT TYPE="password" + advertencia
- Validar con un ping a AFIP testing antes de guardar

**Mientras la pantalla no existe**, podés cargar manualmente vía SQL en Supabase:
```sql
INSERT INTO afip_credenciales (
  tenant_id, cuit, ambiente, punto_venta, tipo_contribuyente,
  cert_pem, key_pem, activa
) VALUES (
  '5841143c-5594-4728-99c6-a313d40618e6',  -- tu tenant_id
  '20XXXXXXXXX',                            -- tu CUIT sin guiones
  'testing',
  1,
  'monotributo',
  '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----',
  '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----',
  TRUE
);
```

### 3. Endpoint server-side `/api/afip-cae` ⚠️

**Bloqueado por límite Vercel Hobby** (12/12 functions). Para resolver:

**Opción A — Pasar a Vercel Pro** ($20/mes): más slots de functions, sin cambios de código.

**Opción B — Supabase Edge Functions** (gratis, recomendado):
- Crear función `supabase/functions/afip-cae/index.ts`
- Deno runtime, usa `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` para leer creds
- URL endpoint: `https://pduxydviqiaxfqnshhdc.supabase.co/functions/v1/afip-cae`
- Update `client.ts` para apuntar ahí en vez de `/api/afip-cae`
- Hasta 500K invocations/mes free

**Opción C — Consolidar Vercel functions**: revisar `packages/pase/api/` y consolidar mp-* en uno solo (mp-generate + mp-process + mp-sync + mp-update-pending-releases podrían vivir bajo un solo `/api/mp` con query param `action=...`). Liberar 3 slots.

### 4. Implementar el endpoint

Usar lib `@afipsdk/afip.js` (oficial AFIPSDK, freemium). Workflow:

```ts
// Pseudocódigo del endpoint
import { Afip } from '@afipsdk/afip.js';

export default async function handler(req, res) {
  // 1. Validar JWT del user
  const auth = await validarSupabaseAuth(req);
  if (!auth) return res.status(401).json({ error: 'NO_AUTH' });

  // 2. Leer credenciales del tenant (via service_role)
  const { data: cred } = await supabaseService
    .from('afip_credenciales')
    .select('cuit, ambiente, cert_pem, key_pem, punto_venta, activa')
    .eq('tenant_id', auth.tenant_id)
    .single();
  if (!cred?.activa) return res.status(400).json({ error: 'AFIP_NO_ACTIVA' });

  // 3. Idempotency: si request_uuid ya tiene CAE, devolver el cached
  const { data: prev } = await supabaseService
    .from('afip_facturas')
    .select('cae, cae_vence_at, numero, qr_fiscal_url, estado')
    .eq('request_uuid', req.body.request_uuid)
    .maybeSingle();
  if (prev?.cae) return res.json(prev);

  // 4. Inicializar SDK + obtener token WSAA (cache 12hs)
  const afip = new Afip({
    CUIT: cred.cuit,
    cert: cred.cert_pem,
    key: cred.key_pem,
    production: cred.ambiente === 'produccion',
  });

  // 5. Obtener último número de comprobante para el punto venta
  const ultimo = await afip.ElectronicBilling.getLastVoucher(
    cred.punto_venta,
    req.body.tipo_comprobante
  );
  const numero = ultimo + 1;

  // 6. Solicitar CAE
  const data = await afip.ElectronicBilling.createVoucher({
    CantReg: 1,
    PtoVta: cred.punto_venta,
    CbteTipo: req.body.tipo_comprobante,
    Concepto: req.body.concepto,
    DocTipo: req.body.doc_tipo || 99,
    DocNro: req.body.doc_nro || 0,
    CbteDesde: numero,
    CbteHasta: numero,
    CbteFch: parseInt(today.toISOString().slice(0, 10).replaceAll('-', '')),
    ImpTotal: req.body.importe_total,
    ImpTotConc: 0,
    ImpNeto: req.body.importe_neto,
    ImpOpEx: 0,
    ImpIVA: req.body.importe_iva,
    ImpTrib: 0,
    MonId: 'PES',
    MonCotiz: 1,
    Iva: req.body.importe_iva > 0 ? [{
      Id: 5, // 21%
      BaseImp: req.body.importe_neto,
      Importe: req.body.importe_iva,
    }] : undefined,
  });

  // 7. Generar QR fiscal AR (Res. 4892/2020)
  const qrPayload = btoa(JSON.stringify({
    ver: 1, fecha: today.toISOString().slice(0, 10),
    cuit: parseInt(cred.cuit),
    ptoVta: cred.punto_venta,
    tipoCmp: req.body.tipo_comprobante,
    nroCmp: numero,
    importe: req.body.importe_total,
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: req.body.doc_tipo || 99,
    nroDocRec: parseInt(req.body.doc_nro || '0'),
    tipoCodAut: 'E',
    codAut: parseInt(data.CAE),
  }));
  const qrUrl = `https://www.afip.gob.ar/fe/qr/?p=${qrPayload}`;

  // 8. Guardar en afip_facturas
  const { data: factura } = await supabaseService.from('afip_facturas').insert({
    tenant_id: auth.tenant_id,
    venta_pos_id: req.body.venta_pos_id,
    tipo_comprobante: req.body.tipo_comprobante,
    punto_venta: cred.punto_venta,
    numero,
    importe_neto: req.body.importe_neto,
    importe_iva: req.body.importe_iva,
    importe_total: req.body.importe_total,
    concepto: req.body.concepto,
    doc_tipo: req.body.doc_tipo,
    doc_nro: req.body.doc_nro,
    cliente_razon_social: req.body.cliente_razon_social,
    cae: data.CAE,
    cae_vence_at: data.CAEFchVto,
    qr_fiscal_url: qrUrl,
    estado: 'aprobada',
    request_uuid: req.body.request_uuid,
    emitida_at: new Date(),
    emitida_por: auth.usuario_id,
  }).select().single();

  return res.json({
    factura_id: factura.id,
    cae: data.CAE,
    cae_vence_at: data.CAEFchVto,
    numero,
    qr_fiscal_url: qrUrl,
    estado: 'aprobada',
    rechazo_motivo: null,
  });
}
```

### 5. Wirea UI: post-cobro botón "Emitir factura"

En `VentaScreen` después de `onCobrado`:

```tsx
{ventaCobrada && (
  <Button onClick={async () => {
    try {
      const { factura_id, cae, numero, qr_fiscal_url } = await emitirFactura({
        tenant_id: venta.tenant_id,
        venta_pos_id: venta.id,
        tipo_comprobante: 6, // Factura B típica
        importe_neto: venta.subtotal - venta.descuento_total,
        importe_iva: 0, // monotributo: 0
        importe_total: venta.total,
        concepto: 1, // productos
        request_uuid: crypto.randomUUID(),
      });
      toast.success(`Factura B #${numero} emitida. CAE: ${cae}`);
      // Imprimir ticket fiscal con QR
      await printer.printReceipt({ ..., cae, qr_afip: qr_fiscal_url });
    } catch (err) {
      toast.error(err.message);
    }
  }}>
    Emitir factura electrónica
  </Button>
)}
```

## Resumen de estado

| Componente | Estado |
|---|---|
| Schema DB (2 tablas) | ✅ Aplicado |
| Cliente JS browser-side | ✅ Listo (`src/lib/afip/`) |
| Tipos TypeScript | ✅ Listo |
| RLS + cert protection | ✅ Listo |
| Pantalla `/configuracion/afip` para cargar creds | ❌ TODO |
| Endpoint server-side `/api/afip-cae` (Vercel o Edge Function) | ❌ TODO — **bloqueado por límite Vercel 12/12** |
| Botón "Emitir factura" en VentaScreen post-cobro | ❌ TODO |
| Soporte impresión QR fiscal en `printer.ts` | ✅ Listo (campo `qr_afip` en `printReceipt`) |
| Validación CUIT, tests, manejo errores AFIP | ❌ TODO |

## Decisiones pendientes (Lucas)

1. **Vercel Pro vs Supabase Edge Functions**: ¿pasamos a Pro o vamos a Edge?
2. **Monotributo o RI**: ¿qué tipo de contribuyente es Neko? (afecta IVA discriminado o no)
3. **Punto de venta**: ¿usamos 1 (default) o tenés multiples PV configurados?
4. **Empezar en testing o producción**: testing primero es OBLIGATORIO antes de prod real.
