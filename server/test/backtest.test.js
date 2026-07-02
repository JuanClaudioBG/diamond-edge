import { test } from "node:test";
import assert from "node:assert/strict";
import { brier, logLoss, accuracy, wilson, log5Prob, calibrationBuckets } from "../backtest/evaluate.js";

const row = (probHome, resultado, extra = {}) => ({
  llm_prob_home: probHome, market_prob_home: null, resultado,
  home_team: "H", away_team: "A", predicted_winner: null, ...extra,
});

/* ── Brier / log loss ────────────────────────────────────────────── */
test("Brier: predicción perfecta → 0, peor posible → 1", () => {
  assert.equal(brier([row(1.0, "home"), row(0.0, "away")]), 0);
  assert.equal(brier([row(0.0, "home"), row(1.0, "away")]), 1);
});

test("Brier: coin flip constante → 0.25", () => {
  assert.equal(brier([row(0.5, "home"), row(0.5, "away")]), 0.25);
});

test("Brier y log loss excluyen filas sin probabilidad, null si no hay ninguna", () => {
  assert.equal(brier([row(null, "home")]), null);
  assert.equal(logLoss([row(null, "home")]), null);
  const mixed = [row(0.5, "home"), row(null, "away")];
  assert.equal(brier(mixed), 0.25, "la fila sin probabilidad no debe contar como cero");
});

test("log loss de p=0.5 constante = ln(2)", () => {
  const ll = logLoss([row(0.5, "home"), row(0.5, "away")]);
  assert.ok(Math.abs(ll - Math.log(2)) < 1e-9);
});

/* ── accuracy / wilson ───────────────────────────────────────────── */
test("accuracy ignora filas donde el picker no aplica", () => {
  const rows = [
    { resultado: "home", predicted_winner: "H", home_team: "H", away_team: "A" },
    { resultado: "away", predicted_winner: null, home_team: "H", away_team: "A" },
  ];
  const pick = (r) => r.predicted_winner === r.home_team ? "home" : r.predicted_winner === r.away_team ? "away" : null;
  const { n, acc } = accuracy(rows, pick);
  assert.equal(n, 1);
  assert.equal(acc, 1);
});

test("wilson: intervalo contiene p y se estrecha con n", () => {
  const [lo1, hi1] = wilson(0.6, 20);
  const [lo2, hi2] = wilson(0.6, 200);
  assert.ok(lo1 < 0.6 && hi1 > 0.6);
  assert.ok(hi2 - lo2 < hi1 - lo1);
});

/* ── log5 baseline ───────────────────────────────────────────────── */
test("log5: equipos iguales → 0.5; mejor récord → >0.5; sin juegos → null", () => {
  assert.equal(log5Prob(40, 40, 40, 40), 0.5);
  assert.ok(log5Prob(50, 30, 30, 50) > 0.5);
  assert.equal(log5Prob(0, 0, 40, 40), null);
});

/* ── calibración ─────────────────────────────────────────────────── */
test("calibración: buckets acumulan n y frecuencia real", () => {
  const rows = [row(0.95, "home"), row(0.92, "home"), row(0.91, "away")];
  const buckets = calibrationBuckets(rows);
  const top = buckets[9];
  assert.equal(top.n, 3);
  assert.ok(Math.abs(top.frecuenciaReal - 2 / 3) < 1e-9);
});
