const{Client}=require('pg');
const c=new Client('postgresql://postgres.pduxydviqiaxfqnshhdc:ai1neEybY9mz547L@aws-1-us-west-2.pooler.supabase.com:5432/postgres');
c.connect().then(async()=>{
  const tid='5841143c-5594-4728-99c6-a313d40618e6';
  const lid=5;

  // Columnas de rrhh_liquidaciones
  const cols=await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='rrhh_liquidaciones' ORDER BY ordinal_position");
  console.log('Columnas liquidaciones:', cols.rows.map(r=>r.column_name).join(', '));

  // Liquidaciones con detalle
  const liq=await c.query("SELECT l.id, e.apellido, l.total_a_pagar, l.total_adelantos FROM rrhh_liquidaciones l JOIN rrhh_novedades n ON n.id=l.novedad_id JOIN rrhh_empleados e ON e.id=n.empleado_id WHERE l.tenant_id=$1 AND e.local_id=$2 AND l.estado IN ('pendiente','pagado') AND l.anulado=false AND l.calculado_at BETWEEN '2026-05-01T00:00:00' AND '2026-05-31T23:59:59' ORDER BY e.apellido",[tid,lid]);
  let sumPagar=0, sumAdel=0;
  for(const r of liq.rows){
    sumPagar+=Number(r.total_a_pagar);
    sumAdel+=Number(r.total_adelantos||0);
    console.log(`  ${r.apellido}: pagar=${r.total_a_pagar} adelantos=${r.total_adelantos}`);
  }
  console.log(`  TOTAL: pagar=${sumPagar} adelantos=${sumAdel} bruto_impl=${sumPagar+sumAdel}`);

  // Alquiler
  const alq=await c.query("SELECT categoria, SUM(monto) as total FROM gastos WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31' AND (estado IS NULL OR estado<>'anulado') AND (LOWER(categoria) LIKE '%alquiler%' OR LOWER(categoria) LIKE '%rent%') GROUP BY categoria",[tid,lid]);
  console.log('ALQUILER:', alq.rows.length ? JSON.stringify(alq.rows) : 'NO HAY');

  // Todos los tipos
  const tipos=await c.query("SELECT DISTINCT tipo FROM gastos WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31' AND (estado IS NULL OR estado<>'anulado')",[tid,lid]);
  console.log('Tipos gasto:', tipos.rows.map(r=>r.tipo));

  c.end();
}).catch(e=>{console.error(e.message);c.end();process.exit(1)});
