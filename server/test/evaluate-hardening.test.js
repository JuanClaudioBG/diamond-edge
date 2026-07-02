import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupLatest, roiReport, priceForPredicted, pickModelo } from "../backtest/evaluate.js";

/* Fixture: fila de analysis_log con odds congeladas */
const mkRow = ({ id, gamePk, created, winner, resultado, price, home = "Equipo H", away = "Equipo A" }) => ({
  id,
  game_pk: gamePk,
  created_at: created,
  game_date: "2026-07-02T23:00:00Z",
  home_team: home,
  away_team: away,
  predicted_winner: winner,
  resultado,
  retro: 0,
  odds_json: price == null ? null : JSON.stringify({
    home_team: home, away_team: away,
    bookmakers: [{
      key: "fanduel", title: "FanDuel", last_update: "2026-07-02T18:00:00Z",
      markets: [{ key: "h2h", outcomes: [
        { name: home, price },
        { name: away, price: price > 0 ? -Math.abs(price) - 20 : Math.abs(price) + 20 },
      ]}],
    }],
  }),
});

/* ── dedupLatest ─────────────────────────────────────────────────── */
test("dedup conserva solo el snapshot más reciente por game_pk", () => {
  const rows = [
    mkRow({ id: 1, gamePk: 111, created: "2026-07-02 10:00:00", winner: "Equipo H", resultado: "home", price: -110 }),
    mkRow({ id: 2, gamePk: 111, created: "2026-07-02 12:00:00", winner: "Equipo A", resultado: "home", price: -110 }),
    mkRow({ id: 3, gamePk: 222, created: "2026-07-02 11:00:00", winner: "Equipo H", resultado: "away", price: -110 }),
  ];
  const { rows: deduped, duplicatesDropped } = dedupLatest(rows);
  assert.equal(deduped.length, 2);
  assert.equal(duplicatesDropped, 1);
  const g111 = deduped.find(r => r.game_pk === 111);
  assert.equal(g111.id, 2, "debe quedar el reanálisis más reciente");
});

test("dedup no descarta filas sin game_pk (las reporta)", () => {
  const rows = [
    mkRow({ id: 1, gamePk: null, created: "2026-07-02 10:00:00", winner: "Equipo H", resultado: "home", price: -110 }),
    mkRow({ id: 2, gamePk: null, created: "2026-07-02 11:00:00", winner: "Equipo H", resultado: "home", price: -110 }),
  ];
  const { rows: deduped, noPk } = dedupLatest(rows);
  assert.equal(deduped.length, 2);
  assert.equal(noPk, 2);
});

/* ── priceForPredicted ───────────────────────────────────────────── */
test("priceForPredicted toma la cuota del lado predicho desde el snapshot congelado", () => {
  const r = mkRow({ id: 1, gamePk: 1, created: "x", winner: "Equipo H", resultado: "home", price: -150 });
  assert.equal(priceForPredicted(r), -150);
  const r2 = { ...r, predicted_winner: "Equipo A" };
  assert.equal(priceForPredicted(r2), 170); // el lado contrario del fixture
});

test("priceForPredicted → null sin odds o sin pick mapeable", () => {
  const r = mkRow({ id: 1, gamePk: 1, created: "x", winner: "Equipo H", resultado: "home", price: null });
  assert.equal(priceForPredicted(r), null);
  const r2 = mkRow({ id: 2, gamePk: 2, created: "x", winner: "Otro Equipo", resultado: "home", price: -110 });
  assert.equal(pickModelo(r2), null, "ganador que no coincide con home/away no es mapeable");
  assert.equal(priceForPredicted(r2), null);
});

/* ── roiReport: verificable a mano ───────────────────────────────── */
test("ROI: 2 aciertos a -110 y 1 fallo = +0.818u en 3 apuestas", () => {
  const rows = [
    mkRow({ id: 1, gamePk: 1, created: "a", winner: "Equipo H", resultado: "home", price: -110 }),
    mkRow({ id: 2, gamePk: 2, created: "b", winner: "Equipo H", resultado: "home", price: -110 }),
    mkRow({ id: 3, gamePk: 3, created: "c", winner: "Equipo H", resultado: "away", price: -110 }),
  ];
  const roi = roiReport(rows);
  assert.equal(roi.n, 3);
  assert.equal(roi.wins, 2);
  // 2·(100/110) − 1 = 0.8182
  assert.ok(Math.abs(roi.units - 0.82) < 0.005, `units=${roi.units}`);
  assert.ok(Math.abs(roi.roi - 0.8182 / 3) < 0.01);
});

test("ROI: drawdown máximo con secuencia perdedora conocida", () => {
  // pierde, pierde, gana(+1): drawdown máximo = 2u
  const rows = [
    mkRow({ id: 1, gamePk: 1, created: "a", winner: "Equipo H", resultado: "away", price: 100 }),
    mkRow({ id: 2, gamePk: 2, created: "b", winner: "Equipo H", resultado: "away", price: 100 }),
    mkRow({ id: 3, gamePk: 3, created: "c", winner: "Equipo H", resultado: "home", price: 100 }),
  ].map((r, i) => ({ ...r, game_date: `2026-07-0${i + 1}T00:00:00Z` }));
  const roi = roiReport(rows);
  assert.equal(roi.maxDrawdown, 2);
  assert.equal(roi.units, -1);
});

test("ROI excluye filas sin cuota congelada — jamás inventa odds", () => {
  const rows = [
    mkRow({ id: 1, gamePk: 1, created: "a", winner: "Equipo H", resultado: "home", price: -110 }),
    mkRow({ id: 2, gamePk: 2, created: "b", winner: "Equipo H", resultado: "home", price: null }),
  ];
  const roi = roiReport(rows);
  assert.equal(roi.n, 1);
  assert.equal(roi.excluidasSinCuota, 1);
});
