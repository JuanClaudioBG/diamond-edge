/*
 * Picks sugeridos derivados exclusivamente de ambos Radares.
 * Son ángulos informativos con línea/cuota verificadas para el parlay UI:
 * jamás son picks oficiales ni participan en ROI/CLV. Solo se persisten
 * cuando el usuario los añade explícitamente al parlay para tracking manual.
 */

const BATTER_SCORE_MIN = 7;
const PITCHER_SCORE_MIN = 6;
const MAX_BATTER_PLAYERS = 3;

const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const norm = (value) => String(value ?? "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

const verifiedBatterOver = (market, point) => (
  market?.status === "LINEA_VERIFICADA" &&
  Number(market.line) === point &&
  finite(market.overPrice)
);

function suggestion({ source, player, teamName = null, market, point, price, book,
  lastUpdate = null, score, lineupSlot = null, pick, reason }) {
  return {
    suggestionKey: `${source}:${norm(player)}:${market}:over:${point}`,
    source,
    suggested: true,
    officialPick: false,
    noRoi: true,
    noClv: true,
    tipo: "Prop sugerido",
    player,
    teamName,
    market,
    side: "Over",
    point: Number(point),
    cuotaReal: Number(price),
    book: book ?? null,
    lastUpdate,
    score: Number(score),
    lineupSlot,
    pick,
    valor: "ÁNGULO RADAR",
    riesgo: "MEDIO",
    razon: reason,
  };
}

function bestBatterMarket(card) {
  const options = [
    { key: "hits", market: "batter_hits", label: "Hits", point: 0.5, priority: 0 },
    { key: "totalBases", market: "batter_total_bases", label: "TB", point: 1.5, priority: 1 },
  ].flatMap(meta => {
    const data = card?.markets?.[meta.key];
    return data?.score >= BATTER_SCORE_MIN && verifiedBatterOver(data, meta.point)
      ? [{ ...meta, data }]
      : [];
  });

  return options.sort((a, b) =>
    (b.data.score - a.data.score) || (a.priority - b.priority)
  )[0] ?? null;
}

function rankedBatterCandidates(batterRadar) {
  const cards = [
    ...(batterRadar?.away?.cards ?? []),
    ...(batterRadar?.home?.cards ?? []),
  ];

  return cards.flatMap(card => {
    if (!card?.name || card.insufficient) return [];
    const best = bestBatterMarket(card);
    return best ? [{ card, best }] : [];
  }).sort((a, b) =>
    (b.best.data.score - a.best.data.score) ||
    ((a.card.lineupSlot ?? 99) - (b.card.lineupSlot ?? 99)) ||
    a.card.name.localeCompare(b.card.name)
  ).slice(0, MAX_BATTER_PLAYERS);
}

function batterSuggestions(batterRadar) {
  const selected = rankedBatterCandidates(batterRadar);
  const primary = selected.map(({ card, best }) => suggestion({
    source: "batter_radar",
    player: card.name,
    teamName: card.teamName,
    market: best.market,
    point: best.point,
    price: best.data.overPrice,
    book: best.data.book,
    lastUpdate: best.data.lastUpdate,
    score: best.data.score,
    lineupSlot: card.lineupSlot,
    pick: `${card.name} — ${best.label} Over ${best.point}`,
    reason: `Perfil Radar ${best.data.score}/10 · turno #${card.lineupSlot} · línea y cuota verificadas en ${best.data.book}.`,
  }));

  const rbis = selected.flatMap(({ card, best }) => {
    const rbi = card?.markets?.rbi;
    const slot = Number(card?.lineupSlot);
    if (slot < 3 || slot > 5 || !verifiedBatterOver(rbi, 0.5)) return [];
    return [suggestion({
      source: "batter_radar",
      player: card.name,
      teamName: card.teamName,
      market: "batter_rbis",
      point: 0.5,
      price: rbi.overPrice,
      book: rbi.book,
      lastUpdate: rbi.lastUpdate,
      score: best.data.score,
      lineupSlot: slot,
      pick: `${card.name} — RBI Over 0.5`,
      reason: `Perfil Radar ${best.data.score}/10 · turno #${slot} en posición de producción · línea y cuota verificadas en ${rbi.book}.`,
    })];
  });

  return [...primary, ...rbis];
}

function strikeoutSuggestions(radar) {
  return [radar?.away, radar?.home].flatMap(card => {
    const point = card?.line?.point;
    const price = card?.line?.over?.price;
    if (!card?.name || card.insufficient || card.radarQualified !== true ||
        card.score < PITCHER_SCORE_MIN || !finite(point) || !finite(price)) return [];

    const book = card.line.bookTitle ?? card.line.book ?? null;
    return [suggestion({
      source: "strikeout_radar",
      player: card.name,
      market: "pitcher_strikeouts",
      point,
      price,
      book,
      lastUpdate: card.line.lastUpdate,
      score: card.score,
      pick: `${card.name} — Over ${Number(point)} Ks`,
      reason: `Perfil Radar calificado ${card.score}/10 · línea y cuota verificadas en ${book}.`,
    })];
  });
}

export function buildRadarSuggestedPicks({ batterRadar = null, radar = null } = {}) {
  return [
    ...batterSuggestions(batterRadar),
    ...strikeoutSuggestions(radar),
  ];
}
