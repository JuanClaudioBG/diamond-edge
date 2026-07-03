/*
 * Radar de Ponches — 12 casos exigidos.
 * Todos los números salen de game logs reales procesados en código; el LLM
 * no participa en ningún punto de este módulo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mean, median, lineToThreshold, hitsOverLine, recordVsIntegerLine,
  hitRateAtThreshold, applyCutoff, qualifyPitcher, buildRadarCard,
  verifyStrikeoutLine, getStrikeoutRadar,
} from "../radar.js";

/* Fixture: game log splits estilo MLB API (orden ascendente por fecha) */
const mkSplit = (date, k, ip = "6.0", pitches = 95, gs = 1) => ({
  date, stat: { strikeOuts: k, inningsPitched: ip, numberOfPitches: pitches, gamesStarted: gs },
});

const TEN_STARTS = [
  mkSplit("2026-05-01", 5), mkSplit("2026-05-07", 3), mkSplit("2026-05-13", 8),
  mkSplit("2026-05-19", 6), mkSplit("2026-05-25", 4), mkSplit("2026-05-31", 7),
  mkSplit("2026-06-06", 6), mkSplit("2026-06-12", 8), mkSplit("2026-06-18", 4),
  mkSplit("2026-06-24", 9),
];
const SAVANT_GOOD = { xera: "3.40", k_percent: "27.0", whiff_percent: "30.1" };
const FG_GOOD     = { fip: "3.30", xfip: "3.20" };
const SEASON_GOOD = { era: "3.20", strikeoutsPer9Inn: "9.8" };

/* ═══ 1. Últimas 5 y 10 aperturas ═══ */
test("últimas 5 y 10 aperturas en orden cronológico, solo aperturas (GS≥1)", () => {
  const withRelief = [...TEN_STARTS, mkSplit("2026-06-26", 2, "1.0", 18, 0)]; // relevo: fuera
  const usable = applyCutoff(withRelief, "2026-07-03T18:00:00Z");
  assert.equal(usable.length, 10, "el juego como relevista (GS=0) no cuenta");
  const card = buildRadarCard({ name: "P", splits: usable, seasonStats: SEASON_GOOD, savantRow: SAVANT_GOOD, fgRow: FG_GOOD });
  assert.deepEqual(card.sample.last10Ks, [5, 3, 8, 6, 4, 7, 6, 8, 4, 9]);
  assert.deepEqual(card.sample.last5Ks, [7, 6, 8, 4, 9], "las 5 más recientes");
});

/* ═══ 2. Promedio y mediana ═══ */
test("promedio y mediana (par e impar)", () => {
  assert.equal(mean([7, 6, 8, 4, 9]), 6.8);
  assert.equal(median([7, 6, 8, 4, 9]), 7);
  assert.equal(median([4, 6, 7, 8]), 6.5, "n par → promedio de centrales");
  assert.equal(mean([]), null);
  assert.equal(median([]), null);
});

/* ═══ 3. Línea 5.5 requiere 6+ ═══ */
test("línea 5.5 → umbral 6: 'habría superado' cuenta aperturas con ≥6 K", () => {
  assert.equal(lineToThreshold(5.5), 6);
  const r = hitsOverLine([7, 6, 8, 4, 9], 5.5);
  assert.deepEqual(r, { hits: 4, n: 5, threshold: 6 });
});

/* ═══ 4. Línea entera 6.0: win/push/loss ═══ */
test("línea entera 6.0 distingue win (>6), push (=6) y loss (<6)", () => {
  const r = recordVsIntegerLine([7, 6, 8, 4, 9], 6);
  assert.deepEqual(r, { win: 3, push: 1, loss: 1, n: 5 });
  assert.equal(recordVsIntegerLine([7, 6], 5.5), null, "línea con .5 no tiene push");
  assert.equal(lineToThreshold(6), 7, "superar una línea entera exige >línea");
});

/* ═══ 5. Muestra insuficiente ═══ */
test("menos de 8 aperturas y <50 IP → muestra insuficiente, sin porcentajes falsos", () => {
  const card = buildRadarCard({ name: "Novato", splits: TEN_STARTS.slice(0, 4), seasonStats: SEASON_GOOD, savantRow: SAVANT_GOOD, fgRow: FG_GOOD });
  assert.equal(card.insufficient, true);
  assert.match(card.reason, /muestra insuficiente/);
  assert.equal(card.line, null);
  assert.ok(!("thresholds" in card), "sin muestra no se publican hit rates");
});

/* ═══ 6. Anti-leakage: fecha de corte ═══ */
test("aperturas del día del análisis o posteriores quedan excluidas", () => {
  const withToday = [...TEN_STARTS, mkSplit("2026-07-03", 12), mkSplit("2026-07-08", 11)];
  const usable = applyCutoff(withToday, "2026-07-03T18:00:00Z");
  assert.equal(usable.length, 10, "la apertura actual (hoy) y la futura no entran");
  assert.ok(!usable.some(s => s.date >= "2026-07-03"));
});

/* ═══ 7. ERA buena + K% bajo → goodPitcher pero JAMÁS radarQualified ═══ */
test("pitcher de contacto: ERA/xERA/xFIP excelentes + volumen alto + K% 16 → sin tarjeta completa", () => {
  const q = qualifyPitcher({ era: 2.80, xera: 3.50, xfip: 3.80, kPct: 16, whiffPct: 19, avgIP: 6.1, starts: 15, totalIP: 90 });
  assert.ok(q.subscores.quality >= 3.5, `calidad=${q.subscores.quality}`);
  assert.equal(q.subscores.volume, 2, "volumen alto");
  assert.equal(q.subscores.kProfile, 0, "K% y Whiff% bajo umbral no suman");
  assert.equal(q.goodPitcher, true, "es buen abridor");
  assert.equal(q.strongKProfile, false);
  assert.equal(q.radarQualified, false, "score 6 con kProfile 0 NO basta: radar exige ponches");
  // La tarjeta refleja la fila compacta
  const card = buildRadarCard({
    name: "Contacto Elite", splits: TEN_STARTS,
    seasonStats: { era: "2.80" }, savantRow: { xera: "3.50", k_percent: "16.0", whiff_percent: "19.0" }, fgRow: { xfip: "3.80" },
  });
  assert.equal(card.radarQualified, false);
  assert.match(card.compactNote, /Abridor sólido, perfil de ponches bajo — no califica para Radar/);
});

/* ═══ 8. Perfil sólido completo sí califica ═══ */
test("ERA/xERA/xFIP/K%/Whiff%/volumen sólidos → radarQualified con score alto", () => {
  const q = qualifyPitcher({ era: 3.20, xera: 3.40, xfip: 3.20, kPct: 27, whiffPct: 30, avgIP: 6.0, starts: 10, totalIP: 60 });
  assert.equal(q.score, 10);
  assert.equal(q.goodPitcher, true);
  assert.equal(q.strongKProfile, true);
  assert.equal(q.radarQualified, true);
});

/* ═══ 9. Línea ausente: sin cuota, sin EV, PROP PARA REVISAR ═══ */
test("sin línea real → line null, nota de prop para revisar, cero campos financieros", () => {
  const card = buildRadarCard({ name: "P", splits: TEN_STARTS, seasonStats: SEASON_GOOD, savantRow: SAVANT_GOOD, fgRow: FG_GOOD, line: null });
  assert.equal(card.line, null);
  assert.match(card.nota, /Línea no disponible — PROP PARA REVISAR/);
  assert.match(card.nota, /No entra a ROI, CLV ni a la muestra oficial/);
  const json = JSON.stringify(card);
  assert.ok(!/"ev"|"cuota"|"valor"/i.test(json), "sin línea no existe cuota/EV/valor en la tarjeta");
});

/* ═══ 10. Línea verificada: match exacto de jugador/mercado/lado/línea/book ═══ */
test("verifyStrikeoutLine exige coincidencia exacta y trae book + timestamp", () => {
  const odds = {
    bookmakers: [{
      key: "fanduel", title: "FanDuel", last_update: "2026-07-03T20:00:00Z",
      markets: [{
        key: "pitcher_strikeouts",
        outcomes: [
          { name: "Over",  description: "Nathan Eovaldi", point: 5.5, price: -115 },
          { name: "Under", description: "Nathan Eovaldi", point: 5.5, price: -105 },
          { name: "Over",  description: "Otro Pitcher",   point: 7.5, price: -120 },
        ],
      }],
    }],
  };
  const line = verifyStrikeoutLine(odds, "Nathan Eovaldi");
  assert.equal(line.point, 5.5);
  assert.equal(line.over.price, -115);
  assert.equal(line.under.price, -105);
  assert.equal(line.book, "fanduel");
  assert.equal(line.lastUpdate, "2026-07-03T20:00:00Z");
  assert.equal(verifyStrikeoutLine(odds, "Pitcher Inexistente"), null, "otro jugador no matchea");
  // Con línea verificada la tarjeta reporta 'habría superado', como SEÑAL, sin VALOR
  const card = buildRadarCard({ name: "Nathan Eovaldi", splits: TEN_STARTS, seasonStats: SEASON_GOOD, savantRow: SAVANT_GOOD, fgRow: FG_GOOD, line });
  assert.equal(card.line.vsLine.last10.threshold, 6);
  assert.match(card.line.nota, /Línea y cuota verificadas\. EV no calculado\. No entra a ROI ni a la muestra oficial\./);
  assert.ok(!/VALOR/.test(JSON.stringify(card)));
});

/* ═══ 11. El LLM no puede introducir una línea estimada ═══ */
test("snapshot sin mercado de props → línea null aunque exista texto LLM con línea estimada", () => {
  const snapshotSinProps = {
    bookmakers: [{ key: "fanduel", markets: [{ key: "h2h", outcomes: [] }] }],
  };
  assert.equal(verifyStrikeoutLine(snapshotSinProps, "Nathan Eovaldi"), null,
    "la única fuente de línea es el snapshot de odds — el texto del LLM no entra a este módulo");
  const card = buildRadarCard({
    name: "Nathan Eovaldi", splits: TEN_STARTS, seasonStats: SEASON_GOOD,
    savantRow: SAVANT_GOOD, fgRow: FG_GOOD,
    line: verifyStrikeoutLine(snapshotSinProps, "Nathan Eovaldi"),
  });
  assert.equal(card.line, null);
  assert.ok(!JSON.stringify(card).includes("5.5-6.0"), "ninguna línea estimada puede colarse");
});

/* ═══ 12. Datos null permanecen null ═══ */
test("fuentes ausentes → null explícito, jamás cero", () => {
  const card = buildRadarCard({ name: "P", splits: TEN_STARTS, seasonStats: null, savantRow: null, fgRow: null });
  assert.equal(card.season.era, null);
  assert.equal(card.season.xera, null);
  assert.equal(card.season.kPct, null);
  assert.equal(card.season.xfip, null);
  assert.equal(card.criteria.era, "sin dato");
  assert.notEqual(card.season.era, 0, "null nunca se disfraza de 0");
  // sin pitches en los logs → avgPitches null
  const noPitches = TEN_STARTS.map(s => ({ ...s, stat: { ...s.stat, numberOfPitches: null } }));
  const card2 = buildRadarCard({ name: "P", splits: noPitches, seasonStats: SEASON_GOOD, savantRow: SAVANT_GOOD, fgRow: FG_GOOD });
  assert.equal(card2.sample.avgPitches, null);
});

/* ═══ Fetch: fuente caída no inventa datos ═══ */
test("getStrikeoutRadar con fuente caída → insufficient con razón, sin números falsos", async () => {
  const card = await getStrikeoutRadar({
    pitcherId: 999999, name: "X", asOfISO: "2026-07-03T18:00:00Z",
    fetcher: async () => { throw new Error("red caída"); },
  });
  assert.equal(card.insufficient, true);
  assert.match(card.reason, /no disponible/);
});

/* ═══ Nulls: strikeOuts faltante jamás se convierte en 0 ═══ */

test("apertura con strikeOuts null/ausente: fuera de promedio, mediana y hit rates; cobertura reportada", () => {
  const withNulls = [
    ...TEN_STARTS.slice(0, 8),
    { date: "2026-06-26", stat: { inningsPitched: "6.0", numberOfPitches: 92, gamesStarted: 1 } },          // sin strikeOuts
    { date: "2026-06-30", stat: { strikeOuts: null, inningsPitched: "5.0", numberOfPitches: 88, gamesStarted: 1 } },
  ];
  const card = buildRadarCard({ name: "P", splits: withNulls, seasonStats: SEASON_GOOD, savantRow: SAVANT_GOOD, fgRow: FG_GOOD });
  assert.equal(card.sample.validKLast10, 8);
  assert.equal(card.sample.incompleteLast10, 2);
  assert.equal(card.sample.coverage, 0.8);
  // Promedio/mediana solo sobre los 8 válidos: [5,3,8,6,4,7,6,8]
  assert.equal(card.sample.avgK, 5.9);
  assert.equal(card.sample.medianK, 6);
  // Hit rates con n=8, no n=10, y sin ceros fantasma: [5,3,8,6,4,7,6,8] → ≥6: 8,6,7,6,8 = 5
  assert.deepEqual(card.thresholds[6], { hits: 5, n: 8 });
  // Los nulls se conservan como null en la serie visible (UI los pinta como –)
  assert.equal(card.sample.last10Ks.filter(k => k === null).length, 2);
  assert.ok(!card.sample.last10Ks.includes(0), "ningún 0 inventado");
});

test("cobertura <70% → datos incompletos y sin tarjeta completa", () => {
  const mostlyNull = TEN_STARTS.map((s, i) => i < 6
    ? { date: s.date, stat: { inningsPitched: "6.0", gamesStarted: 1 } }   // 6 sin dato de K
    : s);
  const card = buildRadarCard({ name: "P", splits: mostlyNull, seasonStats: SEASON_GOOD, savantRow: SAVANT_GOOD, fgRow: FG_GOOD });
  assert.equal(card.sample.dataIncomplete, true);
  assert.equal(card.radarQualified, false, "sin cobertura suficiente no hay candidato de props");
  assert.match(card.compactNote, /datos incompletos/);
});

/* ═══ Hit rate de temporada con línea real ═══ */

test("línea 5.5: temporada completa hasta el corte cuenta aperturas con 6+", () => {
  const line = { book: "fanduel", bookTitle: "FanDuel", lastUpdate: "x", player: "P", point: 5.5, over: { price: -115 }, under: { price: -105 }, complete: true };
  const fifteen = [
    mkSplit("2026-04-05", 6), mkSplit("2026-04-11", 3), mkSplit("2026-04-17", 7),
    mkSplit("2026-04-23", 5), mkSplit("2026-04-29", 9),
    ...TEN_STARTS,
  ];
  const card = buildRadarCard({ name: "P", splits: fifteen, seasonStats: SEASON_GOOD, savantRow: SAVANT_GOOD, fgRow: FG_GOOD, line });
  // Temporada (15): [6,3,7,5,9] + [5,3,8,6,4,7,6,8,4,9] → ≥6: 3 + 6 = 9 de 15
  assert.deepEqual(card.line.vsLine.season, { hits: 9, n: 15, threshold: 6 });
  assert.equal(card.line.vsLine.last10.n, 10);
  assert.equal(card.line.vsLine.last5.n, 5);
});

test("línea entera 6.0: temporada distingue win (7+), push (=6) y loss (<6)", () => {
  const line = { book: "fanduel", bookTitle: "FanDuel", lastUpdate: "x", player: "P", point: 6, over: { price: -110 }, under: { price: -110 }, complete: true };
  const card = buildRadarCard({ name: "P", splits: TEN_STARTS, seasonStats: SEASON_GOOD, savantRow: SAVANT_GOOD, fgRow: FG_GOOD, line });
  // [5,3,8,6,4,7,6,8,4,9]: >6 → 8,7,8,9 = 4 · =6 → 2 · <6 → 4
  assert.deepEqual(card.line.vsLine.recordSeason, { win: 4, push: 2, loss: 4, n: 10 });
});

/* ═══ Freshness real de caché ═══ */

test("caché: primer fetch marca fromCache=false; segundo conserva fetchedAt original", async () => {
  let calls = 0;
  const fetcher = async () => ({ ok: true, json: async () => ({ stats: [{ splits: TEN_STARTS }] }) });
  const countingFetcher = async (u) => { calls++; return fetcher(u); };
  const args = {
    pitcherId: 777001, name: "Cache Test", asOfISO: "2026-07-03T18:00:00Z",
    seasonStats: SEASON_GOOD, savantRow: SAVANT_GOOD, fgRow: FG_GOOD, fetcher: countingFetcher,
  };
  const first = await getStrikeoutRadar(args);
  assert.equal(first.fromCache, false);
  assert.equal(calls, 1);
  const t0 = first.fetchedAt;
  await new Promise(r => setTimeout(r, 15));
  const second = await getStrikeoutRadar(args);
  assert.equal(calls, 1, "segundo pedido no vuelve a la red");
  assert.equal(second.fromCache, true);
  assert.equal(second.fetchedAt, t0, "el timestamp es el del fetch REAL, no la hora actual");
  assert.ok(second.cacheAgeMinutes >= 0);
});

/* ═══ Respuestas HTTP inválidas ═══ */

test("HTTP 429/500 → fuente no disponible, jamás pitcher con cero aperturas", async () => {
  const card = await getStrikeoutRadar({
    pitcherId: 777002, name: "X", asOfISO: "2026-07-03T18:00:00Z",
    fetcher: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  assert.equal(card.insufficient, true);
  assert.match(card.reason, /no disponible/);
  assert.match(card.reason, /429/);
  assert.ok(!("thresholds" in card), "sin estadísticas falsas");
});

test("JSON sin la estructura esperada → fuente no disponible", async () => {
  const card = await getStrikeoutRadar({
    pitcherId: 777003, name: "X", asOfISO: "2026-07-03T18:00:00Z",
    fetcher: async () => ({ ok: true, json: async () => ({ message: "algo raro" }) }),
  });
  assert.equal(card.insufficient, true);
  assert.match(card.reason, /no disponible/);
});

/* ═══ Verificación exacta de línea: mismo point obligatorio ═══ */

const mkPropOdds = (outcomes) => ({
  bookmakers: [{
    key: "fanduel", title: "FanDuel", last_update: "2026-07-03T20:00:00Z",
    markets: [{ key: "pitcher_strikeouts", outcomes }],
  }],
});

test("Over 5.5 y Under 5.5 (mismo point) → línea completa", () => {
  const line = verifyStrikeoutLine(mkPropOdds([
    { name: "Over",  description: "Nathan Eovaldi", point: 5.5, price: -115 },
    { name: "Under", description: "Nathan Eovaldi", point: 5.5, price: -105 },
  ]), "Nathan Eovaldi");
  assert.equal(line.complete, true);
  assert.equal(line.point, 5.5);
  assert.equal(line.over.price, -115);
  assert.equal(line.under.price, -105);
});

test("Over 5.5 y Under 6.5 (points distintos) → JAMÁS se combinan", () => {
  const line = verifyStrikeoutLine(mkPropOdds([
    { name: "Over",  description: "Nathan Eovaldi", point: 5.5, price: -115 },
    { name: "Under", description: "Nathan Eovaldi", point: 6.5, price: -120 },
  ]), "Nathan Eovaldi");
  assert.equal(line.complete, false, "sin ambos lados del MISMO point no hay línea completa");
  const sides = [line.over, line.under].filter(Boolean);
  assert.equal(sides.length, 1, "solo un lado verificado, nunca una mezcla 5.5/6.5");
});

test("solo Over 5.5 disponible → únicamente Over verificado, complete=false", () => {
  const line = verifyStrikeoutLine(mkPropOdds([
    { name: "Over", description: "Nathan Eovaldi", point: 5.5, price: -115 },
  ]), "Nathan Eovaldi");
  assert.equal(line.complete, false);
  assert.equal(line.over.price, -115);
  assert.equal(line.under, null);
  assert.equal(line.book, "fanduel");
  assert.equal(line.lastUpdate, "2026-07-03T20:00:00Z");
});

test("jugador distinto o mercado ausente → null", () => {
  const line = verifyStrikeoutLine(mkPropOdds([
    { name: "Over", description: "Otro Pitcher", point: 5.5, price: -115 },
  ]), "Nathan Eovaldi");
  assert.equal(line, null);
  assert.equal(verifyStrikeoutLine({ bookmakers: [{ key: "fd", markets: [{ key: "h2h", outcomes: [] }] }] }, "Nathan Eovaldi"), null);
  assert.equal(verifyStrikeoutLine(null, "Nathan Eovaldi"), null);
});
