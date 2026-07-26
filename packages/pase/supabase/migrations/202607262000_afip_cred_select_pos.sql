-- ═══════════════════════════════════════════════════════════════════════════
-- AFIP — permitir al POS leer si AFIP está activo (RLS)
-- Sesión 2026-07-26
--
-- Bug: en el POS el botón Factura mostraba "AFIP no está activo en este tenant"
-- aunque en Configuración figure activo. Causa: la policy afip_cred_select sólo
-- permitía SELECT a dueño/admin/superadmin. La sesión del POS corre con
-- permisos de cajero (el rol "Dueño" que se ve es el empleado, no el usuario
-- Supabase) → no podía leer afip_credenciales → getCredencialesAFIP devolvía
-- null → el POS creía que AFIP estaba apagado.
--
-- Fix: cualquier miembro del tenant puede leer las columnas NO SECRETAS de
-- afip_credenciales (activa, punto_venta, tipo_contribuyente, ambiente, cuit,
-- vencimiento). El certificado y la clave privada NO se exponen: siguen
-- protegidos por el GRANT a nivel de columna (sólo service_role los lee), que
-- es independiente de esta policy de fila. Ver migración 202605190400.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS afip_cred_select ON afip_credenciales;
CREATE POLICY afip_cred_select ON afip_credenciales FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR tenant_id = auth_tenant_id()
  );

NOTIFY pgrst, 'reload schema';
