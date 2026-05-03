// Bearer auth para endpoints disparados por cron externo (GitHub Actions,
// cron-job.org legacy). Si la env var CRON_BEARER NO está seteada, NO
// valida — backwards compat para que cron-job.org siga funcionando hasta
// que el switch a GH Actions termine y CRON_BEARER se configure en Vercel.
//
// Uso:
//   import { checkCronAuth } from './_cron-auth.js';
//   export default async function handler(req, res) {
//     if (!checkCronAuth(req, res)) return;  // ← responde 401 y returns false
//     ... resto del handler
//   }
//
// Setup (orden importa):
//   1. Configurar MP_CRON_BEARER en GitHub Settings → Secrets → Actions.
//   2. Verificar GH Actions corre OK con workflow_dispatch (sin Bearer aún).
//   3. Setear CRON_BEARER en Vercel Environment Variables (mismo valor que GH).
//   4. Desactivar cron-job.org (ahora 401 sobre los endpoints).

export function checkCronAuth(req, res) {
  const expected = process.env.CRON_BEARER;
  if (!expected) return true;  // backwards compat — ver doc arriba
  const got = req.headers?.authorization || '';
  if (got !== `Bearer ${expected}`) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}
