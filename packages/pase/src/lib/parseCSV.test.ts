import { describe, it, expect } from "vitest";
import { parseCSV } from "./parseCSV";

describe("parseCSV", () => {
  it("parsea CSV simple con coma", () => {
    const csv = "nombre,edad\nJuan,30\nAna,25";
    expect(parseCSV(csv)).toEqual([
      { nombre: "Juan", edad: "30" },
      { nombre: "Ana", edad: "25" },
    ]);
  });

  it("auto-detect separador `;` cuando hay más punto-y-coma que comas (Excel-AR)", () => {
    const csv = "nombre;cuit;saldo\nProv 1;20-12345678-9;1000,50\nProv 2;20-87654321-0;200,00";
    expect(parseCSV(csv)).toEqual([
      { nombre: "Prov 1", cuit: "20-12345678-9", saldo: "1000,50" },
      { nombre: "Prov 2", cuit: "20-87654321-0", saldo: "200,00" },
    ]);
  });

  it("strip BOM UTF-8 al inicio", () => {
    const csv = "﻿nombre,edad\nJuan,30";
    const out = parseCSV(csv);
    expect(out).toHaveLength(1);
    // El BOM no debe contaminar el primer header
    expect(Object.keys(out[0]!)).toEqual(["nombre", "edad"]);
    expect(out[0]!.nombre).toBe("Juan");
  });

  it("respeta comillas dobles que envuelven separador", () => {
    const csv = `nombre,nota\n"Juan, Pedro","hola, mundo"\nAna,simple`;
    expect(parseCSV(csv)).toEqual([
      { nombre: "Juan, Pedro", nota: "hola, mundo" },
      { nombre: "Ana", nota: "simple" },
    ]);
  });

  it("escape de comillas internas: '\"\"' → '\"'", () => {
    const csv = `nombre,frase\nJuan,"él dijo \"\"hola\"\" ayer"`;
    expect(parseCSV(csv)).toEqual([
      { nombre: "Juan", frase: `él dijo "hola" ayer` },
    ]);
  });

  it("soporta CRLF (line endings Windows)", () => {
    const csv = "nombre,edad\r\nJuan,30\r\nAna,25";
    expect(parseCSV(csv)).toEqual([
      { nombre: "Juan", edad: "30" },
      { nombre: "Ana", edad: "25" },
    ]);
  });

  it("ignora filas vacías", () => {
    const csv = "nombre,edad\nJuan,30\n\nAna,25\n";
    expect(parseCSV(csv)).toEqual([
      { nombre: "Juan", edad: "30" },
      { nombre: "Ana", edad: "25" },
    ]);
  });

  it("trim de headers y celdas", () => {
    const csv = "  nombre  ,  edad  \n  Juan  ,  30  ";
    expect(parseCSV(csv)).toEqual([
      { nombre: "Juan", edad: "30" },
    ]);
  });

  it("celdas faltantes quedan como string vacío", () => {
    const csv = "nombre,edad,ciudad\nJuan,30";
    expect(parseCSV(csv)).toEqual([
      { nombre: "Juan", edad: "30", ciudad: "" },
    ]);
  });

  it("CSV vacío devuelve array vacío", () => {
    expect(parseCSV("")).toEqual([]);
  });

  it("solo headers (sin data rows) devuelve array vacío", () => {
    expect(parseCSV("nombre,edad")).toEqual([]);
  });

  it("comillas envuelven salto de línea interno (celda multilínea)", () => {
    const csv = `nombre,desc\nJuan,"linea 1\nlinea 2"\nAna,simple`;
    const out = parseCSV(csv);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ nombre: "Juan", desc: "linea 1\nlinea 2" });
    expect(out[1]).toEqual({ nombre: "Ana", desc: "simple" });
  });

  it("auto-detect: línea sin separadores cae a coma por default", () => {
    const csv = "solounacolumna\nvalor1\nvalor2";
    expect(parseCSV(csv)).toEqual([
      { solounacolumna: "valor1" },
      { solounacolumna: "valor2" },
    ]);
  });

  it("BOM + separador `;` + comillas: combo real Excel-AR exportado", () => {
    const csv = `﻿nombre;monto;nota\n"Prov, S.A.";1234,56;"con ""comillas"" adentro"`;
    expect(parseCSV(csv)).toEqual([
      { nombre: "Prov, S.A.", monto: "1234,56", nota: `con "comillas" adentro` },
    ]);
  });

  it("última fila sin \\n al final no se pierde", () => {
    const csv = "a,b\n1,2\n3,4";
    expect(parseCSV(csv)).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });
});
