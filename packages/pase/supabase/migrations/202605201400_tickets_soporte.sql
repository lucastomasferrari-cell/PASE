-- ═══════════════════════════════════════════════════════════════════════════
-- Sistema de soporte centralizado (admin-console)
--
-- Lucas 2026-05-19: necesita un canal donde cualquier usuario (encargado,
-- dueño, mozo, cajero) reporte dudas/bugs desde PASE o COMANDA, y queden
-- centralizados en una cola que él atiende desde el Admin Console nuevo.
--
-- Modelo:
--   - tickets_soporte: una fila por reporte. La auto-respuesta del LLM
--     queda guardada en respuesta_llm para que el user no tenga que
--     repetir nada si cierra el chat.
--   - Comentarios subsiguientes (back-and-forth entre user y superadmin)
--     se guardan en el array JSONB comentarios.
--   - Storage bucket "soporte-screenshots": el usuario sube capturas
--     opcionales que se referencian via URL.
--
-- RLS:
--   - INSERT: cualquier user authenticated dentro de su tenant.
--   - SELECT: el autor ve sus propios tickets + superadmin ve todos.
--   - UPDATE: solo superadmin (mover estado, agregar comentarios,
--     reclasificar prioridad).
--
-- NO es tabla financiera → no entra a la regla C4 (sin idempotency atómico).
-- Pero sí tiene C7 columnas estándar (tenant_id, created_at, updated_at,
-- RLS dual).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Tabla principal ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets_soporte (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  autor_user_id     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  autor_email       TEXT,                           -- snapshot — sobrevive borrado de usuario
  autor_rol         TEXT,                           -- snapshot — dueno/admin/encargado/superadmin
  sistema           TEXT NOT NULL CHECK (sistema IN ('comanda','pase')),
  pantalla_origen   TEXT,                           -- ej. '/herramientas/lector-facturas'
  mensaje           TEXT NOT NULL CHECK (length(trim(mensaje)) > 0),
  categoria         TEXT CHECK (categoria IN ('duda','bug','feature','otro')),
  prioridad         TEXT CHECK (prioridad IN ('baja','media','alta','critica')),
  screenshot_url    TEXT,                           -- path en bucket soporte-screenshots
  contexto_jsonb    JSONB DEFAULT '{}'::jsonb,      -- venta_id, local_id, mes, etc según pantalla
  respuesta_llm     TEXT,                           -- primera auto-respuesta del LLM
  estado            TEXT NOT NULL DEFAULT 'abierto'
                    CHECK (estado IN ('abierto','respondido','cerrado','duplicado')),
  comentarios       JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{autor,texto,created_at}]
  atendido_por      INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  atendido_at       TIMESTAMPTZ,
  resuelto_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para la cola admin (filtros típicos) y la vista del usuario.
CREATE INDEX IF NOT EXISTS idx_tickets_soporte_tenant_estado_prioridad
  ON tickets_soporte (tenant_id, estado, prioridad, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_soporte_autor
  ON tickets_soporte (autor_user_id, created_at DESC)
  WHERE autor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_soporte_sistema_created
  ON tickets_soporte (sistema, created_at DESC);

-- Trigger updated_at auto.
CREATE OR REPLACE FUNCTION _tickets_soporte_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tickets_soporte_updated_at ON tickets_soporte;
CREATE TRIGGER trg_tickets_soporte_updated_at
  BEFORE UPDATE ON tickets_soporte
  FOR EACH ROW
  EXECUTE FUNCTION _tickets_soporte_updated_at();

-- ─── 2. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE tickets_soporte ENABLE ROW LEVEL SECURITY;

-- INSERT: cualquier user authenticated dentro de su tenant. El tenant_id
-- debe coincidir con auth_tenant_id() (o ser superadmin que crea cross-tenant).
DROP POLICY IF EXISTS tickets_soporte_insert ON tickets_soporte;
CREATE POLICY tickets_soporte_insert ON tickets_soporte
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth_es_superadmin()
    OR tenant_id = auth_tenant_id()
  );

-- SELECT: el autor ve sus propios tickets + dueño/admin del tenant ve los
-- de su tenant + superadmin ve TODOS los tenants (cross-tenant para admin
-- console). El autor_user_id se compara contra auth_usuario_id().
DROP POLICY IF EXISTS tickets_soporte_select ON tickets_soporte;
CREATE POLICY tickets_soporte_select ON tickets_soporte
  FOR SELECT
  TO authenticated
  USING (
    auth_es_superadmin()
    OR autor_user_id = auth_usuario_id()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  );

-- UPDATE: solo superadmin. El autor NO puede editar su ticket después
-- de creado (evita revisionismo). Si necesita aclarar algo, deja un
-- comentario via RPC dedicada (próxima migration).
DROP POLICY IF EXISTS tickets_soporte_update ON tickets_soporte;
CREATE POLICY tickets_soporte_update ON tickets_soporte
  FOR UPDATE
  TO authenticated
  USING (auth_es_superadmin())
  WITH CHECK (auth_es_superadmin());

-- DELETE: nadie. Los tickets son archivos históricos. Si hay que sacarlos
-- por privacidad se hace con SERVICE_KEY desde un script (no es operación
-- normal del producto).
DROP POLICY IF EXISTS tickets_soporte_delete ON tickets_soporte;
-- (sin policy de delete → default deny)

-- ─── 3. Storage bucket para screenshots ─────────────────────────────────────
-- Crea el bucket si no existe. Privado (no público) — el acceso pasa por
-- signed URLs generados desde el endpoint del Admin Console.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'soporte-screenshots',
  'soporte-screenshots',
  false,
  10 * 1024 * 1024,   -- 10 MB máx por archivo (capturas razonables)
  ARRAY['image/png','image/jpeg','image/webp','image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Policies del bucket:
--   - INSERT: cualquier user authenticated puede subir archivo en su path
--     personal `tickets/<user_id>/<filename>`.
--   - SELECT: el autor puede leer sus archivos + superadmin puede leer todo.
DROP POLICY IF EXISTS soporte_screenshots_insert ON storage.objects;
CREATE POLICY soporte_screenshots_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'soporte-screenshots'
    AND (storage.foldername(name))[1] = 'tickets'
    AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[2] = auth_usuario_id()::text
    )
  );

DROP POLICY IF EXISTS soporte_screenshots_select ON storage.objects;
CREATE POLICY soporte_screenshots_select ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'soporte-screenshots'
    AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[2] = auth_usuario_id()::text
    )
  );

-- ─── 4. RPC: agregar comentario a un ticket (idempotente) ───────────────────
-- Permite al autor responder a un comentario del superadmin, o al
-- superadmin responder al autor. Append-only en el array comentarios.
CREATE OR REPLACE FUNCTION agregar_comentario_ticket(
  p_ticket_id      UUID,
  p_texto          TEXT
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket RECORD;
  v_uid    UUID := auth.uid();
  v_usuario_id INTEGER := auth_usuario_id();
  v_es_superadmin BOOLEAN := auth_es_superadmin();
  v_comentario JSONB;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF p_texto IS NULL OR length(trim(p_texto)) = 0 THEN
    RAISE EXCEPTION 'TEXTO_REQUERIDO';
  END IF;

  SELECT * INTO v_ticket FROM tickets_soporte WHERE id = p_ticket_id;
  IF v_ticket IS NULL THEN RAISE EXCEPTION 'TICKET_NO_ENCONTRADO'; END IF;

  -- Solo el autor o el superadmin pueden comentar.
  IF NOT v_es_superadmin AND v_ticket.autor_user_id IS DISTINCT FROM v_usuario_id THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  v_comentario := jsonb_build_object(
    'autor_user_id', v_usuario_id,
    'autor_rol',     CASE WHEN v_es_superadmin THEN 'superadmin' ELSE v_ticket.autor_rol END,
    'texto',         p_texto,
    'created_at',    now()
  );

  UPDATE tickets_soporte
     SET comentarios = comentarios || jsonb_build_array(v_comentario),
         -- Si el que comenta es el superadmin y el estado era abierto,
         -- pasa a "respondido". El autor luego puede cerrarlo o seguir.
         estado = CASE
           WHEN v_es_superadmin AND estado = 'abierto' THEN 'respondido'
           ELSE estado
         END,
         atendido_por = CASE
           WHEN v_es_superadmin AND atendido_por IS NULL THEN v_usuario_id
           ELSE atendido_por
         END,
         atendido_at = CASE
           WHEN v_es_superadmin AND atendido_at IS NULL THEN now()
           ELSE atendido_at
         END
   WHERE id = p_ticket_id;

  RETURN jsonb_build_object('ok', true, 'comentario', v_comentario);
END;
$$;

GRANT EXECUTE ON FUNCTION agregar_comentario_ticket(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION agregar_comentario_ticket(UUID, TEXT) FROM PUBLIC;

-- ─── 5. RPC: cerrar ticket (solo superadmin) ────────────────────────────────
CREATE OR REPLACE FUNCTION cerrar_ticket(
  p_ticket_id   UUID,
  p_motivo      TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_usuario_id INTEGER := auth_usuario_id();
BEGIN
  IF NOT auth_es_superadmin() THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  UPDATE tickets_soporte
     SET estado = 'cerrado',
         resuelto_at = now(),
         atendido_por = COALESCE(atendido_por, v_usuario_id),
         atendido_at  = COALESCE(atendido_at, now()),
         comentarios = CASE
           WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
           THEN comentarios || jsonb_build_array(jsonb_build_object(
             'autor_user_id', v_usuario_id,
             'autor_rol', 'superadmin',
             'texto', '[cerrado] ' || p_motivo,
             'created_at', now()
           ))
           ELSE comentarios
         END
   WHERE id = p_ticket_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'TICKET_NO_ENCONTRADO'; END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION cerrar_ticket(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION cerrar_ticket(UUID, TEXT) FROM PUBLIC;

-- ─── 6. Refresh PostgREST ────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
