import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const analysisTab = readFileSync(new URL("../../src/components/AnalysisTab.jsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../../src/App.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../../src/index.css", import.meta.url), "utf8");
const evaluation = readFileSync(new URL("../evaluation.js", import.meta.url), "utf8");

test("PICKS Y SEÑALES muestra suggestedPicks primero con etiqueta ÁNGULO RADAR", () => {
  assert.match(analysisTab, /analysis\.suggestedPicks \?\? \[\]/);
  assert.match(analysisTab, />ÁNGULO RADAR</);
  assert.match(analysisTab, /Ángulos Radar con línea verificada/);
  assert.match(analysisTab, /Sugerencia informativa · no entra a ROI oficial/);
  const suggestedAt = analysisTab.indexOf("suggested.map");
  const officialAt = analysisTab.indexOf("oficiales.map");
  assert.ok(suggestedAt > -1 && officialAt > suggestedAt, "los ángulos se presentan antes de los picks principales");
});

test("botón Radar usa callback propio y App no persiste ese callback", () => {
  assert.match(analysisTab, /onAddSuggestedPick\?\.\(pk\)/);
  assert.match(app, /onAddSuggestedPick=\{addSuggestedPick\}/);
  const start = app.indexOf("const addSuggestedPick =");
  const end = app.indexOf("const rmPick", start);
  const callback = app.slice(start, end);
  assert.match(callback, /setParlay/);
  assert.doesNotMatch(callback, /fetch|\/api\/picks|loadHistorial/);
});

test("estilo Radar es visualmente distinto y evaluation permanece aislado", () => {
  assert.match(css, /\.pv\.RADAR/);
  assert.match(css, /\.pick\.radar-angle/);
  assert.match(css, /border-left:3px solid var\(--cy\)/);
  assert.doesNotMatch(evaluation, /suggestedPicks|ÁNGULO RADAR/);
});

