/*
 * Helpers puros de presentación del análisis — Fase 4 de 2026-07-02.5.
 * Sin JSX ni dependencias: importables por AnalysisTab y por la suite de
 * tests del server. No alteran datos; solo deciden qué se muestra.
 */

const norm = (s) => String(s ?? "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[̀-ͯ]/g, "");

/**
 * Total de Carreras: separa proyección del modelo, línea real verificada y
 * señal. La señal solo existe con recomendación Y línea real — jamás se
 * presenta la proyección como si fuera la línea del sportsbook.
 * Compatible con análisis históricos que solo traen `estimado`.
 */
export function totalDisplay(t) {
  if (!t) return { proyeccion: null, lineaReal: null, senal: null };
  const proyeccion = t.proyectado ?? t.estimado ?? null;
  const lineaReal  = t.lineaMercado ?? null;
  const senal      = t.recomendacion && lineaReal != null
    ? `${t.recomendacion} ${lineaReal}`
    : null;
  return { proyeccion, lineaReal, senal };
}

const K_PROP_PATTERN = /(strikeouts?|ponches?|\bk\b)/i;

/**
 * ¿Este prop de strikeouts de un ABRIDOR ya está cubierto por una tarjeta
 * visible del Radar de Ponches? (dedupe VISUAL: el pick sigue íntegro en
 * output_json, solo no se repite como párrafo largo en Props para Revisar).
 *
 * Requiere: tipo Prop, texto con ángulo de strikeouts, y que el pitcher
 * tenga tarjeta de radar CON datos (una tarjeta "muestra insuficiente" no
 * cubre nada — el prop sigue visible). Props de bateadores y props no-K
 * nunca se ocultan.
 */
export function isStarterKPropCoveredByRadar(pick, radar) {
  if (!pick || !radar) return false;
  if (!norm(pick.tipo).startsWith("prop")) return false;
  const text = norm(pick.pick);
  if (!K_PROP_PATTERN.test(text)) return false;

  const cards = [radar.away, radar.home].filter(c => c && !c.insufficient);
  return cards.some(card => {
    const full = norm(card.name);
    if (!full) return false;
    if (text.includes(full)) return true;
    const last = full.split(" ").pop();
    return last.length > 2 && text.includes(last);
  });
}
