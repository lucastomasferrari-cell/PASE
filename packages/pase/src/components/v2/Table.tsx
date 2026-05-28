// PASE V2 — Table
// Wrapper minimal sobre <table> con estilo v2.
// Para tablas con sort/filter complejos, crear DataTable aparte.

import type { CSSProperties, ReactNode } from "react";

interface Column<T> {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  width?: string | number;
  render?: (row: T) => ReactNode;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  emptyText?: string;
  onRowClick?: (row: T) => void;
  getRowKey: (row: T) => string | number;
}

export function Table<T>({
  columns, rows, emptyText = "Sin datos.", onRowClick, getRowKey,
}: TableProps<T>) {
  const headStyle: CSSProperties = {
    textAlign: "left",
    padding: "var(--v2-space-3) var(--v2-space-4)",
    fontSize: "var(--v2-fs-xs)",
    fontWeight: 700,
    letterSpacing: "var(--v2-tracking-wider)",
    textTransform: "uppercase",
    color: "var(--v2-text-subtle)",
    background: "var(--v2-bg-3)",
    borderBottom: "1px solid var(--v2-border)",
  };

  const cellStyle: CSSProperties = {
    padding: "var(--v2-space-3) var(--v2-space-4)",
    fontSize: "var(--v2-fs-sm)",
    color: "var(--v2-text)",
  };

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          {columns.map(col => (
            <th
              key={col.key}
              style={{
                ...headStyle,
                textAlign: col.align ?? "left",
                width: col.width,
              }}
            >
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} style={{
              ...cellStyle,
              textAlign: "center",
              color: "var(--v2-text-muted)",
              padding: "var(--v2-space-8)",
            }}>
              {emptyText}
            </td>
          </tr>
        ) : (
          rows.map(row => (
            <tr
              key={getRowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={{
                borderTop: "1px solid var(--v2-border)",
                cursor: onRowClick ? "pointer" : "default",
                transition: "background var(--v2-tr-fast)",
              }}
              onMouseEnter={onRowClick ? (e) => {
                (e.currentTarget as HTMLTableRowElement).style.background = "var(--v2-bg-3)";
              } : undefined}
              onMouseLeave={onRowClick ? (e) => {
                (e.currentTarget as HTMLTableRowElement).style.background = "transparent";
              } : undefined}
            >
              {columns.map(col => (
                <td
                  key={col.key}
                  style={{
                    ...cellStyle,
                    textAlign: col.align ?? "left",
                  }}
                >
                  {col.render
                    ? col.render(row)
                    : (row as Record<string, unknown>)[col.key] as ReactNode}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
