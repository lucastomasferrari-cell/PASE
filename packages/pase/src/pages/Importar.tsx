import { useState } from "react";
import { db } from "../lib/supabase";
import { PageHeader, EmptyState, InfoTooltip, LocalLockedChip, LocalSelectorObligatorio } from "../components/ui";
import { parseCSV, downloadCSVTemplate } from "../lib/parseCSV";
import type { Local, Usuario } from "../types";

/**
 * Importar — pantalla para migrar data vieja desde Excel/CSV.
 *
 * Pedido Lucas 2026-05-17: el mayor bloqueo de adopción es cargar a mano
 * cientos de proveedores + decenas de empleados + conceptos por sucursal
 * cuando se arranca con PASE. Esta pantalla resuelve eso vía CSV bulk
 * import con preview + validación.
 *
 * Flujo por entidad:
 *   1. Descargar plantilla CSV (con headers + 1 fila ejemplo)
 *   2. Llenar en Excel/Sheets
 *   3. Subir el archivo
 *   4. Preview con validación (rojo = error, gris = warning, OK = celeste)
 *   5. Confirmar import → insert masivo
 *
 * Solo accesible para dueño/admin/superadmin. Encargados no migran data.
 */

type Tab = "proveedores" | "empleados" | "conceptos";

interface ImportarProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

export default function Importar({ user, locales, localActivo }: ImportarProps) {
  const [tab, setTab] = useState<Tab>("proveedores");

  const tabs: Array<{ id: Tab; label: string; descripcion: string }> = [
    { id: "proveedores", label: "Proveedores", descripcion: "Nombre, CUIT, categoría y saldo inicial" },
    { id: "empleados", label: "Empleados", descripcion: "Datos básicos + sueldo + fecha de inicio" },
    { id: "conceptos", label: "Conceptos de caja", descripcion: "Categorías custom para movimientos y gastos" },
  ];

  return (
    <div style={{ padding: "0 20px" }}>
      <PageHeader
        title="Importar"
        subtitle="migrar data vieja desde Excel/CSV"
        info={<>
          Descargá la plantilla, llenala en Excel o Sheets, subila acá. El sistema te muestra un preview con validaciones — recién después de revisar confirmás el import.<br /><br />
          Usá esta pantalla cuando arrancás con PASE o sumás una sucursal nueva. Para alta puntual de un proveedor/empleado usá su pantalla específica.
        </>}
      />

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, borderBottom: "0.5px solid var(--pase-border)", marginBottom: 20 }}>
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              padding: "10px 16px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              borderBottom: `2px solid ${tab === t.id ? "var(--pase-celeste)" : "transparent"}`,
              marginBottom: -0.5,
              color: tab === t.id ? "var(--pase-text)" : "var(--pase-text-muted)",
              fontWeight: tab === t.id ? 500 : 400,
              fontSize: "var(--pase-fs-base)",
              fontFamily: "var(--pase-font)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "proveedores" && <TabProveedores user={user} />}
      {tab === "empleados" && <TabEmpleados user={user} locales={locales} localActivo={localActivo} />}
      {tab === "conceptos" && <TabConceptos user={user} />}
    </div>
  );
}

// ─── helpers compartidos por todos los tabs ────────────────────────────

interface Resultado {
  ok: boolean;
  importadas: number;
  errores: string[];
}

function FileUploader({ onParsed }: { onParsed: (rows: Array<Record<string, string>>) => void }) {
  return (
    <label style={{
      display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px",
      border: "0.5px dashed var(--pase-celeste-300)", borderRadius: 8, cursor: "pointer",
      background: "var(--pase-celeste-100)", color: "var(--pase-text)",
      fontSize: "var(--pase-fs-base)", fontWeight: 500,
    }}>
      📂 Subir CSV
      <input
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={async e => {
          const file = e.target.files?.[0];
          if (!file) return;
          const text = await file.text();
          const rows = parseCSV(text);
          onParsed(rows);
          // reset para que pueda subir el mismo archivo otra vez
          e.target.value = "";
        }}
      />
    </label>
  );
}

function Resumen({ resultado, onReset }: { resultado: Resultado; onReset: () => void }) {
  return (
    <div style={{
      padding: 20, borderRadius: 10,
      background: resultado.ok ? "var(--pase-celeste-100)" : "var(--pase-bg-out)",
      border: `0.5px solid ${resultado.ok ? "var(--pase-celeste-300)" : "var(--pase-border-strong)"}`,
      marginTop: 12,
    }}>
      <strong style={{ fontSize: "var(--pase-fs-md)", color: "var(--pase-text)" }}>
        {resultado.ok ? "✓ " : "⚠ "}
        {resultado.importadas} registro{resultado.importadas === 1 ? "" : "s"} importado{resultado.importadas === 1 ? "" : "s"}
      </strong>
      {resultado.errores.length > 0 && (
        <div style={{ marginTop: 8, fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>
          <div>Errores ({resultado.errores.length}):</div>
          <ul style={{ marginTop: 4, paddingLeft: 18 }}>
            {resultado.errores.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
            {resultado.errores.length > 10 && <li>... y {resultado.errores.length - 10} más</li>}
          </ul>
        </div>
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onReset} style={{ marginTop: 12 }}>
        Importar otro archivo
      </button>
    </div>
  );
}

// ─── TAB PROVEEDORES ────────────────────────────────────────────────────

function TabProveedores({ user }: { user: Usuario }) {
  const [rows, setRows] = useState<Array<Record<string, string>> | null>(null);
  const [importing, setImporting] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  const headers = ["nombre", "cuit", "categoria", "saldo_inicial"];
  const ejemplo = { nombre: "Distribuidora Norte SRL", cuit: "30-12345678-9", categoria: "Bebidas", saldo_inicial: "0" };

  function validarRow(r: Record<string, string>): string | null {
    if (!r["nombre"] || r["nombre"].trim() === "") return "Falta nombre";
    if (r["cuit"] && !/^\d{2}-?\d{8}-?\d$/.test(r["cuit"].replace(/[\s]/g, ""))) return "CUIT inválido (formato XX-XXXXXXXX-X)";
    if (r["saldo_inicial"] && isNaN(parseFloat(r["saldo_inicial"].replace(/[^0-9.-]/g, "")))) return "Saldo inicial no numérico";
    return null;
  }

  async function importar() {
    if (!rows || !user.tenant_id) return;
    setImporting(true);
    const validRows = rows.filter(r => !validarRow(r));
    const errores: string[] = [];
    rows.forEach((r, i) => {
      const err = validarRow(r);
      if (err) errores.push(`Fila ${i + 2}: ${err} (${r["nombre"] || "(sin nombre)"})`);
    });

    const payload = validRows.map(r => ({
      tenant_id: user.tenant_id,
      nombre: r["nombre"]!.trim(),
      cuit: r["cuit"]?.trim() || null,
      cat: r["categoria"]?.trim() || null,
      saldo: parseFloat((r["saldo_inicial"] || "0").replace(/[^0-9.-]/g, "")) || 0,
      estado: "Activo",
    }));

    if (payload.length === 0) {
      setResultado({ ok: false, importadas: 0, errores });
      setImporting(false);
      return;
    }

    const { error } = await db.from("proveedores").insert(payload);
    if (error) {
      setResultado({ ok: false, importadas: 0, errores: [error.message, ...errores] });
    } else {
      setResultado({ ok: true, importadas: payload.length, errores });
      setRows(null);
    }
    setImporting(false);
  }

  return (
    <div>
      <p style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginBottom: 14 }}>
        Importá tu lista de proveedores desde un Excel/CSV. Columnas: <strong>nombre</strong> (obligatorio), <strong>cuit</strong>, <strong>categoria</strong>, <strong>saldo_inicial</strong>.
      </p>
      {!rows && !resultado && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sec" onClick={() => downloadCSVTemplate("plantilla_proveedores.csv", headers, ejemplo)}>
            ⬇ Descargar plantilla
          </button>
          <FileUploader onParsed={setRows} />
        </div>
      )}

      {rows && !resultado && (
        <PreviewTable
          rows={rows}
          headers={headers}
          validar={validarRow}
          onCancel={() => setRows(null)}
          onConfirm={importar}
          confirming={importing}
          confirmLabel={`Importar ${rows.filter(r => !validarRow(r)).length} proveedores`}
        />
      )}

      {resultado && (
        <Resumen
          resultado={resultado}
          onReset={() => { setResultado(null); setRows(null); }}
        />
      )}
    </div>
  );
}

// ─── TAB EMPLEADOS ──────────────────────────────────────────────────────

function TabEmpleados({ user, locales, localActivo }: { user: Usuario; locales: Local[]; localActivo: number | null }) {
  const [rows, setRows] = useState<Array<Record<string, string>> | null>(null);
  const [importing, setImporting] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  // Los empleados se importan a UNA sucursal — todos van a la misma. Si
  // el sidebar tiene una activa, usamos esa; si está en "Todas" (que ya no
  // existe — pero por defensa), el usuario debe elegir.
  const [localImport, setLocalImport] = useState<number | null>(localActivo);

  const headers = ["apellido", "nombre", "cuil", "puesto", "sueldo_mensual", "fecha_inicio", "alias_mp"];
  const ejemplo = { apellido: "Pérez", nombre: "Juan", cuil: "20-12345678-9", puesto: "Mozo", sueldo_mensual: "650000", fecha_inicio: "2024-03-15", alias_mp: "juan.perez.mp" };

  function validarRow(r: Record<string, string>): string | null {
    if (!r["apellido"] || r["apellido"].trim() === "") return "Falta apellido";
    if (!r["nombre"] || r["nombre"].trim() === "") return "Falta nombre";
    if (!r["puesto"] || r["puesto"].trim() === "") return "Falta puesto";
    if (!r["sueldo_mensual"] || isNaN(parseFloat(r["sueldo_mensual"]))) return "Sueldo no numérico";
    if (!r["fecha_inicio"] || !/^\d{4}-\d{2}-\d{2}$/.test(r["fecha_inicio"])) return "Fecha inicio formato YYYY-MM-DD";
    if (r["cuil"] && !/^\d{2}-?\d{8}-?\d$/.test(r["cuil"].replace(/[\s]/g, ""))) return "CUIL inválido (formato XX-XXXXXXXX-X)";
    return null;
  }

  async function importar() {
    if (!rows || !user.tenant_id || localImport == null) return;
    setImporting(true);
    const validRows = rows.filter(r => !validarRow(r));
    const errores: string[] = [];
    rows.forEach((r, i) => {
      const err = validarRow(r);
      if (err) errores.push(`Fila ${i + 2}: ${err} (${r["apellido"] || ""}, ${r["nombre"] || ""})`);
    });

    const payload = validRows.map(r => ({
      tenant_id: user.tenant_id,
      local_id: localImport,
      apellido: r["apellido"]!.trim(),
      nombre: r["nombre"]!.trim(),
      cuil: r["cuil"]?.trim() || null,
      puesto: r["puesto"]!.trim(),
      sueldo_mensual: parseFloat(r["sueldo_mensual"]!) || 0,
      fecha_inicio: r["fecha_inicio"]!,
      alias_mp: r["alias_mp"]?.trim() || null,
      activo: true,
    }));

    if (payload.length === 0) {
      setResultado({ ok: false, importadas: 0, errores });
      setImporting(false);
      return;
    }

    const { error } = await db.from("rrhh_empleados").insert(payload);
    if (error) {
      setResultado({ ok: false, importadas: 0, errores: [error.message, ...errores] });
    } else {
      setResultado({ ok: true, importadas: payload.length, errores });
      setRows(null);
    }
    setImporting(false);
  }

  return (
    <div>
      <p style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginBottom: 14 }}>
        Importá empleados a una sucursal específica. Columnas: <strong>apellido</strong>, <strong>nombre</strong>, <strong>puesto</strong>, <strong>sueldo_mensual</strong>, <strong>fecha_inicio</strong> (YYYY-MM-DD), <strong>cuil</strong> (opcional), <strong>alias_mp</strong> (opcional).
      </p>

      {/* Selector de sucursal destino — siempre debe haber una activa */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>Importar a:</span>
        {localActivo !== null ? (
          <LocalLockedChip nombre={locales.find(l => l.id === localActivo)?.nombre ?? "—"} />
        ) : (
          <LocalSelectorObligatorio
            value={localImport}
            onChange={setLocalImport}
            locales={locales}
          />
        )}
      </div>

      {!rows && !resultado && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sec" onClick={() => downloadCSVTemplate("plantilla_empleados.csv", headers, ejemplo)}>
            ⬇ Descargar plantilla
          </button>
          <FileUploader onParsed={setRows} />
        </div>
      )}

      {rows && !resultado && (
        <PreviewTable
          rows={rows}
          headers={headers}
          validar={validarRow}
          onCancel={() => setRows(null)}
          onConfirm={importar}
          confirming={importing || localImport == null}
          confirmLabel={localImport == null
            ? "Elegí una sucursal arriba"
            : `Importar ${rows.filter(r => !validarRow(r)).length} empleados a ${locales.find(l => l.id === localImport)?.nombre ?? ""}`
          }
        />
      )}

      {resultado && (
        <Resumen resultado={resultado} onReset={() => { setResultado(null); setRows(null); }} />
      )}
    </div>
  );
}

// ─── TAB CONCEPTOS DE CAJA ──────────────────────────────────────────────

function TabConceptos({ user }: { user: Usuario }) {
  const [rows, setRows] = useState<Array<Record<string, string>> | null>(null);
  const [importing, setImporting] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  const headers = ["nombre", "tipo", "grupo"];
  const ejemplo = { nombre: "Servicios públicos", tipo: "gasto_fijo", grupo: "Gastos Fijos" };

  const tiposValidos = ["gasto_fijo", "gasto_variable", "gasto_publicidad", "gasto_comisiones", "gasto_impuestos", "compra", "ingreso"];

  function validarRow(r: Record<string, string>): string | null {
    if (!r["nombre"] || r["nombre"].trim() === "") return "Falta nombre";
    if (!r["tipo"] || !tiposValidos.includes(r["tipo"])) return `Tipo inválido (debe ser: ${tiposValidos.join(", ")})`;
    return null;
  }

  async function importar() {
    if (!rows || !user.tenant_id) return;
    setImporting(true);
    const validRows = rows.filter(r => !validarRow(r));
    const errores: string[] = [];
    rows.forEach((r, i) => {
      const err = validarRow(r);
      if (err) errores.push(`Fila ${i + 2}: ${err} (${r["nombre"] || "(sin nombre)"})`);
    });

    const payload = validRows.map((r, i) => ({
      tenant_id: user.tenant_id,
      nombre: r["nombre"]!.trim(),
      tipo: r["tipo"]!,
      grupo: r["grupo"]?.trim() || null,
      orden: 100 + i,
      activo: true,
    }));

    if (payload.length === 0) {
      setResultado({ ok: false, importadas: 0, errores });
      setImporting(false);
      return;
    }

    const { error } = await db.from("config_categorias").insert(payload);
    if (error) {
      setResultado({ ok: false, importadas: 0, errores: [error.message, ...errores] });
    } else {
      setResultado({ ok: true, importadas: payload.length, errores });
      setRows(null);
    }
    setImporting(false);
  }

  return (
    <div>
      <p style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginBottom: 14 }}>
        Importá categorías custom para movimientos de caja y gastos. Columnas: <strong>nombre</strong>, <strong>tipo</strong>{" "}
        <InfoTooltip maxWidth={300} size={13}>
          Valores válidos: <code>{tiposValidos.join(", ")}</code>
        </InfoTooltip>, <strong>grupo</strong> (opcional, ej: "Gastos Fijos").
      </p>
      {!rows && !resultado && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sec" onClick={() => downloadCSVTemplate("plantilla_conceptos.csv", headers, ejemplo)}>
            ⬇ Descargar plantilla
          </button>
          <FileUploader onParsed={setRows} />
        </div>
      )}

      {rows && !resultado && (
        <PreviewTable
          rows={rows}
          headers={headers}
          validar={validarRow}
          onCancel={() => setRows(null)}
          onConfirm={importar}
          confirming={importing}
          confirmLabel={`Importar ${rows.filter(r => !validarRow(r)).length} conceptos`}
        />
      )}

      {resultado && <Resumen resultado={resultado} onReset={() => { setResultado(null); setRows(null); }} />}
    </div>
  );
}

// ─── Preview con validación ─────────────────────────────────────────────

interface PreviewProps {
  rows: Array<Record<string, string>>;
  headers: string[];
  validar: (r: Record<string, string>) => string | null;
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
  confirmLabel: string;
}

function PreviewTable({ rows, headers, validar, onCancel, onConfirm, confirming, confirmLabel }: PreviewProps) {
  const errores = rows.map(validar);
  const validos = errores.filter(e => e === null).length;
  const conError = rows.length - validos;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="⚠"
        title="CSV vacío"
        description="El archivo no tiene filas de datos (solo el header). Revisá el archivo y volvé a subir."
        cta={<button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Volver</button>}
      />
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 14, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--pase-fs-sm)" }}>
          <strong style={{ color: "var(--pase-celeste)" }}>{validos}</strong> válidos
          {conError > 0 && <> · <strong style={{ color: "#D97706" }}>{conError}</strong> con error</>}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={confirming}>Cancelar</button>
        <button type="button" className="btn btn-acc" onClick={onConfirm} disabled={confirming || validos === 0}>
          {confirming ? "Importando..." : confirmLabel}
        </button>
      </div>

      <div style={{ maxHeight: 400, overflowY: "auto", border: "0.5px solid var(--pase-border)", borderRadius: 8 }}>
        <table style={{ width: "100%", fontSize: "var(--pase-fs-sm)" }}>
          <thead>
            <tr>
              <th style={{ width: 30 }}>#</th>
              {headers.map(h => <th key={h}>{h}</th>)}
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const err = errores[i];
              return (
                <tr key={i} style={{ background: err ? "rgba(217,119,6,0.08)" : undefined }}>
                  <td style={{ color: "var(--pase-text-muted)", fontVariantNumeric: "tabular-nums" }}>{i + 2}</td>
                  {headers.map(h => <td key={h}>{r[h] || ""}</td>)}
                  <td style={{ fontSize: "var(--pase-fs-xs)" }}>
                    {err ? (
                      <span style={{ color: "#D97706" }}>⚠ {err}</span>
                    ) : (
                      <span style={{ color: "var(--pase-celeste)" }}>✓ OK</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
