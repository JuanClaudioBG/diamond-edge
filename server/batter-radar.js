/*
 * Batter Props Radar v1 F1 — modulo PURO e informativo.
 *
 * Calcula perfiles de bateadores desde game logs reales. No consulta odds,
 * no genera picks oficiales, no calcula EV y no participa en ROI/CLV.
 *
 * Reglas F1:
 *  - Anti-leakage: solo juegos estrictamente anteriores al dia de analisis.
 *  - null/undefined se conserva como null; nunca se convierte en 0.
 *  - Sin linea real: todos los mercados quedan PROP_PARA_REVISAR.
 *  - HR es evento raro: puede tener score, pero no lenguaje fuerte ni pick oficial.
 */

export const BATTER_RADAR_MIN_VALID_GAMES = 8;
const MLB_BASE = "https://statsapi.mlb.com/api/v1";

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round1 = (v) => v == null ? null : Math.round(v * 10) / 10;
const round2 = (v) => v == null ? null : Math.round(v * 100) / 100;
const roundScore = (v) => Math.round(Math.max(0, Math.min(10, v)) * 10) / 10;

function mean(xs) {
  const valid = xs.filter(v => v != null);
  return valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : null;
}

function median(xs) {
  const valid = xs.filter(v => v != null).sort((a, b) => a - b);
  if (!valid.length) return null;
  const m = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[m] : (valid[m - 1] + valid[m]) / 2;
}

function rateAtLeast(xs, threshold) {
  const valid = xs.filter(v => v != null);
  return {
    hits: valid.filter(v => v >= threshold).length,
    n: valid.length,
    rate: valid.length ? round2(valid.filter(v => v >= threshold).length / valid.length) : null,
    threshold,
  };
}

function profileLabel(score, insufficient = false) {
  if (insufficient) return "Muestra insuficiente";
  if (score >= 6.5) return "Perfil calificado";
  if (score >= 4) return "Perfil medio";
  return "Perfil bajo";
}

function statcastValue(row, ...keys) {
  for (const key of keys) {
    const v = num(row?.[key]);
    if (v != null) return v;
  }
  return null;
}

export function computeTotalBases({ hits, doubles, triples, homeRuns, totalBases } = {}) {
  const official = num(totalBases);
  if (official != null) return official;

  const h = num(hits);
  const d = num(doubles);
  const t = num(triples);
  const hr = num(homeRuns);
  if ([h, d, t, hr].some(v => v == null)) return null;
  if (d < 0 || t < 0 || hr < 0 || h < d + t + hr) return null;
  return h + d + (2 * t) + (3 * hr);
}

export function parseBatterGameLogs(gameLogSplits, cutoffISO) {
  const cutoffDay = String(cutoffISO ?? new Date().toISOString()).slice(0, 10);
  return (gameLogSplits ?? [])
    .filter(s => s?.date && s.date < cutoffDay)
    .map(s => {
      const st = s.stat ?? {};
      const hits = num(st.hits);
      const doubles = num(st.doubles);
      const triples = num(st.triples);
      const homeRuns = num(st.homeRuns);
      const rbi = num(st.rbi ?? st.runsBattedIn);
      const totalBases = computeTotalBases({
        hits,
        doubles,
        triples,
        homeRuns,
        totalBases: st.totalBases,
      });
      return {
        date: s.date,
        atBats: num(st.atBats),
        plateAppearances: num(st.plateAppearances),
        hits,
        doubles,
        triples,
        homeRuns,
        rbi,
        totalBases,
      };
    });
}

function metricSample(games, key) {
  const season = games.map(g => g[key]);
  const last10 = season.slice(-10);
  const last5 = last10.slice(-5);
  const validLast10 = last10.filter(v => v != null);
  return {
    last5,
    last10,
    validLast10: validLast10.length,
    missingLast10: last10.length - validLast10.length,
    avgLast5: round1(mean(last5)),
    avgLast10: round1(mean(last10)),
    medianLast10: median(last10),
    seasonAvg: round1(mean(season)),
    atLeast1Last10: rateAtLeast(last10, 1),
    atLeast2Last10: rateAtLeast(last10, 2),
  };
}

export function computeRecentBatterSample(games, { minValidGames = BATTER_RADAR_MIN_VALID_GAMES } = {}) {
  const clean = Array.isArray(games) ? games : [];
  const validGames = clean.filter(g =>
    g?.hits != null || g?.totalBases != null || g?.homeRuns != null || g?.rbi != null
  ).length;
  const last10Games = clean.slice(-10);

  return {
    games: clean.length,
    validGames,
    insufficient: validGames < minValidGames,
    minValidGames,
    last5Dates: clean.slice(-5).map(g => g.date),
    last10Dates: last10Games.map(g => g.date),
    metrics: {
      hits: metricSample(clean, "hits"),
      totalBases: metricSample(clean, "totalBases"),
      homeRuns: metricSample(clean, "homeRuns"),
      rbi: metricSample(clean, "rbi"),
    },
  };
}

export function scoreHitsProfile(sample, statcastRow = {}, context = {}) {
  const m = sample?.metrics?.hits ?? {};
  let score = 0;
  const notes = [];

  if (m.avgLast10 >= 1.2) score += 3;
  else if (m.avgLast10 >= 1.0) score += 2;
  else if (m.avgLast10 >= 0.8) score += 1;

  if (m.atLeast1Last10?.rate >= 0.7) score += 3;
  else if (m.atLeast1Last10?.rate >= 0.6) score += 2;
  else if (m.atLeast1Last10?.rate >= 0.5) score += 1;

  const xba = statcastValue(statcastRow, "xba", "expected_batting_avg", "batting_avg");
  const xwoba = statcastValue(statcastRow, "xwoba");
  const hardHit = statcastValue(statcastRow, "hard_hit_percent", "hardHitPct");
  const statcastBoost = [
    xba != null && xba >= 0.280,
    xwoba != null && xwoba >= 0.350,
    hardHit != null && hardHit >= 42,
  ].filter(Boolean).length;
  score += statcastBoost;
  if (context.lineupSlot != null && Number(context.lineupSlot) <= 5) score += 1;

  const finalScore = roundScore(score);
  if (sample?.insufficient) notes.push("muestra insuficiente para hits");
  if (statcastBoost > 0) notes.push("Statcast aporta al perfil de hits sin reemplazar la muestra reciente.");
  return {
    key: "hits",
    label: profileLabel(finalScore, sample?.insufficient),
    score: sample?.insufficient ? null : finalScore,
    radarQualified: !sample?.insufficient && finalScore >= 6.5,
    status: "PROP_PARA_REVISAR",
    line: null,
    officialPick: false,
    sample: m,
    notes,
  };
}

export function scoreTotalBasesProfile(sample, statcastRow = {}, context = {}) {
  const m = sample?.metrics?.totalBases ?? {};
  let score = 0;
  const notes = [];

  if (m.avgLast10 >= 2.2) score += 3;
  else if (m.avgLast10 >= 1.7) score += 2;
  else if (m.avgLast10 >= 1.2) score += 1;

  if (m.atLeast2Last10?.rate >= 0.6) score += 3;
  else if (m.atLeast2Last10?.rate >= 0.5) score += 2;
  else if (m.atLeast2Last10?.rate >= 0.4) score += 1;

  const barrel = statcastValue(statcastRow, "barrel_batted_rate", "barrel_percent", "barrelPct");
  const hardHit = statcastValue(statcastRow, "hard_hit_percent", "hardHitPct");
  const exitVelo = statcastValue(statcastRow, "exit_velocity_avg", "exitVelo");
  const iso = statcastValue(statcastRow, "iso");
  const statcastBoost = [
    barrel != null && barrel >= 9,
    hardHit != null && hardHit >= 44,
    exitVelo != null && exitVelo >= 90,
    iso != null && iso >= 0.180,
  ].filter(Boolean).length;
  score += statcastBoost;
  if (context.lineupSlot != null && Number(context.lineupSlot) <= 5) score += 0.5;

  const finalScore = roundScore(score);
  if (sample?.insufficient) notes.push("muestra insuficiente para total bases");
  if (statcastBoost > 0) notes.push("Statcast aporta al perfil de bases totales sin inventar linea.");
  return {
    key: "totalBases",
    label: profileLabel(finalScore, sample?.insufficient),
    score: sample?.insufficient ? null : finalScore,
    radarQualified: !sample?.insufficient && finalScore >= 6.5,
    status: "PROP_PARA_REVISAR",
    line: null,
    officialPick: false,
    sample: m,
    notes,
  };
}

export function scoreHomeRunProfile(sample, statcastRow = {}, context = {}) {
  const m = sample?.metrics?.homeRuns ?? {};
  let score = 0;
  const notes = ["HR es evento raro: F1 no genera lenguaje fuerte ni pick oficial."];

  if (m.atLeast1Last10?.hits >= 3) score += 2;
  else if (m.atLeast1Last10?.hits >= 1) score += 1;

  const barrel = statcastValue(statcastRow, "barrel_batted_rate", "barrel_percent", "barrelPct");
  const hardHit = statcastValue(statcastRow, "hard_hit_percent", "hardHitPct");
  const exitVelo = statcastValue(statcastRow, "exit_velocity_avg", "exitVelo");
  const launchAngle = statcastValue(statcastRow, "launch_angle", "launch_angle_avg", "launchAngle");
  const iso = statcastValue(statcastRow, "iso");
  if (barrel != null && barrel >= 12) score += 2;
  if (hardHit != null && hardHit >= 48) score += 1.5;
  if (exitVelo != null && exitVelo >= 91) score += 1.5;
  if (launchAngle != null && launchAngle >= 10 && launchAngle <= 22) score += 1;
  if (iso != null && iso >= 0.220) score += 1;
  if (context.parkHrBoost === true) score += 1;

  const finalScore = roundScore(score);
  return {
    key: "homeRuns",
    label: sample?.insufficient ? "Muestra insuficiente" : (finalScore >= 4 ? "Perfil medio" : "Perfil bajo"),
    score: sample?.insufficient ? null : finalScore,
    radarQualified: false,
    status: "PROP_PARA_REVISAR",
    line: null,
    officialPick: false,
    rareEvent: true,
    strongLanguageAllowed: false,
    sample: m,
    notes,
  };
}

function rbiContext(sample, context = {}) {
  const lineupConfirmed = context.lineupConfirmed === true;
  const lineupSlot = context.lineupSlot != null ? Number(context.lineupSlot) : null;
  const hasRunContext = context.teamObp != null || context.projectedTeamRuns != null || context.baseRunnersContext === true;
  let confidence = "BAJA";
  if (lineupConfirmed && hasRunContext && lineupSlot != null && lineupSlot >= 3 && lineupSlot <= 6) {
    confidence = "MEDIA";
  }
  return {
    key: "rbi",
    label: sample?.insufficient ? "Muestra insuficiente" : "Dato contextual",
    score: null,
    radarQualified: false,
    status: "PROP_PARA_REVISAR",
    line: null,
    officialPick: false,
    confidence,
    sample: sample?.metrics?.rbi ?? null,
    notes: confidence === "BAJA"
      ? ["RBI queda en baja confianza sin lineup/contexto de corredores confirmado."]
      : ["RBI se conserva como contexto; F1 no produce score fuerte."],
  };
}

export function buildBatterRadarCard({
  playerId = null,
  name,
  teamName = null,
  lineupSlot = null,
  gameLogs = [],
  asOfISO = new Date().toISOString(),
  statcastRow = null,
  context = {},
} = {}) {
  const games = parseBatterGameLogs(gameLogs, asOfISO);
  const sample = computeRecentBatterSample(games);
  const mergedContext = { ...context, lineupSlot: lineupSlot ?? context.lineupSlot };

  const markets = {
    hits: scoreHitsProfile(sample, statcastRow, mergedContext),
    totalBases: scoreTotalBasesProfile(sample, statcastRow, mergedContext),
    homeRuns: scoreHomeRunProfile(sample, statcastRow, mergedContext),
    rbi: rbiContext(sample, mergedContext),
  };

  const bestScore = Math.max(
    markets.hits.score ?? 0,
    markets.totalBases.score ?? 0,
    markets.homeRuns.score ?? 0
  );

  return {
    playerId,
    name: name ?? null,
    teamName,
    lineupSlot,
    insufficient: sample.insufficient,
    label: profileLabel(bestScore, sample.insufficient),
    status: "PROP_PARA_REVISAR",
    officialPick: false,
    source: "MLB Stats API gameLog + Baseball Savant",
    cutoff: String(asOfISO).slice(0, 10),
    sample,
    statcast: {
      xba: statcastValue(statcastRow, "xba", "expected_batting_avg", "batting_avg"),
      xwoba: statcastValue(statcastRow, "xwoba"),
      barrelPct: statcastValue(statcastRow, "barrel_batted_rate", "barrel_percent", "barrelPct"),
      hardHitPct: statcastValue(statcastRow, "hard_hit_percent", "hardHitPct"),
      exitVelo: statcastValue(statcastRow, "exit_velocity_avg", "exitVelo"),
      launchAngle: statcastValue(statcastRow, "launch_angle", "launch_angle_avg", "launchAngle"),
      iso: statcastValue(statcastRow, "iso"),
      kPct: statcastValue(statcastRow, "k_percent", "kPct"),
      bbPct: statcastValue(statcastRow, "bb_percent", "bbPct"),
      whiffPct: statcastValue(statcastRow, "whiff_percent", "whiffPct"),
    },
    markets,
    nota: "Linea no disponible — PROP_PARA_REVISAR. Analisis informativo. No entra a ROI, CLV ni a la muestra oficial.",
  };
}

function playerNameFromBoxscore(players, playerId) {
  return players?.[`ID${playerId}`]?.person?.fullName ?? String(playerId);
}

function cardScore(card) {
  return Math.max(
    card?.markets?.hits?.score ?? 0,
    card?.markets?.totalBases?.score ?? 0,
    card?.markets?.homeRuns?.score ?? 0
  );
}

export async function fetchBatterGameLogs({ playerId, season, fetcher = fetch } = {}) {
  if (!playerId) return [];
  const r = await fetcher(`${MLB_BASE}/people/${playerId}/stats?stats=gameLog&group=hitting&season=${season}`);
  if (!r?.ok) throw new Error(`HTTP ${r?.status ?? "?"}`);
  const d = await r.json();
  const splits = d?.stats?.[0]?.splits;
  if (!Array.isArray(splits)) throw new Error("estructura inesperada (sin stats[0].splits)");
  return splits;
}

export async function buildBatterRadarTeam({
  teamName,
  battingOrder = [],
  players = {},
  savantMap = null,
  getStatcastProfile = null,
  asOfISO = new Date().toISOString(),
  season = new Date(asOfISO).getFullYear(),
  maxCards = 4,
  fetcher = fetch,
} = {}) {
  const order = (battingOrder ?? []).map(String).filter(Boolean);
  if (!order.length) {
    return {
      teamName,
      lineupConfirmed: false,
      status: "LINEUP_NO_CONFIRMADO",
      cards: [],
      nota: "Lineup no confirmado — Batter Radar compacto; no se inventan jugadores.",
    };
  }

  const candidates = order.slice(0, 6);
  const cards = await Promise.all(candidates.map(async (playerId, idx) => {
    const lineupSlot = idx + 1;
    const name = playerNameFromBoxscore(players, playerId);
    let gameLogs = [];
    try {
      gameLogs = await fetchBatterGameLogs({ playerId, season, fetcher });
    } catch (err) {
      gameLogs = [];
    }
    const statcastRow = typeof getStatcastProfile === "function"
      ? getStatcastProfile(savantMap, { playerId, name })
      : null;
    return buildBatterRadarCard({
      playerId,
      name,
      teamName,
      lineupSlot,
      gameLogs,
      asOfISO,
      statcastRow,
      context: { lineupConfirmed: true },
    });
  }));

  const ranked = cards
    .sort((a, b) => (cardScore(b) - cardScore(a)) || (a.lineupSlot - b.lineupSlot))
    .slice(0, maxCards);

  return {
    teamName,
    lineupConfirmed: true,
    status: "OK",
    cards: ranked,
    maxCards,
    candidates: candidates.length,
  };
}

export async function buildBatterRadar({
  awayTeamName,
  homeTeamName,
  awayOrder = [],
  homeOrder = [],
  awayPlayers = {},
  homePlayers = {},
  savantMap = null,
  getStatcastProfile = null,
  asOfISO = new Date().toISOString(),
  season = new Date(asOfISO).getFullYear(),
  maxCardsPerTeam = 4,
  fetcher = fetch,
} = {}) {
  const [away, home] = await Promise.all([
    buildBatterRadarTeam({
      teamName: awayTeamName,
      battingOrder: awayOrder,
      players: awayPlayers,
      savantMap,
      getStatcastProfile,
      asOfISO,
      season,
      maxCards: maxCardsPerTeam,
      fetcher,
    }),
    buildBatterRadarTeam({
      teamName: homeTeamName,
      battingOrder: homeOrder,
      players: homePlayers,
      savantMap,
      getStatcastProfile,
      asOfISO,
      season,
      maxCards: maxCardsPerTeam,
      fetcher,
    }),
  ]);
  const anyLineup = away.lineupConfirmed || home.lineupConfirmed;
  return {
    source: "MLB Stats API gameLog + Baseball Savant",
    status: anyLineup ? "OK" : "LINEUP_NO_CONFIRMADO",
    cutoff: String(asOfISO).slice(0, 10),
    maxCardsPerTeam,
    away,
    home,
    nota: anyLineup
      ? "Batter Radar informativo. Todos los mercados quedan PROP_PARA_REVISAR hasta verificar linea real."
      : "Lineups no confirmados — Batter Radar compacto; no se inventan jugadores.",
  };
}
