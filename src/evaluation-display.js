/*
 * Formateo puro para la sección Evaluación Moneyball (F3).
 * Sin JSX: importable por HistorialTab y por la suite de tests del server.
 * Tolerante a null/undefined en todos los casos.
 */

export const fmtPct = (x) =>
  x == null ? "–" : `${Math.round(x * 100)}%`;

export const fmtRoi = (r) =>
  r == null ? "–" : `${r > 0 ? "+" : ""}${(r * 100).toFixed(1)}%`;

export const fmtUnits = (u) =>
  u == null ? "–" : `${u > 0 ? "+" : ""}${u}u`;

export const fmtRecordLine = (r) =>
  r == null ? "–" : `${r.ganados ?? 0}-${r.perdidos ?? 0}${r.pendientes ? ` · ${r.pendientes} pend` : ""}`;

export const fmtBrier = (b) =>
  b == null ? "–" : b.toFixed(4);
