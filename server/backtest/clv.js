/*
 * Closing Line Value — lógica pura (sin red, sin DB).
 *
 * Terminología:
 *  - LÍNEA DE ENTRADA: la cuota registrada en analysis_log al momento del
 *    análisis. NO es la apertura del mercado (no tenemos fuente de apertura).
 *  - LÍNEA DE CIERRE: la última cuota fresca capturada dentro de la ventana
 *    [inicio − 30 min, inicio] del mismo sportsbook y mercado.
 *
 * Fórmula (probabilidades SIN VIG en ambos extremos, jamás mezclar con brutas):
 *    CLV (puntos de probabilidad) = close_prob_nv(lado) − entry_prob_nv(lado)
 *  positivo → el mercado cerró dándole más probabilidad al lado seleccionado;
 *  negativo → el mercado se movió en contra. CLV NO garantiza rentabilidad:
 *  mide anticipación de información, no vence al vig por sí solo.
 */
import { devig } from "./odds-math.js";

export const CLOSE_WINDOW_MINUTES    = 30; // cierre válido: 0..30 min antes del inicio
export const STALE_THRESHOLD_MINUTES = 15; // last_update del book más viejo → stale
export const BOOK_PREFERENCE = ["draftkings", "fanduel", "betmgm"];

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");

/** Mismo criterio de selección de book que usó el servidor en la entrada. */
export function preferredBookKey(oddsJson) {
  const books = oddsJson?.bookmakers ?? [];
  if (!books.length) return null;
  return (books.find(b => BOOK_PREFERENCE.includes(b.key)) ?? books[0]).key;
}

/** Lado seleccionado por el modelo en una fila de analysis_log. */
export function pickedSide(row) {
  if (row?.predicted_winner == null) return null;
  if (row.predicted_winner === row.home_team) return "home";
  if (row.predicted_winner === row.away_team) return "away";
  return null;
}

/**
 * Clasificación de una captura. Precedencia: posterior al inicio invalida
 * todo; fuera de ventana es snapshot temprano; sin last_update o viejo es
 * stale (no fingimos frescura solo porque NUESTRA petición fue puntual).
 */
export function classifyCapture({ minutesBeforeStart, stalenessMinutes }) {
  if (minutesBeforeStart == null) return "api_error";
  if (minutesBeforeStart < 0) return "post_start_invalid";
  if (minutesBeforeStart > CLOSE_WINDOW_MINUTES) return "early_snapshot";
  if (stalenessMinutes == null || stalenessMinutes > STALE_THRESHOLD_MINUTES) return "stale";
  return "valid_close";
}

/**
 * Skip PRE-fetch (ahorra llamadas): se omite una identidad solo cuando ya
 * nada puede mejorar — post-start registrado, pospuesto hoy, o cierre válido
 * de un juego que YA empezó. Un valid_close de un juego aún no iniciado NO
 * bloquea: una captura más cercana al inicio es un cierre mejor.
 */
export function shouldSkipCapture(existingRows, nowISO) {
  const today = String(nowISO).slice(0, 10);
  const nowMs = new Date(nowISO).getTime();
  return (existingRows ?? []).some(r =>
    r.capture_status === "post_start_invalid" ||
    (r.capture_status === "game_postponed" && String(r.captured_at).slice(0, 10) === today) ||
    (r.capture_status === "valid_close" && r.game_start_time &&
      new Date(r.game_start_time).getTime() <= nowMs)
  );
}

/**
 * Selección del cierre principal entre varias filas de la MISMA identidad
 * (game_pk + book_key + market): solo valid_close dentro de [0, 30] min;
 * gana el menor minutes_before_start (más cercano al inicio); empate →
 * captured_at más reciente. early/post_start/stale/api_error jamás ganan.
 */
export function selectClose(rows) {
  const valid = (rows ?? []).filter(r =>
    r.capture_status === "valid_close" &&
    r.minutes_before_start != null &&
    r.minutes_before_start >= 0 &&
    r.minutes_before_start <= CLOSE_WINDOW_MINUTES
  );
  if (!valid.length) return null;
  return [...valid].sort((a, b) =>
    a.minutes_before_start - b.minutes_before_start ||
    String(b.captured_at).localeCompare(String(a.captured_at))
  )[0];
}

/**
 * Idempotencia POST-extracción: impide duplicados exactos, no líneas nuevas.
 *  - Duplicado exacto = mismo status + mismo book_last_update + mismas cuotas
 *    → no se inserta (segunda corrida inmediata idéntica = una sola fila).
 *  - Candidato valid_close: se inserta solo si está MÁS CERCA del inicio que
 *    el mejor valid_close existente (las filas previas nunca se sobrescriben).
 *  - Candidato post_start_invalid con un valid_close ya asegurado: no ensucia.
 */
export function shouldInsertCapture(existingRows, candidate) {
  const rows = existingRows ?? [];
  const dup = rows.some(r =>
    r.capture_status === candidate.capture_status &&
    (r.book_last_update ?? null) === (candidate.book_last_update ?? null) &&
    (r.odds_home ?? null) === (candidate.odds_home ?? null) &&
    (r.odds_away ?? null) === (candidate.odds_away ?? null)
  );
  if (dup) return { insert: false, reason: "duplicado_exacto" };
  const best = selectClose(rows);
  if (candidate.capture_status === "valid_close" && best &&
      best.minutes_before_start <= candidate.minutes_before_start) {
    return { insert: false, reason: "ya_existe_cierre_mas_cercano" };
  }
  if (candidate.capture_status === "post_start_invalid" && best) {
    return { insert: false, reason: "cierre_valido_ya_asegurado" };
  }
  return { insert: true };
}

/**
 * Empareja el juego correcto del feed de odds: equipos + cercanía de
 * commence_time al inicio real (±4 h). Dobles carteleras: dos juegos con los
 * mismos equipos se distinguen por horario; si ninguno cae en ±4 h → null.
 */
export function matchOddsGame(games, homeName, awayName, gameStartISO) {
  const hn = norm(homeName), an = norm(awayName);
  let candidates = (games ?? []).filter(g => norm(g.home_team) === hn && norm(g.away_team) === an);
  if (!candidates.length) {
    candidates = (games ?? []).filter(g =>
      norm(g.home_team).includes(hn.slice(-7)) && norm(g.away_team).includes(an.slice(-7)));
  }
  if (!candidates.length) return null;
  const target = new Date(gameStartISO).getTime();
  const scored = candidates
    .map(g => ({ g, diff: Math.abs(new Date(g.commence_time).getTime() - target) }))
    .sort((x, y) => x.diff - y.diff);
  return scored[0].diff <= 4 * 60 * 60 * 1000 ? scored[0].g : null;
}

/**
 * Extrae el h2h del book EXACTO de la entrada. Sin fallback a otro book:
 * mezclar books convierte movimiento de línea en ruido entre casas.
 */
export function extractClose(oddsGame, bookKey, homeName, awayName) {
  const bk = oddsGame?.bookmakers?.find(b => b.key === bookKey);
  if (!bk) return { status: "book_missing" };
  const h2h = bk.markets?.find(m => m.key === "h2h");
  if (!h2h) return { status: "market_missing" };
  const hOut = h2h.outcomes?.find(o => norm(o.name) === norm(homeName));
  const aOut = h2h.outcomes?.find(o => norm(o.name) === norm(awayName));
  if (hOut?.price == null || aOut?.price == null) return { status: "market_missing" };
  const dv = devig(hOut.price, aOut.price);
  if (!dv) return { status: "market_missing" };
  return {
    status: "ok",
    oddsHome: hOut.price,
    oddsAway: aOut.price,
    probHomeNv: dv.a,
    probAwayNv: dv.b,
    lastUpdate: bk.last_update ?? null,
  };
}

/**
 * CLV de UN análisis contra UNA línea de cierre ya emparejada por identidad.
 * Devuelve { clv: number|null, reason?, ...detalle }.
 */
export function computeClvForAnalysis(analysis, closing) {
  if (analysis?.retro !== 0) return { clv: null, reason: "retro" };
  const side = pickedSide(analysis);
  if (!side) return { clv: null, reason: "sin_lado" };
  const entryProb = side === "home" ? analysis.market_prob_home : analysis.market_prob_away;
  let entryBook = null;
  try { entryBook = preferredBookKey(JSON.parse(analysis.odds_json ?? "null")); } catch { /* json corrupto */ }
  if (entryProb == null || entryBook == null) return { clv: null, reason: "sin_entrada" };
  if (!closing) return { clv: null, reason: "sin_cierre" };
  if (closing.book_key !== entryBook) return { clv: null, reason: "book_distinto" };
  if (closing.market !== "h2h") return { clv: null, reason: "mercado_distinto" };
  if (closing.capture_status !== "valid_close") return { clv: null, reason: closing.capture_status };
  const closeProb = side === "home" ? closing.close_prob_home_nv : closing.close_prob_away_nv;
  if (closeProb == null) return { clv: null, reason: "cierre_incompleto" };
  return {
    clv:         closeProb - entryProb,
    side,
    book:        entryBook,
    entryProbNv: entryProb,
    closeProbNv: closeProb,
    entryOdds:   entryOddsForSide(analysis, side, entryBook),
    closeOdds:   side === "home" ? closing.odds_home : closing.odds_away,
  };
}

/** Cuota americana de entrada del lado seleccionado (desde el snapshot). */
function entryOddsForSide(analysis, side, bookKey) {
  try {
    const odds = JSON.parse(analysis.odds_json ?? "null");
    const teamName = side === "home" ? analysis.home_team : analysis.away_team;
    const bk = odds?.bookmakers?.find(b => b.key === bookKey);
    const h2h = bk?.markets?.find(m => m.key === "h2h");
    return h2h?.outcomes?.find(o => norm(o.name) === norm(teamName))?.price ?? null;
  } catch { return null; }
}

/**
 * CLV por lote: cada análisis se compara con la línea de cierre de SU
 * identidad (game_pk + book de entrada + h2h). Una misma línea de cierre
 * puede servir a varios análisis del mismo juego y book — cada uno conserva
 * su CLV individual (NO se deduplica aquí).
 */
export function computeClvRows(analyses, closingRows) {
  const byGame = new Map();
  for (const c of closingRows ?? []) {
    if (!byGame.has(c.game_pk)) byGame.set(c.game_pk, []);
    byGame.get(c.game_pk).push(c);
  }
  return (analyses ?? []).map(a => {
    let entryBook = null;
    try { entryBook = preferredBookKey(JSON.parse(a.odds_json ?? "null")); } catch { /* ignore */ }
    const rows = byGame.get(a.game_pk) ?? [];
    const sameBook = rows.filter(r => r.book_key === entryBook && r.market === "h2h");
    /* Cierre principal: el valid_close MÁS CERCANO al inicio; si no hay
       ninguno válido, el último intento solo para reportar la razón. */
    const closing = selectClose(sameBook) ?? sameBook[sameBook.length - 1] ?? null;
    const res = computeClvForAnalysis(a, closing);
    if (res.reason === "sin_cierre" && rows.length > 0) res.reason = "book_distinto";
    return { analysisId: a.id, gamePk: a.game_pk, logicVersion: a.logic_version, ...res };
  });
}
