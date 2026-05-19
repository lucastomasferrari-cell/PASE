// Service para CRUD de credenciales AFIP. Llama a Supabase RPCs server-side
// porque los campos cert_pem + key_pem están protegidos por column-level
// grants (solo service_role puede SELECT/INSERT/UPDATE en esos).
//
// El upsert usa una RPC SECURITY DEFINER que valida que el caller es
// dueno/admin del tenant y que el CUIT es numérico de 11 dígitos.

import { db } from '../supabase';
import type { AfipAmbiente, AfipCredencialesPublic } from './types';

export interface UpsertAfipCredencialesArgs {
  cuit: string;
  ambiente: AfipAmbiente;
  punto_venta: number;
  tipo_contribuyente: 'monotributo' | 'responsable_inscripto' | 'exento';
  cert_pem: string;
  key_pem: string;
  activa?: boolean;
  cert_vence_at?: string | null;
}

export async function upsertCredencialesAFIP(args: UpsertAfipCredencialesArgs): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await db.rpc('fn_upsert_afip_credenciales', {
    p_cuit: args.cuit,
    p_ambiente: args.ambiente,
    p_punto_venta: args.punto_venta,
    p_tipo_contribuyente: args.tipo_contribuyente,
    p_cert_pem: args.cert_pem,
    p_key_pem: args.key_pem,
    p_activa: args.activa ?? false,
    p_cert_vence_at: args.cert_vence_at ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

export async function getCredencialesAFIP(): Promise<{ data: AfipCredencialesPublic | null; error: string | null }> {
  const { data, error } = await db
    .from('afip_credenciales')
    .select('tenant_id, cuit, ambiente, punto_venta, tipo_contribuyente, cert_vence_at, ultimo_token_at, activa')
    .maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data: (data as AfipCredencialesPublic | null), error: null };
}

export async function eliminarCredencialesAFIP(): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await db.rpc('fn_eliminar_afip_credenciales');
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

/**
 * Prueba la conexión con AFIP: WSAA login + getLastVoucher contra el
 * punto de venta + tipo configurado. Si pasa, confirma que el cert/key
 * son válidos y que los servicios están adheridos correctamente.
 */
export async function probarConexionAFIP(): Promise<{
  ok: boolean;
  message?: string;
  proximo_numero?: number;
  tipo_chequeado?: string;
  ambiente?: string;
  error?: string;
}> {
  const sess = (await db.auth.getSession()).data.session;
  if (!sess?.access_token) return { ok: false, error: 'Sesión expirada' };

  try {
    const resp = await fetch('/api/tienda-mp?action=afip-test-connection', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sess.access_token}`,
      },
      body: JSON.stringify({}),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, error: data?.detail || data?.error || `HTTP ${resp.status}` };
    }
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Parseo client-side básico de un certificado X.509 PEM para extraer la
 * fecha de vencimiento. Hace minimal ASN.1 parsing — alcanza para sacar
 * el `notAfter` (UTCTime).
 *
 * Devuelve null si el PEM no parsea (ej. archivo corrupto). El usuario
 * puede cargarlo igual y el server fallará al pegarle a AFIP — al menos
 * no rompemos la UX por un parse temprano.
 */
export function parsearCertVencimiento(pem: string): string | null {
  try {
    // Sacar header/footer + decode base64
    const cleaned = pem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
    if (!cleaned) return null;

    const bin = atob(cleaned);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    // Buscar el primer SEQUENCE (0x30) → tbsCertificate
    // tbsCertificate.validity es el 4to o 5to elemento del SEQUENCE interno.
    // En lugar de ASN.1 completo, buscamos pattern: 0x17 0x0D <YY MM DD HH MM SS Z>
    // (UTCTime de 13 bytes). Hay 2 UTCTime: notBefore y notAfter.
    // Tomamos el SEGUNDO encontrado.
    let count = 0;
    for (let i = 0; i < bytes.length - 14; i++) {
      if (bytes[i] === 0x17 && bytes[i + 1] === 0x0D) {
        count++;
        if (count === 2) {
          // notAfter encontrado
          const ascii = Array.from(bytes.slice(i + 2, i + 14))
            .map((b) => String.fromCharCode(b))
            .join('');
          // Formato YYMMDDHHMMSS — interpretamos YY ≥ 50 como 19xx, sino 20xx
          const yy = parseInt(ascii.slice(0, 2));
          const yyyy = yy >= 50 ? 1900 + yy : 2000 + yy;
          const mm = ascii.slice(2, 4);
          const dd = ascii.slice(4, 6);
          return `${yyyy}-${mm}-${dd}`;
        }
      }
    }

    // También probamos GeneralizedTime (0x18) para certs con notAfter después de 2049
    let countG = 0;
    for (let i = 0; i < bytes.length - 16; i++) {
      if (bytes[i] === 0x18 && bytes[i + 1] === 0x0F) {
        countG++;
        if (countG === 2) {
          const ascii = Array.from(bytes.slice(i + 2, i + 17))
            .map((b) => String.fromCharCode(b))
            .join('');
          const yyyy = ascii.slice(0, 4);
          const mm = ascii.slice(4, 6);
          const dd = ascii.slice(6, 8);
          return `${yyyy}-${mm}-${dd}`;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
