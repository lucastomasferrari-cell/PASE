import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader, PageContainer } from "../components/ui";
import { PREGUNTAS_CLAVE, MODULOS_AYUDA } from "../lib/ayudaContenido";

// Página de Ayuda (Lucas 17-jun). EN CONSTRUCCIÓN: arranca con preguntas
// clave (casos de uso) + para-qué-sirve de cada módulo. El manual detallado
// función-por-función se suma cuando el sistema se estabilice.
export default function Ayuda() {
  const navigate = useNavigate();
  const [abierta, setAbierta] = useState<number | null>(null);

  return (
    <PageContainer>
      <PageHeader title="Ayuda" />

      <p style={{ color: "var(--muted2)", fontSize: 13, lineHeight: 1.6, maxWidth: 720, marginTop: -4 }}>
        Acá te contamos para qué te sirve cada parte del sistema y cómo sacarle provecho.
        Empezá por las preguntas de abajo — son las que más se hacen los dueños.
      </p>

      {/* ── Sección 1: Preguntas frecuentes (casos de uso) ──────────────── */}
      <h3 style={{ fontSize: 15, marginTop: 22, marginBottom: 10 }}>Preguntas frecuentes</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {PREGUNTAS_CLAVE.map((p, i) => {
          const open = abierta === i;
          return (
            <div key={i} style={{ border: "0.5px solid var(--bd)", borderRadius: 8, background: "var(--s2)", overflow: "hidden" }}>
              <button
                onClick={() => setAbierta(open ? null : i)}
                style={{
                  width: "100%", textAlign: "left", padding: "12px 14px", background: "transparent",
                  border: "none", color: "var(--text)", fontSize: 13.5, fontWeight: 500, cursor: "pointer",
                  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
                }}
              >
                <span>{p.q}</span>
                <span style={{ color: "var(--muted2)", fontSize: 12, flexShrink: 0 }}>{open ? "−" : "+"}</span>
              </button>
              {open && (
                <div style={{ padding: "0 14px 14px", fontSize: 13, lineHeight: 1.65, color: "var(--pase-text, var(--text))" }}>
                  <p style={{ margin: "0 0 10px" }}>{p.a}</p>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{
                      fontSize: 11, fontWeight: 500, color: "var(--acc)", background: "rgba(96,165,250,0.12)",
                      borderRadius: 6, padding: "2px 8px",
                    }}>{p.modulo}</span>
                    {p.ruta && (
                      <button className="btn btn-acc btn-sm" onClick={() => navigate(p.ruta!)} style={{ fontSize: 12 }}>
                        Ir a {p.modulo} →
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Sección 2: ¿Para qué sirve cada módulo? ─────────────────────── */}
      <h3 style={{ fontSize: 15, marginTop: 26, marginBottom: 10 }}>¿Para qué sirve cada módulo?</h3>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10,
      }}>
        {MODULOS_AYUDA.map((m) => (
          <div key={m.titulo} style={{
            border: "0.5px solid var(--bd)", borderRadius: 8, background: "var(--s2)", padding: "12px 14px",
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {m.icon && <span style={{ fontSize: 16 }}>{m.icon}</span>}
              <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)" }}>{m.titulo}</span>
            </div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "var(--muted2)" }}>{m.paraQue}</p>
            {m.ruta && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => navigate(m.ruta!)}
                style={{ fontSize: 12, alignSelf: "flex-start", marginTop: 2, color: "var(--acc)" }}
              >
                Abrir →
              </button>
            )}
          </div>
        ))}
      </div>

      {/* ── Sección 3: Manual paso a paso (en construcción) ─────────────── */}
      <h3 style={{ fontSize: 15, marginTop: 26, marginBottom: 10 }}>Cómo usar paso a paso</h3>
      <div style={{
        border: "1px dashed var(--bd2, var(--bd))", borderRadius: 8, padding: "14px 16px",
        background: "var(--s2)", fontSize: 13, color: "var(--muted2)", lineHeight: 1.6, maxWidth: 720,
      }}>
        🚧 Estamos sumando guías detalladas, función por función de cada módulo. Por ahora,
        las <strong>preguntas de arriba</strong> cubren lo que más se usa. Si te trabás con algo
        puntual, escribinos y lo agregamos acá.
      </div>
    </PageContainer>
  );
}
