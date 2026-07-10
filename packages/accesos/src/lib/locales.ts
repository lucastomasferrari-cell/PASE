// Filtro de locales de prueba (E2E / QA) en el panel de Accesos.
//
// "Local Prueba" / "Local Prueba 2" viven en el tenant productivo (Neko) porque
// los usan los tests mutantes/E2E de PASE, así que NO se pueden borrar. Pero en
// el panel del dueño molestan. Los ocultamos por nombre en todos los selectores
// y listas de Accesos (POS del local, ficha de persona, marcas). Un cambio acá
// se aplica en todos lados. Si algún día se marca "oculto" a nivel DB, se puede
// reemplazar este filtro por una columna.
export const RE_LOCAL_OCULTO = /prueba/i;

export function esLocalVisible(nombre: string | null | undefined): boolean {
  return !RE_LOCAL_OCULTO.test(nombre ?? '');
}
