# Pruebas manuales pendientes — Lucas

Tareas que NO son código y requieren tu intervención (configurar env vars, comprar/conseguir hardware, testear con dispositivos reales). Acumuladas durante los sprints de mayo 2026.

---

## 🛒 Marketplace (sprint 19-may, ya en producción)

### 1. Resend para emails al cliente
- [ ] Crear cuenta en [resend.com](https://resend.com) (free 100/día)
- [ ] Verificar dominio (DKIM + SPF) — ej. `neko.com.ar`
- [ ] Cargar env vars en Vercel proyecto `pase-yndx`:
  - `RESEND_API_KEY=re_XXXXXXXXX`
  - `RESEND_FROM="Neko <pedidos@neko.com.ar>"`
- [ ] Smoke test: hacer un pedido en `/tienda/{slug}` con email → verificar que llegue "Recibimos tu pedido"

### 2. Activar locales reales al marketplace
Para que un local aparezca en `/marketplace`:
```sql
UPDATE comanda_local_settings
SET tienda_activa = TRUE,
    visible_marketplace = TRUE,
    slug = 'mi-local'
WHERE local_id = <ID>;
```
- [ ] Completar dirección/lat/lon/radio_delivery_km desde `Configuración → Local` en COMANDA

### 3. Dominio del marketplace
- [ ] Decidir: subdominio (`pedi.neko.com.ar`) vs dominio nuevo
- [ ] Vercel proyecto COMANDA → Settings → Domains → Add
- [ ] Cargar CNAME en DNS

### 4. Smoke test cliente real
- [ ] Pedido completo desde celular: cargar carrito → checkout → email → POS aprueba → tracking → review

---

## 🖨️ Impresoras (sprint 19-may, código listo)

### 5. Build del Print Agent + distribución
- [ ] Tener Node 22.x (no 24+) instalado
- [ ] `pnpm install` desde la raíz
- [ ] `pnpm --filter @pase/print-agent dist:win` → genera `.exe` ~85 MB
- [ ] Test en VM Windows 10 limpia: doble click instalador → wizard → ventana aparece → status verde

### 6. Subir installer a hosting
- [ ] Crear bucket Supabase Storage `print-agent-releases` (público)
- [ ] Drag-and-drop el `.exe` + `latest.yml` (electron-builder genera)
- [ ] Actualizar URL del botón en `HardwareImpresoras.tsx` (hoy apunta a Vercel)

### 7. Code signing (opcional)
- [ ] Comprar certificado EV ($200/año SSL.com) cuando quieras evitar warning SmartScreen
- [ ] Configurar `CSC_LINK` + `CSC_KEY_PASSWORD` en CI

### 8. Test con hardware real
- [ ] Conseguir Xprinter genérica USB ($100-150 USD MercadoLibre)
- [ ] Instalar driver Windows ("POS-58" o "POS-80")
- [ ] Configurar desde COMANDA → Hardware → Impresoras → USB auto-detect
- [ ] "Imprimir prueba" → ticket debe salir
- [ ] Hacer un pedido marketplace → aprobar → ver que sale comanda de cocina

---

## 🛵 Delivery + Tracking (sprint 20-may, código listo)

### 9. Cron token para auto-entrega emails
- [ ] Generar token aleatorio (32 chars hex)
- [ ] Cargar env var en Vercel: `CRON_TOKEN=...`
- [ ] Configurar cron externo (GitHub Actions / cron-job.org) cada 2min:
  ```
  POST https://pase-yndx.vercel.app/api/tienda-mp?action=cron-process-delivered
  Header: X-Cron-Token: <token>
  ```
- Sin esto, los pedidos auto-entregados por geofencing NO disparan email "calificá".

### 10. Test rider end-to-end
- [ ] Crear rider desde `/hardware/riders`
- [ ] Copiar el link generado → abrirlo en tu celular
- [ ] Dar permiso GPS → tocar "Empezar turno"
- [ ] Hacer pedido delivery de prueba
- [ ] POS → aprobar → `/online/dispatch` → asignar el rider al pedido
- [ ] Caminar (o mover el celu) hasta lat/lon del cliente
- [ ] Verificar: pasados 5 min en radio < 200m, se marca `entregada` automático
- [ ] Cliente recibe email "calificá" (si el cron está configurado)

### 11. Geocoding de pedidos
- [ ] Hacer pedidos nuevos para que tengan `cliente_lat`/`cliente_lon` (los viejos no aparecen en el mapa).
- [ ] Opcional: configurar `VITE_GOOGLE_MAPS_KEY` para precision sub-metro (GeoRef tiene ~50m de error).

---

## 🌐 Pre-deploy

### 12. Smoke test completo en producción
Una vez activado todo:
1. Abrir `/marketplace` desde celular real (no incógnito)
2. Permitir geolocalización → ordenar por cercanía
3. Click en una card → catálogo + populares
4. Carrito → checkout → datos + ETA dinámico
5. "Programar para más tarde" (probar +30min)
6. Confirmar → email "recibimos tu pedido"
7. Como dueño: aprobar → email "salió tu pedido"
8. Asignar rider → ver moto en mapa cliente
9. Marcar entregado → email "calificá"
10. Cliente deja review → admin modera → aparece en card del marketplace
