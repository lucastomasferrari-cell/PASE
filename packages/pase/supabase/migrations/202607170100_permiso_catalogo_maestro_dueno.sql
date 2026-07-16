-- ============================================================
-- 202607170100_permiso_catalogo_maestro_dueno.sql
-- Nuevo permiso comanda.catalogo.maestro.editar → solo dueño.
-- Habilita la sección "Menú Marca" del sidebar admin de COMANDA y las
-- rutas /menu/maestro/* (editor del menú maestro).
--
-- Contexto (Lucas 17-jul): el manager tenía comanda.catalogo.editar y
-- podía tocar el maestro desde el dropdown de alcance, afectando a
-- todas las sucursales al importar. Separación de poderes: el maestro
-- es de la marca (dueño), la sucursal es del manager/encargado.
--
-- Impacto: solo dueño ve/edita el maestro. El resto sigue viendo su
-- sucursal desde /menu/*, sin la opción "Menú maestro" en el dropdown.
-- ============================================================

BEGIN;

INSERT INTO rol_pos_permisos (rol_pos, slug, activo) VALUES
  ('dueno', 'comanda.catalogo.maestro.editar', true)
ON CONFLICT DO NOTHING;
-- Nota: dueño ya tiene '*' (bypass total) en rol_pos_permisos, pero explícito
-- ayuda a que la UI que chequea el slug puntual con hasPermission() lo detecte
-- sin depender del bypass.

COMMIT;
