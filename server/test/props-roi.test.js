import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import {
  buildEvaluation,
  priceForOfficialProp,
  roiOfficialProps,
} from "../evaluation.js";

const PLAYER = "Riley Greene";
const MARKET = "batter_hits";

function propsJson({
  point = 0.5,
  overPrice = 120,
  underPrice = -150,
  books,
} = {}) {
  const defaultBooks = [{
    key: "draftkings",
    title: "DraftKings",
    markets: [{
      key: MARKET,
      outcomes: [
        { name: "Over", description: PLAYER, point, price: overPrice },
        { name: "Under", description: PLAYER, point, price: underPrice },
      ],
    }],
  }];
  return JSON.stringify({
    schemaVersion: 1,
    source: "the-odds-api",
    eventId: "event-1",
    frozenAt: "2026-07-20T12:00:00.000Z",
    payload: { id: "event-1", bookmakers: books ?? defaultBooks },
  });
}

const prop = (over = {}) => ({
  id: 1,
  analysis_id: 10,
  tipo: "Prop oficial",
  player: PLAYER,
  market: MARKET,
  side: "Over",
  point: 0.5,
  props_json: propsJson(),
  resultado: "ganó",
  ...over,
});

const analysis = (over = {}) => ({
  id: 10,
  game_pk: 100,
  retro: 0,
  logic_version: "2026-07-02.5",
  odds_json: null,
  created_at: "2026-07-20 10:00:00",
  ...over,
});

test("priceForOfficialProp obtiene la cuota exacta del lado y point congelados", () => {
  assert.deepEqual(priceForOfficialProp(prop()), {
    price: 120, book: "DraftKings", corrupt: false,
  });
  assert.deepEqual(priceForOfficialProp(prop({ side: "Under" })), {
    price: -150, book: "DraftKings", corrupt: false,
  });
});

test("la preferencia de bookmaker coincide con inserción: DraftKings, FanDuel, BetMGM", () => {
  const market = (overPrice) => [{
    key: MARKET,
    outcomes: [
      { name: "Over", description: PLAYER, point: 0.5, price: overPrice },
      { name: "Under", description: PLAYER, point: 0.5, price: -110 },
    ],
  }];
  const frozen = propsJson({ books: [
    { key: "betmgm", title: "BetMGM", markets: market(105) },
    { key: "fanduel", title: "FanDuel", markets: market(115) },
  ] });
  assert.deepEqual(priceForOfficialProp(prop({ props_json: frozen })), {
    price: 115, book: "FanDuel", corrupt: false,
  });
});

test("snapshot corrupto o identidad distinta se excluyen sin inventar precio", () => {
  assert.deepEqual(priceForOfficialProp(prop({ props_json: "{roto" })), {
    price: null, book: null, corrupt: true,
  });
  assert.deepEqual(priceForOfficialProp(prop({ point: 1.5 })), {
    price: null, book: null, corrupt: false,
  });
  assert.deepEqual(priceForOfficialProp(prop({ player: "Hunter Greene" })), {
    price: null, book: null, corrupt: false,
  });
});

test("ROI Props: ganancias americanas, pérdida -1u y denominador independiente", () => {
  const r = roiOfficialProps([
    prop({ id: 1, side: "Over", resultado: "ganó" }),              // +120 → +1.20u
    prop({ id: 2, side: "Under", resultado: "ganó" }),             // -150 → +0.67u
    prop({ id: 3, side: "Over", resultado: "perdió" }),            // -1u
    prop({ id: 4, resultado: "push" }),
    prop({ id: 5, resultado: "void" }),
    prop({ id: 6, resultado: null }),
  ]);
  assert.deepEqual(r, {
    n: 3,
    wins: 2,
    losses: 1,
    pushes: 1,
    voids: 1,
    pendientes: 1,
    units: 0.87,
    roi: 0.289,
    excluidosSinCuota: 0,
    corruptos: 0,
  });
});

test("props decididos sin cuota o con JSON corrupto se reportan y no entran al ROI", () => {
  const r = roiOfficialProps([
    prop({ id: 1, point: 1.5, resultado: "ganó" }),
    prop({ id: 2, props_json: "no-json", resultado: "perdió" }),
  ]);
  assert.equal(r.n, 0);
  assert.equal(r.units, 0);
  assert.equal(r.roi, null);
  assert.equal(r.excluidosSinCuota, 1);
  assert.equal(r.corruptos, 1);
});

test("buildEvaluation separa completamente ROI Moneyline y ROI Props", () => {
  const mlAnalysis = analysis({
    id: 20,
    game_pk: 200,
    odds_json: JSON.stringify({
      bookmakers: [{ key: "draftkings", markets: [{ key: "h2h", outcomes: [
        { name: "Home", price: -110 }, { name: "Away", price: -110 },
      ] }] }],
    }),
    home_team: "Home",
    away_team: "Away",
  });
  const ml = {
    id: 20,
    analysis_id: 20,
    tipo: "Moneyline",
    pick: "Home ML",
    resultado: "perdió",
  };
  const officialProp = prop({ id: 21, analysis_id: 10, resultado: "ganó" });
  const ev = buildEvaluation({ picks: [ml, officialProp], analyses: [mlAnalysis, analysis()] });

  assert.equal(ev.officialSample.roiML.n, 1);
  assert.equal(ev.officialSample.roiML.units, -1);
  assert.equal(ev.officialSample.roiProps.n, 1);
  assert.equal(ev.officialSample.roiProps.units, 1.2);
  assert.equal(ev.byVerificationStatus.propsOficiales.n, 1,
    "el prop sigue siendo oficial aunque su análisis no tenga odds_json general");
  assert.equal(ev.byVerificationStatus.propsOficiales.roiEligible, true);
  assert.deepEqual(ev.byVerificationStatus.propsOficiales.roi, ev.officialSample.roiProps);
});

test("props retro, sin versión, legado o para revisar jamás entran al bucket ROI", () => {
  const ev = buildEvaluation({
    picks: [
      prop({ id: 1, analysis_id: 1 }),
      prop({ id: 2, analysis_id: 2 }),
      { ...prop({ id: 3, analysis_id: 3 }), tipo: "Prop" },
      { ...prop({ id: 4, analysis_id: 3 }), tipo: "Prop para revisar" },
      { ...prop({ id: 5, analysis_id: 3 }), tipo: "Prop sugerido" },
    ],
    analyses: [
      analysis({ id: 1, retro: 1 }),
      analysis({ id: 2, logic_version: null }),
      analysis({ id: 3 }),
    ],
  });
  assert.equal(ev.officialSample.roiProps.n, 0);
  assert.equal(ev.byVerificationStatus.propsOficiales.n, 0);
  assert.equal(ev.byVerificationStatus.propsSugeridos.n, 1);
});

test("UI muestra récord, win rate, ROI y unidades del bucket Props Oficiales", () => {
  const ui = readFileSync(new URL("../../src/components/HistorialTab.jsx", import.meta.url), "utf8");
  assert.match(ui, /PROPS OFICIALES · BUCKET INDEPENDIENTE/);
  assert.match(ui, /Win rate Props/);
  assert.match(ui, /ROI Props/);
  assert.match(ui, /Unidades Props/);
  assert.match(ui, /roiProps\.pushes/);
  assert.match(ui, /roiProps\.voids/);
});
