import { test } from "node:test";
import assert from "node:assert/strict";
import { americanToProb, probToAmerican, devig, unitProfit, evUnits } from "../backtest/odds-math.js";

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

/* ── americanToProb: casos conocidos verificables a mano ─────────── */
test("americanToProb casos canónicos", () => {
  close(americanToProb(100), 0.5);           // +100 → 50%
  close(americanToProb(150), 0.4);           // +150 → 100/250 = 40%
  close(americanToProb(-110), 110 / 210);    // −110 → 52.381%
  close(americanToProb(-150), 0.6);          // −150 → 150/250 = 60%
  close(americanToProb(-200), 2 / 3);        // −200 → 66.667%
});

test("americanToProb rechaza cuotas inválidas", () => {
  assert.equal(americanToProb(0), null);
  assert.equal(americanToProb(50), null);    // |odds| < 100 no existe
  assert.equal(americanToProb(-99), null);
  assert.equal(americanToProb("abc"), null);
  assert.equal(americanToProb(null), null);
});

/* ── probToAmerican: inversa ─────────────────────────────────────── */
test("probToAmerican inversa de casos conocidos", () => {
  assert.equal(probToAmerican(0.5), -100);
  assert.equal(probToAmerican(0.6), -150);
  assert.equal(probToAmerican(0.4), 150);
  assert.equal(probToAmerican(2 / 3), -200);
  assert.equal(probToAmerican(0), null);
  assert.equal(probToAmerican(1), null);
});

/* ── devig ───────────────────────────────────────────────────────── */
test("devig -110/-110 → 50/50 exacto", () => {
  const d = devig(-110, -110);
  close(d.a, 0.5);
  close(d.b, 0.5);
});

test("devig -150/+130: normaliza y suma 1", () => {
  const d = devig(-150, 130);
  close(d.a + d.b, 1);
  // -150 cruda = .6 ; +130 cruda = 100/230 = .43478 ; suma 1.03478 (vig 3.5%)
  close(d.a, 0.6 / (0.6 + 100 / 230));
});

test("devig requiere AMBOS lados — un lado faltante → null", () => {
  assert.equal(devig(-150, null), null);
  assert.equal(devig(undefined, 130), null);
  assert.equal(devig(-150, 50), null);   // lado inválido
});

/* ── unitProfit / payout ─────────────────────────────────────────── */
test("unitProfit: ganancia neta de 1 unidad", () => {
  close(unitProfit(100), 1.0);     // +100 gana 1u
  close(unitProfit(150), 1.5);     // +150 gana 1.5u
  close(unitProfit(-110), 100 / 110); // −110 gana 0.909u
  close(unitProfit(-200), 0.5);    // −200 gana 0.5u
  assert.equal(unitProfit(0), null);
});

/* ── EV verificable a mano ───────────────────────────────────────── */
test("EV: p=0.55 a -110 → 0.55·0.9091 − 0.45 = +0.05 (5% por unidad)", () => {
  close(evUnits(0.55, -110), 0.55 * (100 / 110) - 0.45, 1e-12);
  assert.ok(evUnits(0.55, -110) > 0.049 && evUnits(0.55, -110) < 0.051);
});

test("EV: probabilidad justa a cuota justa → EV 0", () => {
  close(evUnits(0.5, 100), 0);          // 50% a +100
  close(evUnits(2 / 3, -200), 0);       // 66.7% a −200
});

test("EV negativo cuando el mercado tiene razón y hay vig", () => {
  // apostar 50% real a −110 pierde el vig
  assert.ok(evUnits(0.5, -110) < 0);
});
