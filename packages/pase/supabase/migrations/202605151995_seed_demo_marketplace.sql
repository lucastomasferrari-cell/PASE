-- ─── Seed demo: activa Local Prueba 2 en marketplace + agrega fotos a items ─
-- Pone al local 7 visible en /marketplace con descripción + tags + foto de
-- portada, y rellena foto_url de los items existentes con imágenes
-- generadas por loremflickr (servicio público, URL estable por lock).
--
-- Solo actualiza items donde foto_url IS NULL (no pisa fotos custom).
-- Si el local 7 no existe o tiene otro id, ajustar antes de correr.

-- 1. Activar local en marketplace
UPDATE locales
SET
  visible_marketplace = TRUE,
  marketplace_descripcion = 'Sushi premium con delivery en CABA. Rolls clásicos y de autor, sashimi fresco, sake y postres japoneses. Pedí online y recibí en 35 min.',
  marketplace_tags = ARRAY['Sushi', 'Japonesa', 'Delivery', 'Apto celíaco', 'Premium'],
  marketplace_foto_url = 'https://loremflickr.com/1200/750/sushi,restaurant?lock=1001'
WHERE id = 7;

-- 2. Fotos para items existentes (solo si NULL — no pisa fotos del user)
-- Loremflickr URL: https://loremflickr.com/{w}/{h}/{tag1,tag2}?lock={id}
-- lock=N congela la imagen (siempre la misma para ese N).

-- Sushi rolls (matching por nombre LIKE)
UPDATE items SET foto_url = 'https://loremflickr.com/400/300/sushi,roll,salmon?lock=' || id::TEXT
WHERE local_id = 7 AND foto_url IS NULL AND deleted_at IS NULL
  AND (nombre ILIKE '%roll%' OR nombre ILIKE '%philadelphia%' OR nombre ILIKE '%california%' OR nombre ILIKE '%salmon%' OR nombre ILIKE '%avocado%');

-- Niguiri / Sashimi
UPDATE items SET foto_url = 'https://loremflickr.com/400/300/sashimi,japanese?lock=' || id::TEXT
WHERE local_id = 7 AND foto_url IS NULL AND deleted_at IS NULL
  AND (nombre ILIKE '%niguiri%' OR nombre ILIKE '%sashimi%' OR nombre ILIKE '%tartar%');

-- Sake
UPDATE items SET foto_url = 'https://loremflickr.com/400/300/sake,japanese,drink?lock=' || id::TEXT
WHERE local_id = 7 AND foto_url IS NULL AND deleted_at IS NULL
  AND nombre ILIKE '%sake%';

-- Cerveza
UPDATE items SET foto_url = 'https://loremflickr.com/400/300/beer,sapporo?lock=' || id::TEXT
WHERE local_id = 7 AND foto_url IS NULL AND deleted_at IS NULL
  AND (nombre ILIKE '%cerveza%' OR nombre ILIKE '%sapporo%');

-- Bebidas no alcohólicas
UPDATE items SET foto_url = 'https://loremflickr.com/400/300/cola,drink,glass?lock=' || id::TEXT
WHERE local_id = 7 AND foto_url IS NULL AND deleted_at IS NULL
  AND (nombre ILIKE '%coca%' OR nombre ILIKE '%cola%' OR nombre ILIKE '%t[eé]%');

-- Postres japoneses
UPDATE items SET foto_url = 'https://loremflickr.com/400/300/mochi,dessert,japanese?lock=' || id::TEXT
WHERE local_id = 7 AND foto_url IS NULL AND deleted_at IS NULL
  AND (nombre ILIKE '%mochi%' OR nombre ILIKE '%helado%' OR nombre ILIKE '%cheesecake%');

-- Entradas (Gyozas, Sopa Miso, Edamame)
UPDATE items SET foto_url = 'https://loremflickr.com/400/300/gyoza,dumpling,asian?lock=' || id::TEXT
WHERE local_id = 7 AND foto_url IS NULL AND deleted_at IS NULL
  AND (nombre ILIKE '%gyoza%' OR nombre ILIKE '%dumpling%');

UPDATE items SET foto_url = 'https://loremflickr.com/400/300/miso,soup,japanese?lock=' || id::TEXT
WHERE local_id = 7 AND foto_url IS NULL AND deleted_at IS NULL
  AND nombre ILIKE '%miso%';

UPDATE items SET foto_url = 'https://loremflickr.com/400/300/edamame,bean,japanese?lock=' || id::TEXT
WHERE local_id = 7 AND foto_url IS NULL AND deleted_at IS NULL
  AND nombre ILIKE '%edamame%';

-- Pizza (item extra que no es sushi pero existe en el seed)
UPDATE items SET foto_url = 'https://loremflickr.com/400/300/pizza,napoletana?lock=' || id::TEXT
WHERE local_id = 7 AND foto_url IS NULL AND deleted_at IS NULL
  AND nombre ILIKE '%pizza%';

-- Fallback: items sin match específico → foto genérica de comida
UPDATE items SET foto_url = 'https://loremflickr.com/400/300/food,asian?lock=' || id::TEXT
WHERE local_id = 7 AND foto_url IS NULL AND deleted_at IS NULL;

-- 3. Verificación (info, no afecta nada)
DO $$
DECLARE
  v_total INTEGER;
  v_con_foto INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_total FROM items WHERE local_id = 7 AND deleted_at IS NULL;
  SELECT COUNT(*) INTO v_con_foto FROM items WHERE local_id = 7 AND deleted_at IS NULL AND foto_url IS NOT NULL;
  RAISE NOTICE 'Items local 7: % con foto de % totales', v_con_foto, v_total;
END $$;
