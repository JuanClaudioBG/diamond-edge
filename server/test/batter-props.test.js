/*
 * Player Props F5 — verificación informativa de líneas de bateador.
 * Contrato: matching exacto o nada; jamás picks oficiales/EV/ROI/CLV.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import {
  BATTER_PROP_MARKETS, RADAR_PROP_MARKETS, normPlayerName, findBatterPropLine,
  verifyBatterRadarLines, fetchEventBatterProps, fetchEventRadarProps, _clearPropsCache,
} from "../player-props.js";
import { batterRadarDisplay } from "../../src/analysis-display.js";

/* Snapshot mínimo con la forma real del endpoint por evento de The Odds API */
const snapshot = (markets, bookKey = "draftkings", title = "DraftKings") => ({
  id: "evt1",
  bookmakers: [{ key: bookKey, title, last_update: "2026-07-09T15:00:00Z", markets }],
});

const HITS_MARKET = {
  key: "batter_hits",
  last_update: "2026-07-09T15:05:00Z",
  outcomes: [
    { name: "Over",  description: "Riley Greene",  price: -180, point: 0.5 },
    { name: "Under", description: "Riley Greene",  price: 140,  point: 0.5 },
    { name: "Over",  description: "Hunter Greene", price: 120,  point: 0.5 },
    { name: "Under", description: "Hunter Greene", price: -150, point: 0.5 },
  ],
};

/* ═══ 1. Matching exacto por jugador, mercado y point ═══ */
test("findBatterPropLine: batter_hits de Riley Greene → línea 0.5 con Over -180 / Under +140 del mismo point", () => {
  const found = findBatterPropLine(snapshot([HITS_MARKET]), {
    marketKey: "batter_hits", playerName: "Riley Greene",
  });
  assert.deepEqual(found, {
    line: 0.5, overPrice: -180, underPrice: 140,
    book: "DraftKings", lastUpdate: "2026-07-09T15:05:00Z",
  });
});

test("matching exacto de los 4 mercados: batter_total_bases, batter_home_runs y batter_rbis también", () => {
  const snap = snapshot([
    { key: "batter_total_bases", last_update: "2026-07-09T15:05:00Z", outcomes: [
      { name: "Over", description: "Riley Greene", price: 110, point: 1.5 },
      { name: "Under", description: "Riley Greene", price: -145, point: 1.5 },
    ] },
    { key: "batter_home_runs", last_update: "2026-07-09T15:05:00Z", outcomes: [
      { name: "Over", description: "Riley Greene", price: 450, point: 0.5 },
    ] },
    { key: "batter_rbis", last_update: "2026-07-09T15:05:00Z", outcomes: [
      { name: "Over", description: "Riley Greene", price: 130, point: 0.5 },
      { name: "Under", description: "Riley Greene", price: -170, point: 0.5 },
    ] },
  ]);
  const tb = findBatterPropLine(snap, { marketKey: "batter_total_bases", playerName: "Riley Greene" });
  assert.deepEqual({ line: tb.line, over: tb.overPrice, under: tb.underPrice }, { line: 1.5, over: 110, under: -145 });
  const hr = findBatterPropLine(snap, { marketKey: "batter_home_runs", playerName: "Riley Greene" });
  assert.deepEqual({ line: hr.line, over: hr.overPrice, under: hr.underPrice }, { line: 0.5, over: 450, under: null },
    "HR sin Under listado: overPrice real, underPrice null — no se inventa el otro lado");
  const rbi = findBatterPropLine(snap, { marketKey: "batter_rbis", playerName: "Riley Greene" });
  assert.deepEqual({ line: rbi.line, over: rbi.overPrice, under: rbi.underPrice }, { line: 0.5, over: 130, under: -170 });
});

test("normPlayerName: acentos y puntuación no rompen el matching exacto", () => {
  assert.equal(normPlayerName("José Ramírez"), normPlayerName("Jose Ramirez"));
  const snap = snapshot([{
    key: "batter_hits",
    outcomes: [{ name: "Over", description: "José Ramírez", price: -140, point: 0.5 }],
  }]);
  const found = findBatterPropLine(snap, { marketKey: "batter_hits", playerName: "Jose Ramirez" });
  assert.equal(found.line, 0.5);
});

/* ═══ 2. Jamás mezclar points distintos ═══ */
test("Over 1.5 y Under 0.5 del mismo jugador (points distintos) → ambigüedad → null", () => {
  const snap = snapshot([{
    key: "batter_total_bases",
    outcomes: [
      { name: "Over",  description: "Riley Greene", price: 110,  point: 1.5 },
      { name: "Under", description: "Riley Greene", price: -145, point: 0.5 },
    ],
  }]);
  assert.equal(findBatterPropLine(snap, { marketKey: "batter_total_bases", playerName: "Riley Greene" }), null);
});

test("outcomes Over duplicados del mismo point → duda → null", () => {
  const snap = snapshot([{
    key: "batter_hits",
    outcomes: [
      { name: "Over", description: "Riley Greene", price: -180, point: 0.5 },
      { name: "Over", description: "Riley Greene", price: -170, point: 0.5 },
    ],
  }]);
  assert.equal(findBatterPropLine(snap, { marketKey: "batter_hits", playerName: "Riley Greene" }), null);
});

/* ═══ 3. Jamás el jugador equivocado ═══ */
test("mismo apellido no es matching: 'R. Greene' o 'Hunter Greene' no verifican a Riley Greene", () => {
  const soloIniciales = snapshot([{
    key: "batter_hits",
    outcomes: [{ name: "Over", description: "R. Greene", price: -180, point: 0.5 }],
  }]);
  assert.equal(findBatterPropLine(soloIniciales, { marketKey: "batter_hits", playerName: "Riley Greene" }), null,
    "sin nombre completo exacto no hay fallback por apellido");
  const found = findBatterPropLine(snapshot([HITS_MARKET]), { marketKey: "batter_hits", playerName: "Hunter Greene" });
  assert.equal(found.overPrice, 120, "cada jugador recibe SUS cuotas, no las del otro Greene");
});

test("mercado distinto jamás se cruza: batter_hits no responde por batter_rbis", () => {
  assert.equal(findBatterPropLine(snapshot([HITS_MARKET]), { marketKey: "batter_rbis", playerName: "Riley Greene" }), null);
});

test("point no numérico o ausente → outcome descartado, sin inventar línea", () => {
  const snap = snapshot([{
    key: "batter_home_runs",
    outcomes: [{ name: "Over", description: "Riley Greene", price: 450 }],  // sin point
  }]);
  assert.equal(findBatterPropLine(snap, { marketKey: "batter_home_runs", playerName: "Riley Greene" }), null);
});

/* ═══ 4. verifyBatterRadarLines: shape del mercado verificado ═══ */
const mkMarket = () => ({ status: "PROP_PARA_REVISAR", line: null, officialPick: false, score: 7.1 });
const mkRadar = () => ({
  status: "OK",
  away: { teamName: "Tigers", cards: [{ name: "Riley Greene", lineupSlot: 2, markets: {
    hits: mkMarket(), totalBases: mkMarket(), homeRuns: mkMarket(), rbi: mkMarket(),
  } }] },
  home: { teamName: "Athletics", cards: [] },
  nota: "previa",
});

test("línea encontrada → LINEA_VERIFICADA con officialPick:false, ev:null, noRoi/noClv:true y book/lastUpdate", () => {
  const radar = verifyBatterRadarLines(mkRadar(), snapshot([HITS_MARKET]));
  const hits = radar.away.cards[0].markets.hits;
  assert.equal(hits.status, "LINEA_VERIFICADA");
  assert.equal(hits.line, 0.5);
  assert.equal(hits.overPrice, -180);
  assert.equal(hits.underPrice, 140);
  assert.equal(hits.book, "DraftKings");
  assert.equal(hits.lastUpdate, "2026-07-09T15:05:00Z");
  assert.equal(hits.officialPick, false);
  assert.equal(hits.ev, null);
  assert.equal(hits.noRoi, true);
  assert.equal(hits.noClv, true);
  assert.equal(hits.score, 7.1, "el score del perfil no se pisa");
  assert.match(radar.nota, /solo como referencia; no entra a ROI, CLV ni muestra oficial/);
});

test("mercado sin línea en el snapshot → queda PROP_PARA_REVISAR con line:null, sin cuota ni EV", () => {
  const radar = verifyBatterRadarLines(mkRadar(), snapshot([HITS_MARKET]));
  const tb = radar.away.cards[0].markets.totalBases;
  assert.equal(tb.status, "PROP_PARA_REVISAR");
  assert.equal(tb.line, null);
  assert.ok(!("overPrice" in tb) && !("ev" in tb), "sin campos financieros fantasma");
  const original = mkRadar();
  assert.deepEqual(verifyBatterRadarLines(original, null), original, "snapshot null → radar intacto");
});

/* ═══ 5. Fetch: guardas sin red y estructura inválida ═══ */
test("fetchEventBatterProps: sin eventId o apiKey → null sin llamar a la red; respuesta inválida → null", async () => {
  _clearPropsCache();
  let called = 0;
  const fetcher = async () => { called++; return { ok: true, json: async () => ({ bookmakers: [] }) }; };
  assert.equal(await fetchEventBatterProps({ apiKey: "k", fetcher }), null);
  assert.equal(await fetchEventBatterProps({ eventId: "e", fetcher }), null);
  assert.equal(called, 0, "sin credenciales completas no hay red");

  const bad = async () => ({ ok: true, json: async () => ["no-es-objeto"] });
  assert.equal(await fetchEventBatterProps({ eventId: "e1", apiKey: "k", fetcher: bad }), null);
  const notOk = async () => ({ ok: false, status: 402 });
  assert.equal(await fetchEventBatterProps({ eventId: "e2", apiKey: "k", fetcher: notOk }), null);

  const good = async () => { called++; return { ok: true, json: async () => ({ id: "e3", bookmakers: [] }) }; };
  const first = await fetchEventBatterProps({ eventId: "e3", apiKey: "k", fetcher: good });
  const second = await fetchEventBatterProps({ eventId: "e3", apiKey: "k", fetcher: good });
  assert.deepEqual(first, second);
  assert.equal(called, 1, "segunda llamada sale de caché");
  _clearPropsCache();
});

test("fetchEventRadarProps solicita bateadores y pitcher_strikeouts en un solo snapshot", async () => {
  _clearPropsCache();
  let requestedUrl = null;
  const fetcher = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ id: "radar-event", bookmakers: [] }) };
  };
  const result = await fetchEventRadarProps({ eventId: "radar-event", apiKey: "secret", fetcher });
  assert.equal(result.id, "radar-event");
  const markets = new URL(requestedUrl).searchParams.get("markets").split(",");
  assert.deepEqual(markets, Object.values(RADAR_PROP_MARKETS));
  assert.ok(markets.includes("pitcher_strikeouts"));
  _clearPropsCache();
});

/* ═══ 6. UI: líneas verificadas sin + PARLAY ni VALOR ═══ */
test("batterRadarDisplay: mercado verificado muestra línea y cuotas de referencia; HR/RBI cautelosos; sin VALOR", () => {
  const radar = verifyBatterRadarLines(mkRadar(), snapshot([
    HITS_MARKET,
    { key: "batter_total_bases", outcomes: [
      { name: "Over", description: "Riley Greene", price: 110, point: 1.5 },
      { name: "Under", description: "Riley Greene", price: -145, point: 1.5 },
    ] },
    { key: "batter_home_runs", outcomes: [{ name: "Over", description: "Riley Greene", price: 450, point: 0.5 }] },
    { key: "batter_rbis", outcomes: [{ name: "Over", description: "Riley Greene", price: 130, point: 0.5 }] },
  ]));
  const display = batterRadarDisplay(radar);
  const line = display.teams[0].cards[0].marketLine;
  assert.match(line, /Hits: Línea 0\.5 verificada · Over -180 \/ Under \+140/);
  assert.match(line, /TB: Línea 1\.5 verificada · Over \+110 \/ Under -145/);
  assert.match(line, /HR: Línea 0\.5 verificada · SOLO ÁNGULO/);
  assert.match(line, /RBI: Línea 0\.5 verificada · BAJA CONFIANZA/);
  assert.ok(!/VALOR/.test(line), "jamás lenguaje financiero de picks");
  const chip = display.teams[0].cards[0].chips.find(c => c.key === "hits");
  assert.equal(chip.verified, true);
  assert.equal(chip.book, "DraftKings");
});

test("batterRadarDisplay: sin verificación todo sigue PROP PARA REVISAR / SOLO ÁNGULO / BAJA CONFIANZA", () => {
  const display = batterRadarDisplay(mkRadar());
  const line = display.teams[0].cards[0].marketLine;
  assert.match(line, /Hits: PROP PARA REVISAR/);
  assert.match(line, /HR: SOLO ÁNGULO/);
  assert.match(line, /RBI: BAJA CONFIANZA/);
});

/* ═══ 7. Aislamiento: nada de esto entra a picks/ROI/CLV/evaluation ═══ */
test("aislamiento F5: evaluation/settle no leen batterRadar; el radar UI no ofrece + PARLAY", () => {
  const evaluation = readFileSync(new URL("../evaluation.js", import.meta.url), "utf8");
  const settle = readFileSync(new URL("../backtest/settle.js", import.meta.url), "utf8");
  assert.ok(!/batterRadar/.test(evaluation), "evaluation no consume el radar informativo");
  assert.ok(!/batterRadar/.test(settle), "settlement no consume el radar informativo");

  const tab = readFileSync(new URL("../../src/components/AnalysisTab.jsx", import.meta.url), "utf8");
  const radarSection = tab.slice(tab.indexOf("RADAR DE BATEADORES"), tab.indexOf("Total de Carreras"));
  assert.ok(!/PARLAY/.test(radarSection), "la sección del Batter Radar no tiene botón + PARLAY");
  assert.ok(!/VALOR (ALTO|MEDIO|BAJO)/.test(radarSection), "sin badges financieros en el radar");
  assert.match(radarSection, /Líneas verificadas solo como referencia; no entra a ROI, CLV ni muestra oficial/);

  const idx = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const iRadar = idx.indexOf("analysis.batterRadar = await buildBatterRadar");
  const iVerify = idx.indexOf("verifyBatterRadarLines(analysis.batterRadar");
  assert.ok(iRadar > -1 && iVerify > -1 && iRadar < iVerify, "la verificación corre tras construir el radar");
  assert.ok(!/insertPick\([^)]*batterRadar/.test(idx), "batterRadar jamás se inserta como pick");
});

test("BATTER_PROP_MARKETS mapea exactamente los 4 mercados esperados de The Odds API", () => {
  assert.deepEqual(BATTER_PROP_MARKETS, {
    hits: "batter_hits",
    totalBases: "batter_total_bases",
    homeRuns: "batter_home_runs",
    rbi: "batter_rbis",
  });
  assert.deepEqual(RADAR_PROP_MARKETS, {
    ...BATTER_PROP_MARKETS,
    pitcherStrikeouts: "pitcher_strikeouts",
  });
});
