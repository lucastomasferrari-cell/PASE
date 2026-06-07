-- 202606071500_bandeja_conciliacion_backend.sql
-- Pieza A — Bandeja conciliadora · Fase 1 (backend).
-- Spec: docs/superpowers/specs/2026-06-07-bandeja-conciliacion-compras-insumos-design.md
--
-- 1. fn_normalizar_texto: normaliza el texto de un producto (lower+unaccent+trim).
-- 2. Extiende el trigger de stock para disparar también al SETEAR materia_prima_id
--    (hoy solo dispara en INSERT; la bandeja vincula con UPDATE).
-- 3. fn_trg_factura_item_automatch (BEFORE INSERT): auto-vincula renglones a una
--    materia prima si ya hay un mapeo aprendido (compras_mapeo).
-- 4. fn_conciliar_producto: resuelve un producto de la bandeja — escribe el mapeo
--    y vincula TODOS los renglones pendientes con ese mismo producto.
-- 5. fn_descartar_renglon: marca un renglón como "no es insumo".
-- 6. v_bandeja_conciliacion: vista de pendientes para la UI.

-- ── 1. Normalización de texto ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_normalizar_texto(p text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
  SELECT NULLIF(regexp_replace(lower(unaccent(trim(COALESCE(p, '')))), '\s+', ' ', 'g'), '');
$$;

-- ── 2. Trigger de stock: que dispare también en UPDATE de materia_prima_id ──
-- La función fn_trg_factura_item_entrada_stock ya chequea NULL + idempotencia,
-- así que sumarle el evento UPDATE es seguro (no duplica).
DROP TRIGGER IF EXISTS trg_factura_item_entrada_stock ON factura_items;
CREATE TRIGGER trg_factura_item_entrada_stock
  AFTER INSERT OR UPDATE OF materia_prima_id ON factura_items
  FOR EACH ROW EXECUTE FUNCTION fn_trg_factura_item_entrada_stock();

-- ── 3. Auto-match al insertar un renglón ──────────────────────────────────
CREATE OR REPLACE FUNCTION fn_trg_factura_item_automatch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_texto text;
  v_prov  integer;
  v_mp    bigint;
BEGIN
  -- Ya vinculado (ej. modal manual lo mandó con materia prima) → no tocar.
  IF NEW.materia_prima_id IS NOT NULL THEN RETURN NEW; END IF;
  v_texto := fn_normalizar_texto(NEW.producto);
  IF v_texto IS NULL THEN RETURN NEW; END IF;

  SELECT f.prov_id INTO v_prov FROM facturas f WHERE f.id = NEW.factura_id;

  -- Mapeo aprendido: prioriza el específico del proveedor sobre el global.
  SELECT cm.materia_prima_id INTO v_mp
  FROM compras_mapeo cm
  WHERE cm.tenant_id = NEW.tenant_id
    AND cm.texto_norm = v_texto
    AND (cm.proveedor_id = v_prov OR cm.proveedor_id IS NULL)
  ORDER BY (cm.proveedor_id = v_prov) DESC NULLS LAST
  LIMIT 1;

  IF v_mp IS NOT NULL THEN
    NEW.materia_prima_id := v_mp;   -- el trigger AFTER hará la entrada de stock
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_factura_item_automatch ON factura_items;
CREATE TRIGGER trg_factura_item_automatch
  BEFORE INSERT ON factura_items
  FOR EACH ROW EXECUTE FUNCTION fn_trg_factura_item_automatch();

-- ── 4. Conciliar un producto (resolver desde la bandeja) ──────────────────
CREATE OR REPLACE FUNCTION fn_conciliar_producto(
  p_materia_prima_id bigint,
  p_producto         text,
  p_proveedor_id     integer DEFAULT NULL,
  p_global           boolean DEFAULT false,
  p_idempotency_key  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
  v_texto  text;
  v_prov   integer;
  v_count  integer;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('compras')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  v_texto := fn_normalizar_texto(p_producto);
  IF v_texto IS NULL THEN RAISE EXCEPTION 'PRODUCTO_INVALIDO'; END IF;

  -- La materia prima debe ser del tenant.
  PERFORM 1 FROM materias_primas WHERE id = p_materia_prima_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'MATERIA_PRIMA_NO_ENCONTRADA'; END IF;

  v_prov := CASE WHEN p_global THEN NULL ELSE p_proveedor_id END;

  -- Escribir/actualizar la memoria de mapeo.
  INSERT INTO compras_mapeo (tenant_id, proveedor_id, texto_norm, materia_prima_id, created_by)
  VALUES (v_tenant, v_prov, v_texto, p_materia_prima_id, auth_usuario_id())
  ON CONFLICT (tenant_id, COALESCE(proveedor_id, 0), texto_norm)
  DO UPDATE SET materia_prima_id = EXCLUDED.materia_prima_id,
                updated_at = now(),
                created_by = EXCLUDED.created_by;

  -- Vincular todos los renglones pendientes con ese mismo producto
  -- (mismo proveedor, o cualquiera si es mapeo global). El UPDATE dispara
  -- el trigger de entrada de stock por cada renglón.
  UPDATE factura_items fi
     SET materia_prima_id = p_materia_prima_id
  FROM facturas f
  WHERE fi.factura_id = f.id
    AND fi.tenant_id = v_tenant
    AND fi.materia_prima_id IS NULL
    AND fi.descartado_conciliacion = false
    AND fn_normalizar_texto(fi.producto) = v_texto
    AND (p_global OR f.prov_id IS NOT DISTINCT FROM p_proveedor_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'materia_prima_id', p_materia_prima_id,
    'texto_norm', v_texto,
    'renglones_vinculados', v_count,
    'global', p_global
  );
END;
$$;

REVOKE ALL ON FUNCTION fn_conciliar_producto(bigint, text, integer, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_conciliar_producto(bigint, text, integer, boolean, text) TO authenticated;

-- ── 5. Descartar un renglón ("no es insumo") ──────────────────────────────
CREATE OR REPLACE FUNCTION fn_descartar_renglon(
  p_factura_item_id integer,
  p_descartar       boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('compras')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  UPDATE factura_items
     SET descartado_conciliacion = p_descartar
   WHERE id = p_factura_item_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'RENGLON_NO_ENCONTRADO'; END IF;

  RETURN jsonb_build_object('factura_item_id', p_factura_item_id, 'descartado', p_descartar);
END;
$$;

REVOKE ALL ON FUNCTION fn_descartar_renglon(integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_descartar_renglon(integer, boolean) TO authenticated;

-- ── 6. Vista de la bandeja ────────────────────────────────────────────────
-- security_invoker: aplica la RLS de las tablas base al usuario que consulta.
CREATE OR REPLACE VIEW v_bandeja_conciliacion
WITH (security_invoker = true) AS
SELECT
  fi.id                AS factura_item_id,
  fi.tenant_id,
  fi.factura_id,
  fi.producto,
  fi.cantidad,
  fi.unidad,
  fi.precio_unitario,
  fi.subtotal,
  f.prov_id            AS proveedor_id,
  pr.nombre            AS proveedor_nombre,
  f.fecha              AS factura_fecha,
  f.local_id,
  f.cat                AS categoria,
  cc.grupo             AS grupo_categoria,
  fn_normalizar_texto(fi.producto) AS texto_norm,
  (SELECT cm.materia_prima_id
     FROM compras_mapeo cm
    WHERE cm.tenant_id = fi.tenant_id
      AND cm.texto_norm = fn_normalizar_texto(fi.producto)
      AND (cm.proveedor_id = f.prov_id OR cm.proveedor_id IS NULL)
    ORDER BY (cm.proveedor_id = f.prov_id) DESC NULLS LAST
    LIMIT 1)           AS sugerencia_mp_id
FROM factura_items fi
JOIN facturas f          ON f.id = fi.factura_id
LEFT JOIN proveedores pr ON pr.id = f.prov_id
LEFT JOIN config_categorias cc ON cc.tenant_id = f.tenant_id AND cc.nombre = f.cat
WHERE fi.materia_prima_id IS NULL
  AND fi.descartado_conciliacion = false;

NOTIFY pgrst, 'reload schema';
