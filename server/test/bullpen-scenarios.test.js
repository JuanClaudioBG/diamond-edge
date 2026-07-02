/*
 * Escenarios de bullpen exigidos por la auditoría operativa (Fase 8):
 * closer 3 días seguidos, extra innings, datos incompletos, corte temporal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { relieverAvailability, computeBullpenScores, isUsableGame } from "../bullpen.js";

test("escenario: closer usado 3 días consecutivos → mínima disponibilidad", () => {
  const closer = {
    name: "Closer Élite", era: "1.80",
    appearances: [
      { daysAgo: 1, pitches: 14 },
      { daysAgo: 2, pitches: 16 },
      { daysAgo: 3, pitches: 12 },
    ],
  };
  assert.equal(relieverAvailability(closer.appearances), 0.15);
  const scores = computeBullpenScores(
    [closer, { name: "Middle", era: "4.20", appearances: [] }],
    { gamesFound: 5, windowDays: 7 }
  );
  // El mejor brazo (top-3 por ERA) quemado debe hundir HLA
  assert.ok(scores.highLeverageAvail < 60, `HLA=${scores.highLeverageAvail}`);
  assert.ok(scores.likelyUnavailable.includes("Closer Élite"));
});

test("escenario: extra innings anoche (carga masiva de todo el bullpen)", () => {
  // 14 innings anoche: 5 relevistas usados, cargas altas
  const relievers = ["A", "B", "C", "D", "E"].map((n, i) => ({
    name: n, era: "3.50",
    appearances: [{ daysAgo: 1, pitches: 22 + i * 4 }],  // 22..38 pitches
  }));
  const scores = computeBullpenScores(relievers, { gamesFound: 6, windowDays: 7 });
  // Todos lanzaron ayer → nadie con disponibilidad completa
  assert.ok(scores.availabilityScore <= 70, `BAS=${scores.availabilityScore}`);
  assert.ok(scores.fatigueRisk >= 30);
});

test("escenario: datos incompletos → confianza baja, nunca cero disfrazado", () => {
  const scores = computeBullpenScores(
    [{ name: "Único", era: undefined, appearances: [] }],
    { gamesFound: 1, windowDays: 7 }
  );
  assert.ok(scores.confidence <= 0.25, `confidence=${scores.confidence}`);
  // Sin ERA: qualityAvailable debe ser null (dato faltante), NO 0
  assert.equal(scores.qualityAvailable, null);
  assert.equal(scores.highLeverageAvail, null);
});

test("escenario: aparición posterior a la fecha de corte se descarta (anti-leakage)", () => {
  const asOf = "2026-07-02T17:00:00Z";
  // Juego de hoy en la noche (posterior al corte) NO es utilizable aunque esté Final
  const tonight = { status: { codedGameState: "F" }, gameDate: "2026-07-02T23:10:00Z" };
  assert.equal(isUsableGame(tonight, asOf), false);
  // Juego de ayer sí
  const yesterday = { status: { codedGameState: "F" }, gameDate: "2026-07-01T23:10:00Z" };
  assert.equal(isUsableGame(yesterday, asOf), true);
});

test("escenario: bullpen descansado completo (control)", () => {
  const relievers = Array.from({ length: 8 }, (_, i) => ({
    name: `R${i}`, era: (2.5 + i * 0.4).toFixed(2), appearances: [{ daysAgo: 6, pitches: 15 }],
  }));
  const scores = computeBullpenScores(relievers, { gamesFound: 6, windowDays: 7 });
  assert.equal(scores.availabilityScore, 100);
  assert.equal(scores.fatigueRisk, 0);
  assert.equal(scores.confidence, 1);
});
