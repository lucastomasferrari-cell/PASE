-- v_bandeja_conciliacion: exponer descartados (para poder verlos/reactivarlos en Cruce)
-- Antes el WHERE filtraba descartado_conciliacion=false (desaparecían). Ahora la
-- columna se expone y el filtro se hace en el frontend, para poder mostrar los
-- "No va a receta" y traerlos de vuelta a la bandeja. (fn_descartar_renglon ya
-- soporta p_descartar=false.)

CREATE OR REPLACE VIEW public.v_bandeja_conciliacion WITH (security_invoker=true) AS
 SELECT fi.id AS factura_item_id,
    fi.tenant_id,
    fi.factura_id,
    fi.producto,
    fi.cantidad,
    fi.unidad,
    fi.precio_unitario,
    fi.subtotal,
    f.prov_id AS proveedor_id,
    pr.nombre AS proveedor_nombre,
    f.fecha AS factura_fecha,
    f.local_id,
    f.cat AS categoria,
    cc.grupo AS grupo_categoria,
    fn_normalizar_texto(fi.producto) AS texto_norm,
    ( SELECT cm.materia_prima_id
           FROM compras_mapeo cm
          WHERE cm.tenant_id = fi.tenant_id AND cm.texto_norm = fn_normalizar_texto(fi.producto) AND (cm.proveedor_id = f.prov_id OR cm.proveedor_id IS NULL)
          ORDER BY (cm.proveedor_id = f.prov_id) DESC NULLS LAST
         LIMIT 1) AS sugerencia_mp_id,
    fi.descartado_conciliacion
   FROM factura_items fi
     JOIN facturas f ON f.id = fi.factura_id
     LEFT JOIN proveedores pr ON pr.id = f.prov_id
     LEFT JOIN config_categorias cc ON cc.tenant_id = f.tenant_id AND cc.nombre = f.cat
  WHERE fi.materia_prima_id IS NULL;;
