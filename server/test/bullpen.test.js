import { test } from "node:test";
import assert from "node:assert/strict";
import {
  relieverAvailability, qualityWeight, qualityScore,
  computeBullpenScores, isUsableGame,
} from "../bullpen.js";

/* ── relieverAvailability ────────────────────────────────────────── */
test("relevista descansado → disponibilidad total", () => {
  assert.equal(relieverAvailability([]), 1.0);
  assert.equal(relieverAvailability([{ daysAgo: 5, pitches: 20 }]), 1.0);
});

test("back-to-back terminando ayer → prácticamente no disponible", () => {
  const a = relieverAvailability([
    { daysAgo: 1, pitches: 12 },
    { daysAgo: 2, pitches: 15 },
  ]);
  assert.equal(a, 0.15);
});

test("carga alta ayer (≥25 pitches) → 0.35", () => {
  assert.equal(relieverAvailability([{ daysAgo: 1, pitches: 28 }]), 0.35);
});

test("carga ligera ayer → 0.70, luego degradado por acumulado 2 días", () => {
  assert.equal(relieverAvailability([{ daysAgo: 1, pitches: 10 }]), 0.7);
  const acumulado = relieverAvailability([
    { daysAgo: 1, pitches: 10 },
    { daysAgo: 2, pitches: 0 },   // registro sin pitches no altera back-to-back real
  ]);
  assert.equal(acumulado, 0.7);
});

test("acumulado 3 días ≥55 reduce a 0.60 aunque no lanzó ayer", () => {
  const a = relieverAvailability([
    { daysAgo: 2, pitches: 30 },
    { daysAgo: 3, pitches: 30 },
  ]);
  assert.equal(a, 0.6);
});

/* ── quality ─────────────────────────────────────────────────────── */
test("qualityWeight acota en [0.5, 4.5] y neutral sin dato", () => {
  assert.equal(qualityWeight("1.00"), 4.5);
  assert.equal(qualityWeight("9.99"), 0.5);
  assert.equal(qualityWeight("3.00"), 3.0);
  assert.equal(qualityWeight(undefined), 1.0);
  assert.equal(qualityWeight("-.--"), 1.0);
});

test("qualityScore mapea ERA a 0-100 y null sin dato", () => {
  assert.equal(qualityScore("2.00"), 100);
  assert.equal(qualityScore("5.50"), 0);
  assert.equal(qualityScore(null), null);
});

/* ── computeBullpenScores ────────────────────────────────────────── */
const fresh = (name, era) => ({ name, era, appearances: [] });
const spent = (name, era) => ({
  name, era,
  appearances: [{ daysAgo: 1, pitches: 20 }, { daysAgo: 2, pitches: 18 }],
});

test("bullpen fresco → disponibilidad 100, riesgo 0, sin no-disponibles", () => {
  const s = computeBullpenScores(
    [fresh("A", "2.50"), fresh("B", "3.50"), fresh("C", "4.00")],
    { gamesFound: 5, windowDays: 7 }
  );
  assert.equal(s.availabilityScore, 100);
  assert.equal(s.fatigueRisk, 0);
  assert.equal(s.highLeverageAvail, 100);
  assert.deepEqual(s.likelyUnavailable, []);
});

test("bullpen quemado → alta fatiga y lista de no disponibles", () => {
  const s = computeBullpenScores(
    [spent("A", "2.50"), spent("B", "3.00"), fresh("C", "5.00")],
    { gamesFound: 5, windowDays: 7 }
  );
  assert.ok(s.availabilityScore < 50, `esperado <50, fue ${s.availabilityScore}`);
  assert.ok(s.likelyUnavailable.includes("A") && s.likelyUnavailable.includes("B"));
  // Los dos mejores brazos quemados → HLA bajo
  assert.ok(s.highLeverageAvail < 50);
});

test("sin relevistas → null (nunca ceros silenciosos)", () => {
  assert.equal(computeBullpenScores([], { gamesFound: 3, windowDays: 7 }), null);
});

test("confidence refleja cobertura de datos", () => {
  const full = computeBullpenScores(
    Array.from({ length: 7 }, (_, i) => fresh(`R${i}`, "3.50")),
    { gamesFound: 6, windowDays: 7 }
  );
  assert.equal(full.confidence, 1);
  const thin = computeBullpenScores(
    [fresh("A", "3.50")],
    { gamesFound: 1, windowDays: 7 }
  );
  assert.ok(thin.confidence < 0.3);
});

/* ── Guard anti-leakage ──────────────────────────────────────────── */
test("isUsableGame: solo juegos Final y estrictamente anteriores a asOf", () => {
  const asOf = "2026-07-02T18:00:00Z";
  const final =   { status: { codedGameState: "F" }, gameDate: "2026-07-01T23:00:00Z" };
  const live =    { status: { codedGameState: "I" }, gameDate: "2026-07-01T23:00:00Z" };
  const future =  { status: { codedGameState: "F" }, gameDate: "2026-07-03T23:00:00Z" };
  const posp =    { status: { codedGameState: "D" }, gameDate: "2026-07-01T23:00:00Z" };
  assert.equal(isUsableGame(final, asOf), true);
  assert.equal(isUsableGame(live, asOf), false);
  assert.equal(isUsableGame(future, asOf), false, "juego futuro no debe usarse (leakage)");
  assert.equal(isUsableGame(posp, asOf), false);
});
