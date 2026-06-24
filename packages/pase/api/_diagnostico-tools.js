// Catálogo de herramientas (READ-ONLY) del bot de diagnóstico IA.
//
// Cada tool = schema JSON (para que Claude sepa cuándo/cómo usarla) + su
// ejecución en executeTool(). REGLA DE ORO: executeTool valida SIEMPRE que el
// local pedido esté en scope.locales ANTES de consultar. El cliente
// service_role bypassa RLS → el filtro manual por local es la única defensa
// de aislamiento (regla E de CLAUDE.md).
//
// scope = { tenantId, locales: [id, ...] } (lo calcula _diagnostico-scope.js).

const MAX_FILAS = 20;

export const TOOLS = [
  {
    name: 'buscar_gasto',
    description:
      'Busca gastos cargados en un local. Usala cuando alguien dice que cargó un ' +
      'gasto y no lo encuentra, o quiere ubicar un gasto puntual. IMPORTANTE: pedí ' +
      'SIEMPRE el local y al menos un dato más (fecha aproximada o monto aproximado) ' +
      'antes de llamar — no busques a ciegas. Devuelve hasta 20 gastos con fecha, ' +
      'monto, categoría, detalle, cuenta y estado (sirve para detectar fecha futura, ' +
      'estado anulado, local equivocado, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        local_id: { type: 'integer', description: 'ID del local donde buscar (obligatorio).' },
        fecha_desde: { type: 'string', description: 'Fecha mínima, formato YYYY-MM-DD.' },
        fecha_hasta: { type: 'string', description: 'Fecha máxima, formato YYYY-MM-DD.' },
        monto_aprox: { type: 'number', description: 'Monto aproximado del gasto (busca ±5%).' },
        texto: { type: 'string', description: 'Texto a buscar dentro del detalle o la categoría.' },
        incluir_anulados: { type: 'boolean', description: 'Si es true incluye los anulados. Default false.' },
      },
      required: ['local_id'],
    },
  },
];

// Sanea texto libre antes de meterlo en un filtro PostgREST (.or/.ilike):
// saca comas, paréntesis y comodines que podrían alterar la sintaxis del
// filtro. No es SQL (Supabase parametriza), pero evita ensuciar el OR.
function sanearTexto(t) {
  return String(t).replace(/[^\w\sáéíóúüñÁÉÍÓÚÑ.\-]/gi, ' ').trim().slice(0, 80);
}

export async function executeTool(admin, scope, name, input) {
  input = input || {};

  // Defensa en profundidad: el local pedido DEBE estar en los visibles.
  if (input.local_id == null || !scope.locales.includes(input.local_id)) {
    return {
      error: 'LOCAL_FUERA_DE_ALCANCE',
      detalle: 'No tenés acceso a ese local, o no especificaste uno válido.',
    };
  }

  if (name === 'buscar_gasto') {
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

  return { error: 'TOOL_DESCONOCIDA', detalle: `No existe la herramienta '${name}'.` };
}
