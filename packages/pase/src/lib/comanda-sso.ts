// Helper para abrir COMANDA. Sin SSO bridge desde 24-may (Sprint COMANDA Autónomo).
//
// COMANDA y PASE ahora son 2 sistemas autónomos complementarios. Comparten
// Supabase Auth (mismo email+password loguea en ambos) pero los perfiles y
// permisos son separados (tabla `comanda_usuarios` vs `usuarios`).
//
// Por lo tanto el botón "Abrir COMANDA" del sidebar simplemente abre la URL
// nueva. Si el user tiene perfil COMANDA, va a poder loguearse con su mismo
// email/password. Si no, COMANDA le va a decir "Sin acceso, pedile al dueño".

const COMANDA_URL = (import.meta.env.VITE_COMANDA_URL as string | undefined)?.trim() || "";

/**
 * Abre COMANDA en una nueva tab.
 *
 * Antes (22-may → 24-may) había un SSO bridge que pasaba tokens via query
 * string. Eliminado en Fase 3 del Sprint COMANDA Autónomo: el user se
 * loguea directamente en COMANDA con su email/password (mismo Supabase
 * Auth, perfiles separados).
 *
 * @param path Ruta dentro de COMANDA (default "/"). Sin slash inicial.
 */
export async function abrirComanda(path: string = "/"): Promise<void> {
  if (!COMANDA_URL) {
    alert(
      "VITE_COMANDA_URL no configurada. En prod debería apuntar a https://pase-comanda.vercel.app.",
    );
    return;
  }
  window.open(`${COMANDA_URL}${path}`, "_blank", "noopener");
}
