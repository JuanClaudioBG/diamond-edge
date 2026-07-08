/*
 * Fase 4 UI de 2026-07-02.5 — helpers puros de presentación
 * (src/analysis-display.js, compartido entre frontend y esta suite).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { totalDisplay, isStarterKPropCoveredByRadar } from "../../src/analysis-display.js";

/* ═══ Total: proyección ≠ línea real ≠ señal ═══ */

test("total con proyectado + lineaMercado: los tres campos separados", () => {
  const d = totalDisplay({ proyectado: "9.2", estimado: "9.2", lineaMercado: 8.5, recomendacion: "OVER" });
  assert.equal(d.proyeccion, "9.2");
  assert.equal(d.lineaReal, 8.5);
  assert.equal(d.senal, "OVER 8.5", "la señal usa la LÍNEA REAL, jamás la proyección");
});

test("análisis histórico con solo estimado: fallback sin señal fabricada", () => {
  const d = totalDisplay({ estimado: "9.5", recomendacion: "UNDER", razon: "x" });
  assert.equal(d.proyeccion, "9.5");
  assert.equal(d.lineaReal, null);
  assert.equal(d.senal, null, "sin línea real verificada no hay señal — la proyección no se disfraza de línea");
});

test("sin lineaMercado, sin recomendacion o sin objeto: nunca crash", () => {
  assert.deepEqual(totalDisplay(null), { proyeccion: null, lineaReal: null, senal: null });
  assert.deepEqual(totalDisplay({}), { proyeccion: null, lineaReal: null, senal: null });
  const d = totalDisplay({ proyectado: "8.1", lineaMercado: null });
  assert.equal(d.proyeccion, "8.1");
  assert.equal(d.senal, null);
});

/* ═══ Dedupe Radar / Props ═══ */

const RADAR = {
  away: { name: "Nathan Eovaldi", insufficient: false, radarQualified: true },
  home: { name: "David Peterson", insufficient: true, reason: "muestra insuficiente" },
};
const kProp     = (txt) => ({ tipo: "Prop para revisar", pick: txt, razon: "x" });

test("prop de K de abridor con tarjeta de Radar visible → cubierto (nombre completo o apellido)", () => {
  assert.equal(isStarterKPropCoveredByRadar(kProp("Nathan Eovaldi Over strikeouts"), RADAR), true);
  assert.equal(isStarterKPropCoveredByRadar(kProp("Eovaldi Over 6.5 K"), RADAR), true);
  assert.equal(isStarterKPropCoveredByRadar(kProp("Eovaldi supera en ponches al lineup"), RADAR), true);
});

test("radar con muestra insuficiente NO cubre: el prop sigue visible", () => {
  assert.equal(isStarterKPropCoveredByRadar(kProp("David Peterson Over strikeouts"), RADAR), false,
    "una tarjeta 'muestra insuficiente' no muestra datos de K — ocultar el prop perdería información");
});

test("prop de bateador sigue visible (no está en el radar)", () => {
  assert.equal(isStarterKPropCoveredByRadar(kProp("Juan Soto Over 1.5 total bases"), RADAR), false);
  assert.equal(isStarterKPropCoveredByRadar(kProp("Aaron Judge Over 0.5 HR"), RADAR), false);
});

test("prop no-K del mismo abridor sigue visible", () => {
  assert.equal(isStarterKPropCoveredByRadar(kProp("Nathan Eovaldi Under 2.5 carreras limpias"), RADAR), false);
  assert.equal(isStarterKPropCoveredByRadar(kProp("Eovaldi Over 17.5 outs"), RADAR), false);
});

test("compatibilidad: sin radar, radar vacío o pick nulo → false sin crash", () => {
  assert.equal(isStarterKPropCoveredByRadar(kProp("Eovaldi Over strikeouts"), null), false);
  assert.equal(isStarterKPropCoveredByRadar(kProp("Eovaldi Over strikeouts"), {}), false);
  assert.equal(isStarterKPropCoveredByRadar(null, RADAR), false);
  assert.equal(isStarterKPropCoveredByRadar({ tipo: "Moneyline", pick: "Eovaldi strikeouts" }, RADAR), false, "solo aplica a props");
});
