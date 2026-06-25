// One-off: contrato de los 9 wrappers contra prod (equivalente a spec 43-A).
// IDs inexistentes → esperado P0001 (negocio). Nunca 42883/PGRST202/42501.
const fs = require('fs');
const env = Object.fromEntries(
  fs.readFileSync('.env.local.tmp', 'utf8').split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '').trim()]),
);
const url = 'https://pduxydviqiaxfqnshhdc.supabase.co';
const key = env.SUPABASE_SERVICE_KEY;
const NX = 999999999, NXU = '00000000-0000-0000-0000-00000000e2e1';

const PROBES = [
  ['fn_anular_venta_comanda_offline', { p_venta_id: NX, p_venta_idempotency_uuid: NXU, p_manager_id: null, p_motivo: 'probe', p_idempotency_uuid: null, p_idempotency_key: null }],
  ['fn_anular_item_comanda_offline', { p_item_id: NX, p_item_idempotency_uuid: NXU, p_manager_id: null, p_motivo: 'probe', p_idempotency_uuid: null, p_idempotency_key: null }],
  ['fn_cortesia_item_comanda_offline', { p_item_id: NX, p_item_idempotency_uuid: NXU, p_manager_id: null, p_motivo: 'probe', p_idempotency_uuid: null, p_idempotency_key: null }],
  ['fn_modificar_precio_item_comanda_offline', { p_item_id: NX, p_item_idempotency_uuid: NXU, p_precio_nuevo: 1, p_manager_id: null, p_motivo: 'probe', p_idempotency_uuid: null, p_idempotency_key: null }],
  ['fn_cobrar_venta_comanda_offline', { p_venta_id: NX, p_venta_idempotency_uuid: NXU, p_pagos: [], p_propina: 0, p_cobrado_por: null, p_idempotency_uuid: null, p_idempotency_key: null }],
  ['fn_aplicar_descuento_comanda_offline', { p_venta_id: NX, p_venta_idempotency_uuid: NXU, p_monto: 1, p_motivo: 'probe', p_manager_id: null, p_idempotency_uuid: null, p_idempotency_key: null }],
  ['fn_transferir_mesa_comanda_offline', { p_venta_id: NX, p_venta_idempotency_uuid: NXU, p_mesa_destino_id: NX, p_manager_id: null, p_motivo: 'probe', p_idempotency_uuid: null, p_idempotency_key: null }],
  ['fn_unir_mesas_comanda_offline', { p_venta_destino_id: NX, p_venta_destino_idempotency_uuid: NXU, p_venta_origen_id: NX, p_venta_origen_idempotency_uuid: NXU, p_manager_id: null, p_motivo: 'probe', p_idempotency_uuid: null, p_idempotency_key: null }],
  ['fn_partir_cuenta_comanda_offline', { p_venta_original_id: NX, p_venta_original_idempotency_uuid: NXU, p_item_ids: [NX], p_manager_id: null, p_motivo: 'probe', p_idempotency_uuid: null, p_idempotency_key: null }],
];

(async () => {
  let fallas = 0;
  for (const [fn, args] of PROBES) {
    const res = await fetch(url + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await res.text();
    let code = '';
    try { code = JSON.parse(body).code || ''; } catch { /* */ }
    const ok = code === 'P0001';
    if (!ok) fallas++;
    console.log((ok ? 'OK  ' : 'FAIL') + ' ' + fn + ' → ' + res.status + ' ' + code + (ok ? '' : ' ' + body.slice(0, 120)));
  }
  console.log(fallas === 0 ? '\nCONTRATO OK: los 9 llegan a error de negocio' : `\n${fallas} FALLAS`);
  process.exit(fallas === 0 ? 0 : 1);
})();
