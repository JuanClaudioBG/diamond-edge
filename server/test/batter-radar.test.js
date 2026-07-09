/*
 * Batter Props Radar v1 F1 — funciones puras.
 * No integra odds, UI, prompt, ROI ni CLV.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBatterGameLogs,
  computeRecentBatterSample,
  computeTotalBases,
  scoreHitsProfile,
  scoreTotalBasesProfile,
  scoreHomeRunProfile,
  buildBatterRadarCard,
} from "../batter-radar.js";

const split = (date, stat) => ({ date, stat });
const batting = ({ h, d = 0, t = 0, hr = 0, rbi = 0, ab = 4, pa = 4, tb } = {}) => ({
  hits: h,
  doubles: d,
  triples: t,
  homeRuns: hr,
  rbi,
  atBats: ab,
  plateAppearances: pa,
  ...(tb != null ? { totalBases: tb } : {}),
});

const TEN_GAMES = [
  split("2026-06-01", batting({ h: 1, d: 0, t: 0, hr: 0, rbi: 0 })),
  split("2026-06-02", batting({ h: 2, d: 1, t: 0, hr: 0, rbi: 1 })),
  split("2026-06-03", batting({ h: 0, d: 0, t: 0, hr: 0, rbi: 0 })),
  split("2026-06-04", batting({ h: 3, d: 1, t: 0, hr: 1, rbi: 3 })),
  split("2026-06-05", batting({ h: 1, d: 0, t: 0, hr: 0, rbi: 1 })),
  split("2026-06-06", batting({ h: 2, d: 0, t: 1, hr: 0, rbi: 2 })),
  split("2026-06-07", batting({ h: 1, d: 0, t: 0, hr: 1, rbi: 1 })),
  split("2026-06-08", batting({ h: 2, d: 1, t: 0, hr: 0, rbi: 0 })),
  split("2026-06-09", batting({ h: 1, d: 0, t: 0, hr: 0, rbi: 0 })),
  split("2026-06-10", batting({ h: 2, d: 0, t: 0, hr: 1, rbi: 2 })),
];

const STATCAST_POWER = {
  xba: "0.292",
  xwoba: "0.372",
  barrel_batted_rate: "16.5",
  hard_hit_percent: "51.0",
  exit_velocity_avg: "92.4",
  launch_angle: "16.0",
  iso: "0.260",
};

test("computeTotalBases calcula TB desde H/2B/3B/HR sin inventar nulls", () => {
  assert.equal(computeTotalBases({ hits: 3, doubles: 1, triples: 1, homeRuns: 1 }), 9);
  assert.equal(computeTotalBases({ hits: 2, doubles: 1, triples: 0, homeRuns: 0 }), 3);
  assert.equal(computeTotalBases({ hits: 2, doubles: null, triples: 0, homeRuns: 0 }), null);
  assert.equal(computeTotalBases({ hits: 1, doubles: 1, triples: 1, homeRuns: 0 }), null, "componentes imposibles no se fuerzan");
  assert.equal(computeTotalBases({ hits: 0, doubles: 0, triples: 0, homeRuns: 0, totalBases: 0 }), 0, "0 oficial solo sobrevive si viene en dato real");
});

test("parseBatterGameLogs aplica anti-leakage y last5/last10 quedan antes del cutoff", () => {
  const parsed = parseBatterGameLogs([
    ...TEN_GAMES,
    split("2026-07-03", batting({ h: 4, hr: 2 })),
    split("2026-07-04", batting({ h: 5, hr: 3 })),
  ], "2026-07-03T18:00:00Z");
  const sample = computeRecentBatterSample(parsed);
  assert.equal(parsed.length, 10);
  assert.ok(parsed.every(g => g.date < "2026-07-03"));
  assert.deepEqual(sample.last5Dates, ["2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10"]);
  assert.deepEqual(sample.metrics.hits.last5, [2, 1, 2, 1, 2]);
  assert.deepEqual(sample.metrics.homeRuns.last10, [0, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

test("null/undefined se excluyen de promedios y no se vuelven 0", () => {
  const parsed = parseBatterGameLogs([
    split("2026-06-01", batting({ h: 1, rbi: 1 })),
    split("2026-06-02", { ...batting({ h: 2, rbi: 1 }), hits: null }),
    split("2026-06-03", { doubles: 0, triples: 0, homeRuns: 0, rbi: null }),
    split("2026-06-04", batting({ h: 2, d: 1, rbi: 0 })),
    split("2026-06-05", batting({ h: 1, rbi: 1 })),
    split("2026-06-06", batting({ h: 1, rbi: 0 })),
    split("2026-06-07", batting({ h: 0, rbi: 0 })),
    split("2026-06-08", batting({ h: 2, rbi: 2 })),
    split("2026-06-09", { ...batting({ h: 1, rbi: 0 }), hits: undefined }),
    split("2026-06-10", batting({ h: 1, rbi: 1 })),
  ], "2026-07-01T00:00:00Z");
  const sample = computeRecentBatterSample(parsed);
  assert.equal(sample.metrics.hits.validLast10, 7);
  assert.equal(sample.metrics.hits.missingLast10, 3);
  assert.equal(sample.metrics.hits.avgLast10, 1.1);
  assert.equal(sample.metrics.hits.last10.filter(v => v === null).length, 3);
  assert.ok(!sample.metrics.hits.last10.includes(undefined));
});

test("menos de 8 juegos validos produce muestra insuficiente", () => {
  const parsed = parseBatterGameLogs(TEN_GAMES.slice(0, 7), "2026-07-01T00:00:00Z");
  const sample = computeRecentBatterSample(parsed);
  const card = buildBatterRadarCard({ name: "Sample Small", gameLogs: TEN_GAMES.slice(0, 7), asOfISO: "2026-07-01T00:00:00Z" });
  assert.equal(sample.insufficient, true);
  assert.equal(card.insufficient, true);
  assert.equal(card.label, "Muestra insuficiente");
  assert.equal(card.markets.hits.score, null);
  assert.equal(card.markets.totalBases.label, "Muestra insuficiente");
});

test("scoreHitsProfile y scoreTotalBasesProfile usan lenguaje Radar, no valor financiero", () => {
  const sample = computeRecentBatterSample(parseBatterGameLogs(TEN_GAMES, "2026-07-01T00:00:00Z"));
  const hits = scoreHitsProfile(sample, STATCAST_POWER, { lineupSlot: 2 });
  const tb = scoreTotalBasesProfile(sample, STATCAST_POWER, { lineupSlot: 2 });
  assert.equal(hits.status, "PROP_PARA_REVISAR");
  assert.equal(tb.status, "PROP_PARA_REVISAR");
  assert.ok(["Perfil calificado", "Perfil medio", "Perfil bajo"].includes(hits.label));
  assert.ok(["Perfil calificado", "Perfil medio", "Perfil bajo"].includes(tb.label));
  assert.ok(!/VALOR/.test(JSON.stringify({ hits, tb })));
});

test("HR score alto no implica pick oficial ni lenguaje fuerte", () => {
  const hrGames = TEN_GAMES.map((g, i) => split(g.date, batting({ h: 2, d: 0, t: 0, hr: i % 2 ? 1 : 0, rbi: 2 })));
  const sample = computeRecentBatterSample(parseBatterGameLogs(hrGames, "2026-07-01T00:00:00Z"));
  const hr = scoreHomeRunProfile(sample, STATCAST_POWER, { parkHrBoost: true });
  assert.ok(hr.score >= 7, `score esperado alto, recibido ${hr.score}`);
  assert.equal(hr.label, "Perfil medio", "HR queda capado por rareza");
  assert.equal(hr.radarQualified, false);
  assert.equal(hr.officialPick, false);
  assert.equal(hr.status, "PROP_PARA_REVISAR");
  assert.equal(hr.strongLanguageAllowed, false);
});

test("RBI sin lineup/contexto confirmado queda baja confianza", () => {
  const card = buildBatterRadarCard({
    playerId: 123,
    name: "Batter Uno",
    teamName: "Oakland Athletics",
    lineupSlot: null,
    gameLogs: TEN_GAMES,
    asOfISO: "2026-07-01T00:00:00Z",
    statcastRow: STATCAST_POWER,
    context: { lineupConfirmed: false },
  });
  assert.equal(card.markets.rbi.confidence, "BAJA");
  assert.equal(card.markets.rbi.score, null);
  assert.equal(card.markets.rbi.radarQualified, false);
  assert.match(card.markets.rbi.notes.join(" "), /baja confianza/);
});

test("buildBatterRadarCard mantiene output shape estable y sin cuotas/EV/VALOR", () => {
  const card = buildBatterRadarCard({
    playerId: 456,
    name: "Power Bat",
    teamName: "Detroit Tigers",
    lineupSlot: 3,
    gameLogs: TEN_GAMES,
    asOfISO: "2026-07-01T00:00:00Z",
    statcastRow: STATCAST_POWER,
    context: { lineupConfirmed: true, teamObp: 0.330 },
  });
  assert.deepEqual(Object.keys(card.markets).sort(), ["hits", "homeRuns", "rbi", "totalBases"]);
  assert.equal(card.status, "PROP_PARA_REVISAR");
  assert.equal(card.officialPick, false);
  assert.equal(card.cutoff, "2026-07-01");
  assert.equal(card.sample.metrics.totalBases.last10.length, 10);
  assert.equal(card.statcast.xwoba, 0.372);
  const json = JSON.stringify(card);
  assert.ok(!/"ev"|"cuota"|"valor"/i.test(json));
  assert.match(card.nota, /No entra a ROI, CLV ni a la muestra oficial/);
});
