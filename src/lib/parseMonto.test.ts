import { describe, it, expect } from "vitest";
import { parseMonto } from "./utils";

describe("parseMonto", () => {
  it("número pasa directo", () => {
    expect(parseMonto(40642.56)).toBe(40642.56);
    expect(parseMonto(0)).toBe(0);
    expect(parseMonto(-100.5)).toBe(-100.5);
  });

  it("string con punto decimal", () => {
    expect(parseMonto("40642.56")).toBe(40642.56);
    expect(parseMonto("21.11")).toBe(21.11);
  });

  it("string con coma decimal (es-AR)", () => {
    expect(parseMonto("40642,56")).toBe(40642.56);
    expect(parseMonto("21,11")).toBe(21.11);
  });

  it("punto de miles + coma decimal", () => {
    expect(parseMonto("1.234,56")).toBe(1234.56);
    expect(parseMonto("1.234.567,89")).toBe(1234567.89);
  });

  it("coma de miles + punto decimal", () => {
    expect(parseMonto("1,234.56")).toBe(1234.56);
    expect(parseMonto("1,234,567.89")).toBe(1234567.89);
  });

  it("entero sin separador", () => {
    expect(parseMonto("1000")).toBe(1000);
  });

  it("null, undefined, string vacío → 0", () => {
    expect(parseMonto(null)).toBe(0);
    expect(parseMonto(undefined)).toBe(0);
    expect(parseMonto("")).toBe(0);
  });

  it("NaN-like o basura → 0", () => {
    expect(parseMonto("abc")).toBe(0);
    expect(parseMonto(NaN)).toBe(0);
  });

  it("trim espacios", () => {
    expect(parseMonto("  40642,56  ")).toBe(40642.56);
  });
});
