const{Client}=require('pg');
const c=new Client('postgresql://postgres.pduxydviqiaxfqnshhdc:ai1neEybY9mz547L@aws-1-us-west-2.pooler.supabase.com:5432/postgres');
c.connect().then(async()=>{
  const t=await c.query("SELECT id, tenant_id FROM locales WHERE nombre ILIKE '%rene%cantina%' LIMIT 3");
  console.log('Locales Rene:', JSON.stringify(t.rows));
  if(t.rows.length===0){c.end();return;}
  const tid=t.rows[0].tenant_id;
  const lid=t.rows[0].id;
  console.log('tenant_id=',tid,'local_id=',lid);

  const v=await c.query("SELECT SUM(monto) as total, COUNT(*) as n FROM ventas WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31'",[tid,lid]);
  console.log('VENTAS mayo:', JSON.stringify(v.rows[0]));

  const f=await c.query("SELECT SUM(total) as total, COUNT(*) as n FROM facturas WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31' AND (estado IS NULL OR estado<>'anulada') AND (bucket IS NULL OR bucket='cat_compra')",[tid,lid]);
  console.log('CMV (facturas):', JSON.stringify(f.rows[0]));

  const fb=await c.query("SELECT bucket, SUM(total) as total, COUNT(*) as n FROM facturas WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31' AND (estado IS NULL OR estado<>'anulada') AND bucket IS NOT NULL AND bucket<>'cat_compra' GROUP BY bucket",[tid,lid]);
  console.log('Facturas con bucket gasto:', JSON.stringify(fb.rows));

  const g=await c.query("SELECT tipo, categoria, SUM(monto) as total, COUNT(*) as n FROM gastos WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31' AND (estado IS NULL OR estado<>'anulado') AND categoria<>'SUELDOS' GROUP BY tipo, categoria ORDER BY tipo, categoria",[tid,lid]);
  console.log('GASTOS por tipo+cat:', JSON.stringify(g.rows));

  const cs=await c.query("SELECT SUM(monto) as total, COUNT(*) as n FROM gastos WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31' AND (estado IS NULL OR estado<>'anulado') AND tipo='fijo' AND categoria='CARGAS SOCIALES'",[tid,lid]);
  console.log('CARGAS SOCIALES:', JSON.stringify(cs.rows[0]));

  const s=await c.query("SELECT SUM(l.total_a_pagar) as total, COUNT(*) as n FROM rrhh_liquidaciones l JOIN rrhh_novedades n ON n.id=l.novedad_id JOIN rrhh_empleados e ON e.id=n.empleado_id WHERE l.tenant_id=$1 AND e.local_id=$2 AND l.estado IN ('pendiente','pagado') AND l.anulado=false AND l.calculado_at BETWEEN '2026-05-01T00:00:00' AND '2026-05-31T23:59:59'",[tid,lid]);
  console.log('SUELDOS:', JSON.stringify(s.rows[0]));

  // Ventas por medio
  const vm=await c.query("SELECT medio, SUM(monto) as total FROM ventas WHERE tenant_id=$1 AND local_id=$2 AND fecha BETWEEN '2026-05-01' AND '2026-05-31' GROUP BY medio ORDER BY SUM(monto) DESC",[tid,lid]);
  console.log('VENTAS por medio:', JSON.stringify(vm.rows));

  c.end();
}).catch(e=>{console.error(e.message);c.end();process.exit(1)});
