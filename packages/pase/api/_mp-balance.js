// Helper compartido para obtener el saldo real de la cuenta MP desde la
// API. Lo usan mp-process.js y mp-sync.js después de procesar el CSV
// del release_report (PARTE B de TASK 0.11).
//
// Endpoint: GET /users/{accountId}/mercadopago_account/balance
// HOST: api.mercadolibre.com (la cuenta MP/ML vive en el host ML por
// herencia histórica — el path no resuelve en api.mercadopago.com).
//
// Si el caller pasa un accountId ya resuelto, lo usa directo. Si no,
// el helper lo resuelve internamente vía GET /users/me (mismo host ML).
//
// Devuelve { available, total, unavailable, accountId, raw } o lanza
// Error con status + body de la respuesta de MP para que el log del
// caller cuente exactamente qué pasó. El caller debe envolver en
// try/catch — un fallo en balance NO debe abortar el resto del sync.

export async function fetchMpBalance(token, accountIdHint) {
  if (!token) throw new Error('token requerido');

  // Resolver accountId si no vino del caller. /users/me en api.mercadolibre.com
  // es el endpoint canónico para el id del owner del token.
  let accountId = accountIdHint;
  if (!accountId) {
    const meRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) {
      const body = (await meRes.text()).slice(0, 200);
      throw new Error(`/users/me ${meRes.status}: ${body}`);
    }
    const me = await meRes.json();
    accountId = me?.id;
    if (!accountId) throw new Error('/users/me sin id en respuesta');
  }

  const url = `https://api.mercadolibre.com/users/${encodeURIComponent(accountId)}/mercadopago_account/balance`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`MP balance ${res.status} accountId=${accountId}: ${body}`);
  }
  const data = await res.json();
  return {
    available: Number(data.available_balance) || 0,
    total: Number(data.total_amount) || 0,
    unavailable: Number(data.unavailable_balance) || 0,
    accountId,
    raw: data,
  };
}
