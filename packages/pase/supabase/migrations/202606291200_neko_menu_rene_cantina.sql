-- ============================================================
-- Carga de menú Rene Cantina (local_id = 5, tenant slug = 'neko')
-- Borra TODO el menú existente del tenant y recrea desde cero.
-- Corriendo: pega en Supabase SQL Editor > Run.
-- ============================================================

DO $$
DECLARE
  v_tid   UUID;
  v_lid   INTEGER := 5;            -- Rene Cantina

  -- Grupos
  g_ent   INTEGER;  -- Entradas
  g_comb  INTEGER;  -- Combinados
  g_re    INTEGER;  -- Rolls Especiales
  g_nori  INTEGER;  -- Noritacos
  g_sash  INTEGER;  -- Sashimis
  g_nigi  INTEGER;  -- Nigiris
  g_poke  INTEGER;  -- Pokes
  g_cev   INTEGER;  -- Ceviches
  g_tira  INTEGER;  -- Tiraditos
  g_sal   INTEGER;  -- Salsas
  g_rc    INTEGER;  -- Rolls Clásicos

  -- Modifier groups
  mg_esp  INTEGER;  -- x10 / x5 (precio_madre=26500, x5 resta 13000)
  mg_ny   INTEGER;  -- x10 / x5 (Classic NY: precio_madre=24500, x5 resta 12000)

  -- Items que necesitan modificador de tamaño
  i_dostruchas INTEGER;
  i_crispyebi  INTEGER;
  i_nakamoto   INTEGER;
  i_yakiniku   INTEGER;
  i_limaroll   INTEGER;
  i_classicny  INTEGER;

BEGIN
  SELECT id INTO v_tid FROM tenants WHERE slug = 'neko';
  IF v_tid IS NULL THEN
    RAISE EXCEPTION 'Tenant neko no encontrado';
  END IF;

  -- ── Limpieza (orden inverso a FK) ─────────────────────────────────
  DELETE FROM item_modifier_groups  WHERE tenant_id = v_tid;
  DELETE FROM modifiers             WHERE tenant_id = v_tid;
  DELETE FROM modifier_groups       WHERE tenant_id = v_tid;
  DELETE FROM item_precios_canal    WHERE tenant_id = v_tid;
  DELETE FROM items                 WHERE tenant_id = v_tid;
  DELETE FROM item_grupos           WHERE tenant_id = v_tid;

  -- ── Grupos ────────────────────────────────────────────────────────
  INSERT INTO item_grupos(tenant_id,local_id,nombre,orden) VALUES (v_tid,v_lid,'Entradas',1)        RETURNING id INTO g_ent;
  INSERT INTO item_grupos(tenant_id,local_id,nombre,orden) VALUES (v_tid,v_lid,'Combinados',2)       RETURNING id INTO g_comb;
  INSERT INTO item_grupos(tenant_id,local_id,nombre,orden) VALUES (v_tid,v_lid,'Rolls Especiales',3) RETURNING id INTO g_re;
  INSERT INTO item_grupos(tenant_id,local_id,nombre,orden) VALUES (v_tid,v_lid,'Noritacos',4)        RETURNING id INTO g_nori;
  INSERT INTO item_grupos(tenant_id,local_id,nombre,orden) VALUES (v_tid,v_lid,'Sashimis',5)         RETURNING id INTO g_sash;
  INSERT INTO item_grupos(tenant_id,local_id,nombre,orden) VALUES (v_tid,v_lid,'Nigiris',6)          RETURNING id INTO g_nigi;
  INSERT INTO item_grupos(tenant_id,local_id,nombre,orden) VALUES (v_tid,v_lid,'Pokes',7)            RETURNING id INTO g_poke;
  INSERT INTO item_grupos(tenant_id,local_id,nombre,orden) VALUES (v_tid,v_lid,'Ceviches',8)         RETURNING id INTO g_cev;
  INSERT INTO item_grupos(tenant_id,local_id,nombre,orden) VALUES (v_tid,v_lid,'Tiraditos',9)        RETURNING id INTO g_tira;
  INSERT INTO item_grupos(tenant_id,local_id,nombre,orden) VALUES (v_tid,v_lid,'Salsas',10)          RETURNING id INTO g_sal;
  INSERT INTO item_grupos(tenant_id,local_id,nombre,orden) VALUES (v_tid,v_lid,'Rolls Clásicos',11)  RETURNING id INTO g_rc;

  -- ── Modifier groups + opciones ────────────────────────────────────
  -- Rolls Especiales: x10=$26.500 / x5=$13.500 → diff=$13.000
  INSERT INTO modifier_groups(tenant_id,local_id,nombre,tipo,requerido,min_seleccion,max_seleccion)
    VALUES (v_tid,v_lid,'Porciones','opcion',true,1,1)
    RETURNING id INTO mg_esp;
  INSERT INTO modifiers(tenant_id,modifier_group_id,nombre,precio_extra,orden) VALUES
    (v_tid, mg_esp, 'x10 (10 piezas)',      0, 1),
    (v_tid, mg_esp, 'x5 (5 piezas)',   -13000, 2);

  -- Classic NY: x10=$24.500 / x5=$12.500 → diff=$12.000
  INSERT INTO modifier_groups(tenant_id,local_id,nombre,tipo,requerido,min_seleccion,max_seleccion)
    VALUES (v_tid,v_lid,'Porciones Clásicos','opcion',true,1,1)
    RETURNING id INTO mg_ny;
  INSERT INTO modifiers(tenant_id,modifier_group_id,nombre,precio_extra,orden) VALUES
    (v_tid, mg_ny, 'x10 (10 piezas)',      0, 1),
    (v_tid, mg_ny, 'x5 (5 piezas)',   -12000, 2);

  -- ── ENTRADAS ──────────────────────────────────────────────────────
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden) VALUES
    (v_tid,v_lid,'Empanada de mariscos',
      'Empanada frita rellena de mariscos.',
      g_ent, 8000, 1),
    (v_tid,v_lid,'Croquetas con pesca curada y katsuobushi',
      'Croquetas rellenas de bechamel al ají amarillo, cubiertas de sashimi de pesca curada y escamas de katsuobushi. x4.',
      g_ent, 17500, 2);

  -- ── COMBINADOS ────────────────────────────────────────────────────
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden) VALUES
    (v_tid,v_lid,'Combinado Deluxe x16',
      '5 piezas Kunsei Roll · 5 piezas Crispy Roll · 2 Nigiris Blanco Nikkei · 2 Nigiris Roku · 1 Noritaco Garlic · 1 Noritaco Aji Amarillo',
      g_comb, 44500, 1),
    (v_tid,v_lid,'Sashimi Moriawase x10',
      NULL,
      g_comb, 22500, 2),
    (v_tid,v_lid,'Combinado Fusion x16',
      '3 Nigiris clásicos de trucha · 3 Nigiris Garlic · 5 piezas Crispy Ebi Roll · 5 piezas Avocado Roll',
      g_comb, 40000, 3),
    (v_tid,v_lid,'Combinado Fusion x32',
      'Crispy Ebi x5 · Avocado Roll x5 · Nakamoto x5 · Lima x5 · Nigiri Trucha x3 · Nigiri Ají Amarillo x3 · Nigiri Garlic x3 · Nigiri Blanco Nikkei x3',
      g_comb, 75500, 4),
    (v_tid,v_lid,'Box de Nigiris Omakase x20',
      '20 piezas · 4 variedades a elección del sushiman',
      g_comb, 69000, 5),
    (v_tid,v_lid,'Combinado Clásico x32',
      'Mango Roll x5 · Tartar Roll x5 · Patagonia Roll x5 · Avocado Roll x5 · 3 Nigiri Trucha · 3 Nigiri Nikkei · 3 Nigiri Blanco · 3 Nigiri Garlic',
      g_comb, 69000, 6),
    (v_tid,v_lid,'Box Rolls Omakase x20',
      '20 piezas · 4 variedades a elección del sushiman',
      g_comb, 53500, 7),
    (v_tid,v_lid,'Box Noritacos x4',
      '4 noritacos · 2 variedades a elección del sushiman',
      g_comb, 38000, 8),
    (v_tid,v_lid,'Combinado Deluxe x32',
      'Kunsei Roll x5 · Crispy Ebi x5 · Dos Truchas x5 · Lima Roll x5 · Noritaco Garlic x2 · Noritaco Ají Amarillo x2 · Nigiri Roku x2 · Nigiri Blanco Nikkei x2 · Nigiri Trufado x2 · Nigiri Lima x2',
      g_comb, 86500, 9),
    (v_tid,v_lid,'Combinado Clásico x16',
      'Patagonia Roll x5 · Mango Roll x5 · 3 Nigiri Trucha · 3 Nigiri Blanco',
      g_comb, 36000, 10);

  -- ── ROLLS ESPECIALES — items sin variante de tamaño ───────────────
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden) VALUES
    (v_tid,v_lid,'Nori Furai',
      'Palta, tartar de trucha, teriyaki. 5 piezas.',
      g_re, 14500, 1),
    (v_tid,v_lid,'Kunsei Roll',
      'Trucha, palta, cobertura de trucha, salsa de rocoto, tare y quinoa crocante. 10 piezas.',
      g_re, 26500, 6),
    (v_tid,v_lid,'Truffle Roll',
      'Relleno de tartar de trucha y palta, cobertura de carpaccio de vieiras, con salsa ponzu trufada. 10 piezas.',
      g_re, 29500, 7);

  -- Rolls con modificador x5/x10
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden)
    VALUES (v_tid,v_lid,'Dos Truchas',
      'Tartar de trucha, palta, cobertura de trucha, salsa nikkei, furikake.',
      g_re, 26500, 2)
    RETURNING id INTO i_dostruchas;

  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden)
    VALUES (v_tid,v_lid,'Crispy Ebi',
      'Langostino furai, palta, queso, trucha, spicy maracuyá, hilos de papa crocante.',
      g_re, 26500, 3)
    RETURNING id INTO i_crispyebi;

  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden)
    VALUES (v_tid,v_lid,'Nakamoto Roll',
      'Langostino furai, palta, queso, cobertura de trucha sopleteada con salsa abura, salsa terinikkei, masa filo.',
      g_re, 26500, 4)
    RETURNING id INTO i_nakamoto;

  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden)
    VALUES (v_tid,v_lid,'Yakiniku Roll',
      'Trucha, palta y queso, cubiertos de mango sopleteado con salsa yakiniku, coco tostado y chili jam.',
      g_re, 26500, 5)
    RETURNING id INTO i_yakiniku;

  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden)
    VALUES (v_tid,v_lid,'Lima Roll',
      'Trucha y palta, cubierta de trucha sopleteada con salsa anticuchera, topping de salsa acevichada, cilantro, maíz canchita, cebolla en pluma.',
      g_re, 26500, 8)
    RETURNING id INTO i_limaroll;

  -- Vincular modifier de porciones
  INSERT INTO item_modifier_groups(tenant_id,item_id,modifier_group_id,orden) VALUES
    (v_tid, i_dostruchas, mg_esp, 1),
    (v_tid, i_crispyebi,  mg_esp, 1),
    (v_tid, i_nakamoto,   mg_esp, 1),
    (v_tid, i_yakiniku,   mg_esp, 1),
    (v_tid, i_limaroll,   mg_esp, 1);

  -- ── NORITACOS ─────────────────────────────────────────────────────
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden) VALUES
    (v_tid,v_lid,'Nori Taco Ají Amarillo',
      'Taco de alga nori furai, base de arroz, tartar de trucha, salsa de ají amarillo, aceite de sésamo y chalaca peruana.',
      g_nori, 11000, 1),
    (v_tid,v_lid,'Nori Taco Anticuchero',
      'Taco de alga nori furai, con base de arroz, langostinos salteados en salsa anticuchera, aceite de trufa, palta, mayo de rocoto y chalaca peruana.',
      g_nori, 11000, 2),
    (v_tid,v_lid,'Nori Taco Truffle',
      'Taco de alga nori furai, base de arroz, tartar de trucha, vieyras, ponzu trufada, ciboulette.',
      g_nori, 14000, 3),
    (v_tid,v_lid,'Nori Taco Vieyras',
      'Taco de alga nori furai, base de arroz, vieyras con manteca thai, salsa spicy maracuyá y ciboulette.',
      g_nori, 14000, 4),
    (v_tid,v_lid,'Nori Taco Garlic',
      'Taco de alga nori, base de arroz, tartar de pesca blanca, salsa terinikkei, palta, ciboulette.',
      g_nori, 11000, 5);

  -- ── SASHIMIS ──────────────────────────────────────────────────────
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden) VALUES
    (v_tid,v_lid,'Sashimi Trucha',     '5 piezas.', g_sash, 16000, 1),
    (v_tid,v_lid,'Sashimi Pesca Blanca','5 piezas.', g_sash, 11000, 2);

  -- ── NIGIRIS (todos vienen x2) ─────────────────────────────────────
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden) VALUES
    (v_tid,v_lid,'Nigiri Ají Amarillo',
      '2 unidades · Nigiri de trucha, salsa de ají amarillo, chalaquita.',
      g_nigi, 10250, 1),
    (v_tid,v_lid,'Nigiri Pesca Salvaje',
      '2 unidades · Nigiri clásico de pesca salvaje.',
      g_nigi,  9500, 2),
    (v_tid,v_lid,'Nigiri Nikkei',
      '2 unidades · Nigiri de trucha, salsa nikkei, furikake.',
      g_nigi, 10250, 3),
    (v_tid,v_lid,'Nigiri Trucha',
      '2 unidades · Nigiri clásico de trucha.',
      g_nigi,  9700, 4),
    (v_tid,v_lid,'Nigiri Blanco Nikkei',
      '2 unidades · Nigiri de pesca salvaje, salsa nikkei, furikake.',
      g_nigi, 10250, 5),
    (v_tid,v_lid,'Nigiri Garlic',
      '2 unidades · Nigiri de pesca salvaje con láminas de ajo crocante, almendras, aceite de sésamo.',
      g_nigi, 10250, 6),
    (v_tid,v_lid,'Nigiri Lima',
      '2 unidades · Nigiri de trucha sopleteada en salsa anticuchera, salsa acevichada, criolla chalaca.',
      g_nigi, 10250, 7),
    (v_tid,v_lid,'Nigiri Roku',
      '2 unidades · Nigiri de trucha, mayo de rocoto, abura y chalaca peruana.',
      g_nigi, 10250, 8);

  -- ── POKES ─────────────────────────────────────────────────────────
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden) VALUES
    (v_tid,v_lid,'Poke Crispy',
      'Shari, langostinos furai, trucha, palta, queso, hilos de papa, salsa spicy maracuyá.',
      g_poke, 28000, 1),
    (v_tid,v_lid,'Poke Classic',
      'Shari, trucha, queso, palta y sésamo.',
      g_poke, 28000, 2),
    (v_tid,v_lid,'Poke Dos Truchas',
      'Shari, sashimi de trucha, tartar de trucha, palta, salsa nikkei y furikake.',
      g_poke, 28000, 3);

  -- ── CEVICHES ──────────────────────────────────────────────────────
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden) VALUES
    (v_tid,v_lid,'Ceviche Wasabi',
      '200 gr de pesca salvaje y langostinos blanqueados, leche de tigre agridulce al wasabi, cebolla, furikake.',
      g_cev, 30500, 1),
    (v_tid,v_lid,'Ceviche Carretillero',
      'Pesca salvaje 200 gr, leche de tigre clásica, batata, choclo, maíz canchita, cebolla.',
      g_cev, 27250, 2),
    (v_tid,v_lid,'Ceviche Rocoto',
      '200 gr de langostinos blanqueados y trucha, en leche de tigre cremosa de rocoto, batata, cebolla, aceite de togarashi.',
      g_cev, 36000, 3),
    (v_tid,v_lid,'Mini Ceviche Wasabi',
      '90 g de pesca salvaje y langostinos con leche de tigre agridulce al wasabi y furikake. Picante bajo.',
      g_cev, 16500, 4),
    (v_tid,v_lid,'Mini Ceviche Rocoto',
      '90 g de trucha, langostinos y vieyras con leche de tigre cremosa de ají rocoto, batata y aceite de togarashi. Picante medio.',
      g_cev, 20500, 5),
    (v_tid,v_lid,'Mini Ceviche Clásico',
      '90 g de pesca salvaje con batata, maíz canchita y choclo. No pica.',
      g_cev, 14500, 6);

  -- ── TIRADITOS ─────────────────────────────────────────────────────
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden) VALUES
    (v_tid,v_lid,'Tiradito Trucha Maracuyá',
      '10 cortes de trucha con salsa spicy maracuyá, hilos de masa filo crocante.',
      g_tira, 21000, 1);

  -- ── SALSAS ────────────────────────────────────────────────────────
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden) VALUES
    (v_tid,v_lid,'Dip Salsa Maracuyá',  NULL, g_sal, 1200, 1),
    (v_tid,v_lid,'Dip Salsa Teriyaki',  NULL, g_sal, 1200, 2),
    (v_tid,v_lid,'Dip Salsa Nikkei',    NULL, g_sal, 1200, 3);

  -- ── ROLLS CLÁSICOS — sin variante ─────────────────────────────────
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden) VALUES
    (v_tid,v_lid,'Avocado Roll',
      'Relleno de trucha y palta · sésamo blanco. 10 piezas.',
      g_rc, 24500, 1),
    (v_tid,v_lid,'Mango Roll',
      'Relleno de langostino furai, queso y palta, cobertura de mango. 10 piezas.',
      g_rc, 24500, 3),
    (v_tid,v_lid,'Patagonia Roll',
      'Relleno de trucha y queso · sésamo negro. 10 piezas.',
      g_rc, 24500, 4),
    (v_tid,v_lid,'Tartar Roll',
      'Relleno de tartar de trucha y palta · ciboulette. 10 piezas.',
      g_rc, 24500, 5);

  -- Classic NY con modificador de tamaño
  INSERT INTO items(tenant_id,local_id,nombre,descripcion,grupo_id,precio_madre,orden)
    VALUES (v_tid,v_lid,'Classic NY',
      'Roll relleno de trucha, queso phila y palta.',
      g_rc, 24500, 2)
    RETURNING id INTO i_classicny;

  INSERT INTO item_modifier_groups(tenant_id,item_id,modifier_group_id,orden)
    VALUES (v_tid, i_classicny, mg_ny, 1);

  RAISE NOTICE '✓ Menú Rene Cantina cargado. Tenant: %, Local: %, Items: %',
    v_tid, v_lid,
    (SELECT count(*) FROM items WHERE tenant_id = v_tid);
END $$;
