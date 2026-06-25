const fs=require('fs'); const { Client } = require('pg');
const url=fs.readFileSync('.env.dbg.tmp','utf8').match(/POSTGRES_URL_NON_POOLING="?([^"\n]+)/)[1];
(async()=>{
  const c=new Client({connectionString:url, ssl:{rejectUnauthorized:false}}); await c.connect();
  // rest of fn_anular (full)
  const an=await c.query(`SELECT pg_get_functiondef(p.oid) def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname='fn_anular_venta_comanda' AND n.nspname='public'`);
  console.log('===== fn_anular_venta_comanda (FULL) =====\n'+an.rows[0].def);
  // triggers on ventas_pos
  const trg=await c.query(`SELECT tgname, pg_get_triggerdef(oid) def FROM pg_trigger WHERE tgrelid='ventas_pos'::regclass AND NOT tgisinternal`);
  console.log('\n=== triggers en ventas_pos ==='); trg.rows.forEach(r=>console.log(`${r.tgname}: ${r.def}`));
  // reverso functions
  for (const fn of ['fn_trg_revertir_movimientos_al_anular_venta','fn_procesar_reversos_pendientes_comanda','fn_drenar_reversos_pendientes_comanda']) {
    const d=await c.query(`SELECT pg_get_functiondef(p.oid) def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname=$1 AND n.nspname='public'`,[fn]);
    console.log(`\n\n===== ${fn} =====\n`+(d.rows[0]?.def||'NO EXISTE'));
  }
  // reversos_pendientes table cols
  const cols=await c.query(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='reversos_pendientes' ORDER BY ordinal_position`);
  console.log('\n=== reversos_pendientes cols ==='); cols.rows.forEach(r=>console.log(`${r.column_name} (${r.is_nullable})`));
  await c.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
