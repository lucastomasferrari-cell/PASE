import { describe, it, expect } from "vitest";
import { translateRpcError } from "./errors";

describe("translateRpcError", () => {
  it("traduce código conocido", () => {
    expect(translateRpcError("FACTURA_YA_PAGADA")).toBe("Esta factura ya está pagada");
  });

  it("limpia prefijo ERROR: de Postgres", () => {
    expect(translateRpcError("ERROR:  MONTO_INVALIDO")).toBe("El monto debe ser mayor a cero");
  });

  it("acepta Error con .message", () => {
    const e = new Error("SALDO_INSUFICIENTE");
    expect(translateRpcError(e)).toBe("Saldo insuficiente en la cuenta seleccionada");
  });

  it("fallback transparente: si código no mapeado, devuelve raw", () => {
    expect(translateRpcError("CODIGO_INEXISTENTE")).toBe("CODIGO_INEXISTENTE");
  });

  it("null/undefined → Error desconocido", () => {
    expect(translateRpcError(null)).toBe("Error desconocido");
    expect(translateRpcError(undefined)).toBe("Error desconocido");
  });

  it("empty string → Error desconocido", () => {
    expect(translateRpcError("")).toBe("Error desconocido");
  });

  it("permite casos combinados de Postgres con espacios", () => {
    expect(translateRpcError("ERROR: LIQ_FINAL_YA_EXISTE")).toBe(
      "Este empleado ya tiene liquidación final registrada",
    );
  });
});
