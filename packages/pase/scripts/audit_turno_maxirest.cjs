// Auditoría: cierres importados desde Maxirest con turno potencialmente
// incorrecto (cargados como "Mediodía" cuando en el mail decía "Noche").
//
// Bug detectado el 2026-05-04 en ImportarMaxirest.tsx: el parser de turno
// dependía de un regex case-sensitive sobre el header "Turno N (XXX)";
// cuando capturaba el nombre con otra capitalización o el header faltaba,
// caía silenciosamente al default "Mediodía". El parser se reescribió
// para priorizar el campo "Turno: <valor>" y caer a hora de cierre.
//
// Esta auditoría es read-only. Lucas decide si corregir en bulk o uno a uno.
//
// Uso (desde la raíz del repo):
//   1. npx vercel env pull .env.local.tmp --environment=production --yes
//   2. node packages/pase/scripts/audit_turno_maxirest.cjs

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.env.local.tmp'), 'utf8')
  .match(/^POSTGRES_URL_NON_POOLING="?([^"\n]+)"?/m)[1];
// Sanea prefijo basura conocido (ver DEUDA_TECNICA "POSTGRES_URL_NON_POOLING").
const url = raw.startsWith('postgresql://') ? raw : raw.slice(16);

const c = new Client({ connectionString: url });

(async () => {
  await c.connect();

  console.log('=== Q1: cierres maxirest agrupados por turno ===');
  const q1 = await c.query(`
    SELECT turno,
           COUNT(*)                            AS rows,
           COUNT(DISTINCT (fecha, local_id))   AS cierres
      FROM ventas
     WHERE origen = 'maxirest'
     GROUP BY turno
     ORDER BY turno
  `);
  console.table(q1.rows);

  console.log('\n=== Q2: cierres mediodia maxirest últimos 90 días ===');
  const q2 = await c.query(`
    SELECT fecha::text,
           local_id,
           COUNT(*)                       AS medios,
           SUM(monto)::numeric(14, 0)     AS total
      FROM ventas
     WHERE origen = 'maxirest'
       AND turno = 'Mediodía'
       AND fecha > CURRENT_DATE - INTERVAL '90 days'
     GROUP BY fecha, local_id
     ORDER BY fecha DESC, local_id
     LIMIT 200
  `);
  console.log('rows:', q2.rows.length);
  console.table(q2.rows);

  console.log('\n=== Q3: comparación mediodia vs promedio noche del mismo local ===');
  // Heurística: si total mediodia >= prom noche del local → SOSPECHOSO.
  // Si está entre 70%-100% del prom noche → revisar manualmente.
  const q3 = await c.query(`
    WITH cierres AS (
      SELECT fecha, turno, local_id, SUM(monto) AS total
        FROM ventas WHERE origen = 'maxirest'
       GROUP BY fecha, turno, local_id
    ),
    statsN AS (
      SELECT local_id,
             AVG(total)::numeric(14, 0) AS prom_noche,
             COUNT(*)                   AS n_noche
        FROM cierres WHERE turno = 'Noche'
       GROUP BY local_id
    )
    SELECT c.fecha::text,
           c.local_id,
           c.total::numeric(14, 0)         AS total_md,
           COALESCE(s.prom_noche, 0)       AS prom_n,
           COALESCE(s.n_noche, 0)          AS n_n,
           CASE
             WHEN s.prom_noche IS NULL              THEN '-'
             WHEN c.total >= s.prom_noche           THEN 'SOSPECHOSO'
             WHEN c.total >= s.prom_noche * 0.7     THEN 'revisar'
             ELSE                                        'ok'
           END AS flag
      FROM cierres c
      LEFT JOIN statsN s USING (local_id)
     WHERE c.turno = 'Mediodía'
     ORDER BY c.fecha DESC, c.local_id
  `);
  console.table(q3.rows);

  await c.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
