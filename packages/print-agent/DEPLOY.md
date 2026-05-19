# COMANDA Print Agent — distribución

Pasos manuales pendientes para tener el agent en producción.
Pasos automatizables ya están hechos (build + auto-update endpoint).

---

## 1. Generar el primer build local (verificar que compila)

Desde la raíz del monorepo, con Node 22.x instalado (no 24+ — `better-sqlite3` da `NODE_MODULE_VERSION mismatch`):

```bash
pnpm install
pnpm --filter @pase/print-agent dist:win
```

Tarda ~5 min. Output: `packages/print-agent/dist/COMANDA Print Agent Setup 1.0.0.exe` (~85 MB).

Probarlo en una PC limpia (idealmente VM Windows 10):
1. Doble click → "Windows protegió su PC" → "Más información" → "Ejecutar de todas formas".
2. Wizard NSIS → Next → Install.
3. Se abre la ventana del agent + aparece ícono en bandeja del sistema (esquina inferior derecha).
4. El status debe quedar "Imprimiendo OK" en verde.

## 2. Subir installer a hosting público

Hoy el botón de descarga apunta a `https://pase-yndx.vercel.app/print-agent-releases/win/COMANDA-Print-Agent-Setup.exe`. **Esa URL no existe todavía** — hay que subir el `.exe` ahí.

Opciones:
- **Subir a Vercel como static**: poner el `.exe` en `packages/pase/public/print-agent-releases/win/` y deployar. **Contra**: Vercel limita archivos estáticos a 100 MB, justo en el borde. Y cada deploy de PASE re-sube el archivo (lento).
- **Subir a Supabase Storage**: bucket público `print-agent-releases`. Lucas ya usa Supabase, costo $0 hasta 1 GB. **Recomendado.**
- **Subir a GitHub Releases**: si lo querés versionado público.

Si vas con Supabase Storage:

```sql
-- En Supabase Dashboard → Storage → New bucket
-- name: print-agent-releases, public: yes
```

Después subís el `.exe` (drag & drop), y la URL pública queda algo como:
```
https://pduxydviqiaxfqnshhdc.supabase.co/storage/v1/object/public/print-agent-releases/win/COMANDA-Print-Agent-Setup.exe
```

Actualizá `HardwareImpresoras.tsx` con esa URL en lugar de la de Vercel.

## 3. Auto-update endpoint

Si querés que los agents ya instalados se auto-actualicen:
1. Subir `latest.yml` (que genera electron-builder) junto al `.exe`.
2. El `package.json#build.publish` apunta a la base URL.
3. `electron-updater` chequea cada hora y actualiza silencioso.

Por ahora **NO es crítico** — con pocos clientes, podés mandarles un mail "bajá la nueva versión" hasta tener 50+ agents.

## 4. Code signing (cuando lo decidas)

Comprar certificado EV Windows ($200-400/año, ej. SSL.com o Comodo). Generar PKCS#12 firmado + agregar a env vars de CI:

```env
CSC_LINK=base64-encoded-p12
CSC_KEY_PASSWORD=...
```

Sin firma, los usuarios ven warning de SmartScreen una vez. Después de mucho uso, SmartScreen aprende reputation y deja de molestar — pero en el primer install va a quejarse.

## 5. Test con hardware real (Xprinter genérica)

Tu commitment fue testear con Xprinter genérica china. Setup mínimo:

1. **Comprar/conseguir**: Xprinter 58mm o 80mm USB (~$100-150 USD ML Argentina).
2. **Drivers**: la mayoría son "POS-58" o "POS-80" Windows driver — Xprinter da uno con la impresora, sino bajar de `sistemas360.ar` o similar.
3. **Validación**:
   - Instalar driver Windows (test print desde Panel de Control de impresoras → debería imprimir página de Windows).
   - Instalar el agent.
   - Abrir COMANDA → Hardware → Impresoras → Agregar → USB → si auto-detect funciona, queda. Si no, poner `vendor_id` + `product_id` viendo en Device Manager → Detalles del dispositivo → Hardware Ids.
   - Click "Imprimir prueba" → debería salir un ticket de test con dos items dummy + total.
   - Si NO sale: revisar logs del agent (Tray → Ver logs). Errores típicos:
     - "USB device not found" → el `vendor_id`/`product_id` no matchea. Auto-detect (sin vendor) suele funcionar para impresoras únicas.
     - "Printer offline" → cable suelto, papel apagado, o driver no instalado.
     - "Timeout" → puerto USB con problema (probar otro).

Si todo funciona acá, prácticamente funciona en cualquier impresora ESC/POS-compatible.

---

## Lo que ya está pusheado (resumen)

| Sprint | Qué | Commit |
|---|---|---|
| #1 | Cola SQLite + reintentos | `bde2a02` |
| #2 | Heartbeat + pantalla admin | `8bd78e5` |
| #4 | Wire-up COMANDA (cocina + reimprimir) | `cb294e7` |
| #3 | Electron wrapper + installer config | `1a22ba8` |
| #5 | UI vincular token + pantalla descarga | pendiente push |

DB ya tiene aplicada:
- `202605202700_print_agents.sql` (tabla + RPCs + vista heartbeat status).

Code listo para empaquetar. Falta solo distribución física.
