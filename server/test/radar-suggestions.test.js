import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRadarSuggestedPicks } from "../radar-suggestions.js";

const market = ({ score = 7, line = 0.5, overPrice = -110, book = "DraftKings", status = "LINEA_VERIFICADA" } = {}) => ({
  score, line, overPrice, underPrice: 100, book, status,
  lastUpdate: "2026-07-21T18:00:00Z",
});

const card = (name, slot, hits, totalBases, rbi = market()) => ({
  name, teamName: "Team", lineupSlot: slot, insufficient: false,
  markets: { hits, totalBases, rbi },
});

const batterRadar = cards => ({
  away: { cards },
  home: { cards: [] },
});

test("selecciona máximo tres bateadores, uno por jugador, ordenados por score", () => {
  const radar = batterRadar([
    card("Cuarto", 1, market({ score: 7.1 }), market({ score: 6, line: 1.5 })),
    card("Primero", 4, market({ score: 7.5 }), market({ score: 9, line: 1.5 })),
    card("Tercero", 2, market({ score: 8 }), market({ score: 7.8, line: 1.5 })),
    card("Segundo", 5, market({ score: 8.5 }), market({ score: 8, line: 1.5 })),
  ]);
  const picks = buildRadarSuggestedPicks({ batterRadar: radar });
  const main = picks.filter(p => p.market !== "batter_rbis");
  assert.deepEqual(main.map(p => p.player), ["Primero", "Segundo", "Tercero"]);
  assert.equal(main[0].market, "batter_total_bases");
  assert.equal(main[0].pick, "Primero — TB Over 1.5");
  assert.ok(!main.some(p => p.player === "Cuarto"));
});

test("empate Hits/TB prioriza Hits y exige score 7, línea exacta y cuota Over", () => {
  const radar = batterRadar([
    card("Empate", 1, market({ score: 7.5 }), market({ score: 7.5, line: 1.5 })),
    card("Score Bajo", 2, market({ score: 6.9 }), market({ score: 6.9, line: 1.5 })),
    card("Línea Mala", 3, market({ score: 8, line: 1.5 }), market({ score: 8, line: 2.5 })),
    card("Sin Over", 4, market({ score: 8, overPrice: null }), market({ score: 8, line: 1.5, overPrice: null })),
  ]);
  const main = buildRadarSuggestedPicks({ batterRadar: radar }).filter(p => p.market !== "batter_rbis");
  assert.equal(main.length, 1);
  assert.equal(main[0].player, "Empate");
  assert.equal(main[0].market, "batter_hits");
});

test("RBI solo sale para bateador seleccionado de score alto, slot 3-5 y línea 0.5 verificada", () => {
  const radar = batterRadar([
    card("Productor", 3, market({ score: 8 }), market({ score: 7, line: 1.5 }), market({ line: 0.5, overPrice: 125 })),
    card("Leadoff", 1, market({ score: 8 }), market({ score: 7, line: 1.5 }), market({ line: 0.5 })),
    card("Sexto", 6, market({ score: 8 }), market({ score: 7, line: 1.5 }), market({ line: 0.5 })),
  ]);
  const rbis = buildRadarSuggestedPicks({ batterRadar: radar }).filter(p => p.market === "batter_rbis");
  assert.equal(rbis.length, 1);
  assert.equal(rbis[0].pick, "Productor — RBI Over 0.5");
  assert.equal(rbis[0].cuotaReal, 125);
});

test("Ponches exige radarQualified, score 6+ y línea/cuota Over verificadas", () => {
  const kCard = (overrides = {}) => ({
    name: "Pitcher", insufficient: false, radarQualified: true, score: 7,
    line: { point: 6.5, over: { price: -115 }, book: "fanduel", bookTitle: "FanDuel", lastUpdate: "now" },
    ...overrides,
  });
  const picks = buildRadarSuggestedPicks({ radar: {
    away: kCard(),
    home: kCard({ name: "No Califica", radarQualified: false, score: 9 }),
  } });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].pick, "Pitcher — Over 6.5 Ks");
  assert.equal(picks[0].market, "pitcher_strikeouts");
  assert.equal(picks[0].book, "FanDuel");
});

test("todos los picks sugeridos quedan explícitamente fuera de ROI y con clave estable", () => {
  const picks = buildRadarSuggestedPicks({ batterRadar: batterRadar([
    card("Jugador", 2, market({ score: 8 }), market({ score: 6, line: 1.5 })),
  ]) });
  assert.equal(picks.length, 1);
  assert.deepEqual({ suggested: picks[0].suggested, officialPick: picks[0].officialPick, noRoi: picks[0].noRoi, noClv: picks[0].noClv }, {
    suggested: true, officialPick: false, noRoi: true, noClv: true,
  });
  assert.equal(picks[0].valor, "ÁNGULO RADAR");
  assert.equal(picks[0].suggestionKey, "batter_radar:jugador:batter_hits:over:0.5");
});

test("pipeline genera suggestedPicks antes del log sin alimentar picks oficiales", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const buildAt = source.indexOf("analysis.suggestedPicks = buildRadarSuggestedPicks");
  const logAt = source.indexOf("const logResult = insertAnalysisLog");
  assert.ok(buildAt > -1 && logAt > buildAt, "las sugerencias quedan congeladas en output_json");
  assert.match(source, /oddsGame: propsSnapshot \?\? oddsGame/);
  assert.match(source, /const selectedPropCandidates = \[\];/);
  assert.doesNotMatch(source, /selectedPropCandidates\s*=\s*analysis\.suggestedPicks/);
  assert.doesNotMatch(source, /analysis\.picks\s*=\s*\[?\.\.\.analysis\.suggestedPicks/);
});
