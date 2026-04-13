export const toISO = (d: Date) => d.toISOString().split("T")[0];
export const today = new Date();
export const fmt_d = (d: string | null | undefined) => d ? new Date(d+"T12:00:00").toLocaleDateString("es-AR") : "—";
export const fmt_$ = (n: number | null | undefined) => new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(n||0);
export const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
