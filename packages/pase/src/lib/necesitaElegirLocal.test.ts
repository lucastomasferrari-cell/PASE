import { describe, it, expect } from "vitest";
import { necesitaElegirLocal } from "./auth";

describe("necesitaElegirLocal", () => {
  it("dueno → none", () => {
    expect(necesitaElegirLocal({ rol: "dueno", _locales: [] }, null))
      .toEqual({ action: "none" });
  });

  it("admin → none", () => {
    expect(necesitaElegirLocal({ rol: "admin", _locales: [1, 2, 3] }, null))
      .toEqual({ action: "none" });
  });

  it("encargado 0 locales → none", () => {
    expect(necesitaElegirLocal({ rol: "encargado", _locales: [] }, null))
      .toEqual({ action: "none" });
  });

  it("encargado 1 local → setActivo con ese local", () => {
    expect(necesitaElegirLocal({ rol: "encargado", _locales: [5] }, null))
      .toEqual({ action: "setActivo", localId: 5 });
  });

  it("encargado 1 local ignora stored distinto", () => {
    expect(necesitaElegirLocal({ rol: "encargado", _locales: [5] }, 99))
      .toEqual({ action: "setActivo", localId: 5 });
  });

  it("encargado >1 sin stored → showModal", () => {
    expect(necesitaElegirLocal({ rol: "encargado", _locales: [1, 2, 3] }, null))
      .toEqual({ action: "showModal" });
  });

  it("encargado >1 con stored válido → setActivo con stored", () => {
    expect(necesitaElegirLocal({ rol: "encargado", _locales: [1, 2, 3] }, 2))
      .toEqual({ action: "setActivo", localId: 2 });
  });

  it("encargado >1 con stored inválido → showModal", () => {
    expect(necesitaElegirLocal({ rol: "encargado", _locales: [1, 2, 3] }, 99))
      .toEqual({ action: "showModal" });
  });

  it("encargado >1 con stored que ya no está en sus locales → showModal (dueño lo quitó)", () => {
    // Escenario: Anto tenía Belgrano (id=2), eligió ese local en sesión previa, dueño
    // le quita Belgrano de usuario_locales → no debe auto-setear.
    expect(necesitaElegirLocal({ rol: "encargado", _locales: [1, 3] }, 2))
      .toEqual({ action: "showModal" });
  });

  it("user null → none (login loading)", () => {
    expect(necesitaElegirLocal(null, null))
      .toEqual({ action: "none" });
  });

  it("fallback a user.locales (legacy) si _locales vacío", () => {
    expect(necesitaElegirLocal({ rol: "encargado", _locales: [], locales: [7] }, null))
      .toEqual({ action: "setActivo", localId: 7 });
  });

  it("strings/numbers: stored viene como string, locs como number", () => {
    const r = necesitaElegirLocal({ rol: "encargado", _locales: [1, 2, 3] }, 2 as any);
    expect(r.action).toBe("setActivo");
    expect(r.localId).toBe(2);
  });
});
