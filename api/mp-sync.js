export default async function handler(req, res) {
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Traer todos los locales con credenciales MP activas
  const { data: creds } = await db.from('mp_credenciales')
    .select('*, locales(nombre)')
    .eq('activo', true);

  if (!creds || creds.length === 0) {
    return res.status(200).json({ message: 'Sin credenciales configuradas' });
  }

  const resultados = [];

  for (const cred of creds) {
    try {
      // Traer movimientos de los últimos 7 días
      const desde = new Date();
      desde.setDate(desde.getDate() - 7);
      const desdeISO = desde.toISOString();

      const mpRes = await fetch(
        `https://api.mercadopago.com/v1/account/movements/search?begin_date=${desdeISO}&limit=100`,
        { headers: { Authorization: `Bearer ${cred.access_token}` } }
      );
      const mpData = await mpRes.json();

      if (mpData.results) {
        for (const mov of mpData.results) {
          await db.from('mp_movimientos').upsert([{
            id: String(mov.id),
            local_id: cred.local_id,
            fecha: mov.date_created,
            tipo: mov.type,
            descripcion: mov.description || mov.reason || mov.type,
            monto: mov.amount,
            saldo: mov.balance,
            estado: mov.status,
            referencia_id: String(mov.source_id || ''),
            medio_pago: mov.payment_method_id || null,
          }], { onConflict: 'id' });
        }
      }

      // Actualizar timestamp de última sync
      await db.from('mp_credenciales')
        .update({ ultima_sync: new Date().toISOString() })
        .eq('local_id', cred.local_id);

      resultados.push({ local: cred.locales?.nombre, movimientos: mpData.results?.length || 0 });
    } catch (err) {
      resultados.push({ local: cred.locales?.nombre, error: err.message });
    }
  }

  res.status(200).json({ ok: true, resultados });
}
