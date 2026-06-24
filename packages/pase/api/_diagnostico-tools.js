// Catálogo de herramientas (READ-ONLY) del bot de diagnóstico IA.
//
// Cada tool = schema JSON (para que Claude sepa cuándo/cómo usarla) + su
// ejecución en executeTool(). REGLA DE ORO: cada tool valida que el local
// pedido (o el del registro encontrado) esté en scope.locales ANTES de
// devolver datos. El cliente service_role bypassa RLS → el filtro manual por
// local es la única defensa de aislamiento (regla E de CLAUDE.md).
//
// scope = { tenantId, locales: [id, ...] } (lo calcula _diagnostico-scope.js).

const MAX_FILAS = 20;
const FUERA = {
  error: 'LOCAL_FUERA_DE_ALCANCE',
  detalle: 'No tenés acceso a ese local, o no especificaste uno válido.',
};

export const TOOLS = [
  {
    name: 'buscar_gasto',
    description:
      'Busca gastos cargados en un local. Usala cuando alguien dice que cargó un ' +
      'gasto y no lo encuentra, o quiere ubicar un gasto puntual. Pedí SIEMPRE el ' +
      'local y al menos un dato más (fecha aprox o monto aprox) antes de llamar. ' +
      'Devuelve hasta 20 gastos con fecha, monto, categoría, detalle, cuenta y estado.',
    input_schema: {
      type: 'object',
      properties: {
        local_id: { type: 'integer', description: 'ID del local (obligatorio).' },
        fecha_desde: { type: 'string', description: 'Fecha mínima YYYY-MM-DD.' },
        fecha_hasta: { type: 'string', description: 'Fecha máxima YYYY-MM-DD.' },
        monto_aprox: { type: 'number', description: 'Monto aproximado (±5%).' },
        texto: { type: 'string', description: 'Texto a buscar en detalle o categoría.' },
        incluir_anulados: { type: 'boolean', description: 'Incluir anulados. Default false.' },
      },
      required: ['local_id'],
    },
  },
  {
    name: 'buscar_movimiento',
    description:
      'Busca movimientos de caja (ingresos, egresos, pagos, cobros, transferencias) ' +
      'en un local. Usala para "no encuentro un pago/ingreso/cobro", o para ver el ' +
      'movimiento de plata que generó un gasto/factura/sueldo. Pedí local + al menos ' +
      'un dato más (fecha aprox o monto aprox). Los egresos tienen importe negativo.',
    input_schema: {
      type: 'object',
      properties: {
        local_id: { type: 'integer', description: 'ID del local (obligatorio).' },
        fecha_desde: { type: 'string', description: 'Fecha mínima YYYY-MM-DD.' },
        fecha_hasta: { type: 'string', description: 'Fecha máxima YYYY-MM-DD.' },
        monto_aprox: { type: 'number', description: 'Monto aproximado en magnitud (matchea + o -, ±5%).' },
        cuenta: { type: 'string', description: 'Filtrar por cuenta exacta (ej: "Caja Efectivo", "MercadoPago").' },
        texto: { type: 'string', description: 'Texto a buscar en el detalle.' },
        incluir_anulados: { type: 'boolean', description: 'Incluir anulados. Default false.' },
      },
      required: ['local_id'],
    },
  },
  {
    name: 'saldo_cuentas',
    description:
      'Devuelve el saldo actual de cada cuenta (Efectivo, MercadoPago, Banco, etc.) ' +
      'de un local. Usala para "la caja no me cuadra" o "cuánto tengo en tal cuenta". ' +
      'Para entender una diferencia, combinala con buscar_movimiento de esa cuenta.',
    input_schema: {
      type: 'object',
      properties: {
        local_id: { type: 'integer', description: 'ID del local (obligatorio).' },
      },
      required: ['local_id'],
    },
  },
  {
    name: 'buscar_factura',
    description:
      'Busca facturas de proveedores en un local. Usala para "no encuentro una factura" ' +
      'o "qué le debo a tal proveedor". Pedí local + (proveedor / fecha aprox / monto aprox). ' +
      'Devuelve nro, fecha, total, categoría, estado, tipo y el nombre del proveedor.',
    input_schema: {
      type: 'object',
      properties: {
        local_id: { type: 'integer', description: 'ID del local (obligatorio).' },
        proveedor: { type: 'string', description: 'Nombre (o parte) del proveedor.' },
        fecha_desde: { type: 'string', description: 'Fecha mínima YYYY-MM-DD.' },
        fecha_hasta: { type: 'string', description: 'Fecha máxima YYYY-MM-DD.' },
        monto_aprox: { type: 'number', description: 'Total aproximado (±5%).' },
        estado: { type: 'string', description: 'Filtrar por estado (ej: "pendiente", "pagada").' },
        incluir_anuladas: { type: 'boolean', description: 'Incluir anuladas. Default false.' },
      },
      required: ['local_id'],
    },
  },
  {
    name: 'detalle_registro',
    description:
      'Trae TODOS los campos de un registro puntual por su id, cuando ya lo identificaste ' +
      'con otra herramienta y querés ver el detalle completo (fecha de carga vs fecha del ' +
      'hecho, estado, vínculos, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['gasto', 'factura', 'movimiento'], description: 'Tipo de registro.' },
        id: { type: 'string', description: 'ID del registro.' },
      },
      required: ['tipo', 'id'],
    },
  },
  {
    name: 'desglose_categoria',
    description:
      'Desglosa los gastos y facturas de un local en un mes, agrupados por categoría — para ' +
      '"por qué este total no cuadra" o "qué compone los $X de tal rubro". Sin categoría ' +
      'devuelve el total de cada categoría; con una categoría lista los gastos y facturas ' +
      'individuales. (No incluye ventas ni sueldos todavía — para esos, guiá a Reportes/Equipo.)',
    input_schema: {
      type: 'object',
      properties: {
        local_id: { type: 'integer', description: 'ID del local (obligatorio).' },
        mes: { type: 'string', description: 'Mes en formato YYYY-MM (obligatorio).' },
        categoria: { type: 'string', description: 'Categoría a detallar (opcional).' },
      },
      required: ['local_id', 'mes'],
    },
  },
  {
    name: 'estado_empleado',
    description:
      'Estado de un empleado: legajo (sueldo declarado, antigüedad), adelantos recientes y ' +
      'pagos especiales (aguinaldo, vacaciones, liquidación final). Usala para "no le figura ' +
      'el aguinaldo/adelanto a tal empleado". Pedí nombre del empleado + local. (Las ' +
      'liquidaciones de sueldo mensual todavía no están acá — para eso guiá a Equipo.)',
    input_schema: {
      type: 'object',
      properties: {
        local_id: { type: 'integer', description: 'ID del local (obligatorio).' },
        nombre: { type: 'string', description: 'Nombre o apellido del empleado (obligatorio).' },
      },
      required: ['local_id', 'nombre'],
    },
  },
];

// Sanea texto libre antes de meterlo en un filtro PostgREST (.or/.ilike):
// saca comas, paréntesis y comodines que podrían alterar la sintaxis del filtro.
function sanearTexto(t) {
  return String(t).replace(/[^\w\sáéíóúüñÁÉÍÓÚÑ.\-]/gi, ' ').trim().slice(0, 80);
}

// Convierte "YYYY-MM" en { desde, hastaExcl } (primer día del mes y primer día
// del mes siguiente, para filtrar fecha con gte/lt). null si el formato es malo.
function mesBounds(mes) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mes || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  return { desde: `${m[1]}-${m[2]}-01`, hastaExcl: `${ny}-${String(nm).padStart(2, '0')}-01` };
}

// Resuelve prov_id → nombre para un set de facturas (segunda query, evita
// depender del nombre del FK en un embedded select).
async function adjuntarProveedores(admin, filas) {
  const ids = [...new Set(filas.map((f) => f.prov_id).filter((x) => x != null))];
  if (!ids.length) return filas;
  const { data } = await admin.from('proveedores').select('id, nombre').in('id', ids);
  const map = new Map((data || []).map((p) => [p.id, p.nombre]));
  return filas.map((f) => ({ ...f, proveedor: map.get(f.prov_id) ?? null }));
}

export async function executeTool(admin, scope, name, input) {
  input = input || {};
  const enScope = (lid) => lid != null && scope.locales.includes(lid);

  if (name === 'buscar_gasto') {
    if (!enScope(input.local_id)) return FUERA;
    let q = admin
      .from('gastos')
      .select('id, fecha, monto, categoria, subcategoria, detalle, cuenta, estado')
      .eq('local_id', input.local_id)
      .order('fecha', { ascending: false })
      .limit(MAX_FILAS);
    if (input.fecha_desde) q = q.gte('fecha', input.fecha_desde);
    if (input.fecha_hasta) q = q.lte('fecha', input.fecha_hasta);
    if (typeof input.monto_aprox === 'number') {
      const tol = Math.max(Math.abs(input.monto_aprox) * 0.05, 100);
      q = q.gte('monto', input.monto_aprox - tol).lte('monto', input.monto_aprox + tol);
    }
    if (input.texto) {
      const t = sanearTexto(input.texto);
      if (t) q = q.or(`detalle.ilike.%${t}%,categoria.ilike.%${t}%`);
    }
    if (!input.incluir_anulados) q = q.or('estado.neq.anulado,estado.is.null');
    const { data, error } = await q;
    if (error) return { error: 'QUERY_FALLO', detalle: error.message };
    return { filas: data || [], truncado: (data || []).length >= MAX_FILAS };
  }

  if (name === 'buscar_movimiento') {
    if (!enScope(input.local_id)) return FUERA;
    let q = admin
      .from('movimientos')
      .select('id, fecha, cuenta, tipo, cat, importe, detalle, anulado')
      .eq('local_id', input.local_id)
      .order('fecha', { ascending: false })
      .limit(MAX_FILAS);
    if (input.fecha_desde) q = q.gte('fecha', input.fecha_desde);
    if (input.fecha_hasta) q = q.lte('fecha', input.fecha_hasta);
    if (typeof input.monto_aprox === 'number') {
      const mag = Math.abs(input.monto_aprox);
      const tol = Math.max(mag * 0.05, 100);
      const lo = mag - tol, hi = mag + tol;
      // Matchea importe ≈ +mag o ≈ -mag (egresos son negativos). Valores
      // numéricos → sin riesgo de inyección en el filtro.
      q = q.or(`and(importe.gte.${lo},importe.lte.${hi}),and(importe.gte.${-hi},importe.lte.${-lo})`);
    }
    if (input.cuenta) q = q.eq('cuenta', input.cuenta);
    if (input.texto) {
      const t = sanearTexto(input.texto);
      if (t) q = q.ilike('detalle', `%${t}%`);
    }
    if (!input.incluir_anulados) q = q.eq('anulado', false);
    const { data, error } = await q;
    if (error) return { error: 'QUERY_FALLO', detalle: error.message };
    return { filas: data || [], truncado: (data || []).length >= MAX_FILAS };
  }

  if (name === 'saldo_cuentas') {
    if (!enScope(input.local_id)) return FUERA;
    const { data, error } = await admin
      .from('saldos_caja')
      .select('cuenta, saldo')
      .eq('local_id', input.local_id)
      .order('cuenta', { ascending: true });
    if (error) return { error: 'QUERY_FALLO', detalle: error.message };
    return { cuentas: data || [] };
  }

  if (name === 'buscar_factura') {
    if (!enScope(input.local_id)) return FUERA;
    // Si filtra por proveedor, primero resolvemos los prov_id por nombre.
    let provIds = null;
    if (input.proveedor) {
      const t = sanearTexto(input.proveedor);
      if (t) {
        const { data: provs } = await admin.from('proveedores').select('id').ilike('nombre', `%${t}%`);
        provIds = (provs || []).map((p) => p.id);
        if (!provIds.length) return { filas: [], truncado: false, nota: 'No hay proveedor que coincida con ese nombre.' };
      }
    }
    let q = admin
      .from('facturas')
      .select('id, nro, fecha, total, neto, cat, estado, tipo, prov_id')
      .eq('local_id', input.local_id)
      .order('fecha', { ascending: false })
      .limit(MAX_FILAS);
    if (provIds) q = q.in('prov_id', provIds);
    if (input.fecha_desde) q = q.gte('fecha', input.fecha_desde);
    if (input.fecha_hasta) q = q.lte('fecha', input.fecha_hasta);
    if (typeof input.monto_aprox === 'number') {
      const tol = Math.max(Math.abs(input.monto_aprox) * 0.05, 100);
      q = q.gte('total', input.monto_aprox - tol).lte('total', input.monto_aprox + tol);
    }
    if (input.estado) q = q.eq('estado', input.estado);
    else if (!input.incluir_anuladas) q = q.or('estado.neq.anulada,estado.is.null');
    const { data, error } = await q;
    if (error) return { error: 'QUERY_FALLO', detalle: error.message };
    const filas = await adjuntarProveedores(admin, data || []);
    return { filas, truncado: filas.length >= MAX_FILAS };
  }

  if (name === 'detalle_registro') {
    const tabla = { gasto: 'gastos', factura: 'facturas', movimiento: 'movimientos' }[input.tipo];
    if (!tabla) return { error: 'TIPO_INVALIDO', detalle: 'tipo debe ser gasto, factura o movimiento.' };
    if (input.id == null) return { error: 'FALTA_ID' };
    const { data, error } = await admin.from(tabla).select('*').eq('id', input.id).limit(1).maybeSingle();
    if (error) return { error: 'QUERY_FALLO', detalle: error.message };
    if (!data) return { error: 'NO_ENCONTRADO', detalle: 'No hay un registro con ese id.' };
    // El registro existe: validamos que su local esté en el alcance del usuario.
    if (!enScope(data.local_id)) return FUERA;
    return { registro: data };
  }

  if (name === 'desglose_categoria') {
    if (!enScope(input.local_id)) return FUERA;
    const b = mesBounds(input.mes);
    if (!b) return { error: 'MES_INVALIDO', detalle: 'mes debe tener formato "YYYY-MM".' };
    const cat = input.categoria ? sanearTexto(input.categoria) : null;

    let gq = admin.from('gastos')
      .select('id, fecha, monto, categoria, detalle, cuenta, estado')
      .eq('local_id', input.local_id).gte('fecha', b.desde).lt('fecha', b.hastaExcl)
      .or('estado.neq.anulado,estado.is.null').limit(200);
    if (cat) gq = gq.eq('categoria', cat);
    let fq = admin.from('facturas')
      .select('id, nro, fecha, total, cat, estado, prov_id')
      .eq('local_id', input.local_id).gte('fecha', b.desde).lt('fecha', b.hastaExcl)
      .or('estado.neq.anulada,estado.is.null').limit(200);
    if (cat) fq = fq.eq('cat', cat);
    const [gr, fr] = await Promise.all([gq, fq]);
    if (gr.error || fr.error) return { error: 'QUERY_FALLO', detalle: (gr.error || fr.error).message };
    const gastos = gr.data || [];
    const facturas = fr.data || [];

    if (cat) {
      const facs = await adjuntarProveedores(admin, facturas);
      const totG = gastos.reduce((s, x) => s + Number(x.monto || 0), 0);
      const totF = facs.reduce((s, x) => s + Number(x.total || 0), 0);
      return { mes: input.mes, categoria: cat, total: totG + totF, total_gastos: totG, total_facturas: totF, gastos, facturas: facs };
    }
    const map = new Map();
    const sumar = (k, campo, val) => {
      const key = k || 'SIN CATEGORÍA';
      const e = map.get(key) || { categoria: key, gastos: 0, facturas: 0, total: 0 };
      e[campo] += Number(val || 0); e.total += Number(val || 0); map.set(key, e);
    };
    for (const g of gastos) sumar(g.categoria, 'gastos', g.monto);
    for (const f of facturas) sumar(f.cat, 'facturas', f.total);
    const por_categoria = [...map.values()].sort((a, c) => c.total - a.total);
    return { mes: input.mes, total: por_categoria.reduce((s, x) => s + x.total, 0), por_categoria };
  }

  if (name === 'estado_empleado') {
    if (!enScope(input.local_id)) return FUERA;
    const t = input.nombre ? sanearTexto(input.nombre) : '';
    let eq = admin.from('rrhh_empleados')
      .select('id, nombre, apellido, puesto, activo, sueldo_mensual, fecha_inicio, local_id')
      .in('local_id', scope.locales).limit(5);
    if (t) eq = eq.or(`nombre.ilike.%${t}%,apellido.ilike.%${t}%`);
    const { data: emps, error: ee } = await eq;
    if (ee) return { error: 'QUERY_FALLO', detalle: ee.message };
    if (!emps || !emps.length) return { empleados: [], nota: 'No encontré un empleado con ese nombre en tus locales.' };
    const out = [];
    for (const emp of emps) {
      const [adel, esp] = await Promise.all([
        admin.from('rrhh_adelantos').select('*').eq('empleado_id', emp.id).order('fecha', { ascending: false }).limit(10),
        admin.from('rrhh_pagos_especiales').select('*').eq('empleado_id', emp.id).order('pagado_at', { ascending: false }).limit(10),
      ]);
      out.push({ ...emp, adelantos: adel.data || [], pagos_especiales: esp.data || [] });
    }
    return { empleados: out };
  }

  return { error: 'TOOL_DESCONOCIDA', detalle: `No existe la herramienta '${name}'.` };
}
