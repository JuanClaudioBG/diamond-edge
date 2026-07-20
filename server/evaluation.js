/*
 * Evaluación Moneyball — helpers PUROS para separar el desempeño de forma
 * honesta y auditable. Solo lectura: nada se borra, nada se reconstruye.
 *
 * Separación central:
 *  - officialAnalyses: métricas de MODELO (Brier/log loss) sobre análisis
 *    prospectivos liquidados, deduplicados al último por gamePk.
 *  - officialSample: métricas de PICKS/apuestas. Las apuestas de reanálisis
 *    supersedidos fueron reales → se cuentan, pero se marcan y reportan.
 *  - ROI oficial separado: Moneyline usa odds_json; Prop oficial usa su
 *    props_json congelado. Nunca se mezclan unidades ni denominadores.
 *    RL/Total son SEÑAL (win rate sí, ROI no).
 *  - Históricos sin analysis_id: cuentan en overall con disclaimer; sin ROI.
 */
import { brier, logLoss, marketBrier, dedupLatest } from "./backtest/evaluate.js";
import { unitProfit } from "./backtest/odds-math.js";
import { findBatterPropLine } from "./player-props.js";

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "");
const tipoDe = (p) => norm(p?.tipo).replace(/\s+/g, "");

export const OFFICIAL_MIN_N = 30;

/* ── Récord básico: el win rate SIEMPRE ignora pendientes ────────── */
export function record(picks) {
  const ps = picks ?? [];
  const ganados    = ps.filter(p => p?.resultado === "ganó").length;
  const perdidos   = ps.filter(p => p?.resultado === "perdió").length;
  const pushes     = ps.filter(p => p?.resultado === "push").length;
  const voids      = ps.filter(p => p?.resultado === "void").length;
  const pendientes = ps.filter(p => p?.resultado == null).length;
  const decididos  = ganados + perdidos;
  return {
    n: ps.length, ganados, perdidos, pushes, voids, pendientes,
    winRate: decididos > 0 ? Math.round((ganados / decididos) * 1000) / 1000 : null,
  };
}

/* ── Odds del snapshot congelado para el lado del pick (solo ML) ─── */
function parseOddsJson(analysis) {
  if (analysis?.odds_json == null) return { odds: null, corrupt: false };
  try {
    const odds = JSON.parse(analysis.odds_json);
    return { odds: odds ?? null, corrupt: false };
  } catch { return { odds: null, corrupt: true }; }
}

export function priceForPickSide(pick, analysis) {
  const { odds, corrupt } = parseOddsJson(analysis);
  if (corrupt) return { price: null, corrupt: true };
  if (!odds?.bookmakers?.length) return { price: null, corrupt: false };
  const bk  = odds.bookmakers.find(b => ["draftkings", "fanduel", "betmgm"].includes(b.key)) ?? odds.bookmakers[0];
  const h2h = bk.markets?.find(m => m.key === "h2h");
  if (!h2h) return { price: null, corrupt: false };
  const t = norm(pick?.pick);
  const team = analysis?.home_team && t.includes(norm(analysis.home_team)) ? analysis.home_team
             : analysis?.away_team && t.includes(norm(analysis.away_team)) ? analysis.away_team
             : null;
  if (!team) return { price: null, corrupt: false };
  const out = h2h.outcomes?.find(o => norm(o.name) === norm(team));
  return { price: out?.price ?? null, corrupt: false };
}

/* ── Cuota de Prop oficial desde SU snapshot congelado ──────────── */
export function priceForOfficialProp(pick) {
  if (pick?.props_json == null) return { price: null, book: null, corrupt: false };

  let frozen;
  try {
    frozen = JSON.parse(pick.props_json);
  } catch {
    return { price: null, book: null, corrupt: true };
  }

  const snapshot = frozen?.payload;
  if (!snapshot || typeof snapshot !== "object") {
    return { price: null, book: null, corrupt: false };
  }
  const point = Number(pick.point);
  if (!pick.player || !pick.market || !["Over", "Under"].includes(pick.side) || !Number.isFinite(point)) {
    return { price: null, book: null, corrupt: false };
  }

  const found = findBatterPropLine(snapshot, {
    marketKey: pick.market,
    playerName: pick.player,
  });
  if (!found || Number(found.line) !== point) {
    return { price: null, book: null, corrupt: false };
  }
  const price = pick.side === "Over" ? found.overPrice : found.underPrice;
  return {
    price: price != null && Number.isFinite(Number(price)) ? Number(price) : null,
    book: found.book ?? null,
    corrupt: false,
  };
}

/* ── ROI oficial: SOLO Moneyline, cuota congelada, resultado decidido ── */
export function roiML(officialPicks, analysesById) {
  const ml = (officialPicks ?? []).filter(p => tipoDe(p).startsWith("moneyline"));
  let n = 0, wins = 0, units = 0, sinCuota = 0, corruptos = 0, pendientes = 0;
  for (const p of ml) {
    const a = analysesById.get(p.analysis_id);
    const { price, corrupt } = priceForPickSide(p, a);
    if (corrupt) { corruptos++; continue; }
    if (price == null || unitProfit(price) == null) { sinCuota++; continue; }
    if (p.resultado == null) { pendientes++; continue; }
    if (!["ganó", "perdió"].includes(p.resultado)) continue;
    n++;
    if (p.resultado === "ganó") { wins++; units += unitProfit(price); }
    else units -= 1;
  }
  return {
    n, wins,
    units: Math.round(units * 100) / 100,
    roi: n > 0 ? Math.round((units / n) * 1000) / 1000 : null,
    excluidosSinCuota: sinCuota, corruptos, pendientes,
  };
}

/* ── ROI oficial de Props: bucket independiente de Moneyline ────── */
export function roiOfficialProps(picks) {
  const props = (picks ?? []).filter(p => norm(p?.tipo) === "prop oficial");
  let n = 0, wins = 0, losses = 0, units = 0;
  let pushes = 0, voids = 0, pendientes = 0, sinCuota = 0, corruptos = 0;

  for (const p of props) {
    if (p.resultado == null) { pendientes++; continue; }
    if (p.resultado === "push") { pushes++; continue; }
    if (p.resultado === "void") { voids++; continue; }
    if (!["ganó", "perdió"].includes(p.resultado)) continue;

    const { price, corrupt } = priceForOfficialProp(p);
    if (corrupt) { corruptos++; continue; }
    const profit = unitProfit(price);
    if (price == null || profit == null) { sinCuota++; continue; }

    n++;
    if (p.resultado === "ganó") {
      wins++;
      units += profit;
    } else {
      losses++;
      units -= 1;
    }
  }

  return {
    n,
    wins,
    losses,
    pushes,
    voids,
    pendientes,
    units: Math.round(units * 100) / 100,
    roi: n > 0 ? Math.round((units / n) * 1000) / 1000 : null,
    excluidosSinCuota: sinCuota,
    corruptos,
  };
}

/* ── Discrepancias resultado manual vs settle (solo ML mapeable) ─── */
export function resultDiscrepancies(officialPicks, analysesById) {
  const out = [];
  for (const p of officialPicks ?? []) {
    if (!tipoDe(p).startsWith("moneyline") || p.resultado == null) continue;
    const a = analysesById.get(p.analysis_id);
    if (!a || a.resultado == null) continue;                    // sin settle aún
    const t = norm(p.pick);
    const side = a.home_team && t.includes(norm(a.home_team)) ? "home"
               : a.away_team && t.includes(norm(a.away_team)) ? "away" : null;
    if (!side) continue;
    const esperado = a.resultado === side ? "ganó" : "perdió";
    if (p.resultado !== esperado) {
      out.push({ pickId: p.id, analysisId: a.id, manual: p.resultado, settle: esperado });
    }
  }
  return out;
}

/* ── Agrupaciones ────────────────────────────────────────────────── */
export function byTypeRecord(picks) {
  const groups = {};
  for (const p of picks ?? []) {
    const tipo = p?.tipo ?? "Desconocido";
    (groups[tipo] ??= []).push(p);
  }
  return Object.fromEntries(Object.entries(groups).map(([t, ps]) => [t, record(ps)]));
}

export function byLogicVersionRecord(picks, analysesById) {
  const groups = {};
  for (const p of picks ?? []) {
    const a = p?.analysis_id != null ? analysesById.get(p.analysis_id) : null;
    const key = a?.logic_version ?? "histórico (sin registro)";
    (groups[key] ??= []).push(p);
  }
  return Object.fromEntries(Object.entries(groups).map(([v, ps]) => [v, record(ps)]));
}

/* ── Duplicados y reanálisis (se REPORTAN, jamás se borran) ──────── */
export function findExactDuplicates(picks) {
  const seen = new Map();
  for (const p of picks ?? []) {
    const key = `${p?.fecha}|${p?.partido}|${p?.tipo}|${p?.pick}`;
    (seen.get(key) ?? seen.set(key, []).get(key)).push(p.id);
  }
  return [...seen.values()].filter(ids => ids.length > 1).map(ids => ({ ids, n: ids.length }));
}

export function findReanalyses(analyses) {
  const byGame = new Map();
  for (const a of analyses ?? []) {
    if (a?.game_pk == null) continue;
    (byGame.get(a.game_pk) ?? byGame.set(a.game_pk, []).get(a.game_pk)).push(a.id);
  }
  return [...byGame.entries()].filter(([, ids]) => ids.length > 1)
    .map(([gamePk, ids]) => ({ gamePk, n: ids.length, analysisIds: ids }));
}

/* ── buildEvaluation ─────────────────────────────────────────────── */
export function buildEvaluation({ picks, analyses } = {}) {
  picks    = picks ?? [];      // null explícito también cae al vacío
  analyses = analyses ?? [];
  const analysesById = new Map(analyses.map(a => [a.id, a]));

  /* Muestra oficial de PICKS: enlazado + prospectivo + versionado + con odds */
  const officialPicks = picks.filter(p => {
    if (p?.analysis_id == null) return false;
    const a = analysesById.get(p.analysis_id);
    return !!a && a.retro === 0 && a.logic_version != null && a.odds_json != null;
  });

  /* Props oficiales tienen su propia elegibilidad: su fuente de precio es
     props_json, no el snapshot general odds_json de ML/RL/Total. */
  const officialPropCandidates = picks.filter(p => {
    if (norm(p?.tipo) !== "prop oficial" || p?.analysis_id == null || p?.props_json == null) return false;
    const a = analysesById.get(p.analysis_id);
    return !!a && a.retro === 0 && a.logic_version != null;
  });
  const officialPropPicks = officialPropCandidates.filter(p => {
    const { price, corrupt } = priceForOfficialProp(p);
    return !corrupt && price != null && unitProfit(price) != null;
  });

  /* Reanálisis: el último análisis por gamePk define la vista oficial de
     MODELO; las apuestas de análisis supersedidos se cuentan pero se marcan */
  const prospective = analyses.filter(a => a?.retro === 0);
  const latestIds = new Set(dedupLatest(prospective).rows.map(a => a.id));
  const supersededPicks = officialPicks.filter(p => !latestIds.has(p.analysis_id)).map(p => p.id);

  /* Métricas de MODELO: prospectivos liquidados, dedupe al último por gamePk */
  const settledLatest = dedupLatest(prospective.filter(a => a.resultado != null)).rows
    .map(a => ({ ...a, llm_prob_home: a.llm_prob_home != null ? Number(a.llm_prob_home) : null,
                 market_prob_home: a.market_prob_home != null ? Number(a.market_prob_home) : null }));
  const officialAnalyses = {
    n: settledLatest.length,
    brier:        settledLatest.length ? brier(settledLatest) : null,
    brierMercado: settledLatest.length ? marketBrier(settledLatest) : null,
    logLoss:      settledLatest.length ? logLoss(settledLatest) : null,
  };

  const roi = roiML(officialPicks, analysesById);
  const roiProps = roiOfficialProps(officialPropCandidates);
  const discrepancias = resultDiscrepancies(officialPicks, analysesById);
  const duplicates = {
    exactos: findExactDuplicates(picks),
    reanalisis: findReanalyses(analyses),
    supersededPicks,
  };

  const officialSample = {
    criteria: "analysis_id + retro=0 + logic_version + odds_json",
    criteriaProps: "tipo=Prop oficial + analysis_id + retro=0 + logic_version + props_json",
    ...record(officialPicks),
    roiML: roi,
    roiProps,
    supersededIncluidos: supersededPicks.length,
  };

  const senales = officialPicks.filter(p => tipoDe(p).startsWith("runline") || tipoDe(p).startsWith("total"));
  const byVerificationStatus = {
    mlVerificado:        { ...record(officialPicks.filter(p => tipoDe(p).startsWith("moneyline"))), roiEligible: true },
    senalesRLTotal:      { ...record(senales), roiEligible: false, nota: "SEÑAL sin EV — win rate sí, ROI no" },
    propsParaRevisar:    { ...record(picks.filter(p => tipoDe(p) === "propspararevisar" || norm(p?.tipo) === "prop para revisar")), roiEligible: false, nota: "línea/cuota no verificadas" },
    propsOficiales:      { ...record(officialPropPicks), roiEligible: true, roi: roiProps, nota: "bucket independiente; cuota congelada en props_json" },
    propsLegado:         { ...record(picks.filter(p => norm(p?.tipo) === "prop")), roiEligible: false, nota: "era pre-verificación" },
    historicoSinRegistro:{ ...record(picks.filter(p => p?.analysis_id == null)), roiEligible: false, nota: "sin cuota registrada — no auditable" },
  };

  const overall = record(picks);

  /* Alertas de calidad */
  const warnings = [];
  const w = (level, msg) => warnings.push({ level, msg });
  const sinRegistro = byVerificationStatus.historicoSinRegistro.n;
  if (sinRegistro > 0) w("info", `${sinRegistro} picks históricos sin analysis_id: cuentan en el total pero no son auditables (sin cuota registrada).`);
  const mlOficial = byVerificationStatus.mlVerificado;
  if (mlOficial.winRate != null && mlOficial.winRate < 0.5) w("warning", `Moneyline oficial bajo 50% (${(mlOficial.winRate * 100).toFixed(0)}% en ${mlOficial.n}).`);
  const totales = record(picks.filter(p => tipoDe(p).startsWith("total")));
  if (totales.winRate != null && totales.winRate < 0.45) w("warning", `Totales bajo 45% (${(totales.winRate * 100).toFixed(0)}% en ${totales.n}).`);
  if (overall.pendientes > 0) w("info", `${overall.pendientes} picks pendientes de resultado.`);
  if (duplicates.exactos.length > 0) w("warning", `${duplicates.exactos.length} grupos de picks duplicados exactos (reportados, no borrados).`);
  if (duplicates.reanalisis.length > 0) w("info", `${duplicates.reanalisis.length} juegos con reanálisis; las métricas de modelo usan el último por gamePk.`);
  if (supersededPicks.length > 0) w("info", `${supersededPicks.length} picks provienen de análisis supersedidos: cuentan como apuestas reales, marcados en duplicates.supersededPicks.`);
  if (discrepancias.length > 0) w("warning", `${discrepancias.length} discrepancias entre resultado manual del pick y settle del análisis — revisar a mano, no se resuelven en silencio.`);
  if (roi.corruptos > 0) w("warning", `${roi.corruptos} odds_json corruptos excluidos del ROI.`);
  if (roiProps.corruptos > 0) w("warning", `${roiProps.corruptos} props_json corruptos excluidos del ROI de props.`);
  if (roiProps.excluidosSinCuota > 0) w("warning", `${roiProps.excluidosSinCuota} props oficiales sin cuota exacta verificable excluidos de su ROI.`);
  if (roiProps.n > 0 && roiProps.n < OFFICIAL_MIN_N) w("warning", `Muestra de props oficiales n=${roiProps.n} < ${OFFICIAL_MIN_N}: insuficiente para conclusiones.`);
  if (officialSample.n > 0 && officialSample.n < OFFICIAL_MIN_N) w("warning", `Muestra oficial n=${officialSample.n} < ${OFFICIAL_MIN_N}: insuficiente para conclusiones.`);

  return {
    overall,
    officialSample,
    officialAnalyses,
    byLogicVersion: byLogicVersionRecord(picks, analysesById),
    byType: byTypeRecord(picks),
    byVerificationStatus,
    duplicates,
    discrepancias,
    warnings,
  };
}
