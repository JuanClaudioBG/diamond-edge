/*
 * Matemática de cuotas americanas — única fuente de verdad.
 * Usada por el servidor (EV en vivo) y por evaluate.js (ROI histórico).
 */

/** Cuota americana → probabilidad implícita (con vig). */
export function americanToProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || Math.abs(o) < 100) return null; // cuota inválida
  return o >= 0 ? 100 / (o + 100) : -o / (-o + 100);
}

/** Probabilidad → cuota americana equivalente (sin vig). */
export function probToAmerican(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

/**
 * Remueve el vig de un mercado de DOS resultados por normalización proporcional.
 * Requiere ambos lados; con uno solo no hay probabilidad justa → null.
 */
export function devig(priceA, priceB) {
  const pa = americanToProb(priceA);
  const pb = americanToProb(priceB);
  if (pa == null || pb == null) return null;
  const tot = pa + pb;
  return { a: pa / tot, b: pb / tot };
}

/** Ganancia neta de 1 unidad apostada si el pick acierta (pierde 1 si falla). */
export function unitProfit(price) {
  const o = Number(price);
  if (!Number.isFinite(o) || Math.abs(o) < 100) return null;
  return o >= 0 ? o / 100 : 100 / -o;
}

/**
 * EV de 1 unidad: p·ganancia − (1−p)·1.
 * p = probabilidad del modelo para el pick; price = cuota americana del pick.
 */
export function evUnits(p, price) {
  const g = unitProfit(price);
  if (g == null || !(p >= 0 && p <= 1)) return null;
  return p * g - (1 - p);
}
