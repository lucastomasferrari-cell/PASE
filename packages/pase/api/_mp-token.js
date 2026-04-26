// Helper compartido para obtener el token de MP desencriptado vía la
// RPC get_mp_token (definida en
// supabase/migrations/202604261246_encriptar_mp_token_part_a.sql).
//
// Lo usan mp-sync.js, mp-process.js y mp-generate.js para evitar leer
// la columna plana de mp_credenciales.
//
// `createMpTokenGetter(db)` devuelve una función con cache propio
// scoped al closure — es decir, vive sólo durante el handler. Cero
// estado de módulo entre invocaciones; el cache evita las N llamadas
// repetidas a la RPC dentro de un mismo run.

export function createMpTokenGetter(db) {
  const cache = new Map();
  return async function getMpToken(credencialId) {
    if (cache.has(credencialId)) return cache.get(credencialId);
    const { data, error } = await db.rpc('get_mp_token', {
      p_credencial_id: credencialId,
    });
    if (error) throw new Error(`get_mp_token(${credencialId}): ${error.message}`);
    if (!data) throw new Error(`get_mp_token(${credencialId}): token vacío`);
    cache.set(credencialId, data);
    return data;
  };
}
