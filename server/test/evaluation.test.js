/*
 * Evaluación Moneyball F1 — helpers puros (server/evaluation.js).
 * Todo con fixtures: cero DB, cero red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  record, buildEvaluation, roiML, priceForPickSide,
  findExactDuplicates, findReanalyses, OFFICIAL_MIN_N,
} from "../evaluation.js";

const HOME = "San Francisco Giants";
const AWAY = "Toronto Blue Jays";

const oddsJson = (hPrice = -120, aPrice = 100) => JSON.stringify({
  home_team: HOME, away_team: AWAY,
  bookmakers: [{ key: "fanduel", markets: [{ key: "h2h", outcomes: [
    { name: HOME, price: hPrice }, { name: AWAY, price: aPrice },
  ]}]}],
});

let nextId = 1;
const mkAnalysis = (over = {}) => ({
  id: over.id ?? nextId++, game_pk: 100, created_at: "2026-07-08 10:00:00",
  retro: 0, logic_version: "2026-07-02.5", odds_json: oddsJson(),
  home_team: HOME, away_team: AWAY,
  llm_prob_home: 0.55, market_prob_home: 0.52, resultado: null,
  ...over,
});
const mkPick = (over = {}) => ({
  id: over.id ?? nextId++, fecha: "2026-07-08", partido: `${AWAY} @ ${HOME}`,
  tipo: "Moneyline", pick: `${HOME} ML`, valor: "ALTO", riesgo: "MEDIO",
  resultado: null, analysis_id: null,
  ...over,
});

/* ═══ 1. Win rate ignora pendientes ═══ */
test("win rate ignora pendientes", () => {
  const r = record([
    mkPick({ resultado: "ganó" }), mkPick({ resultado: "ganó" }),
    mkPick({ resultado: "perdió" }), mkPick({ resultado: null }), mkPick({ resultado: null }),
  ]);
  assert.equal(r.n, 5);
  assert.equal(r.pendientes, 2);
  assert.ok(Math.abs(r.winRate - 2 / 3) < 0.001, "2/3 sobre decididos, no 2/5");
  assert.equal(record([mkPick({ resultado: null })]).winRate, null, "solo pendientes → winRate null");
});

test("push y void son terminales pero no entran al denominador del win rate", () => {
  const r = record([
    mkPick({ resultado: "ganó" }),
    mkPick({ resultado: "perdió" }),
    mkPick({ resultado: "push" }),
    mkPick({ resultado: "void" }),
    mkPick({ resultado: null }),
  ]);
  assert.equal(r.winRate, 0.5);
  assert.equal(r.pushes, 1);
  assert.equal(r.voids, 1);
  assert.equal(r.pendientes, 1);
});

/* ═══ 2. ROI solo Moneyline con cuota real ═══ */
test("ROI: 2 ML ganados a -120/+100 y 1 perdido = unidades exactas; pick sin odds excluido y contado", () => {
  const a1 = mkAnalysis({ id: 1 });
  const a2 = mkAnalysis({ id: 2, game_pk: 101 });
  const a3 = mkAnalysis({ id: 3, game_pk: 102, odds_json: JSON.stringify({ bookmakers: [] }) }); // sin books
  const byId = new Map([[1, a1], [2, a2], [3, a3]]);
  const picks = [
    mkPick({ analysis_id: 1, pick: `${HOME} ML`, resultado: "ganó" }),   // -120 → +0.8333
    mkPick({ analysis_id: 2, pick: `${AWAY} ML`, resultado: "ganó" }),   // +100 → +1
    mkPick({ analysis_id: 1, pick: `${AWAY} ML`, resultado: "perdió" }), // −1
    mkPick({ analysis_id: 3, pick: `${HOME} ML`, resultado: "ganó" }),   // sin cuota → excluido
    mkPick({ analysis_id: 1, pick: `${HOME} ML`, resultado: null }),     // pendiente → excluido
  ];
  const r = roiML(picks, byId);
  assert.equal(r.n, 3);
  assert.equal(r.wins, 2);
  assert.ok(Math.abs(r.units - 0.83) < 0.01, `units=${r.units}`);
  assert.equal(r.excluidosSinCuota, 1);
  assert.equal(r.pendientes, 1);
});

/* ═══ 3-4. Agrupaciones ═══ */
test("agrupación por tipo y por logic_version", () => {
  const a5 = mkAnalysis({ id: 10, logic_version: "2026-07-02.5" });
  const a4 = mkAnalysis({ id: 11, game_pk: 101, logic_version: "2026-07-02.4" });
  const ev = buildEvaluation({
    picks: [
      mkPick({ analysis_id: 10, resultado: "ganó" }),
      mkPick({ analysis_id: 11, tipo: "Total", pick: "Under 7.5", resultado: "perdió" }),
      mkPick({ tipo: "Prop", pick: "X Over K", resultado: "ganó" }),      // histórico
    ],
    analyses: [a5, a4],
  });
  assert.equal(ev.byType.Moneyline.n, 1);
  assert.equal(ev.byType.Total.n, 1);
  assert.equal(ev.byType.Prop.n, 1);
  assert.equal(ev.byLogicVersion["2026-07-02.5"].n, 1);
  assert.equal(ev.byLogicVersion["2026-07-02.4"].n, 1);
  assert.equal(ev.byLogicVersion["histórico (sin registro)"].n, 1);
});

/* ═══ 5-6. Muestra oficial: exclusiones ═══ */
test("muestra oficial excluye sin analysis_id, retro≠0, sin versión y sin odds", () => {
  const ok      = mkAnalysis({ id: 20 });
  const retro   = mkAnalysis({ id: 21, game_pk: 101, retro: 1 });
  const sinVer  = mkAnalysis({ id: 22, game_pk: 102, logic_version: null });
  const sinOdds = mkAnalysis({ id: 23, game_pk: 103, odds_json: null });
  const ev = buildEvaluation({
    picks: [
      mkPick({ analysis_id: 20, resultado: "ganó" }),
      mkPick({ analysis_id: 21, resultado: "ganó" }),
      mkPick({ analysis_id: 22, resultado: "ganó" }),
      mkPick({ analysis_id: 23, resultado: "ganó" }),
      mkPick({ resultado: "ganó" }),                          // histórico
      mkPick({ analysis_id: 999, resultado: "ganó" }),        // huérfano
    ],
    analyses: [ok, retro, sinVer, sinOdds],
  });
  assert.equal(ev.officialSample.n, 1, "solo el pick del análisis completo entra");
  assert.equal(ev.overall.n, 6, "overall los incluye todos");
});

/* ═══ 7. Brier con dedupe del último por gamePk ═══ */
test("officialAnalyses usa el ÚLTIMO análisis liquidado por gamePk", () => {
  // Mismo juego: análisis viejo prob 0.9 (Brier malo), reanálisis prob 0.6
  const viejo = mkAnalysis({ id: 30, game_pk: 100, created_at: "2026-07-08 09:00:00", llm_prob_home: 0.9, resultado: "away" });
  const nuevo = mkAnalysis({ id: 31, game_pk: 100, created_at: "2026-07-08 12:00:00", llm_prob_home: 0.6, resultado: "away" });
  const ev = buildEvaluation({ picks: [], analyses: [viejo, nuevo] });
  assert.equal(ev.officialAnalyses.n, 1, "dedupe: un juego = un análisis");
  assert.ok(Math.abs(ev.officialAnalyses.brier - 0.36) < 1e-9, `usa prob 0.6 del último (0.6² = 0.36), fue ${ev.officialAnalyses.brier}`);
});

/* ═══ 8-9. Duplicados y reanálisis se reportan, no se borran ═══ */
test("duplicados exactos y reanálisis: reportados con ids, nada desaparece", () => {
  const p1 = mkPick({ id: 501, resultado: "ganó" });
  const p2 = mkPick({ id: 502, resultado: "ganó" });      // duplicado exacto (mismos campos)
  const a1 = mkAnalysis({ id: 40, game_pk: 100 });
  const a2 = mkAnalysis({ id: 41, game_pk: 100 });        // reanálisis
  const ev = buildEvaluation({ picks: [p1, p2], analyses: [a1, a2] });
  assert.equal(ev.duplicates.exactos.length, 1);
  assert.deepEqual(ev.duplicates.exactos[0].ids, [501, 502]);
  assert.equal(ev.duplicates.reanalisis.length, 1);
  assert.equal(ev.duplicates.reanalisis[0].n, 2);
  assert.equal(ev.overall.n, 2, "el duplicado NO se borra del conteo");
  assert.ok(ev.warnings.some(w => /duplicados exactos/.test(w.msg)));
  assert.ok(ev.warnings.some(w => /reanálisis/.test(w.msg)));
});

test("picks de análisis supersedidos cuentan como apuestas y quedan marcados", () => {
  const viejo = mkAnalysis({ id: 50, game_pk: 100, created_at: "2026-07-08 09:00:00" });
  const nuevo = mkAnalysis({ id: 51, game_pk: 100, created_at: "2026-07-08 12:00:00" });
  const pickViejo = mkPick({ id: 601, analysis_id: 50, resultado: "ganó" });
  const ev = buildEvaluation({ picks: [pickViejo], analyses: [viejo, nuevo] });
  assert.equal(ev.officialSample.n, 1, "la apuesta fue real: cuenta");
  assert.deepEqual(ev.duplicates.supersededPicks, [601], "pero queda marcada");
  assert.equal(ev.officialSample.supersededIncluidos, 1);
});

/* ═══ 10-11. RL/Total y Props jamás aportan ROI ═══ */
test("Run Line y Total son SEÑAL: win rate sí, ROI no (aunque el snapshot tenga cuotas)", () => {
  const a = mkAnalysis({ id: 60 });
  const ev = buildEvaluation({
    picks: [
      mkPick({ analysis_id: 60, tipo: "Run Line", pick: `${HOME} -1.5`, resultado: "ganó", cuotaReal: -152 }),
      mkPick({ analysis_id: 60, tipo: "Total", pick: "Under 7.5", resultado: "ganó" }),
    ],
    analyses: [a],
  });
  assert.equal(ev.byVerificationStatus.senalesRLTotal.n, 2);
  assert.equal(ev.byVerificationStatus.senalesRLTotal.winRate, 1);
  assert.equal(ev.byVerificationStatus.senalesRLTotal.roiEligible, false);
  assert.equal(ev.officialSample.roiML.n, 0, "el ROI oficial no incluye señales");
});

test("Props (legado y para revisar) nunca aportan ROI", () => {
  const ev = buildEvaluation({
    picks: [
      mkPick({ tipo: "Prop", pick: "X Over Ks", resultado: "ganó" }),
      mkPick({ tipo: "Prop para revisar", pick: "Y Over strikeouts", resultado: "perdió" }),
    ],
    analyses: [],
  });
  assert.equal(ev.byVerificationStatus.propsLegado.n, 1);
  assert.equal(ev.byVerificationStatus.propsLegado.roiEligible, false);
  assert.equal(ev.byVerificationStatus.propsParaRevisar.n, 1);
  assert.equal(ev.byVerificationStatus.propsParaRevisar.roiEligible, false);
  assert.equal(ev.officialSample.roiML.n, 0);
});

/* ═══ 12. Picks viejos sin campos nuevos no explotan ═══ */
test("picks legado (sin analysis_id ni campos nuevos) y entradas vacías no explotan", () => {
  const legacy = { id: 1, fecha: "2026-05-31", partido: "A @ B", tipo: "Moneyline", pick: "B ML", resultado: "ganó" };
  const ev = buildEvaluation({ picks: [legacy], analyses: [] });
  assert.equal(ev.overall.n, 1);
  assert.equal(ev.byVerificationStatus.historicoSinRegistro.n, 1);
  assert.ok(ev.warnings.some(w => /no son auditables/.test(w.msg)));
  const empty = buildEvaluation({});
  assert.equal(empty.overall.n, 0);
  assert.equal(buildEvaluation({ picks: null, analyses: null }).overall.n, 0);
});

/* ═══ 13. Discrepancia resultado manual vs settle ═══ */
test("pick marcado 'ganó' cuando settle dice que su lado perdió → warning, sin resolver en silencio", () => {
  const a = mkAnalysis({ id: 70, resultado: "away" });   // ganó el visitante
  const ev = buildEvaluation({
    picks: [mkPick({ id: 701, analysis_id: 70, pick: `${HOME} ML`, resultado: "ganó" })], // manual dice ganó el local
    analyses: [a],
  });
  assert.equal(ev.discrepancias.length, 1);
  assert.deepEqual(ev.discrepancias[0], { pickId: 701, analysisId: 70, manual: "ganó", settle: "perdió" });
  assert.ok(ev.warnings.some(w => /discrepancias/.test(w.msg) && w.level === "warning"));
  assert.equal(ev.officialSample.ganados, 1, "el dato manual NO se modifica");
});

/* ═══ 14. Muestra pequeña ═══ */
test("muestra oficial 0 < n < 30 genera warning de insuficiencia", () => {
  const a = mkAnalysis({ id: 80 });
  const ev = buildEvaluation({ picks: [mkPick({ analysis_id: 80, resultado: "ganó" })], analyses: [a] });
  assert.ok(ev.warnings.some(w => new RegExp(`n=1 < ${OFFICIAL_MIN_N}`).test(w.msg)));
});

/* ═══ 15. odds_json corrupto ═══ */
test("odds_json corrupto: no explota, se excluye del ROI y genera warning", () => {
  const a = mkAnalysis({ id: 90, odds_json: "{esto no es json" });
  const byId = new Map([[90, a]]);
  const pick = mkPick({ analysis_id: 90, resultado: "ganó" });
  assert.deepEqual(priceForPickSide(pick, a), { price: null, corrupt: true });
  const r = roiML([pick], byId);
  assert.equal(r.n, 0);
  assert.equal(r.corruptos, 1);
  const ev = buildEvaluation({ picks: [pick], analyses: [a] });
  assert.ok(ev.warnings.some(w => /odds_json corruptos/.test(w.msg)));
});

/* ═══ F2: endpoint registrado y estructura estable ═══ */
import { readFileSync } from "fs";

test("GET /api/evaluation está registrado ANTES del catch-all (o devolvería HTML)", () => {
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const evalIdx     = src.indexOf('app.get("/api/evaluation"');
  const catchAllIdx = src.indexOf('app.get("/{*path}"');
  assert.ok(evalIdx > -1, "el endpoint existe");
  assert.ok(catchAllIdx > -1, "el catch-all existe");
  assert.ok(evalIdx < catchAllIdx, "el endpoint debe ir antes del catch-all");
  assert.match(src, /buildEvaluation\(\{ picks: getAllPicks\(\), analyses: getAllAnalyses\(\) \}\)/);
});

test("estructura del contrato: todas las claves presentes incluso con datos vacíos", () => {
  const ev = buildEvaluation({ picks: [], analyses: [] });
  for (const key of ["overall", "officialSample", "officialAnalyses", "byLogicVersion", "byType", "byVerificationStatus", "duplicates", "discrepancias", "warnings"]) {
    assert.ok(key in ev, `falta la clave ${key}`);
  }
  assert.equal(ev.overall.n, 0);
  assert.equal(ev.officialAnalyses.brier, null, "sin análisis liquidados el Brier es null, no 0");
  assert.deepEqual(ev.duplicates.exactos, []);
});

/* ═══ F3: helpers de formateo de la UI (src/evaluation-display.js) ═══ */
import { fmtPct, fmtRoi, fmtUnits, fmtRecordLine, fmtBrier } from "../../src/evaluation-display.js";

test("formateo UI tolera null y presenta signos correctos", () => {
  assert.equal(fmtPct(0.526), "53%");
  assert.equal(fmtPct(null), "–");
  assert.equal(fmtRoi(-0.07), "-7.0%");
  assert.equal(fmtRoi(0.121), "+12.1%");
  assert.equal(fmtRoi(null), "–");
  assert.equal(fmtUnits(-0.49), "-0.49u");
  assert.equal(fmtUnits(2.5), "+2.5u");
  assert.equal(fmtUnits(null), "–");
  assert.equal(fmtRecordLine({ ganados: 10, perdidos: 9, pendientes: 7 }), "10-9 · 7 pend");
  assert.equal(fmtRecordLine({ ganados: 4, perdidos: 3, pendientes: 0 }), "4-3");
  assert.equal(fmtRecordLine(null), "–");
  assert.equal(fmtBrier(0.20602857), "0.2060");
  assert.equal(fmtBrier(null), "–");
});
