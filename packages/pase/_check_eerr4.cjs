const{Client}=require('pg');
const c=new Client('postgresql://postgres.pduxydviqiaxfqnshhdc:ai1neEybY9mz547L@aws-1-us-west-2.pooler.supabase.com:5432/postgres');
c.connect().then(async()=>{
  const tid='5841143c-5594-4728-99c6-a313d40618e6', lid=5;

  const liq=await c.query(
    "SELECT e.apellido, l.sueldo_base, l.adelantos, l.total_a_pagar, l.cuota_num "+
    "FROM rrhh_liquidaciones l JOIN rrhh_novedades n ON n.id=l.novedad_id JOIN rrhh_empleados e ON e.id=n.empleado_id "+
    "WHERE l.tenant_id=$1 AND e.local_id=$2 AND l.estado IN ('pendiente','pagado') AND l.anulado=false "+
    "AND l.calculado_at BETWEEN '2026-05-01' AND '2026-05-31T23:59:59' ORDER BY e.apellido", [tid, lid]);
  let sb=0, ad=0, tp=0;
  for(const r of liq.rows){
    sb+=Number(r.sueldo_base); ad+=Number(r.adelantos||0); tp+=Number(r.total_a_pagar);
    console.log(`${r.apellido} Q${r.cuota_num}: base=${r.sueldo_base} adel=${r.adelantos} pagar=${r.total_a_pagar}`);
  }
  console.log(`TOTAL: base=${sb} adel=${ad} pagar=${tp} bruto_real=${tp+ad}`);

  // Alquiler - buscar en todas las categorías
  const cats=await c.query(
    "SELECT DISTINCT categoria FROM gastos WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31' AND (estado IS NULL OR estado<>'anulado') ORDER BY categoria", [tid, lid]);
  console.log('\nTodas las categorías de gasto mayo:', cats.rows.map(r=>r.categoria).join(', '));

  c.end();
}).catch(e=>{console.error(e.message);c.end();process.exit(1)});
