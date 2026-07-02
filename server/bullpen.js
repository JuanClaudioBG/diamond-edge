/*
 * Bullpen Fatigue — indicador experimental aislado.
 *
 * Mide DISPONIBILIDAD del bullpen (quién puede lanzar hoy y qué tan bueno es),
 * separada de la CALIDAD agregada de temporada que ya existe en el prompt.
 *
 * Fuentes: MLB Stats API schedule (últimos 7 días, solo juegos Final estrictamente
 * anteriores a asOf) + boxscores. Sin datos → null, nunca ceros silenciosos.
 *
 * Scores (0-100):
 *   availabilityScore (BAS)  — media de disponibilidad ponderada por calidad del relevista
 *   highLeverageAvail (HLA)  — disponibilidad media de los 3 mejores relevistas por ERA
 *   qualityAvailable  (BQA)  — calidad media de los relevistas disponibles (avail ≥ 0.6)
 *   fatigueRisk              — 100 − BAS
 *   confidence (0-1)         — cobertura de datos (juegos y relevistas encontrados)
 */

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const DAY_MS   = 24 * 60 * 60 * 1000;

/* ── Funciones puras ─────────────────────────────────────────────── */

/**
 * appearances: [{ daysAgo: int ≥ 1, pitches: int }] de UN relevista.
 * Regresa disponibilidad 0-1. Heurística documentada en el docstring del módulo:
 * back-to-back reciente y cargas altas de pitcheo reducen disponibilidad.
 */
export function relieverAvailability(appearances) {
  if (!appearances.length) return 1.0;
  const byDay = new Map();
  for (const ap of appearances) {
    byDay.set(ap.daysAgo, (byDay.get(ap.daysAgo) ?? 0) + ap.pitches);
  }
  const p = (d) => byDay.get(d) ?? 0;
  const sum = (from, to) => {
    let s = 0;
    for (let d = from; d <= to; d++) s += p(d);
    return s;
  };

  let avail = 1.0;
  // Lanzó ayer Y antier (back-to-back terminando ayer) → casi seguro descansa
  if (p(1) > 0 && p(2) > 0)        avail = Math.min(avail, 0.15);
  // Carga alta ayer
  else if (p(1) >= 25)             avail = Math.min(avail, 0.35);
  // Lanzó ayer (carga ligera)
  else if (p(1) > 0)               avail = Math.min(avail, 0.70);
  // Cargas acumuladas
  if (sum(1, 2) >= 40)             avail = Math.min(avail, 0.50);
  if (sum(1, 3) >= 55)             avail = Math.min(avail, 0.60);
  return avail;
}

/** ERA de temporada → peso de calidad (mejor ERA pesa más en los scores). */
export function qualityWeight(era) {
  const e = parseFloat(era);
  if (isNaN(e)) return 1.0;                    // sin dato: peso neutral
  return Math.min(4.5, Math.max(0.5, 6 - e));  // ERA 1.50→4.5 … ERA 5.50→0.5
}

/** ERA → score de calidad 0-100 para BQA. */
export function qualityScore(era) {
  const e = parseFloat(era);
  if (isNaN(e)) return null;
  return Math.round(Math.min(1, Math.max(0, (5.5 - e) / 3.5)) * 100);
}

/**
 * relievers: [{ name, era, appearances: [{daysAgo, pitches}] }]
 * meta: { gamesFound, windowDays }
 */
export function computeBullpenScores(relievers, meta = { gamesFound: 0, windowDays: 7 }) {
  if (!relievers.length) return null;

  const scored = relievers.map(r => ({
    ...r,
    avail:  relieverAvailability(r.appearances),
    weight: qualityWeight(r.era),
    qs:     qualityScore(r.era),
  }));

  const wSum = scored.reduce((s, r) => s + r.weight, 0);
  const bas  = Math.round(scored.reduce((s, r) => s + r.avail * r.weight, 0) / wSum * 100);

  const topArms = [...scored]
    .filter(r => r.qs != null)
    .sort((x, y) => parseFloat(x.era) - parseFloat(y.era))
    .slice(0, 3);
  const hla = topArms.length
    ? Math.round(topArms.reduce((s, r) => s + r.avail, 0) / topArms.length * 100)
    : null;

  const availables = scored.filter(r => r.avail >= 0.6 && r.qs != null);
  const bqa = availables.length
    ? Math.round(availables.reduce((s, r) => s + r.qs, 0) / availables.length)
    : null;

  const confidence = Math.round(
    Math.min(1, meta.gamesFound / 4) * Math.min(1, scored.length / 6) * 100
  ) / 100;

  const tired = scored.filter(r => r.avail <= 0.35).map(r => r.name);

  return {
    availabilityScore: bas,
    highLeverageAvail: hla,
    qualityAvailable:  bqa,
    fatigueRisk:       100 - bas,
    confidence,
    relieverCount:     scored.length,
    gamesAnalyzed:     meta.gamesFound,
    likelyUnavailable: tired,
  };
}

/**
 * Guard anti-leakage: un juego cuenta solo si terminó (Final) y empezó
 * estrictamente antes de asOf.
 */
export function isUsableGame(game, asOfISO) {
  return game?.status?.codedGameState === "F" &&
         new Date(game.gameDate).getTime() < new Date(asOfISO).getTime();
}

/* ── Fetch + orquestación (con cache 1h por equipo) ──────────────── */

const fatigueCache = new Map(); // teamId → { data, fetchedAt }
const FATIGUE_TTL_MS = 60 * 60 * 1000;

export async function getBullpenFatigue(teamId, asOfISO = new Date().toISOString()) {
  const cached = fatigueCache.get(teamId);
  if (cached && Date.now() - cached.fetchedAt < FATIGUE_TTL_MS) return cached.data;

  try {
    const asOf  = new Date(asOfISO);
    const start = new Date(asOf.getTime() - 7 * DAY_MS).toISOString().split("T")[0];
    const end   = new Date(asOf.getTime() - 0 * DAY_MS).toISOString().split("T")[0];

    const schedRes = await fetch(
      `${MLB_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${end}`
    );
    const sched = await schedRes.json();
    const games = (sched.dates ?? [])
      .flatMap(d => d.games ?? [])
      .filter(g => isUsableGame(g, asOfISO));

    if (!games.length) {
      const data = null; // sin juegos utilizables → sin indicador, no ceros
      fatigueCache.set(teamId, { data, fetchedAt: Date.now() });
      return data;
    }

    const boxscores = await Promise.all(
      games.map(g =>
        fetch(`${MLB_BASE}/game/${g.gamePk}/boxscore`)
          .then(r => r.json())
          .then(box => ({ gameDate: g.gameDate, box }))
          .catch(() => null)
      )
    );

    // relieverName → { era, appearances }
    const relievers = new Map();
    for (const entry of boxscores) {
      if (!entry) continue;
      const daysAgo = Math.max(1, Math.round((asOf - new Date(entry.gameDate)) / DAY_MS));
      const side = ["home", "away"].find(
        s => entry.box?.teams?.[s]?.team?.id === Number(teamId)
      );
      if (!side) continue;
      const team     = entry.box.teams[side];
      const pitchers = team.pitchers ?? [];          // en orden de aparición
      const relIds   = pitchers.slice(1);            // primero = abridor
      for (const pid of relIds) {
        const pl = team.players?.[`ID${pid}`];
        if (!pl) continue;
        const pitches = pl.stats?.pitching?.numberOfPitches ?? pl.stats?.pitching?.pitchesThrown;
        if (pitches == null) continue;               // sin dato → se excluye, no cero
        const name = pl.person?.fullName ?? String(pid);
        if (!relievers.has(name)) {
          relievers.set(name, { name, era: pl.seasonStats?.pitching?.era, appearances: [] });
        }
        relievers.get(name).appearances.push({ daysAgo, pitches: Number(pitches) });
      }
    }

    const data = computeBullpenScores(
      [...relievers.values()],
      { gamesFound: games.length, windowDays: 7 }
    );
    fatigueCache.set(teamId, { data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    console.error("[Bullpen] Error:", err.message);
    return null;
  }
}

export function fmtBullpenFatigue(scores, teamName) {
  if (!scores) return `${teamName}: sin datos suficientes de uso reciente`;
  const hla = scores.highLeverageAvail != null ? `${scores.highLeverageAvail}` : "–";
  const bqa = scores.qualityAvailable  != null ? `${scores.qualityAvailable}`  : "–";
  const out = scores.likelyUnavailable.length
    ? ` | Probablemente NO disponibles: ${scores.likelyUnavailable.join(", ")}`
    : "";
  return (
    `${teamName}: Disponibilidad ${scores.availabilityScore}/100 | ` +
    `Brazos de alto leverage ${hla}/100 | Calidad disponible ${bqa}/100 | ` +
    `Riesgo fatiga ${scores.fatigueRisk}/100 (confianza ${scores.confidence}, ` +
    `${scores.gamesAnalyzed} juegos, ${scores.relieverCount} relevistas)${out}`
  );
}
