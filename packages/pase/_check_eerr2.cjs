const{Client}=require('pg');
const c=new Client('postgresql://postgres.pduxydviqiaxfqnshhdc:ai1neEybY9mz547L@aws-1-us-west-2.pooler.supabase.com:5432/postgres');
c.connect().then(async()=>{
  const tid='5841143c-5594-4728-99c6-a313d40618e6';
  const lid=5;

  // Gastos tipo "empleado" — no son fijo/variable/publicidad/comision/impuesto/retiro_socio
  // ¿se están contando en ALGÚN bucket del EERR?
  const emp=await c.query("SELECT categoria, SUM(monto) as total, COUNT(*) as n FROM gastos WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31' AND (estado IS NULL OR estado<>'anulado') AND tipo='empleado' GROUP BY categoria",[tid,lid]);
  console.log('GASTOS tipo=empleado (NO cuentan en ningún bucket EERR):', JSON.stringify(emp.rows));

  // Verificar: ¿las liquidaciones ya descuentan adelantos del total_a_pagar?
  const liq=await c.query("SELECT l.id, e.apellido, l.total_a_pagar, l.neto, l.total_adelantos FROM rrhh_liquidaciones l JOIN rrhh_novedades n ON n.id=l.novedad_id JOIN rrhh_empleados e ON e.id=n.empleado_id WHERE l.tenant_id=$1 AND e.local_id=$2 AND l.estado IN ('pendiente','pagado') AND l.anulado=false AND l.calculado_at BETWEEN '2026-05-01T00:00:00' AND '2026-05-31T23:59:59' ORDER BY e.apellido LIMIT 20",[tid,lid]);
  console.log('LIQUIDACIONES detalle (total_a_pagar, neto, total_adelantos):');
  for(const r of liq.rows) console.log(`  ${r.apellido}: pagar=${r.total_a_pagar} neto=${r.neto} adelantos=${r.total_adelantos}`);

  // ¿Hay alquiler?
  const alq=await c.query("SELECT categoria, SUM(monto) as total FROM gastos WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31' AND (estado IS NULL OR estado<>'anulado') AND (LOWER(categoria) LIKE '%alquiler%' OR LOWER(categoria) LIKE '%rent%') GROUP BY categoria",[tid,lid]);
  console.log('ALQUILER/RENT:', alq.rows.length ? JSON.stringify(alq.rows) : 'NO HAY');

  // Todos los tipos de gastos que existen
  const tipos=await c.query("SELECT DISTINCT tipo FROM gastos WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31' AND (estado IS NULL OR estado<>'anulado')",[tid,lid]);
  console.log('Tipos de gasto existentes:', tipos.rows.map(r=>r.tipo));

  c.end();
}).catch(e=>{console.error(e.message);c.end();process.exit(1)});
