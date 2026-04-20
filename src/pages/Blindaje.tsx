import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { toISO, today, fmt_d } from "../lib/utils";

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

export default function Blindaje({ user, locales, localActivo }: any) {
  const esAdmin = user?.rol === "dueno" || user?.rol === "admin";
  const [tipos, setTipos] = useState<any[]>([]);
  const [documentos, setDocumentos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [tipoModal, setTipoModal] = useState<any>(null);
  const [tipoForm, setTipoForm] = useState({ nombre: "", descripcion: "", orden: 0 });

  const [docModal, setDocModal] = useState<any>(null);
  const [docForm, setDocForm] = useState({ vencimiento: "", notas: "" });
  const [archivo, setArchivo] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const loadTipos = async () => {
    const { data } = await db.from("blindaje_tipos_documento").select("*").order("orden").order("nombre");
    setTipos(data || []);
  };

  const loadDocumentos = async () => {
    if (!localActivo) { setDocumentos([]); return; }
    const { data } = await db.from("blindaje_documentos").select("*").eq("local_id", parseInt(String(localActivo)));
    setDocumentos(data || []);
  };

  const loadAll = async () => {
    setLoading(true);
    await Promise.all([loadTipos(), loadDocumentos()]);
    setLoading(false);
  };

  useEffect(() => { loadAll(); }, [localActivo]);

  // ─── TIPOS ─────────────────────────────────────────────────────────────────
  const abrirTipoNuevo = () => {
    setTipoForm({ nombre: "", descripcion: "", orden: tipos.length + 1 });
    setTipoModal("new");
  };
  const abrirTipoEditar = (t: any) => {
    setTipoForm({ nombre: t.nombre, descripcion: t.descripcion || "", orden: t.orden || 0 });
    setTipoModal(t);
  };
  const guardarTipo = async () => {
    if (!tipoForm.nombre.trim()) return;
    if (tipoModal?.id) {
      await db.from("blindaje_tipos_documento").update({ nombre: tipoForm.nombre, descripcion: tipoForm.descripcion || null, orden: tipoForm.orden }).eq("id", tipoModal.id);
    } else {
      await db.from("blindaje_tipos_documento").insert([{ nombre: tipoForm.nombre, descripcion: tipoForm.descripcion || null, orden: tipoForm.orden, activo: true }]);
    }
    setTipoModal(null);
    loadTipos();
  };
  const toggleTipoActivo = async (t: any) => {
    await db.from("blindaje_tipos_documento").update({ activo: !t.activo }).eq("id", t.id);
    loadTipos();
  };

  // ─── DOCUMENTOS ────────────────────────────────────────────────────────────
  const abrirDoc = (tipo: any, doc: any | null) => {
    setArchivo(null);
    setDocForm({
      vencimiento: doc?.vencimiento || "",
      notas: doc?.notas || "",
    });
    setDocModal({ tipo, doc });
  };

  const guardarDoc = async () => {
    if (!localActivo || !docModal) return;
    const { tipo, doc } = docModal;
    const lid = parseInt(String(localActivo));
    setUploading(true);

    let archivo_url = doc?.archivo_url || null;

    if (archivo) {
      const ext = (archivo.name.split(".").pop() || "bin").toLowerCase();
      const yyyymmdd = toISO(today).replace(/-/g, "");
      const path = `${lid}/${tipo.id}_${yyyymmdd}.${ext}`;
      const { error: upErr } = await db.storage.from("blindaje").upload(path, archivo, {
        contentType: archivo.type || "application/octet-stream",
        upsert: true,
      });
      if (upErr) {
        alert("Error subiendo archivo: " + upErr.message);
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
    await db.from("blindaje_documentos").upsert([payload], { onConflict: "id" });

    setUploading(false);
    setDocModal(null);
    setArchivo(null);
    loadDocumentos();
  };

  const verArchivo = async (doc: any) => {
    if (!doc.archivo_url) return;
    const { data } = await db.storage.from("blindaje").createSignedUrl(doc.archivo_url, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────
  if (loading) return <div className="loading">Cargando...</div>;

  const tiposActivos = tipos.filter(t => t.activo);
  const localNombre = locales.find((l: any) => l.id === parseInt(String(localActivo)))?.nombre || "—";

  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">PASE Blindaje</div>
          <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 4 }}>
            Gestor de documentos del local — {localActivo ? localNombre : "Sin local seleccionado"}
          </div>
        </div>
      </div>

      {!localActivo ? (
        <div className="alert alert-info">Seleccioná un local en el sidebar para gestionar sus documentos.</div>
      ) : (
        <div className="grid3" style={{ marginBottom: 16 }}>
          {tiposActivos.length === 0
            ? <div className="empty">No hay tipos de documento configurados</div>
            : tiposActivos.map(tipo => {
              const doc = documentos.find(d => d.tipo_id === tipo.id) || null;
              const estado = getEstado(doc?.vencimiento || null);
              const color = COLORES[estado];
              return (
                <div key={tipo.id} className="panel" style={{ marginBottom: 0 }}>
                  <div style={{ padding: 14, borderLeft: `3px solid ${color}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                      <div>
                        <div style={{ fontFamily: "'Inter',sans-serif", fontWeight: 500, fontSize: 13, color: "var(--txt)" }}>{tipo.nombre}</div>
                        {tipo.descripcion && <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 2 }}>{tipo.descripcion}</div>}
                      </div>
                      <span className="badge" style={{ background: "transparent", color, border: `1px solid ${color}66`, fontSize: 8 }}>
                        {LABELS[estado]}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 6 }}>
                      {doc?.vencimiento ? <>Vence: <strong style={{ color }}>{fmt_d(doc.vencimiento)}</strong></> : "Sin fecha de vencimiento"}
                    </div>
                    {doc?.notas && <div style={{ fontSize: 10, color: "var(--muted2)", marginBottom: 8 }}>{doc.notas}</div>}
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button className="btn btn-acc btn-sm" onClick={() => abrirDoc(tipo, doc)}>
                        {doc ? "Actualizar" : "Cargar"}
                      </button>
                      {doc?.archivo_url && <button className="btn btn-ghost btn-sm" onClick={() => verArchivo(doc)}>Ver archivo</button>}
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {esAdmin && (
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Tipos de documento</span>
            <button className="btn btn-acc btn-sm" onClick={abrirTipoNuevo}>+ Agregar tipo</button>
          </div>
          {tipos.length === 0 ? <div className="empty">Sin tipos cargados</div> : (
            <table>
              <thead><tr><th>Orden</th><th>Nombre</th><th>Descripción</th><th>Estado</th><th></th></tr></thead>
              <tbody>{tipos.map(t => (
                <tr key={t.id} style={{ opacity: t.activo ? 1 : 0.4 }}>
                  <td className="mono" style={{ color: "var(--muted2)" }}>{t.orden}</td>
                  <td style={{ fontWeight: 500 }}>{t.nombre}</td>
                  <td style={{ fontSize: 11, color: "var(--muted2)" }}>{t.descripcion || "—"}</td>
                  <td>
                    <span className={`badge ${t.activo ? "b-success" : "b-muted"}`} style={{ fontSize: 8 }}>
                      {t.activo ? "Activo" : "Inactivo"}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => abrirTipoEditar(t)}>Editar</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleTipoActivo(t)}>{t.activo ? "Desactivar" : "Activar"}</button>
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}

      {/* Modal tipo */}
      {tipoModal && (
        <div className="overlay" onClick={() => setTipoModal(null)}>
          <div className="modal" style={{ width: 440 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">{tipoModal === "new" ? "Nuevo tipo de documento" : "Editar tipo"}</div>
              <button className="close-btn" onClick={() => setTipoModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field"><label>Nombre *</label>
                <input value={tipoForm.nombre} onChange={e => setTipoForm({ ...tipoForm, nombre: e.target.value })} placeholder="Ej: Habilitación Municipal" />
              </div>
              <div className="field"><label>Descripción</label>
                <input value={tipoForm.descripcion} onChange={e => setTipoForm({ ...tipoForm, descripcion: e.target.value })} placeholder="Opcional" />
              </div>
              <div className="field"><label>Orden</label>
                <input type="number" value={tipoForm.orden} onChange={e => setTipoForm({ ...tipoForm, orden: parseInt(e.target.value) || 0 })} />
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setTipoModal(null)}>Cancelar</button>
              <button className="btn btn-acc" onClick={guardarTipo} disabled={!tipoForm.nombre.trim()}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal documento */}
      {docModal && (
        <div className="overlay" onClick={() => setDocModal(null)}>
          <div className="modal" style={{ width: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">{docModal.tipo.nombre}</div>
              <button className="close-btn" onClick={() => setDocModal(null)}>✕</button>
            </div>
            <div className="modal-body">
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
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setDocModal(null)}>Cancelar</button>
              <button className="btn btn-acc" onClick={guardarDoc} disabled={uploading}>
                {uploading ? "Subiendo..." : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
