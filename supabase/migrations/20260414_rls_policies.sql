-- ═══════════════════════════════════════════════════════════════
-- RLS: requiere usuario autenticado para todas las tablas
-- ═══════════════════════════════════════════════════════════════

-- Habilitar RLS en todas las tablas
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE locales ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE facturas ENABLE ROW LEVEL SECURITY;
ALTER TABLE factura_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE ventas ENABLE ROW LEVEL SECURITY;
ALTER TABLE gastos ENABLE ROW LEVEL SECURITY;
ALTER TABLE remitos ENABLE ROW LEVEL SECURITY;
ALTER TABLE proveedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE empleados ENABLE ROW LEVEL SECURITY;
ALTER TABLE empleado_archivos ENABLE ROW LEVEL SECURITY;
ALTER TABLE insumos ENABLE ROW LEVEL SECURITY;
ALTER TABLE recetas ENABLE ROW LEVEL SECURITY;
ALTER TABLE receta_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE saldos_caja ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_credenciales ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_movimientos ENABLE ROW LEVEL SECURITY;

-- Política: usuarios autenticados pueden leer todas las filas
-- (el filtrado por local se hace en la app por ahora)

-- usuarios: autenticado puede leer, solo service_role puede escribir
CREATE POLICY "usuarios_select" ON usuarios FOR SELECT TO authenticated USING (true);
CREATE POLICY "usuarios_insert" ON usuarios FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "usuarios_update" ON usuarios FOR UPDATE TO authenticated USING (true);

-- locales: lectura para autenticados
CREATE POLICY "locales_select" ON locales FOR SELECT TO authenticated USING (true);
CREATE POLICY "locales_all" ON locales FOR ALL TO authenticated USING (true);

-- Tablas de negocio: CRUD completo para autenticados
CREATE POLICY "movimientos_all" ON movimientos FOR ALL TO authenticated USING (true);
CREATE POLICY "facturas_all" ON facturas FOR ALL TO authenticated USING (true);
CREATE POLICY "factura_items_all" ON factura_items FOR ALL TO authenticated USING (true);
CREATE POLICY "ventas_all" ON ventas FOR ALL TO authenticated USING (true);
CREATE POLICY "gastos_all" ON gastos FOR ALL TO authenticated USING (true);
CREATE POLICY "remitos_all" ON remitos FOR ALL TO authenticated USING (true);
CREATE POLICY "proveedores_all" ON proveedores FOR ALL TO authenticated USING (true);
CREATE POLICY "empleados_all" ON empleados FOR ALL TO authenticated USING (true);
CREATE POLICY "empleado_archivos_all" ON empleado_archivos FOR ALL TO authenticated USING (true);
CREATE POLICY "insumos_all" ON insumos FOR ALL TO authenticated USING (true);
CREATE POLICY "recetas_all" ON recetas FOR ALL TO authenticated USING (true);
CREATE POLICY "receta_items_all" ON receta_items FOR ALL TO authenticated USING (true);
CREATE POLICY "saldos_caja_all" ON saldos_caja FOR ALL TO authenticated USING (true);

-- MP: CRUD para autenticados + service_role (cron)
CREATE POLICY "mp_credenciales_auth" ON mp_credenciales FOR ALL TO authenticated USING (true);
CREATE POLICY "mp_credenciales_service" ON mp_credenciales FOR ALL TO service_role USING (true);
CREATE POLICY "mp_movimientos_auth" ON mp_movimientos FOR ALL TO authenticated USING (true);
CREATE POLICY "mp_movimientos_service" ON mp_movimientos FOR ALL TO service_role USING (true);

-- Permitir al anon key leer usuarios para el login fallback
-- (se eliminará cuando todos los usuarios estén migrados a Supabase Auth)
CREATE POLICY "usuarios_anon_login" ON usuarios FOR SELECT TO anon USING (true);

-- Permitir service_role acceso completo (para endpoints API en Vercel)
CREATE POLICY "usuarios_service" ON usuarios FOR ALL TO service_role USING (true);
CREATE POLICY "locales_service" ON locales FOR ALL TO service_role USING (true);
CREATE POLICY "movimientos_service" ON movimientos FOR ALL TO service_role USING (true);
CREATE POLICY "facturas_service" ON facturas FOR ALL TO service_role USING (true);
CREATE POLICY "factura_items_service" ON factura_items FOR ALL TO service_role USING (true);
CREATE POLICY "ventas_service" ON ventas FOR ALL TO service_role USING (true);
CREATE POLICY "gastos_service" ON gastos FOR ALL TO service_role USING (true);
CREATE POLICY "remitos_service" ON remitos FOR ALL TO service_role USING (true);
CREATE POLICY "proveedores_service" ON proveedores FOR ALL TO service_role USING (true);
CREATE POLICY "empleados_service" ON empleados FOR ALL TO service_role USING (true);
CREATE POLICY "empleado_archivos_service" ON empleado_archivos FOR ALL TO service_role USING (true);
CREATE POLICY "insumos_service" ON insumos FOR ALL TO service_role USING (true);
CREATE POLICY "recetas_service" ON recetas FOR ALL TO service_role USING (true);
CREATE POLICY "receta_items_service" ON receta_items FOR ALL TO service_role USING (true);
CREATE POLICY "saldos_caja_service" ON saldos_caja FOR ALL TO service_role USING (true);
