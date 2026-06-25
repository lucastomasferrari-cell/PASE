const fs=require('fs'); const { Client } = require('pg');
const url=fs.readFileSync('.env.dbg.tmp','utf8').match(/POSTGRES_URL_NON_POOLING="?([^"\n]+)/)[1];
(async()=>{
  const c=new Client({connectionString:url, ssl:{rejectUnauthorized:false}}); await c.connect();
  const trg=await c.query(`SELECT tgname, pg_get_triggerdef(oid) def FROM pg_trigger WHERE tgrelid='turnos_caja'::regclass AND NOT tgisinternal`);
  console.log('=== triggers en turnos_caja ==='); trg.rows.forEach(r=>console.log(`${r.tgname}`));
  // ¿fn_abrir_turno llama al drain?
  const ab=await c.query(`SELECT pg_get_functiondef(p.oid) def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname='fn_abrir_turno_caja_comanda' AND n.nspname='public'`);
  const def=ab.rows[0].def;
  console.log('\nfn_abrir_turno llama a procesar_reversos?', def.includes('procesar_reversos')||def.includes('reversos_pendientes')?'SÍ':'NO');
  console.log('\n=== fn_abrir_turno (cuerpo relevante) ===');
  console.log(def.split('BEGIN')[1]?.slice(0,1200));
  await c.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
