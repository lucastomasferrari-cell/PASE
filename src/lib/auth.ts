export const ROLES: Record<string, { label: string; color: string; permisos: string[] }> = {
  dueno:   { label:"Dueño",    color:"#E8C547", permisos:["dashboard","ventas","compras","remitos","gastos","caja","eerr","contador","proveedores","empleados","config","maxirest","insumos","lector_ia","recetas","mp"] },
  admin:   { label:"Admin",    color:"#3B82F6", permisos:["dashboard","ventas","compras","remitos","gastos","caja","proveedores","empleados"] },
  compras: { label:"Compras",  color:"#8B5CF6", permisos:["compras","remitos","proveedores"] },
  cajero:  { label:"Cajero",   color:"#10B981", permisos:["caja","dashboard"] },
};
