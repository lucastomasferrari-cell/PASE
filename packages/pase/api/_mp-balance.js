// Helper compartido para obtener el saldo real de la cuenta MP desde la
// API. Lo usan mp-process.js y mp-sync.js después de procesar el CSV
// del release_report (PARTE B de TASK 0.11).
//
// Endpoint: GET /users/{accountId}/mercadopago_account/balance
// El accountId se obtiene previamente con resolverAccountId() (ya
// implementado en mp-process.js / mp-sync.js).
//
// Devuelve { available, total, unavailable, raw } o lanza Error con el
// status y body de la respuesta de MP. El caller debe envolver en
// try/catch — un fallo en balance NO debe abortar el resto del sync.

export async function fetchMpBalance(token, accountId) {
  if (!token) throw new Error('token requerido');
  if (!accountId) throw new Error('accountId requerido');
  const url = `https://api.mercadopago.com/users/${encodeURIComponent(accountId)}/mercadopago_account/balance`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`MP balance ${res.status}: ${body}`);
  }
  const data = await res.json();
  return {
    available: Number(data.available_balance) || 0,
    total: Number(data.total_amount) || 0,
    unavailable: Number(data.unavailable_balance) || 0,
    raw: data,
  };
}
