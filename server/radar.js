/*
 * Radar de Ponches — sección INFORMATIVA para abridores calificados.
 *
 * Producción reciente de strikeouts desde game logs REALES (MLB Stats API),
 * enriquecida con Savant (xERA, K%, Whiff%) y FanGraphs (FIP, xFIP) ya
 * cacheados. El LLM no interviene: todos los números se calculan en código.
 *
 * NO participa en: prompt del modelo, ROI, CLV ni muestra oficial.
 *
 * Políticas duras:
 *  - strikeOuts faltante = null, JAMÁS 0: la apertura no entra a promedio,
 *    mediana ni hit rates; la cobertura se reporta explícitamente.
 *  - radarQualified exige SIMULTÁNEAMENTE calidad + perfil de ponches +
 *    volumen + muestra: un abridor élite de contacto no es candidato a props.
 *  - Anti-leakage: solo aperturas ESTRICTAMENTE anteriores al día de corte.
 *  - Línea real solo desde el snapshot de odds, con Over/Under del MISMO
 *    point; nunca desde texto del LLM.
 */

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

/* ── Funciones puras: estadística ────────────────────────────────── */

export function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Línea de mercado → strikeouts mínimos para superarla (5.5 → 6; entera 6 → 7). */
export function lineToThreshold(line) {
  const l = Number(line);
  if (!Number.isFinite(l)) return null;
  return Number.isInteger(l) ? l + 1 : Math.ceil(l);
}

/** "Habría superado una línea de X en N de sus últimas M aperturas." Solo Ks válidos. */
export function hitsOverLine(ks, line) {
  const th = lineToThreshold(line);
  if (th == null) return null;
  const valid = ks.filter(k => k != null);
  return { hits: valid.filter(k => k >= th).length, n: valid.length, threshold: th };
}

/** Línea entera: win (> línea), push (= línea), loss (< línea). Solo Ks válidos. */
export function recordVsIntegerLine(ks, line) {
  const l = Number(line);
  if (!Number.isInteger(l)) return null;
  const valid = ks.filter(k => k != null);
  return {
    win:  valid.filter(k => k > l).length,
    push: valid.filter(k => k === l).length,
    loss: valid.filter(k => k < l).length,
    n:    valid.length,
  };
}

export function hitRateAtThreshold(ks, minK) {
  const valid = ks.filter(k => k != null);
  return { hits: valid.filter(k => k >= minK).length, n: valid.length };
}

/* ── Anti-leakage: fecha de corte explícita ──────────────────────── */

export function applyCutoff(gameLogSplits, cutoffISO) {
  const cutoffDay = String(cutoffISO).slice(0, 10);
  return (gameLogSplits ?? []).filter(s =>
    s?.date && s.date < cutoffDay && Number(s.stat?.gamesStarted) >= 1
  );
}

export function parseIP(ip) {
  if (ip == null) return null;
  const [full = "0", thirds = "0"] = String(ip).split(".");
  return parseInt(full) + parseInt(thirds) / 3;
}

/* ── Calificación ────────────────────────────────────────────────── */

export const QUALIFY_THRESHOLDS = {
  minStarts: 8, minIP: 50,
  era: 4.00, xera: 4.15, xfip: 4.15,
  kPct: 22, whiffPct: 25, avgIP: 5.0,
  minQuality: 2.5, minKProfile: 3, minVolume: 1, minScore: 6,
};

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/**
 * Tres sub-perfiles independientes (criterio sin dato NO suma ni resta):
 *   calidad (0-4): ERA ≤4.00 (1) · xERA ≤4.15 (1.5) · xFIP ≤4.15 (1.5)
 *   ponches (0-4): K% ≥22 (2) · Whiff% ≥25 (2)
 *   volumen (0-2): IP promedio ≥5.0 (2)
 *
 *   goodPitcher     = muestra OK y calidad ≥ 2.5
 *   strongKProfile  = ponches ≥ 3
 *   radarQualified  = muestra OK ∧ calidad ≥2.5 ∧ ponches ≥3 ∧ volumen ≥1 ∧ score ≥6
 * Un ERA élite con K% bajo → goodPitcher sí, radarQualified NO.
 */
export function qualifyPitcher({ era, xera, xfip, kPct, whiffPct, avgIP, starts, totalIP }) {
  const T = QUALIFY_THRESHOLDS;
  const sampleOk = (starts ?? 0) >= T.minStarts || (totalIP ?? 0) >= T.minIP;

  const crit = {};
  const check = (name, value, limit, lower = true) => {
    const v = num(value);
    if (v == null) { crit[name] = "sin dato"; return null; }
    const ok = lower ? v <= limit : v >= limit;
    crit[name] = ok;
    return ok;
  };
  const pts = (ok, w) => (ok === true ? w : 0);

  const quality =
    pts(check("era",  era,  T.era),  1) +
    pts(check("xera", xera, T.xera), 1.5) +
    pts(check("xfip", xfip, T.xfip), 1.5);
  const kProfile =
    pts(check("kPct",     kPct,     T.kPct,     false), 2) +
    pts(check("whiffPct", whiffPct, T.whiffPct, false), 2);
  const volume =
    pts(check("avgIP", avgIP, T.avgIP, false), 2);

  const score = Math.round((quality + kProfile + volume) * 10) / 10;
  const goodPitcher    = sampleOk && quality >= T.minQuality;
  const strongKProfile = kProfile >= T.minKProfile;
  return {
    sampleOk, score,
    subscores: { quality, kProfile, volume },
    criteria: crit,
    goodPitcher,
    strongKProfile,
    radarQualified: sampleOk && quality >= T.minQuality && kProfile >= T.minKProfile &&
                    volume >= T.minVolume && score >= T.minScore,
  };
}

/* ── Verificación de línea real (en código, nunca LLM) ───────────── */

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, "").trim();

/**
 * Mercado estándar "pitcher_strikeouts". Over y Under solo forman línea
 * completa cuando comparten EXACTAMENTE el mismo point (jamás se combinan
 * Over 5.5 con Under 6.5). Con un solo lado disponible, solo ese lado queda
 * verificado y se marca complete:false.
 */
export function verifyStrikeoutLine(oddsGame, pitcherName) {
  if (!oddsGame?.bookmakers?.length || !pitcherName) return null;
  for (const bk of oddsGame.bookmakers) {
    const m = bk.markets?.find(mk => mk.key === "pitcher_strikeouts");
    if (!m) continue;
    const outs = (m.outcomes ?? []).filter(o =>
      norm(o.description ?? o.player ?? "") === norm(pitcherName) &&
      o.point != null && o.price != null
    );
    if (!outs.length) continue;

    /* Agrupar por point y preferir una línea con AMBOS lados del mismo point */
    const byPoint = new Map();
    for (const o of outs) {
      const key = Number(o.point);
      if (!byPoint.has(key)) byPoint.set(key, {});
      if (o.name === "Over")  byPoint.get(key).over  = o;
      if (o.name === "Under") byPoint.get(key).under = o;
    }
    const points   = [...byPoint.entries()];
    const complete = points.find(([, s]) => s.over && s.under);
    const [point, sides] = complete ?? points.find(([, s]) => s.over || s.under);

    return {
      book:       bk.key,
      bookTitle:  bk.title ?? bk.key,
      lastUpdate: bk.last_update ?? null,
      player:     pitcherName,
      point,
      over:  sides.over  ? { price: sides.over.price }  : null,
      under: sides.under ? { price: sides.under.price } : null,
      complete: !!(sides.over && sides.under),
    };
  }
  return null;
}

/* ── Construcción de la tarjeta (pura) ───────────────────────────── */

const K_COVERAGE_MIN = 0.7; // <70% de aperturas con dato de K → datos incompletos

export function buildRadarCard({ name, splits, seasonStats, savantRow, fgRow, rival, line = null }) {
  const starts = splits.map(s => ({
    date:    s.date,
    k:       s.stat?.strikeOuts != null ? Number(s.stat.strikeOuts) : null,   // null se queda null
    ip:      parseIP(s.stat?.inningsPitched),
    pitches: s.stat?.numberOfPitches != null ? Number(s.stat.numberOfPitches) : null,
  }));
  const last10 = starts.slice(-10);
  const last5  = last10.slice(-5);
  const ks10   = last10.map(s => s.k);              // puede contener null (se muestran como –)
  const ks5    = last5.map(s => s.k);
  const ksSeason  = starts.map(s => s.k);
  const valid10   = ks10.filter(k => k != null);
  const ips       = last10.map(s => s.ip).filter(v => v != null);
  const pitches   = last10.map(s => s.pitches).filter(v => v != null);
  const totalIP   = starts.map(s => s.ip).filter(v => v != null).reduce((a, b) => a + b, 0);

  const season = {
    era:   num(seasonStats?.era),
    k9:    num(seasonStats?.strikeoutsPer9Inn),
    xera:  num(savantRow?.xera),
    kPct:  num(savantRow?.k_percent),
    whiffPct: num(savantRow?.whiff_percent),
    fip:   num(fgRow?.fip),
    xfip:  num(fgRow?.xfip),
  };
  const avgIP = mean(ips);

  const qual = qualifyPitcher({
    era: season.era, xera: season.xera, xfip: season.xfip,
    kPct: season.kPct, whiffPct: season.whiffPct,
    avgIP, starts: starts.length, totalIP,
  });

  if (!qual.sampleOk) {
    return {
      name, insufficient: true,
      reason: `muestra insuficiente (${starts.length} aperturas, ${totalIP.toFixed(0)} IP — mínimo ${QUALIFY_THRESHOLDS.minStarts} aperturas o ${QUALIFY_THRESHOLDS.minIP} IP)`,
      starts: starts.length,
      line: null,
    };
  }

  const coverage = last10.length ? valid10.length / last10.length : 0;
  const dataIncomplete = coverage < K_COVERAGE_MIN;

  const thresholds = {};
  for (const t of [4, 5, 6, 7, 8]) thresholds[t] = hitRateAtThreshold(ks10, t);

  let lineInfo = null;
  if (line) {
    lineInfo = {
      ...line,
      vsLine: {
        last5:  hitsOverLine(ks5, line.point),
        last10: hitsOverLine(ks10, line.point),
        season: hitsOverLine(ksSeason, line.point),
        recordLast10: recordVsIntegerLine(ks10, line.point),    // null si la línea no es entera
        recordSeason: recordVsIntegerLine(ksSeason, line.point),
      },
      nota: "Línea y cuota verificadas. EV no calculado. No entra a ROI ni a la muestra oficial.",
    };
  }

  return {
    name,
    insufficient: false,
    radarQualified: qual.radarQualified && !dataIncomplete,
    goodPitcher: qual.goodPitcher,
    strongKProfile: qual.strongKProfile,
    compactNote: qual.radarQualified && !dataIncomplete ? null
      : dataIncomplete ? "datos incompletos de strikeouts — sin tarjeta completa"
      : qual.goodPitcher && !qual.strongKProfile ? "Abridor sólido, perfil de ponches bajo — no califica para Radar"
      : "Perfil no calificado para Radar",
    score: qual.score,
    subscores: qual.subscores,
    criteria: qual.criteria,
    sample: {
      starts: starts.length,
      validKLast10: valid10.length,
      incompleteLast10: last10.length - valid10.length,
      coverage: Math.round(coverage * 100) / 100,
      dataIncomplete,
      last5Ks: ks5, last10Ks: ks10,
      avgK: mean(valid10) != null ? Math.round(mean(valid10) * 10) / 10 : null,
      medianK: median(valid10),
      avgIP: avgIP != null ? Math.round(avgIP * 10) / 10 : null,
      avgPitches: pitches.length ? Math.round(mean(pitches)) : null,
    },
    thresholds,
    season,
    rival: rival ?? null,
    line: lineInfo,
    nota: lineInfo ? null : "Línea no disponible — PROP PARA REVISAR. Análisis informativo. No entra a ROI, CLV ni a la muestra oficial.",
  };
}

/* ── Fetch con caché por pitcher + fecha de corte (freshness real) ── */

const radarCache = new Map(); // `${pitcherId}:${cutoffDay}` → { data, fetchedAt }
const RADAR_TTL_MS = 60 * 60 * 1000;

export async function getStrikeoutRadar({
  pitcherId, name, asOfISO = new Date().toISOString(),
  seasonStats = null, savantRow = null, fgRow = null, rival = null, oddsGame = null,
  fetcher = fetch,
}) {
  if (!pitcherId) return null;
  const cutoffDay = String(asOfISO).slice(0, 10);
  const cacheKey  = `${pitcherId}:${cutoffDay}`;

  let splits, fetchedAt, fromCache;
  const cached = radarCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < RADAR_TTL_MS) {
    splits    = cached.data;
    fetchedAt = cached.fetchedAt;      // timestamp REAL del fetch original
    fromCache = true;
  } else {
    try {
      const season = new Date(asOfISO).getFullYear();
      const r = await fetcher(`${MLB_BASE}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const raw = d?.stats?.[0]?.splits;
      if (!Array.isArray(raw)) throw new Error("estructura inesperada (sin stats[0].splits)");
      splits    = raw;
      fetchedAt = Date.now();
      fromCache = false;
      radarCache.set(cacheKey, { data: splits, fetchedAt });
    } catch (err) {
      console.error("[Radar] Error gameLog:", err.message);
      return { name, insufficient: true, reason: `fuente de game logs no disponible (${err.message})`, line: null };
    }
  }

  const usable = applyCutoff(splits, asOfISO);
  const line = verifyStrikeoutLine(oddsGame, name);
  const card = buildRadarCard({ name, splits: usable, seasonStats, savantRow, fgRow, rival, line });
  card.source          = "MLB Stats API gameLog + Baseball Savant + FanGraphs";
  card.fetchedAt       = new Date(fetchedAt).toISOString();
  card.fromCache       = fromCache;
  card.cacheAgeMinutes = Math.round((Date.now() - fetchedAt) / 60000);
  card.cutoff          = cutoffDay;
  return card;
}
