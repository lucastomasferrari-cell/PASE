const{Client}=require('pg');
const c=new Client('postgresql://postgres.pduxydviqiaxfqnshhdc:ai1neEybY9mz547L@aws-1-us-west-2.pooler.supabase.com:5432/postgres');
c.connect().then(async()=>{
  const tid='5841143c-5594-4728-99c6-a313d40618e6', lid=5;

  // ¿Hay Q2 (segunda quincena) de mayo? Puede tener calculado_at en junio
  const q2=await c.query(
    "SELECT e.apellido, l.cuota_num, l.total_a_pagar, l.calculado_at::date as calc "+
    "FROM rrhh_liquidaciones l JOIN rrhh_novedades n ON n.id=l.novedad_id JOIN rrhh_empleados e ON e.id=n.empleado_id "+
    "WHERE l.tenant_id=$1 AND e.local_id=$2 AND l.estado IN ('pendiente','pagado') AND l.anulado=false "+
    "AND n.mes=5 AND n.anio=2026 ORDER BY e.apellido, l.cuota_num", [tid, lid]);
  console.log('TODAS las liquidaciones de MAYO 2026 (por novedad mes=5):');
  let sumQ1=0, sumQ2=0;
  for(const r of q2.rows){
    if(r.cuota_num===1) sumQ1+=Number(r.total_a_pagar);
    else sumQ2+=Number(r.total_a_pagar);
    console.log(`  ${r.apellido} Q${r.cuota_num}: pagar=${r.total_a_pagar} calculado=${r.calc}`);
  }
  console.log(`  TOTAL Q1=${sumQ1} Q2=${sumQ2} TOTAL=${sumQ1+sumQ2}`);

  // ¿Las liquidaciones de Q2 mayo tienen calculado_at en junio?
  const q2j=await c.query(
    "SELECT e.apellido, l.cuota_num, l.total_a_pagar, l.calculado_at::date as calc "+
    "FROM rrhh_liquidaciones l JOIN rrhh_novedades n ON n.id=l.novedad_id JOIN rrhh_empleados e ON e.id=n.empleado_id "+
    "WHERE l.tenant_id=$1 AND e.local_id=$2 AND l.estado IN ('pendiente','pagado') AND l.anulado=false "+
    "AND l.calculado_at BETWEEN '2026-06-01' AND '2026-06-15T23:59:59' "+
    "AND n.mes=5 ORDER BY e.apellido", [tid, lid]);
  if(q2j.rows.length>0){
    console.log('\nQ2 mayo CON calculado_at en junio (NO aparecen en EERR mayo!):');
    let sum=0;
    for(const r of q2j.rows){sum+=Number(r.total_a_pagar);console.log(`  ${r.apellido}: pagar=${r.total_a_pagar} calc=${r.calc}`);}
    console.log(`  TOTAL faltante=${sum}`);
  }

  c.end();
}).catch(e=>{console.error(e.message);c.end();process.exit(1)});
