const fs=require('fs'); const { Client } = require('pg');
const url=fs.readFileSync('.env.dbg.tmp','utf8').match(/POSTGRES_URL_NON_POOLING="?([^"\n]+)/)[1];
(async()=>{
  const c=new Client({connectionString:url, ssl:{rejectUnauthorized:false}}); await c.connect();
  // ventas_pos_overrides columns + constraints
  const cols=await c.query(`SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_name='ventas_pos_overrides' ORDER BY ordinal_position`);
  console.log('=== ventas_pos_overrides columns ==='); cols.rows.forEach(r=>console.log(`${r.column_name} | nullable=${r.is_nullable} | ${r.data_type}`));
  const chk=await c.query(`SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='ventas_pos_overrides'::regclass`);
  console.log('\n=== constraints ==='); chk.rows.forEach(r=>console.log(`${r.conname}: ${r.def}`));
  // fn defs
  for (const fn of ['fn_movimiento_caja_comanda','fn_anular_venta_comanda']) {
    const d=await c.query(`SELECT pg_get_functiondef(p.oid) def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname=$1 AND n.nspname='public'`,[fn]);
    console.log(`\n\n===== ${fn} =====\n`+(d.rows[0]?.def||'NO EXISTE'));
  }
  await c.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
