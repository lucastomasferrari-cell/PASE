export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars',
      });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Traer todos los locales con credenciales MP activas
    const { data: creds, error: credsError } = await db
      .from('mp_credenciales')
      .select('*, locales(nombre)')
      .eq('activo', true);

    if (credsError) {
      console.error('mp-sync: error fetching credentials', credsError);
      return res.status(500).json({ ok: false, error: credsError.message });
    }

    if (!creds || creds.length === 0) {
      return res.status(200).json({ message: 'Sin credenciales configuradas' });
    }

    const resultados = [];

    for (const cred of creds) {
      try {
        // Traer pagos de los últimos 7 días
        const hasta = new Date();
        const desde = new Date();
        desde.setDate(desde.getDate() - 7);
        const beginDate = desde.toISOString();
        const endDate = hasta.toISOString();

        const mpUrl =
          `https://api.mercadopago.com/v1/payments/search?` +
          `begin_date=${encodeURIComponent(beginDate)}` +
          `&end_date=${encodeURIComponent(endDate)}` +
          `&sort=date_created&criteria=desc`;

        const mpRes = await fetch(mpUrl, {
          headers: { Authorization: `Bearer ${cred.access_token}` },
        });
        const mpData = await mpRes.json();

        if (!mpRes.ok) {
          resultados.push({
            local: cred.locales?.nombre,
            error: `MP API ${mpRes.status}: ${mpData?.message || 'error'}`,
          });
          continue;
        }

        if (mpData.results) {
          for (const mov of mpData.results) {
            await db.from('mp_movimientos').upsert(
              [
                {
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
                },
              ],
              { onConflict: 'id' }
            );
          }
        }

        // Actualizar timestamp de última sync
        await db
          .from('mp_credenciales')
          .update({ ultima_sync: new Date().toISOString() })
          .eq('local_id', cred.local_id);

        resultados.push({
          local: cred.locales?.nombre,
          movimientos: mpData.results?.length || 0,
        });
      } catch (err) {
        console.error('mp-sync: error processing credential', cred?.local_id, err);
        resultados.push({ local: cred.locales?.nombre, error: err.message });
      }
    }

    return res.status(200).json({ ok: true, resultados });
  } catch (err) {
    console.error('mp-sync: unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
