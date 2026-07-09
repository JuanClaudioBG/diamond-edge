/*
 * Fase 4 UI de 2026-07-02.5 — helpers puros de presentación
 * (src/analysis-display.js, compartido entre frontend y esta suite).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { totalDisplay, isStarterKPropCoveredByRadar, batterRadarDisplay } from "../../src/analysis-display.js";

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

/* ═══ Batter Radar UI compacta ═══ */

const batterCard = {
  name: "Aaron Judge",
  lineupSlot: 2,
  label: "Perfil calificado",
  insufficient: false,
  statcast: { xwoba: 0.381, xba: 0.295, barrelPct: 14.2, hardHitPct: 49.5, exitVelo: 91.8 },
  sample: {
    metrics: {
      hits: { last5: [1, 2, 1, 0, 2], validLast10: 10 },
      totalBases: { last5: [1, 3, 1, 0, 5], avgLast10: 2.1 },
    },
  },
  markets: {
    hits:       { score: 7, status: "PROP_PARA_REVISAR", line: null, notes: ["Statcast aporta al perfil de hits."] },
    totalBases: { score: 6, status: "PROP_PARA_REVISAR", line: null, notes: [] },
    homeRuns:  { score: 4, status: "PROP_PARA_REVISAR", line: null, notes: ["HR es evento raro."] },
    rbi:       { score: null, status: "PROP_PARA_REVISAR", line: null, notes: [] },
  },
};

test("batterRadarDisplay tolera batterRadar null: no visible", () => {
  assert.deepEqual(batterRadarDisplay(null), { visible: false });
});

test("batterRadarDisplay muestra LINEUP_NO_CONFIRMADO sin inventar jugadores", () => {
  const d = batterRadarDisplay({ status: "LINEUP_NO_CONFIRMADO", away: { cards: [] }, home: { cards: [] } });
  assert.equal(d.visible, true);
  assert.equal(d.status, "LINEUP_NO_CONFIRMADO");
  assert.match(d.message, /Lineup no confirmado/);
  assert.deepEqual(d.teams, []);
});

test("batterRadarDisplay muestra cards OK con chips PROP PARA REVISAR y sin VALOR", () => {
  const d = batterRadarDisplay({
    status: "OK",
    away: { teamName: "Yankees", lineupConfirmed: true, cards: [batterCard] },
    home: { teamName: "Mets", lineupConfirmed: true, cards: [] },
  });
  assert.equal(d.visible, true);
  assert.equal(d.teams[0].side, "Visitante");
  assert.equal(d.teams[0].cards[0].name, "Aaron Judge");
  assert.equal(d.teams[0].cards[0].score, 7);
  assert.deepEqual(d.teams[0].cards[0].chips.map(c => c.status), [
    "PROP PARA REVISAR", "PROP PARA REVISAR", "PROP PARA REVISAR", "PROP PARA REVISAR",
  ]);
  assert.match(d.teams[0].cards[0].recent.hitsLast5, /1 · 2 · 1/);
  assert.ok(d.teams[0].cards[0].statcast.some(s => /xwOBA 0\.381/.test(s)));
  assert.ok(d.teams[0].cards[0].statcast.some(s => /Exit Velo 91\.8/.test(s)));
  const json = JSON.stringify(d);
  assert.ok(!/VALOR\s+(ALTO|MEDIO|BAJO)/i.test(json));
  assert.ok(!/cuota/i.test(json));
});

test("AnalysisTab incluye sección Batter Radar compacta sin botón PARLAY dentro del bloque", () => {
  const src = readFileSync(new URL("../../src/components/AnalysisTab.jsx", import.meta.url), "utf8");
  const start = src.indexOf("batterRadar.visible");
  const end = src.indexOf("<div className=\"acard-hdr\">🔢 Total de Carreras</div>");
  assert.ok(start > -1 && end > start, "bloque Batter Radar existe antes del Total");
  const block = src.slice(start, end);
  assert.match(block, /RADAR DE BATEADORES/);
  assert.match(block, /PROP PARA REVISAR/);
  assert.ok(!/onAddPick|className="padd"|\+ PARLAY/.test(block), "Batter Radar no ofrece añadir al parlay");
  assert.ok(!/VALOR\s+(ALTO|MEDIO|BAJO)/i.test(block), "Batter Radar no usa badges financieros");
});
