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
  /* Proyección demasiado cerca de la línea: el servidor marca senalClara=false
     y no se fabrica dirección fuerte */
  if (t.senalClara === false) {
    return { proyeccion, lineaReal, senal: "SEÑAL NO CLARA" };
  }
  const senal = t.recomendacion && lineaReal != null
    ? `${t.recomendacion} ${lineaReal}`   // recomendacion ya viene corregida por el servidor
    : null;
  return { proyeccion, lineaReal, senal };
}

/**
 * Badge de un pick: texto, clase visual y si es recomendación ACTIVA.
 * Un pick noOficial (Total contradictorio con la dirección del servidor)
 * no se presenta como recomendación: badge gris "SEÑAL NO OFICIAL",
 * activo:false — la card lo atenúa, explica la contradicción y no ofrece
 * + PARLAY. La línea y la razón se conservan como auditoría.
 */
export function pickBadge(pk) {
  if (!pk) return { texto: null, clase: null, activo: false };
  if (pk.noOficial === true || pk.valor === "SEÑAL NO OFICIAL") {
    return { texto: "SEÑAL NO OFICIAL", clase: "NOOF", activo: false };
  }
  const v = pk.valor;
  const texto = (v === "SIN CUOTA" || v === "SIN VERIFICAR" || v === "SIN VALOR" || String(v).startsWith("SEÑAL"))
    ? v : `VALOR ${v}`;
  const clase = v === "SEÑAL ALTA" ? "ALTO"
    : v === "SEÑAL MEDIA" ? "MEDIO"
    : (v === "SEÑAL BAJA" || v === "SIN VALOR") ? "BAJO"
    : v;
  return { texto, clase, activo: true };
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

const BATTER_MARKETS = [
  ["hits", "Hits"],
  ["totalBases", "TB"],
  ["homeRuns", "HR"],
  ["rbi", "RBI"],
];

const propStatus = (key, m) => {
  if (key === "homeRuns") return "SOLO ÁNGULO";
  if (key === "rbi") return "BAJA CONFIANZA";
  return m?.line ? "SEÑAL" : "PROP PARA REVISAR";
};
const bestBatterScore = (card) => {
  const scores = ["hits", "totalBases", "homeRuns"]
    .map(k => card?.markets?.[k]?.score)
    .filter(v => v != null);
  return scores.length ? Math.max(...scores) : null;
};
const fmt1 = (v) => v == null ? null : Number(v).toFixed(1);
const shortSeries = (xs, joiner = "-") => Array.isArray(xs) && xs.length ? xs.map(v => v == null ? "–" : v).join(joiner) : null;
const marketScore = (card, key) => card?.markets?.[key]?.score ?? null;
const hasPowerAngle = (card) => {
  const hrScore = marketScore(card, "homeRuns");
  const s = card?.statcast ?? {};
  return (hrScore != null && hrScore >= 5)
    || (s.barrelPct != null && s.barrelPct >= 12)
    || (s.hardHitPct != null && s.hardHitPct >= 48)
    || (s.exitVelo != null && s.exitVelo >= 91);
};

const batterAngleForCard = (card, teamName) => {
  if (!card || card.insufficient) return null;
  const candidates = [];
  const hitsScore = marketScore(card, "hits");
  const tbScore = marketScore(card, "totalBases");
  const hrScore = marketScore(card, "homeRuns");
  const rbiConfidence = card.markets?.rbi?.confidence;

  if (hitsScore != null && hitsScore >= 5.5) candidates.push({ label: "Hits", weight: hitsScore + 2 });
  if (tbScore != null && tbScore >= 5.5) candidates.push({ label: "TB", weight: tbScore + 1.5 });
  if (hasPowerAngle(card)) candidates.push({ label: "HR profile", weight: (hrScore ?? 4) - 0.5 });
  if (rbiConfidence && rbiConfidence !== "BAJA") candidates.push({ label: "RBI contexto", weight: 2 });

  if (!candidates.length) {
    const fallback = [
      { label: "Hits", weight: hitsScore ?? -1 },
      { label: "TB", weight: tbScore ?? -1 },
    ].sort((a, b) => b.weight - a.weight)[0];
    if (!fallback || fallback.weight < 4.5) return null;
    candidates.push(fallback);
  }

  candidates.sort((a, b) => b.weight - a.weight);
  const labels = candidates.slice(0, 2).map(c => c.label).join("/");
  const weight = Math.max(...candidates.map(c => c.weight));
  return {
    teamName,
    name: card.name,
    label: labels,
    weight,
  };
};

const compactNotes = (card) => BATTER_MARKETS
  .flatMap(([key]) => card.markets?.[key]?.notes ?? [])
  .filter(Boolean)
  .slice(0, 1);

const compactRecent = (card) => {
  const hitSample = card.sample?.metrics?.hits;
  const tbSample  = card.sample?.metrics?.totalBases;
  const bits = [];
  const h5 = shortSeries(hitSample?.last5);
  if (h5) bits.push(`H5: ${h5}`);
  if (tbSample?.avgLast10 != null) bits.push(`TB10 prom: ${fmt1(tbSample.avgLast10)}`);
  return bits.join(" · ");
};

const compactStatcast = (card) => [
  ["xwOBA", card.statcast?.xwoba, 3, ""],
  ["xBA", card.statcast?.xba, 3, ""],
  ["Barrel", card.statcast?.barrelPct, 1, "%"],
  ["HH", card.statcast?.hardHitPct, 1, "%"],
  ["EV", card.statcast?.exitVelo, 1, ""],
].filter(([, v]) => v != null)
 .map(([label, v, digits, suffix]) => `${label} ${Number(v).toFixed(digits)}${suffix}`);

export function batterRadarDisplay(radar) {
  if (!radar) return { visible: false };
  if (radar.status === "LINEUP_NO_CONFIRMADO") {
    return {
      visible: true,
      status: "LINEUP_NO_CONFIRMADO",
      message: "Lineup no confirmado — Radar de Bateadores pendiente.",
      teams: [],
    };
  }
  const teams = [
    ["Visitante", radar.away],
    ["Local", radar.home],
  ].map(([side, team]) => ({
    side,
    teamName: team?.teamName ?? side,
    lineupConfirmed: team?.lineupConfirmed === true,
    cards: (team?.cards ?? []).map(card => {
      const notes = compactNotes(card);
      const statcast = compactStatcast(card);
      const score = bestBatterScore(card);
      return {
        name: card.name,
        lineupSlot: card.lineupSlot ?? null,
        label: card.label ?? "Radar",
        score,
        insufficient: card.insufficient === true,
        chips: BATTER_MARKETS.map(([key, label]) => ({
          key,
          label,
          status: propStatus(key, card.markets?.[key]),
          line: card.markets?.[key]?.line ?? null,
        })),
        heading: `${card.name}${card.lineupSlot != null ? ` · Slot ${card.lineupSlot}` : ""}${score != null ? ` · ${score}/10` : ""}`,
        marketLine: BATTER_MARKETS.map(([key, label]) => `${label}: ${propStatus(key, card.markets?.[key])}`).join(" · "),
        recentLine: compactRecent(card),
        statcast,
        statcastLine: statcast.join(" · "),
        notes,
      };
    }),
  }));
  const angles = teams
    .flatMap(team => team.cards
      .map(card => {
        const raw = (radar[team.side === "Visitante" ? "away" : "home"]?.cards ?? [])
          .find(c => c.name === card.name && c.lineupSlot === card.lineupSlot);
        return batterAngleForCard(raw, team.teamName);
      })
      .filter(Boolean))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map(({ weight, ...angle }) => angle);
  return { visible: true, status: radar.status ?? "OK", angles, teams };
}
