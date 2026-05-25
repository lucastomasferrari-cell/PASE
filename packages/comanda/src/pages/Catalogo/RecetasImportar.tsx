import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Download, Upload, Eye, Check, AlertTriangle, FileText } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  importarRecetasBulk,
  parsearCsvRecetas,
  type LineaImportRecetas,
  type ReporteImport,
} from '@/services/recetasService';

// Importador masivo de recetas desde CSV/Excel.
//
// FLOW:
//   1) Descargar template (Excel) o pegar CSV directo
//   2) Click "Validar" → llama RPC con dry_run=true → muestra reporte
//   3) Si OK + usuario confirma → click "Importar" → dry_run=false
//
// Acelera el onboarding inicial. Sin esto, cargar 100 recetas manuales lleva
// 1 día completo. Con esto: 10 minutos armando el Excel + 1 click.
//
// Decisiones de diseño:
//   - CSV plano (no JSON): el dueño lo arma en Excel y exporta como CSV.
//   - Soporta `,` y `;` (Excel ES usa `;`) — detección automática.
//   - Items e insumos faltantes se crean al vuelo con valores mínimos
//     (precio_plato del CSV / costo=0). Después se editan desde las
//     pantallas normales de Insumos/Items.
//   - Idempotente: reimportar el mismo CSV NO duplica recetas. Si el item
//     ya tiene receta activa, la marca inactiva (versionado) y crea nueva.

const TEMPLATE_CSV = `plato,ingrediente,cantidad,unidad,merma_pct,precio_plato
Sushi Salmón,Salmón rosado,0.05,kg,30,4500
Sushi Salmón,Arroz,0.1,kg,0,
Sushi Salmón,Alga nori,1,un,0,
Ramen Tonkotsu,Caldo cerdo,0.4,L,0,6200
Ramen Tonkotsu,Fideos,0.15,kg,0,
`;

export function RecetasImportar() {
  const navigate = useNavigate();
  const [csvText, setCsvText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [lineas, setLineas] = useState<LineaImportRecetas[]>([]);
  const [reporte, setReporte] = useState<ReporteImport | null>(null);
  const [running, setRunning] = useState(false);
  const [importedOk, setImportedOk] = useState(false);

  // Idempotency key estable por CSV — si el usuario hace click 2 veces no
  // duplica. Cambia cuando cambia el contenido del textarea.
  const idemKey = useMemo(() => {
    if (!csvText.trim()) return null;
    // Hash simple del contenido (no crypto, solo para idempotency)
    let h = 0;
    for (let i = 0; i < csvText.length; i++) {
      h = ((h << 5) - h + csvText.charCodeAt(i)) | 0;
    }
    return `csv-${h}-${Date.now().toString().slice(0, -4)}`; // bucket de 10s
  }, [csvText]);

  const descargarTemplate = () => {
    const blob = new Blob([TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'template_recetas.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const onFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
    setReporte(null);
    setImportedOk(false);
  };

  const validar = async () => {
    if (!csvText.trim()) {
      toast.error('Pegá el CSV o cargá un archivo');
      return;
    }
    setRunning(true);
    setReporte(null);

    // 1) parsear cliente-side
    const p = parsearCsvRecetas(csvText);
    if (p.error) {
      setParseError(p.error);
      setRunning(false);
      toast.error(`Parse: ${p.error}`);
      return;
    }
    setParseError(null);
    setLineas(p.data);

    // 2) dry-run en servidor
    const r = await importarRecetasBulk(p.data, { dryRun: true });
    setRunning(false);
    if (r.error) {
      toast.error(r.error);
      return;
    }
    setReporte(r.data);
    if (r.data?.ok) {
      toast.success(`Validación OK: ${r.data.recetas_a_crear} recetas listas para importar`);
    } else {
      toast.warning(`${r.data?.errores?.length ?? 0} errores — corregilos y volvé a validar`);
    }
  };

  const importar = async () => {
    if (!reporte?.ok || !lineas.length) return;
    if (!confirm(`Vas a crear ${reporte.recetas_a_crear} recetas, ${reporte.items_a_crear} items y ${reporte.insumos_a_crear} insumos. ¿Confirmás?`)) return;
    setRunning(true);
    const r = await importarRecetasBulk(lineas, {
      dryRun: false,
      idempotencyKey: idemKey ?? undefined,
    });
    setRunning(false);
    if (r.error) {
      toast.error(`Importar: ${r.error}`);
      return;
    }
    setReporte(r.data);
    setImportedOk(true);
    toast.success(`Importado: ${r.data?.recetas_creadas} recetas creadas`);
  };

  return (
    <div className="container py-6 max-w-4xl">
      <header className="mb-5 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/menu/recetas')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Importar recetas</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cargá un Excel/CSV con muchas recetas a la vez. Crea items e insumos faltantes automáticamente.
          </p>
        </div>
      </header>

      {/* PASO 1: descarga del template + carga */}
      <Card className="mb-4">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-sm">1. Armá el CSV</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Descargá el template, abrilo en Excel, completá una fila por ingrediente.
                Una receta puede tener varias filas. El <code>precio_plato</code> solo en la primera fila de cada plato.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={descargarTemplate}>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Template
            </Button>
          </div>

          <div className="border-t pt-4 space-y-3">
            <h3 className="font-semibold text-sm">2. Pegalo acá o subí el archivo</h3>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
              className="text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:cursor-pointer cursor-pointer"
            />
            <Textarea
              value={csvText}
              onChange={(e) => { setCsvText(e.target.value); setReporte(null); setImportedOk(false); }}
              placeholder="plato,ingrediente,cantidad,unidad,merma_pct,precio_plato&#10;Sushi Salmón,Salmón rosado,0.05,kg,30,4500&#10;Sushi Salmón,Arroz,0.1,kg,0,&#10;..."
              rows={8}
              className="font-mono text-xs"
            />
            {parseError && (
              <div className="text-sm text-destructive flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" /> {parseError}
              </div>
            )}
          </div>

          <div className="border-t pt-4 flex items-center gap-2">
            <Button onClick={validar} disabled={running || !csvText.trim() || importedOk}>
              <Eye className="h-3.5 w-3.5 mr-1.5" />
              {running ? 'Validando…' : '3. Validar (no toca DB)'}
            </Button>
            {reporte && reporte.ok && !importedOk && (
              <Button onClick={importar} disabled={running} variant="default" className="bg-success text-success-foreground hover:bg-success/90">
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                {running ? 'Importando…' : '4. Importar todo'}
              </Button>
            )}
            {importedOk && (
              <Button variant="outline" onClick={() => navigate('/menu/recetas')}>
                <Check className="h-3.5 w-3.5 mr-1.5" />
                Ver recetas creadas
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* PASO 2: reporte */}
      {reporte && (
        <Card className={reporte.ok ? 'border-success/40' : 'border-destructive/40'}>
          <CardContent className="p-5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              {reporte.ok ? (
                <><Check className="h-4 w-4 text-success" /> Reporte de validación</>
              ) : (
                <><AlertTriangle className="h-4 w-4 text-destructive" /> Validación falló</>
              )}
            </h3>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <Stat label="Filas leídas" value={reporte.filas_total} />
              <Stat label="Recetas" value={importedOk ? reporte.recetas_creadas : reporte.recetas_a_crear} highlight={reporte.ok} />
              <Stat label="Items nuevos" value={importedOk ? reporte.items_creados : reporte.items_a_crear} />
              <Stat label="Insumos nuevos" value={importedOk ? reporte.insumos_creados : reporte.insumos_a_crear} />
            </div>

            {!importedOk && reporte.items_nuevos && reporte.items_nuevos.length > 0 && (
              <div className="mb-3 text-xs">
                <div className="font-medium mb-1 text-muted-foreground">Items que se crearán:</div>
                <div className="flex flex-wrap gap-1">
                  {reporte.items_nuevos.map(n => <span key={n} className="px-2 py-0.5 bg-muted rounded text-xs">{n}</span>)}
                </div>
              </div>
            )}

            {!importedOk && reporte.insumos_nuevos && reporte.insumos_nuevos.length > 0 && (
              <div className="mb-3 text-xs">
                <div className="font-medium mb-1 text-muted-foreground">Insumos que se crearán (costo $0, completar después):</div>
                <div className="flex flex-wrap gap-1">
                  {reporte.insumos_nuevos.map(n => <span key={n} className="px-2 py-0.5 bg-muted rounded text-xs">{n}</span>)}
                </div>
              </div>
            )}

            {reporte.errores.length > 0 && (
              <div className="border-t pt-3 mt-3">
                <div className="font-medium text-sm text-destructive mb-2">
                  Errores ({reporte.errores.length}) — corregí el CSV y volvé a validar
                </div>
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1.5 pr-3">Línea</th>
                      <th className="text-left py-1.5 pr-3">Error</th>
                      <th className="text-left py-1.5">Contexto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reporte.errores.map((e, i) => (
                      <tr key={i} className="border-t border-border/40">
                        <td className="py-1.5 pr-3 tabular-nums">{e.linea}</td>
                        <td className="py-1.5 pr-3 font-medium">{e.error}</td>
                        <td className="py-1.5 text-muted-foreground">
                          {e.plato && <span>plato: <code>{e.plato}</code> </span>}
                          {e.ingrediente && <span>ingr: <code>{e.ingrediente}</code> </span>}
                          {e.recibido !== undefined && <span>recibido: <code>{String(e.recibido)}</code></span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {importedOk && (
              <div className="border-t pt-3 mt-3 text-sm flex items-center gap-2 text-success">
                <Check className="h-4 w-4" />
                Importado OK. Los insumos nuevos quedaron con costo $0 — completalos desde
                <Link to="/menu/insumos" className="underline ml-1">Insumos</Link>.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="mt-5 text-xs text-muted-foreground flex items-start gap-2">
        <FileText className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
        <div>
          <strong>Tip:</strong> reimportar el mismo CSV es seguro — si una receta ya existe,
          la marca como vieja (queda histórico) y crea la versión nueva. Las unidades válidas son:
          <code className="mx-1">kg</code>, <code className="mx-1">g</code>, <code className="mx-1">L</code>,
          <code className="mx-1">ml</code>, <code className="mx-1">un</code>, <code className="mx-1">porcion</code>.
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value?: number; highlight?: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${highlight ? 'bg-success/5 border-success/30' : 'bg-muted/30'}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-bold tabular-nums mt-0.5">{value ?? 0}</div>
    </div>
  );
}
