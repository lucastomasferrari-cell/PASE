-- CAMBIO 2: Tabla config_categorias para gestión dinámica de categorías
-- Ejecutar en Supabase SQL Editor

CREATE TABLE IF NOT EXISTS config_categorias (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,
  nombre TEXT NOT NULL,
  activo BOOLEAN DEFAULT true,
  orden INTEGER DEFAULT 0
);

-- Seed con los valores actuales
INSERT INTO config_categorias (tipo, nombre, orden) VALUES
-- Gastos Fijos
('gasto_fijo','ALQUILER',1),('gasto_fijo','EDESUR',2),('gasto_fijo','METROGAS',3),
('gasto_fijo','AYSA',4),('gasto_fijo','INTERNET',5),('gasto_fijo','MAXIREST',6),
('gasto_fijo','WOKI',7),('gasto_fijo','SEGURO',8),('gasto_fijo','FUMIGACION',9),
('gasto_fijo','ABL',10),('gasto_fijo','EXPENSAS',11),('gasto_fijo','AQA',12),
('gasto_fijo','CONTADOR',13),('gasto_fijo','OTROS FIJOS',14),
-- Gastos Variables
('gasto_variable','COMPRAS MERCADO LIBRE',1),('gasto_variable','ENVIOS',2),
('gasto_variable','LIBRERIA',3),('gasto_variable','BAZAR',4),
('gasto_variable','FARMACIA',5),('gasto_variable','MANTENIMIENTO',6),
('gasto_variable','EQUIPAMIENTO',7),('gasto_variable','DEVOLUCIONES CLIENTES',8),
('gasto_variable','PERSONAL',9),('gasto_variable','AJUSTE',10),
('gasto_variable','GASTOS VARIOS',11),
-- Publicidad
('gasto_publicidad','PIMENTON',1),('gasto_publicidad','COMMUNITY MANAGER',2),
('gasto_publicidad','PRENSA Y PAUTA FB',3),('gasto_publicidad','FOTOGRAFIA Y ACCIONES',4),
('gasto_publicidad','RAPPI CUOTA ADS',5),('gasto_publicidad','OTRAS PUBLICIDAD',6),
-- Impuestos
('gasto_impuesto','IVA',1),('gasto_impuesto','IIBB',2),
('gasto_impuesto','RETENCIONES',3),('gasto_impuesto','MONOTRIBUTO / AUTONOMOS',4),
('gasto_impuesto','SELLOS',5),('gasto_impuesto','OTROS IMPUESTOS',6),
-- Comisiones
('gasto_comision','MERCADOPAGO',1),('gasto_comision','RAPPI',2),
('gasto_comision','PEDIDOS YA',3),('gasto_comision','MASDELIVERY',4),
('gasto_comision','BANCARIAS NAVE',5),('gasto_comision','COMPENSACIONES',6),
('gasto_comision','OTRAS COMISIONES',7),
-- Medios de cobro
('medio_cobro','EFECTIVO SALON',1),('medio_cobro','TARJETA CREDITO',2),
('medio_cobro','TARJETA DEBITO',3),('medio_cobro','QR',4),
('medio_cobro','LINK',5),('medio_cobro','RAPPI ONLINE',6),
('medio_cobro','PEYA ONLINE',7),('medio_cobro','PEYA EFECTIVO',8),
('medio_cobro','MP DELIVERY',9),('medio_cobro','BIGBOX',10),
('medio_cobro','FANBAG',11),('medio_cobro','EVENTO',12),
('medio_cobro','TRANSFERENCIA',13),('medio_cobro','Point MP',14),
('medio_cobro','Point Nave',15),('medio_cobro','NAVE',16),
('medio_cobro','MASDELIVERY ONLINE',17),('medio_cobro','EFECTIVO DELIVERY',18),
-- Categorías de compra
('cat_compra','PESCADERIA',1),('cat_compra','CARNICERIA',2),
('cat_compra','VERDULERIA',3),('cat_compra','BEBIDAS',4),
('cat_compra','VINOS',5),('cat_compra','ALMACEN',6),
('cat_compra','PACKAGING',7),('cat_compra','PAPELERIA',8),
('cat_compra','BARRIO CHINO',9),('cat_compra','PRODUCTOS ORIENTALES',10),
('cat_compra','SUPERMERCADO',11),('cat_compra','HIELO',12),
('cat_compra','LIMPIEZA',13),('cat_compra','CONTADOR',14),
('cat_compra','PUBLICIDAD',15),('cat_compra','EXPENSAS',16),
('cat_compra','PROPINAS',17),('cat_compra','SUSHIMAN PM',18),
('cat_compra','EQUIPAMIENTO',19),('cat_compra','SUELDOS',20),('cat_compra','OTROS',21);

ALTER TABLE config_categorias ENABLE ROW LEVEL SECURITY;
CREATE POLICY "config_all" ON config_categorias FOR ALL USING (true) WITH CHECK (true);
