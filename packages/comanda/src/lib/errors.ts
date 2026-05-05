// Traduce errores RPC del backend a mensajes para el usuario.
// Convención: las RPC lanzan EXCEPTION 'CODIGO_UPPER_SNAKE'.

const TRADUCCIONES: Record<string, string> = {
  SIN_PERMISO_AUMENTO_MASIVO: 'No tenés permiso para aplicar aumento masivo.',
  SIN_PERMISO_MARCAR_AGOTADO: 'No tenés permiso para marcar items como agotados.',
  SIN_PERMISO_MARCAR_DISPONIBLE: 'No tenés permiso para reactivar items.',
  ITEM_NO_ENCONTRADO: 'El item no existe o no es accesible.',
  REDONDEO_INVALIDO: 'El valor de redondeo no es válido.',
  TENANT_NEKO_NOT_FOUND: 'No se encontró el tenant — contactar soporte.',
};

export function translateError(err: { message?: string } | null | undefined): string {
  const raw = (err?.message ?? '').trim();
  if (!raw) return 'Error desconocido.';
  for (const [code, msg] of Object.entries(TRADUCCIONES)) {
    if (raw.includes(code)) return msg;
  }
  return raw;
}
