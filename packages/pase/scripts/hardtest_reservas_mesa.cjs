/* HARD TEST del motor de reservas MESA (local Maneki #4).
   Todo corre en UNA transacción con ROLLBACK final: NO persiste nada.
   Cada test en su SAVEPOINT que se revierte siempre (aísla filas + resetea anti-ráfaga). */
const { Client } = require("pg");
const fs = require("fs");
const url = fs.readFileSync("C:/Users/lucas/Documents/PASE/packages/pase/.env.local","utf8").match(/POSTGRES_URL_NON_POOLING="([^"]+)"/)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const LOCAL = 4, SLUG = "maneki-palermo";
const TENANT = "5841143c-5594-4728-99c6-a313d40618e6";
const DUENO = "e31a4f75-b20d-4e47-8a24-c9ad82ff73c6";      // dueño Maneki
const OTRO  = "5bf1f570-9728-42fd-9e9e-9de6d22b1992";      // dueño de OTRO tenant (Malena)
const BARRA = "Salón - Barra", PRIV = "Privado", ALTAS = "Salón - Mesas Altas";
const D = "2026-07-21";
const T20 = `${D} 20:00:00-03:00`, T22 = `${D} 22:00:00-03:00`, T21 = `${D} 21:00:00-03:00`;

const q = (sql, params) => c.query(sql, params);
const rows = async (sql, params) => (await c.query(sql, params)).rows;
const one = async (sql, params) => (await c.query(sql, params)).rows[0];

async function asUser(authId) {
  if (authId) await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: authId, role: "authenticated" })]);
  else await q(`select set_config('request.jwt.claims', '', true)`);
}
// crear reserva pública -> {id, estado}
async function crearPub({ nombre = "HT Cliente", tel = "1122330000", email = null, fh, personas, zona = null, key = null, notas = "__HARDTEST__" }) {
  return one(`select * from fn_crear_reserva_publica($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [SLUG, nombre, tel, email, fh, personas, notas, key, zona]);
}
async function check({ fh, personas, zona = null }) {
  return one(`select * from fn_check_disponibilidad_reserva($1,$2,$3,$4)`, [SLUG, fh, personas, zona]);
}
// inserta filas crudas (para setup de anti-spam) — se revierten con el savepoint
async function rawInsert(n, { tel = null, fh = T20, estado = "confirmada" } = {}) {
  for (let i = 0; i < n; i++)
    await q(`insert into reservas (tenant_id, local_id, cliente_nombre, cliente_telefono, fecha_hora, personas, estado, notas)
             values ($1,$2,$3,$4,$5,2,$6,'__HARDTEST__')`, [TENANT, LOCAL, "raw" + i, tel, fh, estado]);
}

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  await q("SAVEPOINT s");
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  try { await q("ROLLBACK TO SAVEPOINT s"); await q("RELEASE SAVEPOINT s"); } catch (e) {}
  await asUser(null); // reset auth entre tests
  if (err) { failed++; fails.push(`${name}\n     → ${err.message}`); console.log("  ✗ " + name + "  ::  " + err.message); }
  else { passed++; console.log("  ✓ " + name); }
}
function assert(cond, msg) { if (!cond) throw new Error("ASSERT: " + msg); }
async function expectErr(codeSubstr, fn) {
  await q("SAVEPOINT ee");
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  try { await q("ROLLBACK TO SAVEPOINT ee"); await q("RELEASE SAVEPOINT ee"); } catch (e) {}
  if (!threw) throw new Error(`esperaba error '${codeSubstr}' pero NO falló`);
  if (!String(threw.message).includes(codeSubstr)) throw new Error(`esperaba '${codeSubstr}', obtuve: ${threw.message}`);
}

(async () => {
  await c.connect();
  await q("BEGIN");
  // slate limpio para la fecha de prueba (revertido al final)
  await q(`update reservas set deleted_at=now() where local_id=$1 and fecha_hora::date=$2 and deleted_at is null`, [LOCAL, D]);

  console.log("\n── G1. Disponibilidad / límites por sector ──");
  await test("check Privado 4p → OK", async () => { const r = await check({ fh: T20, personas: 4, zona: PRIV }); assert(r.disponible === true, "no dispo: " + r.motivo); });
  await test("check Privado 3p → SIN_MESA (min 4)", async () => { const r = await check({ fh: T20, personas: 3, zona: PRIV }); assert(r.disponible === false && r.motivo === "SIN_MESA", r.motivo); });
  await test("check Privado 7p → SIN_MESA (max 6)", async () => { const r = await check({ fh: T20, personas: 7, zona: PRIV }); assert(r.disponible === false, r.motivo); });
  await test("check Mesas Altas 2p → OK", async () => { const r = await check({ fh: T20, personas: 2, zona: ALTAS }); assert(r.disponible === true, r.motivo); });
  await test("check Mesas Altas 3p → SIN_MESA (max 2)", async () => { const r = await check({ fh: T20, personas: 3, zona: ALTAS }); assert(r.disponible === false && r.motivo === "SIN_MESA", r.motivo); });
  await test("check Barra 3p → OK", async () => { const r = await check({ fh: T20, personas: 3, zona: BARRA }); assert(r.disponible === true, r.motivo); });
  await test("check Barra 4p → SIN_MESA (max 3)", async () => { const r = await check({ fh: T20, personas: 4, zona: BARRA }); assert(r.disponible === false, r.motivo); });
  await test("check sin zona 2p → OK", async () => { const r = await check({ fh: T20, personas: 2 }); assert(r.disponible === true, r.motivo); });
  await test("check anticipación insuficiente", async () => { const r = await check({ fh: `${D} 20:00:00-03:00`, personas: 2 }); assert(true); /* covered abajo */
    const near = await one(`select * from fn_check_disponibilidad_reserva($1, now()+interval '30 min',2,null)`, [SLUG]); assert(near.motivo === "ANTICIPACION_INSUFICIENTE", near.motivo); });
  await test("check fecha demasiado lejana (>30d)", async () => { const r = await one(`select * from fn_check_disponibilidad_reserva($1, now()+interval '45 days',2,null)`, [SLUG]); assert(r.motivo === "FECHA_DEMASIADO_LEJANA", r.motivo); });
  await test("check 0 personas → PERSONAS_INVALIDAS", async () => { const r = await check({ fh: T20, personas: 0 }); assert(r.motivo === "PERSONAS_INVALIDAS", r.motivo); });
  await test("check 51 personas → PERSONAS_INVALIDAS", async () => { const r = await check({ fh: T20, personas: 51 }); assert(r.motivo === "PERSONAS_INVALIDAS", r.motivo); });
  await test("check fuera de horario (15:00) → FUERA_DE_HORARIO", async () => { const r = await check({ fh: `${D} 15:00:00-03:00`, personas: 2 }); assert(r.motivo === "FUERA_DE_HORARIO", r.motivo); });

  console.log("\n── G2. Slots públicos ──");
  await test("slots devuelve exactamente 20:00 y 22:00", async () => {
    const s = await rows(`select * from fn_slots_disponibilidad_publico($1,$2,$3,null)`, [SLUG, D, 2]);
    const horas = s.map(r => r.hora).sort();
    assert(JSON.stringify(horas) === JSON.stringify(["20:00", "22:00"]), "horas=" + JSON.stringify(horas));
    assert(s.every(r => r.disponible), "algún slot no disponible");
  });

  console.log("\n── G3. Creación pública ──");
  await test("crear Privado 4p → confirmada + mesa asignada", async () => {
    const r = await crearPub({ fh: T20, personas: 4, zona: PRIV });
    assert(r.estado === "confirmada", "estado=" + r.estado);
    const row = await one(`select mesa_id, array_length(mesas_ids,1) n, zona from reservas r join mesas m on m.id=r.mesa_id where r.id=$1`, [r.id]);
    assert(row.mesa_id != null && row.n === 1 && row.zona === PRIV, JSON.stringify(row));
  });
  await test("crear nombre vacío → NOMBRE_REQUERIDO", async () => { await expectErr("NOMBRE_REQUERIDO", () => crearPub({ nombre: " ", fh: T20, personas: 2 })); });
  await test("crear sin teléfono (obligatorio) → TELEFONO_REQUERIDO", async () => { await expectErr("TELEFONO_REQUERIDO", () => crearPub({ tel: "", fh: T20, personas: 2 })); });
  await test("idempotencia: misma key → mismo id", async () => {
    const a = await crearPub({ fh: T20, personas: 4, zona: PRIV, key: "HTKEY1" });
    const b = await crearPub({ fh: T20, personas: 4, zona: PRIV, key: "HTKEY1" });
    assert(String(a.id) === String(b.id), `a=${a.id} b=${b.id}`);
    const cnt = await one(`select count(*)::int n from reservas where idempotency_key='HTKEY1' and deleted_at is null`);
    assert(cnt.n === 1, "filas=" + cnt.n);
  });
  await test("barra: 8 solos llenan 8 banquetas distintas; 9º → SIN_MESA", async () => {
    const usadas = new Set();
    for (let i = 0; i < 8; i++) { const r = await crearPub({ tel: "1150000" + i, fh: T20, personas: 1, zona: BARRA }); const m = await one(`select mesa_id from reservas where id=$1`, [r.id]); usadas.add(String(m.mesa_id)); }
    assert(usadas.size === 8, "banquetas distintas=" + usadas.size);
    await expectErr("SIN_MESA", () => crearPub({ tel: "1150000X", fh: T20, personas: 1, zona: BARRA }));
  });
  await test("barra grupo de 3 → 3 banquetas adyacentes (mesas_ids=3)", async () => {
    const r = await crearPub({ fh: T22, personas: 3, zona: BARRA });
    const row = await one(`select array_length(mesas_ids,1) n from reservas where id=$1`, [r.id]);
    assert(row.n === 3, "mesas_ids=" + row.n);
  });
  await test("privado: 3 sillones se llenan; 4º → SIN_MESA", async () => {
    for (let i = 0; i < 3; i++) await crearPub({ tel: "1160000" + i, fh: T20, personas: 5, zona: PRIV });
    await expectErr("SIN_MESA", () => crearPub({ tel: "1160000X", fh: T20, personas: 5, zona: PRIV }));
  });

  console.log("\n── G4. Overlap / turnos ──");
  await test("22:00 libre tras llenar 20:00 (sin overlap en el borde)", async () => {
    // lleno 8 banquetas a las 20:00 (dur 120 → termina 22:00)
    for (let i = 0; i < 8; i++) await crearPub({ tel: "1170000" + i, fh: T20, personas: 1, zona: BARRA });
    // a las 22:00 la banqueta debe estar libre (20:00+120 = 22:00, sin solape). Pruebo 3 (total 11 < 12 anti-ráfaga).
    let ok = 0; for (let i = 0; i < 3; i++) { await crearPub({ tel: "1180000" + i, fh: T22, personas: 1, zona: BARRA }); ok++; }
    assert(ok === 3, "entraron en T22=" + ok);
  });
  await test("overlap real: banqueta ocupada 20:00-22:00 no admite 21:00 (admin asignar)", async () => {
    await asUser(DUENO);
    const b1 = (await one(`select id from mesas where local_id=$1 and zona=$2 order by id limit 1`, [LOCAL, BARRA])).id;
    await crearPub({ tel: "1190000A", fh: T20, personas: 1, zona: BARRA }); // ocupa alguna banqueta (motor elige)
    // fuerzo ocupar b1 a las 20:00 con asignación admin
    const rocc = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Occ", "1190000B", null, T20, 1, null, null])).id;
    await q(`select fn_asignar_mesa_reserva($1,$2)`, [rocc, b1]);
    const r21 = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "At21", "1190000C", null, T21, 1, null, null])).id;
    await expectErr("MESA_OCUPADA", () => q(`select fn_asignar_mesa_reserva($1,$2)`, [r21, b1])); // 21:00 solapa 20:00-22:00
  });

  console.log("\n── G5. Anti-spam ──");
  await test("4 activas mismo tel → 5ª = DEMASIADAS_RESERVAS", async () => {
    await rawInsert(4, { tel: "1199999999", fh: T20 });
    await expectErr("DEMASIADAS_RESERVAS", () => crearPub({ tel: "1199999999", fh: T22, personas: 2, zona: BARRA }));
  });
  await test("12 en 5min → 13ª = DEMASIADO_RAPIDO", async () => {
    await rawInsert(12, { tel: null, fh: T20 });
    await expectErr("DEMASIADO_RAPIDO", () => crearPub({ tel: "1133330000", fh: T22, personas: 2, zona: BARRA }));
  });

  console.log("\n── G6. Admin: crear/editar/estado (auth dueño) ──");
  await test("admin crear reserva (pendiente, sin mesa)", async () => {
    await asUser(DUENO);
    const id = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Admin Cli", "1140000000", null, T20, 4, null, null])).id;
    const row = await one(`select estado, mesa_id from reservas where id=$1`, [id]);
    assert(row.estado === "pendiente" && row.mesa_id === null, JSON.stringify(row));
  });
  await test("admin sin auth → NO_AUTH", async () => { await asUser(null); await expectErr("NO_AUTH", () => q(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8)`, [LOCAL, "X", null, null, T20, 2, null, null])); });
  await test("admin editar personas + recalcula duración", async () => {
    await asUser(DUENO);
    const id = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Edit Cli", "1140000001", null, T20, 2, null, null])).id;
    await q(`select fn_editar_reserva($1,$2,$3,$4,$5,$6,$7)`, [id, "Edit Cli 2", null, null, null, 6, "nota"]);
    const row = await one(`select cliente_nombre, personas, duracion_min from reservas where id=$1`, [id]);
    assert(row.cliente_nombre === "Edit Cli 2" && row.personas === 6 && row.duracion_min === 120, JSON.stringify(row));
  });
  await test("editar reserva cancelada → RESERVA_NO_EDITABLE", async () => {
    await asUser(DUENO);
    const id = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Canc", "1140000002", null, T20, 2, null, null])).id;
    await q(`select fn_cambiar_estado_reserva($1,'cancelada','x',null)`, [id]);
    await expectErr("RESERVA_NO_EDITABLE", () => q(`select fn_editar_reserva($1,$2)`, [id, "nuevo"]));
  });
  await test("máquina de estados: pendiente→confirmada→sentada→finalizada", async () => {
    await asUser(DUENO);
    const id = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "SM", "1140000003", null, T20, 2, null, null])).id;
    await q(`select fn_cambiar_estado_reserva($1,'confirmada',null,null)`, [id]);
    await q(`select fn_cambiar_estado_reserva($1,'sentada',null,null)`, [id]);
    await q(`select fn_cambiar_estado_reserva($1,'finalizada',null,null)`, [id]);
    const st = await one(`select estado from reservas where id=$1`, [id]); assert(st.estado === "finalizada", st.estado);
  });
  await test("transición inválida pendiente→finalizada", async () => {
    await asUser(DUENO);
    const id = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "SM2", "1140000004", null, T20, 2, null, null])).id;
    await expectErr("TRANSICION_INVALIDA", () => q(`select fn_cambiar_estado_reserva($1,'finalizada',null,null)`, [id]));
  });
  await test("REABRIR: cancelada→confirmada (lo que hace el botón Reactivar)", async () => {
    await asUser(DUENO);
    const id = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Reab", "1140000005", null, T20, 2, null, null])).id;
    await q(`select fn_cambiar_estado_reserva($1,'cancelada','x',null)`, [id]);
    await q(`select fn_cambiar_estado_reserva($1,'confirmada',null,null)`, [id]); // <- UI ofrece esto
    const st = await one(`select estado from reservas where id=$1`, [id]); assert(st.estado === "confirmada", st.estado);
  });
  await test("REABRIR: no_show→confirmada", async () => {
    await asUser(DUENO);
    const id = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Reab2", "1140000006", null, T20, 2, null, null])).id;
    await q(`select fn_cambiar_estado_reserva($1,'confirmada',null,null)`, [id]);
    await q(`select fn_cambiar_estado_reserva($1,'no_show',null,null)`, [id]);
    await q(`select fn_cambiar_estado_reserva($1,'confirmada',null,null)`, [id]);
    const st = await one(`select estado, no_show_auto from reservas where id=$1`, [id]); assert(st.estado === "confirmada", st.estado);
  });
  await test("REABRIR: finalizada→confirmada limpia timestamps terminales", async () => {
    await asUser(DUENO);
    const id = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Reab3", "1140000007", null, T20, 2, null, null])).id;
    await q(`select fn_cambiar_estado_reserva($1,'confirmada',null,null)`, [id]);
    await q(`select fn_cambiar_estado_reserva($1,'sentada',null,null)`, [id]);
    await q(`select fn_cambiar_estado_reserva($1,'finalizada',null,null)`, [id]);
    await q(`select fn_cambiar_estado_reserva($1,'confirmada',null,null)`, [id]);
    const st = await one(`select estado, finalizada_at, cancelada_at from reservas where id=$1`, [id]);
    assert(st.estado === "confirmada" && st.finalizada_at === null, JSON.stringify(st));
  });
  await test("REABRIR cancelada libera y re-chequea mesa (si otro la tomó, la suelta)", async () => {
    await asUser(DUENO);
    const b1 = (await one(`select id from mesas where local_id=$1 and zona=$2 order by id limit 1`, [LOCAL, BARRA])).id;
    // reserva A en b1 a las 20:00, luego cancelada
    const a = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "A", "1145000000", null, T20, 1, null, null])).id;
    await q(`select fn_asignar_mesa_reserva($1,$2)`, [a, b1]);
    await q(`select fn_cambiar_estado_reserva($1,'cancelada',null,null)`, [a]);
    // B toma b1 en el mismo horario
    const b = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "B", "1145000001", null, T20, 1, null, null])).id;
    await q(`select fn_asignar_mesa_reserva($1,$2)`, [b, b1]);
    // reabro A: debe volver a confirmada PERO sin mesa (b1 ocupada por B)
    await q(`select fn_cambiar_estado_reserva($1,'confirmada',null,null)`, [a]);
    const st = await one(`select estado, mesa_id, mesas_ids from reservas where id=$1`, [a]);
    assert(st.estado === "confirmada" && st.mesa_id === null && st.mesas_ids === null, "no soltó la mesa ocupada: " + JSON.stringify(st));
  });

  console.log("\n── G7. Asignar mesa (admin) ──");
  await test("asignar banqueta libre OK; ocupada → MESA_OCUPADA", async () => {
    await asUser(DUENO);
    const b1 = (await one(`select id from mesas where local_id=$1 and zona=$2 order by id limit 1`, [LOCAL, BARRA])).id;
    const id1 = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Asig1", "1141000000", null, T20, 1, null, null])).id;
    await q(`select fn_asignar_mesa_reserva($1,$2)`, [id1, b1]);
    const chk = await one(`select mesa_id from reservas where id=$1`, [id1]); assert(String(chk.mesa_id) === String(b1), "no asignó");
    const id2 = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Asig2", "1141000001", null, T20, 1, null, null])).id;
    await expectErr("MESA_OCUPADA", () => q(`select fn_asignar_mesa_reserva($1,$2)`, [id2, b1]));
  });
  await test("asignar mesa de OTRO local → MESA_OTRO_LOCAL", async () => {
    await asUser(DUENO);
    const otra = await one(`select id from mesas where local_id<>$1 and deleted_at is null limit 1`, [LOCAL]);
    if (!otra) return; // no hay otras mesas
    const id = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Asig3", "1141000002", null, T20, 2, null, null])).id;
    await expectErr("MESA_OTRO_LOCAL", () => q(`select fn_asignar_mesa_reserva($1,$2)`, [id, otra.id]));
  });

  console.log("\n── G8. Aislamiento por tenant ──");
  await test("otro tenant NO puede editar reserva de Maneki → RESERVA_NO_ENCONTRADA", async () => {
    await asUser(DUENO);
    const id = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Iso", "1142000000", null, T20, 2, null, null])).id;
    await asUser(OTRO);
    await expectErr("RESERVA_NO_ENCONTRADA", () => q(`select fn_editar_reserva($1,$2)`, [id, "hack"]));
  });
  await test("otro tenant NO puede cambiar estado de Maneki → RESERVA_NO_ENCONTRADA", async () => {
    await asUser(DUENO);
    const id = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "Iso2", "1142000001", null, T20, 2, null, null])).id;
    await asUser(OTRO);
    await expectErr("RESERVA_NO_ENCONTRADA", () => q(`select fn_cambiar_estado_reserva($1,'cancelada',null,null)`, [id]));
  });

  console.log("\n── G9. Cancelación pública + liberar mesa (reabrir cupo) ──");
  await test("cancelar público: tel mal → false; tel ok → cancela", async () => {
    const r = await crearPub({ tel: "1143000000", fh: T20, personas: 1, zona: BARRA });
    const bad = await one(`select fn_cancelar_reserva_publica($1,$2,null) ok`, [r.id, "0000"]); assert(bad.ok === false, "canceló con tel malo");
    const good = await one(`select fn_cancelar_reserva_publica($1,$2,null) ok`, [r.id, "1143000000"]); assert(good.ok === true, "no canceló");
    const st = await one(`select estado from reservas where id=$1`, [r.id]); assert(st.estado === "cancelada", st.estado);
  });
  await test("cancelar libera la banqueta (nuevo cliente entra)", async () => {
    // llenar 8 banquetas
    const ids = []; for (let i = 0; i < 8; i++) { const r = await crearPub({ tel: "1144000" + i, fh: T20, personas: 1, zona: BARRA }); ids.push(r.id); }
    await expectErr("SIN_MESA", () => crearPub({ tel: "1144000X", fh: T20, personas: 1, zona: BARRA })); // lleno
    // cancelo una y reintento
    await one(`select fn_cancelar_reserva_publica($1,$2,null) ok`, [ids[0], "11440000"]);
    const r2 = await crearPub({ tel: "1144000Z", fh: T20, personas: 1, zona: BARRA });
    assert(r2.id != null, "no pudo re-reservar tras cancelar");
  });

  console.log("\n── G10. Editar fecha no debe doblar la mesa ──");
  await test("editar mueve a horario con mesa ocupada → NO dobla (suelta o bloquea)", async () => {
    await asUser(DUENO);
    const b1 = (await one(`select id from mesas where local_id=$1 and zona=$2 order by id limit 1`, [LOCAL, BARRA])).id;
    // A ocupa b1 a las 20:00
    const a = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "A", "1146000000", null, T20, 1, null, null])).id;
    await q(`select fn_asignar_mesa_reserva($1,$2)`, [a, b1]);
    // B en b1 a las 22:00 (libre)
    const b = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "B", "1146000001", null, T22, 1, null, null])).id;
    await q(`select fn_asignar_mesa_reserva($1,$2)`, [b, b1]);
    // muevo B a las 20:00 (pisaría a A en b1). No debe quedar doble-booking.
    let bloqueado = false;
    try { await q(`select fn_editar_reserva($1,null,null,null,$2,null,null)`, [b, T20]); } catch (e) { bloqueado = true; }
    if (!bloqueado) {
      // si permitió el cambio, B no puede seguir en b1 a las 20:00
      const st = await one(`select mesa_id, mesas_ids from reservas where id=$1`, [b]);
      const sigueEnB1 = String(st.mesa_id) === String(b1) || (st.mesas_ids || []).map(String).includes(String(b1));
      assert(!sigueEnB1, "DOBLE BOOKING: B sigue en b1 a las 20:00 junto con A");
    }
  });
  await test("editar sin conflicto conserva la mesa", async () => {
    await asUser(DUENO);
    const b1 = (await one(`select id from mesas where local_id=$1 and zona=$2 order by id limit 1`, [LOCAL, BARRA])).id;
    const a = (await one(`select fn_crear_reserva($1,$2,$3,$4,$5,$6,$7,$8) id`, [LOCAL, "A", "1146000002", null, T20, 1, null, null])).id;
    await q(`select fn_asignar_mesa_reserva($1,$2)`, [a, b1]);
    await q(`select fn_editar_reserva($1,$2)`, [a, "A editado"]); // solo nombre
    const st = await one(`select mesa_id from reservas where id=$1`, [a]);
    assert(String(st.mesa_id) === String(b1), "perdió la mesa sin motivo");
  });

  await q("ROLLBACK");
  console.log(`\n════════ RESULTADO: ${passed} OK / ${failed} FALLAS ════════`);
  if (fails.length) { console.log("\nFALLAS:"); fails.forEach((f, i) => console.log(` ${i + 1}. ${f}`)); }
  await c.end();
  process.exit(failed ? 2 : 0);
})().catch(async e => { try { await q("ROLLBACK"); } catch (_) {} console.error("FATAL:", e.message, e.stack); process.exit(1); });
