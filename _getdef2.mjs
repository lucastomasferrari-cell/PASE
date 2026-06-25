import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
const url = readFileSync(".env.local.tmp","utf8").split("\n").find(l=>l.startsWith("POSTGRES_URL_NON_POOLING=")).split("=").slice(1).join("=").trim().replace(/^"|"$/g,"");
const c = new pg.Client({connectionString:url}); await c.connect();
const { rows } = await c.query("select pg_get_functiondef(p.oid) def from pg_proc p where p.proname='fn_cruzar_extracto_mp'");
writeFileSync("_cruce2.sql", rows[0].def);
await c.end();
console.log("guardado");
