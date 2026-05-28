// ─────────────────────────────────────────────────────────────────────────
// Seed COMANDA-específico para tests E2E que tocan el POS.
//
// El seed base de `seed-tenant.ts` deja tenant+locales+empleados+items+
// catálogos+TOTP+saldos. Esto agrega lo que COMANDA requiere encima:
//   - canales (salón + mostrador + delivery)
//   - mesas (4 en local 1)
//   - turno_caja abierto con monto inicial 0
//   - pin_pos + rol_pos en el empleado cajero (sino el POS no lo deja operar)
//
// Llamar después del seed base, pasando el resultado:
//   const seed = await seedE2ETenant(...);
//   const pos = await seedComandaPos(seed);
//
// Cleanup: como todo cuelga del tenant_id, `cleanupE2ETenant()` borra estos
// también (cascade via eliminar_tenant_completo).
// ─────────────────────────────────────────────────────────────────────────

import { createServiceClient, type E2ETenantSeedResult } from "./seed-tenant";

export interface E2EComandaPosSeed {
  canalSalonId: number;
  canalMostradorId: number;
  canalDeliveryId: number;
  mesas: { id: number; numero: string }[]; // 4 mesas en local 1
  turnoCajaId: number;                      // turno abierto
  cajeroEmpleadoId: string;                  // UUID del cajero con pin asignado
  cajeroPin: string;                         // pin de 4 dígitos
}

const PIN_CAJERO = "1234";

export async function seedComandaPos(seed: E2ETenantSeedResult): Promise<E2EComandaPosSeed> {
  const svc = createServiceClient();

  // 1. Canales (modo_pos válido: salon|mostrador|pedidos)
  //
  // IDEMPOTENT (sprint 28-may): el tenant es compartido entre specs ahora,
  // así que primero buscar si los canales ya existen del seed anterior.
  // Si sí, reutilizar IDs. Si no, insertar. Antes esto tiraba
  // "duplicate key value violates unique constraint uniq_canales_slug_per_local"
  // a partir del segundo spec.
  const SLUGS = ["salon-e2e", "mostrador-e2e", "delivery-e2e"];
  const { data: existentes } = await svc.from("canales")
    .select("id, slug")
    .eq("tenant_id", seed.tenantId)
    .eq("local_id", seed.local1Id)
    .in("slug", SLUGS);
  let canales: { id: number | string; slug: string }[];
  if (existentes && existentes.length === 3) {
    canales = existentes as { id: number | string; slug: string }[];
  } else {
    // Borrar parciales (por si quedó un canal a medias de un spec interrumpido)
    if (existentes && existentes.length > 0) {
      await svc.from("canales")
        .delete()
        .eq("tenant_id", seed.tenantId)
        .eq("local_id", seed.local1Id)
        .in("slug", SLUGS);
    }
    const { data: nuevos, error: canErr } = await svc.from("canales").insert([
      {
        tenant_id: seed.tenantId,
        local_id: seed.local1Id,
        nombre: "Salón",
        slug: "salon-e2e",
        modo_pos: "salon",
        activo: true,
      },
      {
        tenant_id: seed.tenantId,
        local_id: seed.local1Id,
        nombre: "Mostrador",
        slug: "mostrador-e2e",
        modo_pos: "mostrador",
        activo: true,
      },
      {
        tenant_id: seed.tenantId,
        local_id: seed.local1Id,
        nombre: "Delivery",
        slug: "delivery-e2e",
        modo_pos: "pedidos",
        activo: true,
      },
    ]).select("id, slug");
    if (canErr) throw new Error(`Seed canales: ${canErr.message}`);
    canales = nuevos as { id: number | string; slug: string }[];
  }

  const canalSalonId = canales.find(c => c.slug === "salon-e2e")!.id as number;
  const canalMostradorId = canales.find(c => c.slug === "mostrador-e2e")!.id as number;
  const canalDeliveryId = canales.find(c => c.slug === "delivery-e2e")!.id as number;

  // 2. 4 mesas en local 1 (IDEMPOTENT)
  const mesasData = [
    { numero: "1", capacidad: 2 },
    { numero: "2", capacidad: 4 },
    { numero: "3", capacidad: 4 },
    { numero: "4", capacidad: 6 },
  ];
  const mesasNumeros = mesasData.map(m => m.numero);
  const { data: mesasExistentes } = await svc.from("mesas")
    .select("id, numero")
    .eq("tenant_id", seed.tenantId)
    .eq("local_id", seed.local1Id)
    .in("numero", mesasNumeros);
  let mesas: { id: number | string; numero: string }[];
  if (mesasExistentes && mesasExistentes.length === mesasData.length) {
    mesas = mesasExistentes as { id: number | string; numero: string }[];
  } else {
    if (mesasExistentes && mesasExistentes.length > 0) {
      await svc.from("mesas")
        .delete()
        .eq("tenant_id", seed.tenantId)
        .eq("local_id", seed.local1Id)
        .in("numero", mesasNumeros);
    }
    const { data: nuevasMesas, error: mesasErr } = await svc.from("mesas").insert(
      mesasData.map(m => ({
        tenant_id: seed.tenantId,
        local_id: seed.local1Id,
        numero: m.numero,
        capacidad: m.capacidad,
        estado: "libre",
        forma: "cuadrado",
      }))
    ).select("id, numero");
    if (mesasErr) throw new Error(`Seed mesas: ${mesasErr.message}`);
    mesas = nuevasMesas as { id: number | string; numero: string }[];
  }

  // 3. Asignar pin + rol_pos al empleado SEMANAL (el cajero)
  const cajeroEmpleadoId = seed.empleados.semanal.id;
  const { error: pinErr } = await svc.from("rrhh_empleados")
    .update({
      pin_pos: PIN_CAJERO,
      rol_pos: "cajero",
      pos_activo: true,
      pin_actualizado_at: new Date().toISOString(),
    })
    .eq("id", cajeroEmpleadoId);
  if (pinErr) throw new Error(`Asignar pin_pos: ${pinErr.message}`);

  // 4. Abrir turno_caja con ese cajero (IDEMPOTENT)
  const { data: turnoExistente } = await svc.from("turnos_caja")
    .select("id")
    .eq("tenant_id", seed.tenantId)
    .eq("local_id", seed.local1Id)
    .eq("estado", "abierto")
    .maybeSingle();
  let turno: { id: number | string };
  if (turnoExistente) {
    turno = turnoExistente as { id: number | string };
  } else {
    const { data: nuevoTurno, error: turnoErr } = await svc.from("turnos_caja").insert({
      tenant_id: seed.tenantId,
      local_id: seed.local1Id,
      numero: 1,
      cajero_id: cajeroEmpleadoId,
      monto_inicial: 0,
      estado: "abierto",
    }).select("id").single();
    if (turnoErr) throw new Error(`Abrir turno_caja: ${turnoErr.message}`);
    turno = nuevoTurno as { id: number | string };
  }

  return {
    canalSalonId,
    canalMostradorId,
    canalDeliveryId,
    mesas: mesas!.map(m => ({ id: m.id as number, numero: m.numero })),
    turnoCajaId: turno.id as number,
    cajeroEmpleadoId,
    cajeroPin: PIN_CAJERO,
  };
}
