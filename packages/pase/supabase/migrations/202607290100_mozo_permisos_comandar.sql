-- Camarero/mozo (#6/#7): darle al rol_pos='mozo' los permisos MÍNIMOS para
-- comandar y nada más. Hasta ahora 'mozo' no tenía ninguna fila en
-- rol_pos_permisos → no podía ni abrir una mesa ni agregar items.
--
-- Slugs necesarios (las RPCs de comandar los exigen):
--   comanda.ventas.abrir  → abrir una venta/mesa (fn_abrir_venta_comanda)
--   comanda.ventas.cobrar → OJO nombre engañoso: gatea agregar_item, mandar_curso
--                            y modificar_item (aclaraciones). NO es "cobrar plata"
--                            (fn_agregar_pago NO tiene check). El cobro se bloquea
--                            en el frontend (botón oculto para mozo).
--   comanda.catalogo.ver  → leer el menú para poder cargar items.
--
-- El mozo NO recibe: caja, reportes, inventario, admin, ni edición de catálogo.
-- Además el frontend lo encierra en /pos/handheld (DefaultModeRedirect + guard
-- en PosLayout).

-- El CHECK de rol_pos_permisos.rol_pos no incluía 'mozo' (rol a medio integrar).
-- Lo ampliamos para permitir 'mozo' (y 'admin', que hoy funciona por bypass).
ALTER TABLE public.rol_pos_permisos DROP CONSTRAINT IF EXISTS rol_pos_permisos_rol_pos_check;
ALTER TABLE public.rol_pos_permisos ADD CONSTRAINT rol_pos_permisos_rol_pos_check
  CHECK (rol_pos = ANY (ARRAY['cajero','encargado','manager','dueno','bartender','pos_local','mozo','admin']));

INSERT INTO public.rol_pos_permisos (rol_pos, slug, activo)
SELECT v.rol_pos, v.slug, true
FROM (VALUES
  ('mozo', 'comanda.ventas.abrir'),
  ('mozo', 'comanda.ventas.cobrar'),
  ('mozo', 'comanda.catalogo.ver')
) AS v(rol_pos, slug)
WHERE NOT EXISTS (
  SELECT 1 FROM public.rol_pos_permisos r
  WHERE r.rol_pos = v.rol_pos AND r.slug = v.slug
);
