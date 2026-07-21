/*
 * Player Props — snapshot y verificación de líneas reales de Radar contra
 * The Odds API, SOLO informativa para Batter Radar / Radar de Ponches.
 *
 * Contrato F5:
 *  - No crea picks oficiales, no calcula EV, no entra a ROI/CLV ni a la
 *    muestra oficial, no toca settlement ni evaluation.
 *  - Matching EXACTO: market key exacta, nombre completo normalizado
 *    exacto (sin fallback por apellido), point idéntico entre Over/Under.
 *  - Cualquier ambigüedad (varios points, outcomes duplicados, nombre no
 *    encontrado) → el mercado queda PROP_PARA_REVISAR, sin inventar nada.
 *
 * Los props viven en el endpoint POR EVENTO de The Odds API
 * (/events/{eventId}/odds), no en el bulk de h2h/spreads/totals.
 */

export const BATTER_PROP_MARKETS = {
  hits:       "batter_hits",
  totalBases: "batter_total_bases",
  homeRuns:   "batter_home_runs",
  rbi:        "batter_rbis",
};

export const RADAR_PROP_MARKETS = {
  ...BATTER_PROP_MARKETS,
  pitcherStrikeouts: "pitcher_strikeouts",
};

const PREFERRED_BOOKS = ["draftkings", "fanduel", "betmgm"];
const EVENT_ODDS_BASE = "https://api.the-odds-api.com/v4/sports/baseball_mlb/events";
const PROPS_TTL_MS = 30 * 60 * 1000; // 30 min: los props se mueven más que el h2h
const propsCache = new Map();        // eventId → { data, fetchedAt }

/** Nombre completo normalizado: minúsculas, sin acentos, solo letras. */
export function normPlayerName(name) {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
}

/* Bookmakers en orden de preferencia (el mismo criterio del resto del
   sistema), seguidos del resto tal como vienen. */
function orderedBookmakers(eventOdds) {
  const books = eventOdds?.bookmakers ?? [];
  const preferred = PREFERRED_BOOKS
    .map(key => books.find(b => b?.key === key))
    .filter(Boolean);
  const rest = books.filter(b => b && !PREFERRED_BOOKS.includes(b.key));
  return [...preferred, ...rest];
}

/**
 * Busca la línea real de UN mercado de UN jugador en el snapshot por evento.
 * Devuelve { line, overPrice, underPrice, book, lastUpdate } o null.
 * Reglas duras: nombre completo exacto (normalizado), un único point por
 * jugador/mercado/book (varios points = ambigüedad = null), Over/Under solo
 * del MISMO point, precios numéricos. Jamás cruza jugadores ni mercados.
 */
export function findBatterPropLine(eventOdds, { marketKey, playerName } = {}) {
  if (!eventOdds || !marketKey || !playerName) return null;
  const target = normPlayerName(playerName);
  if (!target) return null;

  for (const bk of orderedBookmakers(eventOdds)) {
    const market = (bk.markets ?? []).find(m => m?.key === marketKey);
    if (!market) continue;

    const mine = (market.outcomes ?? []).filter(o =>
      normPlayerName(o?.description) === target && o?.point != null && Number.isFinite(Number(o.point))
    );
    if (!mine.length) continue;                     // este book no lista al jugador: probar el siguiente

    const points = [...new Set(mine.map(o => Number(o.point)))];
    if (points.length !== 1) continue;              // líneas alternas / ambigüedad: no verificar aquí

    const overs  = mine.filter(o => o?.name === "Over");
    const unders = mine.filter(o => o?.name === "Under");
    if (overs.length > 1 || unders.length > 1) continue;  // duplicados: duda → fuera

    const overPrice  = overs.length  && Number.isFinite(Number(overs[0].price))  ? Number(overs[0].price)  : null;
    const underPrice = unders.length && Number.isFinite(Number(unders[0].price)) ? Number(unders[0].price) : null;
    if (overPrice == null && underPrice == null) continue;

    return {
      line: points[0],
      overPrice,
      underPrice,
      book: bk.title ?? bk.key,
      lastUpdate: market.last_update ?? bk.last_update ?? null,
    };
  }
  return null;
}

/**
 * Cruza el Batter Radar ya construido con el snapshot de props del evento.
 * Puro: devuelve un radar NUEVO. Mercado con línea encontrada →
 * LINEA_VERIFICADA con cuotas reales y flags anti-financieros explícitos;
 * sin línea → el mercado queda intacto (PROP_PARA_REVISAR).
 */
export function verifyBatterRadarLines(batterRadar, eventOdds) {
  if (!batterRadar || !eventOdds) return batterRadar;

  let verified = 0;
  const verifyCard = (card) => {
    if (!card?.name || !card.markets) return card;
    const markets = { ...card.markets };
    for (const [key, marketKey] of Object.entries(BATTER_PROP_MARKETS)) {
      if (!markets[key]) continue;
      const found = findBatterPropLine(eventOdds, { marketKey, playerName: card.name });
      if (!found) continue;                          // sin matching exacto: no se toca
      verified++;
      markets[key] = {
        ...markets[key],
        status: "LINEA_VERIFICADA",
        line: found.line,
        overPrice: found.overPrice,
        underPrice: found.underPrice,
        book: found.book,
        lastUpdate: found.lastUpdate,
        officialPick: false,
        ev: null,
        noRoi: true,
        noClv: true,
      };
    }
    return { ...card, markets };
  };

  const verifyTeam = (team) => team
    ? { ...team, cards: (team.cards ?? []).map(verifyCard) }
    : team;

  const out = {
    ...batterRadar,
    away: verifyTeam(batterRadar.away),
    home: verifyTeam(batterRadar.home),
  };
  if (verified > 0) {
    out.nota = "Radar informativo. Líneas verificadas solo como referencia; no entra a ROI, CLV ni muestra oficial.";
  }
  return out;
}

/**
 * Snapshot de props por evento, con caché de 30 min por eventId.
 * Sin eventId o sin apiKey → null sin red. Respuesta no-OK o inválida →
 * null (jamás se inventan líneas). fetcher inyectable para tests.
 */
export async function fetchEventRadarProps({ eventId, apiKey, fetcher = fetch } = {}) {
  if (!eventId || !apiKey) return null;
  const cached = propsCache.get(eventId);
  if (cached && Date.now() - cached.fetchedAt < PROPS_TTL_MS) return cached.data;

  const markets = Object.values(RADAR_PROP_MARKETS).join(",");
  try {
    const r = await fetcher(
      `${EVENT_ODDS_BASE}/${eventId}/odds?apiKey=${apiKey}&regions=us&markets=${markets}&oddsFormat=american`
    );
    if (!r?.ok) return cached?.data ?? null;
    const data = await r.json();
    if (!data || typeof data !== "object" || !Array.isArray(data.bookmakers)) return cached?.data ?? null;
    propsCache.set(eventId, { data, fetchedAt: Date.now() });
    return data;
  } catch {
    return cached?.data ?? null;
  }
}

/* Alias retrocompatible para consumidores de F5. El snapshot ahora incluye
   también pitcher_strikeouts, sin cambiar el contrato de retorno. */
export const fetchEventBatterProps = fetchEventRadarProps;

/** Solo para tests: limpia la caché por evento. */
export function _clearPropsCache() {
  propsCache.clear();
}
