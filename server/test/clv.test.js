/*
 * Closing Line Value — 15 casos exigidos por la misión C1.
 * Regla de oro matemática: SIN VIG en ambos extremos, jamás mezclar con brutas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { devig } from "../backtest/odds-math.js";
import { readFileSync } from "fs";
import {
  classifyCapture, shouldSkipCapture, shouldInsertCapture, selectClose,
  matchOddsGame, extractClose, computeClvForAnalysis, computeClvRows,
  preferredBookKey, CLOSE_WINDOW_MINUTES, STALE_THRESHOLD_MINUTES,
} from "../backtest/clv.js";
import { runCapture } from "../backtest/capture-closing.js";
import { clvSummary } from "../backtest/evaluate.js";

const HOME = "Texas Rangers";
const AWAY = "Detroit Tigers";

/* ── Fixtures ────────────────────────────────────────────────────── */
const mkAnalysis = ({ id = 1, gamePk = 100, retro = 0, winner = HOME, entryH = -110, entryA = -110, book = "fanduel", version = "2026-07-02.4" } = {}) => {
  const dv = devig(entryH, entryA);
  return Object.freeze({
    id, game_pk: gamePk, retro, logic_version: version,
    home_team: HOME, away_team: AWAY, predicted_winner: winner,
    market_prob_home: dv?.a ?? null, market_prob_away: dv?.b ?? null,
    odds_json: JSON.stringify({
      home_team: HOME, away_team: AWAY,
      bookmakers: [{
        key: book, title: book, last_update: "2026-07-03T17:00:00Z",
        markets: [{ key: "h2h", outcomes: [{ name: HOME, price: entryH }, { name: AWAY, price: entryA }] }],
      }],
    }),
  });
};

const mkClosing = ({ gamePk = 100, book = "fanduel", closeH = -125, closeA = 105, status = "valid_close", market = "h2h" } = {}) => {
  const dv = devig(closeH, closeA);
  return Object.freeze({
    game_pk: gamePk, book_key: book, market, capture_status: status,
    captured_at: "2026-07-03T22:55:00Z",
    odds_home: closeH, odds_away: closeA,
    close_prob_home_nv: dv?.a ?? null, close_prob_away_nv: dv?.b ?? null,
  });
};

/* ═══ 1. Matemática canónica: -110/-110 → -125/+105 ═══ */
test("caso canónico: entrada -110/-110, cierre -125/+105 → CLV favorito ≈ +0.03247 (sin vig, NO +0.056)", () => {
  // Cierre sin vig: bruto -125 = 55.5556%, +105 = 48.7805%, suma 104.3361%
  // favorito sin vig = 55.5556/104.3361 ≈ 53.247% → CLV = 53.247% − 50% = +3.247 pp
  const res = computeClvForAnalysis(mkAnalysis(), mkClosing());
  assert.ok(res.clv != null);
  assert.ok(Math.abs(res.clv - 0.03247) < 0.0005, `CLV=${res.clv} — esperado ≈0.03247`);
  assert.ok(Math.abs(res.clv - 0.056) > 0.01, "el valor bruto 5.6pp es INCORRECTO y no debe reproducirse");
  assert.equal(res.entryOdds, -110);
  assert.equal(res.closeOdds, -125);
  assert.ok(Math.abs(res.entryProbNv - 0.5) < 1e-9);
});

/* ═══ 2. Mismo book → CLV válido ═══ */
test("entrada y cierre del mismo book → CLV numérico", () => {
  const res = computeClvForAnalysis(mkAnalysis({ book: "draftkings" }), mkClosing({ book: "draftkings" }));
  assert.equal(typeof res.clv, "number");
  assert.equal(res.book, "draftkings");
});

/* ═══ 3. Books distintos → NULL ═══ */
test("entrada FanDuel + cierre DraftKings → CLV NULL, jamás se mezclan books", () => {
  const res = computeClvForAnalysis(mkAnalysis({ book: "fanduel" }), mkClosing({ book: "draftkings" }));
  assert.equal(res.clv, null);
  assert.equal(res.reason, "book_distinto");
});

/* ═══ 4. Un solo lado disponible → NULL ═══ */
test("cierre con un solo lado → CLV NULL (extractClose lo marca y el cómputo lo respeta)", () => {
  const game = {
    home_team: HOME, away_team: AWAY,
    bookmakers: [{ key: "fanduel", markets: [{ key: "h2h", outcomes: [{ name: HOME, price: -125 }] }] }],
  };
  assert.equal(extractClose(game, "fanduel", HOME, AWAY).status, "market_missing");
  const closingIncompleto = { ...mkClosing(), close_prob_home_nv: null };
  const res = computeClvForAnalysis(mkAnalysis(), closingIncompleto);
  assert.equal(res.clv, null);
  assert.equal(res.reason, "cierre_incompleto");
});

/* ═══ 5. Idempotencia / skip pre-fetch ═══ */
test("skip pre-fetch: post_start y pospuesto-hoy se saltan; valid_close solo si el juego YA empezó", () => {
  const now = "2026-07-03T22:00:00Z";
  assert.equal(shouldSkipCapture([{ capture_status: "post_start_invalid", captured_at: now }], now), true);
  assert.equal(shouldSkipCapture([{ capture_status: "early_snapshot", captured_at: now }], now), false);
  assert.equal(shouldSkipCapture([{ capture_status: "stale", captured_at: now }], now), false);
  assert.equal(shouldSkipCapture([{ capture_status: "game_postponed", captured_at: now }], now), true, "pospuesto hoy no se reintenta hoy");
  assert.equal(shouldSkipCapture([{ capture_status: "game_postponed", captured_at: "2026-07-01T22:00:00Z" }], now), false, "pospuesto de otro día sí se reintenta");
  // valid_close de un juego NO iniciado no bloquea (una captura más cercana es mejor)
  assert.equal(shouldSkipCapture([{ capture_status: "valid_close", captured_at: now, game_start_time: "2026-07-03T23:05:00Z" }], now), false);
  // valid_close de un juego ya iniciado sí bloquea (nada puede mejorar)
  assert.equal(shouldSkipCapture([{ capture_status: "valid_close", captured_at: now, game_start_time: "2026-07-03T21:30:00Z" }], now), true);
});

test("runCapture: juego ya iniciado con cierre válido asegurado → cero inserts, cero red", async () => {
  let inserts = 0;
  const analysis = mkAnalysis();
  const summary = await runCapture({
    dryRun: false,
    insert: () => inserts++,
    targets: () => [analysis],
    existing: () => [{ game_pk: 100, book_key: "fanduel", market: "h2h", capture_status: "valid_close", captured_at: "2026-07-03T22:50:00Z", game_start_time: "2026-07-03T22:52:00Z" }],
    fetcher: () => { throw new Error("no debería llamar a la red"); },
    now: () => new Date("2026-07-03T22:55:00Z"),
    log: () => {},
  });
  assert.equal(inserts, 0);
  assert.equal(summary.skipped, 1);
});

/* ═══ 6. Dry-run: cero escrituras ═══ */
test("--dry-run nunca llama a insert aunque haya cierre capturable", async () => {
  let inserts = 0;
  const analysis = mkAnalysis();
  const schedResp = { json: async () => ({ dates: [{ games: [{ gamePk: 100, gameDate: "2026-07-03T23:05:00Z", status: { codedGameState: "P", detailedState: "Pre-Game" } }] }] }) };
  const oddsResp = {
    headers: { get: () => "1" },
    json: async () => [{
      home_team: HOME, away_team: AWAY, commence_time: "2026-07-03T23:05:00Z",
      bookmakers: [{ key: "fanduel", last_update: "2026-07-03T22:50:00Z", markets: [{ key: "h2h", outcomes: [{ name: HOME, price: -125 }, { name: AWAY, price: 105 }] }] }],
    }],
  };
  const summary = await runCapture({
    dryRun: true,
    insert: () => inserts++,
    targets: () => [analysis],
    existing: () => [],
    fetcher: async (url) => url.includes("statsapi") ? schedResp : oddsResp,
    now: () => new Date("2026-07-03T22:55:00Z"),   // 10 min antes del inicio
    log: () => {},
  });
  assert.equal(inserts, 0, "dry-run debe dejar la DB bit-idéntica: cero inserts");
  assert.equal(summary.saved, 1, "pero debe reportar qué HABRÍA guardado");
});

/* ═══ 7. Dobles carteleras ═══ */
test("doble cartelera: el cierre se empareja al juego correcto por horario y game_pk", () => {
  const game1 = { home_team: HOME, away_team: AWAY, commence_time: "2026-07-03T17:05:00Z", id: "g1" };
  const game2 = { home_team: HOME, away_team: AWAY, commence_time: "2026-07-03T23:05:00Z", id: "g2" };
  assert.equal(matchOddsGame([game1, game2], HOME, AWAY, "2026-07-03T23:10:00Z").id, "g2");
  assert.equal(matchOddsGame([game1, game2], HOME, AWAY, "2026-07-03T17:00:00Z").id, "g1");
  assert.equal(matchOddsGame([game1], HOME, AWAY, "2026-07-04T23:00:00Z"), null, "sin juego a ±4h → null, no se adivina");
  // game_pk distinto = identidad distinta: el cierre del juego 1 no sirve al análisis del juego 2
  const a2 = mkAnalysis({ gamePk: 200 });
  const rows = computeClvRows([a2], [mkClosing({ gamePk: 100 })]);
  assert.equal(rows[0].clv, null);
  assert.equal(rows[0].reason, "sin_cierre");
});

/* ═══ 8-10. Ventana de cierre ═══ */
test("minutes_before_start=10 y línea fresca → valid_close", () => {
  assert.equal(classifyCapture({ minutesBeforeStart: 10, stalenessMinutes: 3 }), "valid_close");
});
test("minutes_before_start=-2 → post_start_invalid", () => {
  assert.equal(classifyCapture({ minutesBeforeStart: -2, stalenessMinutes: 1 }), "post_start_invalid");
});
test("minutes_before_start=45 → early_snapshot (no es cierre válido)", () => {
  assert.equal(classifyCapture({ minutesBeforeStart: 45, stalenessMinutes: 1 }), "early_snapshot");
  assert.equal(CLOSE_WINDOW_MINUTES, 30);
});

/* ═══ 11. Freshness ═══ */
test("book_last_update viejo o ausente → stale (no fingimos frescura)", () => {
  assert.equal(classifyCapture({ minutesBeforeStart: 10, stalenessMinutes: STALE_THRESHOLD_MINUTES + 5 }), "stale");
  assert.equal(classifyCapture({ minutesBeforeStart: 10, stalenessMinutes: null }), "stale");
  const res = computeClvForAnalysis(mkAnalysis(), { ...mkClosing(), capture_status: "stale" });
  assert.equal(res.clv, null);
  assert.equal(res.reason, "stale");
});

/* ═══ 12. Retrospectivos excluidos ═══ */
test("análisis retro=1 → CLV NULL razón retro", () => {
  const res = computeClvForAnalysis(mkAnalysis({ retro: 1 }), mkClosing());
  assert.equal(res.clv, null);
  assert.equal(res.reason, "retro");
});

/* ═══ 13. Varios análisis comparten cierre con CLV individual ═══ */
test("dos análisis del mismo juego+book comparten el cierre y cada uno conserva su CLV", () => {
  const a1 = mkAnalysis({ id: 1, entryH: -110, entryA: -110 });        // entrada 50.0%
  const a2 = mkAnalysis({ id: 2, entryH: -120, entryA: 100 });         // entrada distinta
  const rows = computeClvRows([a1, a2], [mkClosing()]);
  assert.equal(typeof rows[0].clv, "number");
  assert.equal(typeof rows[1].clv, "number");
  assert.notEqual(rows[0].clv, rows[1].clv, "misma línea de cierre, entradas distintas → CLV distintos");
});

/* ═══ 14. Mismo juego, books distintos: no se mezclan líneas ═══ */
test("cierre existe solo para otro book → book_distinto, sin fallback", () => {
  const a = mkAnalysis({ book: "fanduel" });
  const rows = computeClvRows([a], [mkClosing({ book: "betmgm" })]);
  assert.equal(rows[0].clv, null);
  assert.equal(rows[0].reason, "book_distinto");
});

/* ═══ 15. analysis_log.odds_json intacto ═══ */
test("el pipeline de CLV jamás muta el análisis: fixtures congelados sobreviven", () => {
  const a = mkAnalysis();                      // Object.freeze — cualquier mutación lanzaría
  const before = a.odds_json;
  computeClvRows([a], [mkClosing()]);
  computeClvForAnalysis(a, mkClosing());
  assert.equal(a.odds_json, before, "odds_json bit-idéntico tras computar CLV");
});

/* ═══ Resumen agregado ═══ */
test("clvSummary: media, mediana, % positivo y razones de exclusión", () => {
  const rows = [
    { clv: 0.03, logicVersion: "v", book: "fanduel" },
    { clv: -0.01, logicVersion: "v", book: "fanduel" },
    { clv: 0.01, logicVersion: "v", book: "fanduel" },
    { clv: null, reason: "book_distinto" },
    { clv: null, reason: "sin_cierre" },
  ];
  const s = clvSummary(rows);
  assert.equal(s.n, 3);
  assert.equal(s.candidatos, 5);
  assert.ok(Math.abs(s.mean - 0.01) < 1e-9);
  assert.ok(Math.abs(s.median - 0.01) < 1e-9);
  assert.ok(Math.abs(s.pctPositivo - 2 / 3) < 1e-9);
  assert.deepEqual(s.reasons, { book_distinto: 1, sin_cierre: 1 });
});

/* ═══ preferredBookKey replica la preferencia del servidor ═══ */
test("preferredBookKey: preferidos primero, luego el primero disponible", () => {
  assert.equal(preferredBookKey({ bookmakers: [{ key: "caesars" }, { key: "betmgm" }] }), "betmgm");
  assert.equal(preferredBookKey({ bookmakers: [{ key: "caesars" }] }), "caesars");
  assert.equal(preferredBookKey({ bookmakers: [] }), null);
});

/* ═══ Política de cierre más cercano + idempotencia por duplicado exacto ═══ */

const mkClosingRow = ({ mbs, status = "valid_close", capturedAt = "2026-07-03T22:00:00Z", lastUpdate = "2026-07-03T21:55:00Z", oddsH = -125, oddsA = 105 } = {}) => {
  const dv = devig(oddsH, oddsA);
  return {
    game_pk: 100, book_key: "fanduel", market: "h2h",
    capture_status: status, captured_at: capturedAt, book_last_update: lastUpdate,
    minutes_before_start: mbs, game_start_time: "2026-07-03T23:05:00Z",
    odds_home: oddsH, odds_away: oddsA,
    close_prob_home_nv: dv?.a ?? null, close_prob_away_nv: dv?.b ?? null,
  };
};

test("T−29 válido seguido de T−5 válido: ambos se conservan y T−5 gana la selección", () => {
  const t29 = mkClosingRow({ mbs: 29, capturedAt: "2026-07-03T22:36:00Z", oddsH: -120, oddsA: 100 });
  const t5  = mkClosingRow({ mbs: 5,  capturedAt: "2026-07-03T23:00:00Z", oddsH: -130, oddsA: 110, lastUpdate: "2026-07-03T22:58:00Z" });
  // El T−5 SÍ debe insertarse aunque exista un valid_close previo
  assert.deepEqual(shouldInsertCapture([t29], t5), { insert: true });
  // Y con ambos conservados, la selección elige T−5
  assert.equal(selectClose([t29, t5]).minutes_before_start, 5);
  // Al revés: un T−29 llegando después de un T−5 no se inserta
  assert.equal(shouldInsertCapture([t5], t29).insert, false);
  assert.equal(shouldInsertCapture([t5], t29).reason, "ya_existe_cierre_mas_cercano");
});

test("dos ejecuciones idénticas (mismo last_update y mismas cuotas) → una sola fila", () => {
  const first  = mkClosingRow({ mbs: 12 });
  const second = mkClosingRow({ mbs: 11.5 }); // mismo last_update, mismas cuotas
  const d = shouldInsertCapture([first], second);
  assert.equal(d.insert, false);
  assert.equal(d.reason, "duplicado_exacto");
});

test("nueva actualización del book con cuotas distintas → sí se guarda", () => {
  const first  = mkClosingRow({ mbs: 12, lastUpdate: "2026-07-03T22:50:00Z", oddsH: -125, oddsA: 105 });
  const second = mkClosingRow({ mbs: 8,  lastUpdate: "2026-07-03T22:56:00Z", oddsH: -132, oddsA: 112 });
  assert.deepEqual(shouldInsertCapture([first], second), { insert: true });
});

test("T−5 válido y T+1 post-start: gana T−5, el post-start jamás se usa ni se inserta", () => {
  const t5 = mkClosingRow({ mbs: 5 });
  const tPost = mkClosingRow({ mbs: -1, status: "post_start_invalid" });
  assert.equal(selectClose([t5, tPost]).minutes_before_start, 5);
  assert.equal(selectClose([tPost]), null, "post-start solo jamás gana");
  const d = shouldInsertCapture([t5], tPost);
  assert.equal(d.insert, false);
  assert.equal(d.reason, "cierre_valido_ya_asegurado");
});

test("T−10 stale y T−20 fresh: gana el T−20 válido", () => {
  const t10stale = mkClosingRow({ mbs: 10, status: "stale" });
  const t20ok    = mkClosingRow({ mbs: 20 });
  assert.equal(selectClose([t10stale, t20ok]).minutes_before_start, 20);
});

test("T−45 temprano y T−12 válido: gana T−12; empate de mbs → captured_at más reciente", () => {
  const t45 = mkClosingRow({ mbs: 45, status: "early_snapshot" });
  const t12 = mkClosingRow({ mbs: 12 });
  assert.equal(selectClose([t45, t12]).minutes_before_start, 12);
  const a = mkClosingRow({ mbs: 12, capturedAt: "2026-07-03T22:00:00Z" });
  const b = mkClosingRow({ mbs: 12, capturedAt: "2026-07-03T22:53:00Z" });
  assert.equal(selectClose([a, b]).captured_at, "2026-07-03T22:53:00Z");
});

test("computeClvRows usa el cierre más cercano válido, no el primero insertado", () => {
  const analysis = mkAnalysis(); // entrada -110/-110 → 50% nv
  const t29 = mkClosingRow({ mbs: 29, oddsH: -115, oddsA: -105 });
  const t5  = mkClosingRow({ mbs: 5,  oddsH: -125, oddsA: 105, lastUpdate: "2026-07-03T22:58:00Z" });
  const rows = computeClvRows([analysis], [t29, t5]); // t29 insertado primero
  assert.equal(rows[0].closeOdds, -125, "debe usar las cuotas del T−5, no las del T−29");
  assert.ok(Math.abs(rows[0].clv - 0.03247) < 0.0005);
});

test("la documentación ya no recomienda T−45 como captura final", () => {
  const ops  = readFileSync(new URL("../../docs/DAILY_OPERATIONS.md", import.meta.url), "utf8");
  const meth = readFileSync(new URL("../../docs/BACKTEST_METHODOLOGY.md", import.meta.url), "utf8");
  assert.ok(!/45 minutos previos|45 min previos/.test(ops), "DAILY_OPERATIONS no debe recomendar T−45");
  assert.ok(!/45 min previos/.test(meth), "METHODOLOGY no debe recomendar T−45");
  assert.match(ops, /10-15 minutos antes/);
  assert.match(meth, /10-15 min antes/);
});
