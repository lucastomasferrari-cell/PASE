// onboardingProgress.ts — helper para el wizard /onboarding.
//
// Lee / marca pasos del onboarding por tenant. Tabla
// `tenant_onboarding_progress` + RPC `fn_onboarding_completar_paso` viven en
// migration 202605270100. El wizard solo lee/escribe acá.
//
// NO confundir con `onboardingTours.ts` — ese es el tour guiado driver.js
// que se dispara al entrar a /inicio por primera vez. Este es el wizard de
// SETUP previo: completar dirección, primer empleado, etc.

import { db } from "./supabase";

export type OnboardingPaso =
  | "datos_local"
  | "primer_empleado"
  | "primer_insumo"
  | "primer_item"
  | "primer_canal"
  | "completado";

export interface OnboardingProgress {
  tenant_id: string;
  paso_datos_local: boolean;
  paso_datos_local_at: string | null;
  paso_primer_empleado: boolean;
  paso_primer_empleado_at: string | null;
  paso_primer_insumo: boolean;
  paso_primer_insumo_at: string | null;
  paso_primer_item: boolean;
  paso_primer_item_at: string | null;
  paso_primer_canal: boolean;
  paso_primer_canal_at: string | null;
  completado: boolean;
  completado_at: string | null;
  asistido_por_email: string | null;
}

const PASOS_ORDEN: Exclude<OnboardingPaso, "completado">[] = [
  "datos_local",
  "primer_empleado",
  "primer_insumo",
  "primer_item",
  "primer_canal",
];

export async function getOnboardingProgress(
  tenantId: string,
): Promise<{ data: OnboardingProgress | null; error: string | null }> {
  const { data, error } = await db
    .from("tenant_onboarding_progress")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data: (data as OnboardingProgress | null), error: null };
}

export async function marcarPasoOnboarding(
  paso: OnboardingPaso,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc("fn_onboarding_completar_paso", { p_paso: paso });
  return { error: error?.message ?? null };
}

/**
 * Auto-detecta los pasos del onboarding mirando los datos reales del tenant
 * (RPC `fn_onboarding_autodetectar`, migration 202606131000): marca TRUE cada
 * paso cuyo dato ya exista (provincia/localidad del local, empleado activo,
 * insumo, item, canal). Idempotente — solo FALSE→TRUE, nunca desmarca y NO
 * marca `completado`. Devuelve la fila actualizada para usarla directo en el
 * widget sin un segundo round-trip.
 *
 * Si el usuario no tiene tenant en el JWT, la RPC devuelve NULL (no-op).
 */
export async function autodetectarOnboarding(): Promise<{
  data: OnboardingProgress | null;
  error: string | null;
}> {
  const { data, error } = await db.rpc("fn_onboarding_autodetectar");
  if (error) return { data: null, error: error.message };
  return { data: (data as OnboardingProgress | null), error: null };
}

/**
 * Calcula el % de avance (0-100) y el siguiente paso pendiente.
 * Si está completado, devuelve { pct: 100, next: null }.
 */
export function calcularAvance(p: OnboardingProgress | null): {
  pct: number;
  next: OnboardingPaso | null;
} {
  if (!p) return { pct: 0, next: "datos_local" };
  if (p.completado) return { pct: 100, next: null };
  const flags = [
    p.paso_datos_local,
    p.paso_primer_empleado,
    p.paso_primer_insumo,
    p.paso_primer_item,
    p.paso_primer_canal,
  ];
  const hechos = flags.filter(Boolean).length;
  const pct = Math.round((hechos / flags.length) * 100);
  const next = PASOS_ORDEN.find((paso) => {
    const key = `paso_${paso}` as keyof OnboardingProgress;
    return p[key] === false;
  }) ?? null;
  return { pct, next };
}

/**
 * Verdadero si el tenant tiene onboarding incompleto (algún paso false y
 * completado=false). Útil para gatear redirects.
 */
export function necesitaOnboarding(p: OnboardingProgress | null): boolean {
  if (!p) return true;
  if (p.completado) return false;
  return [
    p.paso_datos_local,
    p.paso_primer_empleado,
    p.paso_primer_insumo,
    p.paso_primer_item,
    p.paso_primer_canal,
  ].some((flag) => flag === false);
}
