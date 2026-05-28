import { useState, useEffect, useRef } from "react";
import { db } from "../../lib/supabase";
import { applyLocalScope } from "../../lib/auth";
import { toISO, today, fmt_d } from "../../lib/utils";
import { PageHeader, Modal } from "../../components/ui";
import { useToast } from "../../hooks/useToast";
import { ToastComponent } from "../../components/Toast";
import type { Usuario, Local } from "../../types";

interface BlindajeTipo {
  id: number;
  nombre: string;
  descripcion: string | null;
  orden: number;
}

interface BlindajeDoc {
  id: string;
  local_id: number;
  tipo_id: number;
  tipo_nombre: string;
  vencimiento: string | null;
  archivo_url: string | null;
  notas: string | null;
  estado: string;
  updated_at?: string;
}

interface BlindajeProps {
  user: Usuario | null;
  locales: Local[];
  localActivo: number | null;
}

// El modal de tipos se abre con "new" para crear o con un BlindajeTipo
// existente para editar. null = cerrado.
type TipoModalState = BlindajeTipo | "new" | null;

// El modal de documentos siempre conoce el tipo y el doc actual (puede
// ser null si es la primera vez para ese tipo).
interface DocModalState {
  tipo: BlindajeTipo;
  doc: BlindajeDoc | null;
}

const COLORES: Record<string, string> = {
  vigente: "var(--success)",
  por_vencer: "var(--warn)",
  vencido: "var(--danger)",
  sin_cargar: "var(--muted)",
};

const LABELS: Record<string, string> = {
  vigente: "Vigente",
  por_vencer: "Por vencer",
  vencido: "Vencido",
  sin_cargar: "Sin cargar",
};

const getEstado = (venc: string | null): string => {
  if (!venc) return "sin_cargar";
  const dias = Math.floor((new Date(venc + "T12:00:00").getTime() - Date.now()) / 86400000);
  if (dias < 0) return "vencido";
  if (dias <= 30) return "por_vencer";
  return "vigente";
};

export default function Blindaje({ user, locales, localActivo }: BlindajeProps) {
  const esAdmin = user?.rol === "dueno" || user?.rol === "admin";
  const { toast, showError } = useToast();
  const [tipos, setTipos] = useState<BlindajeTipo[]>([]);
  const [documentos, setDocumentos] = useState<BlindajeDoc[]>([]);
  const [loading, setLoading] = useState(true);

  const [tipoModal, setTipoModal] = useState<TipoModalState>(null);
  const [tipoForm, setTipoForm] = useState({ nombre: "", descripcion: "", orden: 0 });

  const [docModal, setDocModal] = useState<DocModalState | null>(null);
  const [docForm, setDocForm] = useState({ vencimiento: "", notas: "" });
  const [archivo, setArchivo] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const loadTipos = async () => {
    const { data } = await db.from("blindaje_tipos_documento").select("*").order("orden").order("nombre");
    setTipos((data as BlindajeTipo[]) || []);
  };

  const loadDocumentos = async () => {
    let q = db.from("blindaje_documentos").select("*");
    q = applyLocalScope(q, user, localActivo);
    const { data } = await q;
    setDocumentos((data as BlindajeDoc[]) || []);
  };

  const loadAll = async () => {
    setLoading(true);
    await Promise.all([loadTipos(), loadDocumentos()]);
    setLoading(false);
  };

  // Patrón fetch-on-dep-change. No agregar loadAll a deps (re-fetch infinito).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadAll(); }, [localActivo]);

  // ─── TIPOS ─────────────────────────────────────────────────────────────────
  const abrirTipoNuevo = () => {
    setTipoForm({ nombre: "", descripcion: "", orden: tipos.length + 1 });
    setTipoModal("new");
  };
  const abrirTipoEditar = (t: BlindajeTipo) => {
    setTipoForm({ nombre: t.nombre, descripcion: t.descripcion || "", orden: t.orden || 0 });
    setTipoModal(t);
  };
  const guardandoTipoRef = useRef(false);
  const guardarTipo = async () => {
    if (guardandoTipoRef.current) return;
    if (!tipoForm.nombre.trim()) return;
    const isEdit = tipoModal && tipoModal !== "new" && tipoModal.id;
    const payload = { nombre: tipoForm.nombre.trim(), descripcion: tipoForm.descripcion || null, orden: tipoForm.orden };
    guardandoTipoRef.current = true;
    try {
      const { error } = isEdit
        ? await db.from("blindaje_tipos_documento").update(payload).eq("id", (tipoModal as BlindajeTipo).id)
        : await db.from("blindaje_tipos_documento").insert([payload]);
      if (error) {
        if (error.code === "23505") {
          showError(`Ya existe un tipo de documento con el nombre "${payload.nombre}".`);
        } else {
          showError("No se pudo guardar: " + error.message);
        }
        return;
      }
      setTipoModal(null);
      loadTipos();
    } finally { guardandoTipoRef.current = false; }
  };

  // Eliminación real (cascade). Cuenta los documentos de TODOS los locales
  // que cargaron PDFs bajo este tipo y pide confirmación con el número.
  // Si confirma: borra los archivos del storage, los registros y el tipo.
  const eliminarTipo = async (t: BlindajeTipo) => {
    // Contamos contra DB (no contra el state local — que solo trae los del
    // localActivo via applyLocalScope). Necesitamos la cuenta global.
    const { count } = await db.from("blindaje_documentos")
      .select("*", { count: "exact", head: true })
      .eq("tipo_id", t.id);
    const n = count || 0;
    const msg = n > 0
      ? `"${t.nombre}" tiene ${n} documento${n === 1 ? "" : "s"} cargado${n === 1 ? "" : "s"}. Si continuás se borran TODOS, junto con los PDFs subidos. ¿Seguir?`
      : `Eliminar el tipo "${t.nombre}"?`;
    if (!confirm(msg)) return;

    if (n > 0) {
      // Traemos solo el archivo_url de los documentos para limpiarlos del
      // storage. La RLS puede limitar lo que vemos pero igual borramos los
      // que sí podamos — el resto queda huérfano (acceptable, no bloqueante).
      const { data: docs } = await db.from("blindaje_documentos")
        .select("id, archivo_url")
        .eq("tipo_id", t.id);
      const paths = ((docs || []) as { archivo_url: string | null }[])
        .map(d => d.archivo_url)
        .filter((x): x is string => !!x);
      if (paths.length > 0) {
        await db.storage.from("blindaje").remove(paths);
      }
      const { error: docErr } = await db.from("blindaje_documentos").delete().eq("tipo_id", t.id);
      if (docErr) { showError("No se pudieron borrar los documentos: " + docErr.message); return; }
    }
    const { error } = await db.from("blindaje_tipos_documento").delete().eq("id", t.id);
    if (error) { showError("No se pudo eliminar el tipo: " + error.message); return; }
    loadAll();
  };

  // ─── DOCUMENTOS ────────────────────────────────────────────────────────────
  const abrirDoc = (tipo: BlindajeTipo, doc: BlindajeDoc | null) => {
    setArchivo(null);
    setDocForm({
      vencimiento: doc?.vencimiento || "",
      notas: doc?.notas || "",
    });
    setDocModal({ tipo, doc });
  };

  const guardandoDocRef = useRef(false);
  const guardarDoc = async () => {
    if (guardandoDocRef.current) return;
    if (!localActivo || !docModal) return;
    const { tipo, doc } = docModal;
    const lid = parseInt(String(localActivo));
    guardandoDocRef.current = true;
    setUploading(true);

    let archivo_url = doc?.archivo_url || null;

    if (archivo) {
      const ext = (archivo.name.split(".").pop() || "bin").toLowerCase();
      const yyyymmdd = toISO(today).replace(/-/g, "");
      // AUDIT F2C #8: prefijo tenant_id obligatorio por Storage RLS.
      // Sin esto los tenants nuevos no podrían subir documentos blindaje.
      const tenantPath = user?.tenant_id ?? "superadmin";
      const path = `${tenantPath}/${lid}/${tipo.id}_${yyyymmdd}.${ext}`;
      const { error: upErr } = await db.storage.from("blindaje").upload(path, archivo, {
        contentType: archivo.type || "application/octet-stream",
        upsert: true,
      });
      if (upErr) {
        showError("Error subiendo archivo: " + upErr.message);
        setUploading(false);
        return;
      }
      archivo_url = path;
    }

    const estado = getEstado(docForm.vencimiento || null);
    const id = doc?.id || `BLIN_${lid}_${tipo.id}`;
    const payload = {
      id, local_id: lid, tipo_id: tipo.id, tipo_nombre: tipo.nombre,
      vencimiento: docForm.vencimiento || null,
      archivo_url,
      notas: docForm.notas || null,
      estado,
      updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("blindaje_documentos").upsert([payload], { onConflict: "id" });
    setUploading(false);
    guardandoDocRef.current = false;
    if (error) {
      showError("No se pudo guardar el documento: " + error.message);
      return;
    }
    setDocModal(null);
    setArchivo(null);
    loadDocumentos();
  };

  const verArchivo = async (doc: BlindajeDoc) => {
    if (!doc.archivo_url) return;
    const { data } = await db.storage.from("blindaje").createSignedUrl(doc.archivo_url, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────
  if (loading) return <div className="loading">Cargando...</div>;

  const localNombre = locales.find((l: Local) => l.id === parseInt(String(localActivo)))?.nombre || "—";

  return (
    <div>
      <ToastComponent toast={toast} />
      <PageHeader
        title="Blindaje"
        info={<>
          Gestor de documentos del local seleccionado: habilitaciones,
          contratos, seguros, etc. Estado actual: {localActivo
            ? <strong>{localNombre}</strong>
            : <em>sin local seleccionado</em>}.
        </>}
        actions={esAdmin && <button className="btn btn-acc btn-sm" onClick={abrirTipoNuevo}>+ Agregar tipo</button>}
      />

      {!localActivo ? (
        <div className="alert alert-info">Seleccioná un local en el sidebar para gestionar sus documentos.</div>
      ) : (
        <div className="panel">
          {tipos.length === 0 ? (
            <div className="empty">No hay tipos de documento configurados.{esAdmin && " Agregá uno con el botón de arriba."}</div>
          ) : (
            <table>
              <thead><tr>
                <th style={{ width: 60 }}>Orden</th>
                <th>Nombre</th>
                <th>Descripción</th>
                <th style={{ width: 110 }}>Vencimiento</th>
                <th style={{ width: 100 }}>Estado</th>
                <th style={{ width: 320 }}></th>
              </tr></thead>
              <tbody>{tipos.map(t => {
                const doc = documentos.find(d => d.tipo_id === t.id) || null;
                const estado = getEstado(doc?.vencimiento || null);
                const color = COLORES[estado];
                return (
                  <tr key={t.id}>
                    <td className="mono" style={{ color: "var(--muted2)" }}>{t.orden}</td>
                    <td style={{ fontWeight: 500 }}>{t.nombre}</td>
                    <td style={{ fontSize: 11, color: "var(--muted2)" }}>{t.descripcion || "—"}</td>
                    <td style={{ fontSize: 11 }}>
                      {doc?.vencimiento
                        ? <span style={{ color }}>{fmt_d(doc.vencimiento)}</span>
                        : <span style={{ color: "var(--muted)" }}>—</span>}
                    </td>
                    <td>
                      <span className="badge" style={{ background: "transparent", color, border: `1px solid ${color}66`, fontSize: 8 }}>
                        {LABELS[estado]}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <button className="btn btn-acc btn-sm" onClick={() => abrirDoc(t, doc)}>
                          {doc ? "Actualizar" : "Subir"}
                        </button>
                        {doc?.archivo_url && <button className="btn btn-ghost btn-sm" onClick={() => verArchivo(doc)}>Ver</button>}
                        {esAdmin && <button className="btn btn-ghost btn-sm" onClick={() => abrirTipoEditar(t)}>Editar</button>}
                        {esAdmin && <button className="btn btn-danger btn-sm" onClick={() => eliminarTipo(t)}>Eliminar</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
      )}

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido. */}
      <Modal
        isOpen={!!tipoModal}
        onClose={() => setTipoModal(null)}
        title={tipoModal === "new" ? "Nuevo tipo de documento" : "Editar tipo"}
        maxWidth={440}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setTipoModal(null)}>Cancelar</button>
            <button className="btn btn-acc" onClick={guardarTipo} disabled={!tipoForm.nombre.trim()}>Guardar</button>
          </>
        }
      >
        <div className="field"><label>Nombre *</label>
          <input value={tipoForm.nombre} onChange={e => setTipoForm({ ...tipoForm, nombre: e.target.value })} placeholder="Ej: Habilitación Municipal" />
        </div>
        <div className="field"><label>Descripción</label>
          <input value={tipoForm.descripcion} onChange={e => setTipoForm({ ...tipoForm, descripcion: e.target.value })} placeholder="Opcional" />
        </div>
        <div className="field"><label>Orden</label>
          <input type="number" value={tipoForm.orden} onChange={e => setTipoForm({ ...tipoForm, orden: parseInt(e.target.value) || 0 })} />
        </div>
      </Modal>

      <Modal
        isOpen={!!docModal}
        onClose={() => setDocModal(null)}
        title={docModal ? docModal.tipo.nombre : ""}
        maxWidth={480}
        preventCloseOnOverlay={uploading}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setDocModal(null)}>Cancelar</button>
            <button className="btn btn-acc" onClick={guardarDoc} disabled={uploading}>
              {uploading ? "Subiendo..." : "Guardar"}
            </button>
          </>
        }
      >
        {docModal && (
          <>
            <div className="field"><label>Fecha de vencimiento</label>
              <input type="date" value={docForm.vencimiento} onChange={e => setDocForm({ ...docForm, vencimiento: e.target.value })} />
            </div>
            <div className="field"><label>Archivo (opcional si ya tenés uno cargado)</label>
              <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                onChange={e => setArchivo(e.target.files?.[0] || null)}
                style={{ background: "var(--bg)", border: "1px solid var(--bd)", padding: 8, borderRadius: "var(--r)", width: "100%", color: "var(--txt)", fontFamily: "'DM Mono',monospace", fontSize: 12 }} />
              {docModal.doc?.archivo_url && !archivo && (
                <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4 }}>Ya hay un archivo cargado. Subí uno nuevo para reemplazarlo.</div>
              )}
            </div>
            <div className="field"><label>Notas</label>
              <input value={docForm.notas} onChange={e => setDocForm({ ...docForm, notas: e.target.value })} placeholder="Opcional" />
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
