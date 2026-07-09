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
  buildBatterRadar,
} from "../batter-radar.js";
import { readFileSync } from "fs";

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

const STATCAST_NORMALIZED = {
  xba: 0.295,
  xwoba: 0.381,
  barrelPct: 14.2,
  hardHitPct: 49.5,
  exitVelo: 91.8,
  launchAngle: 15.4,
  kPct: 19.4,
  bbPct: 11.2,
  whiffPct: 22.5,
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

test("Statcast fuerte sube score de Hits/TB/HR de forma moderada y deja notas", () => {
  const sample = computeRecentBatterSample(parseBatterGameLogs(TEN_GAMES, "2026-07-01T00:00:00Z"));
  const baseHits = scoreHitsProfile(sample, null, { lineupSlot: 9 });
  const strongHits = scoreHitsProfile(sample, STATCAST_NORMALIZED, { lineupSlot: 9 });
  const baseTb = scoreTotalBasesProfile(sample, null, { lineupSlot: 9 });
  const strongTb = scoreTotalBasesProfile(sample, STATCAST_NORMALIZED, { lineupSlot: 9 });
  const baseHr = scoreHomeRunProfile(sample, null, {});
  const strongHr = scoreHomeRunProfile(sample, STATCAST_NORMALIZED, {});

  assert.ok(strongHits.score > baseHits.score, "Statcast de contacto debe sumar a hits");
  assert.ok(strongTb.score > baseTb.score, "Statcast de poder/contacto debe sumar a TB");
  assert.ok(strongHr.score > baseHr.score, "Statcast de poder debe sumar a HR");
  assert.ok(strongHits.score - baseHits.score <= 3, "boost moderado para hits");
  assert.ok(strongTb.score - baseTb.score <= 4, "boost moderado para TB");
  assert.match(strongHits.notes.join(" "), /Statcast aporta/);
  assert.match(strongTb.notes.join(" "), /Statcast aporta/);
  assert.equal(strongHr.officialPick, false, "HR sigue sin pick oficial");
});

test("Statcast ausente o null conserva shape estable y no contamina score", () => {
  const cardNoStatcast = buildBatterRadarCard({
    playerId: 789,
    name: "No Statcast",
    teamName: "Texas Rangers",
    lineupSlot: 5,
    gameLogs: TEN_GAMES,
    asOfISO: "2026-07-01T00:00:00Z",
    statcastRow: null,
  });
  const cardNullStatcast = buildBatterRadarCard({
    playerId: 789,
    name: "Null Statcast",
    teamName: "Texas Rangers",
    lineupSlot: 5,
    gameLogs: TEN_GAMES,
    asOfISO: "2026-07-01T00:00:00Z",
    statcastRow: {
      xba: null,
      xwoba: "",
      barrelPct: "no-data",
      hardHitPct: null,
      exitVelo: undefined,
      launchAngle: null,
      kPct: "",
      bbPct: null,
      whiffPct: undefined,
    },
  });

  assert.deepEqual(cardNoStatcast.statcast, {
    xba: null,
    xwoba: null,
    barrelPct: null,
    hardHitPct: null,
    exitVelo: null,
    launchAngle: null,
    iso: null,
    kPct: null,
    bbPct: null,
    whiffPct: null,
  });
  assert.deepEqual(cardNullStatcast.statcast, cardNoStatcast.statcast);
  assert.equal(cardNullStatcast.markets.hits.score, cardNoStatcast.markets.hits.score);
  assert.equal(cardNullStatcast.markets.totalBases.score, cardNoStatcast.markets.totalBases.score);
  assert.equal(cardNullStatcast.markets.homeRuns.score, cardNoStatcast.markets.homeRuns.score);
});

test("buildBatterRadarCard acepta perfil Statcast normalizado player-level", () => {
  const card = buildBatterRadarCard({
    playerId: 901,
    name: "Normalized Statcast",
    teamName: "Seattle Mariners",
    lineupSlot: 2,
    gameLogs: TEN_GAMES,
    asOfISO: "2026-07-01T00:00:00Z",
    statcastRow: STATCAST_NORMALIZED,
  });
  assert.equal(card.statcast.xba, 0.295);
  assert.equal(card.statcast.barrelPct, 14.2);
  assert.equal(card.statcast.hardHitPct, 49.5);
  assert.equal(card.statcast.exitVelo, 91.8);
  assert.equal(card.statcast.launchAngle, 15.4);
  assert.equal(card.statcast.kPct, 19.4);
  assert.equal(card.statcast.bbPct, 11.2);
  assert.equal(card.statcast.whiffPct, 22.5);
  assert.equal(card.status, "PROP_PARA_REVISAR");
  assert.equal(card.officialPick, false);
});

test("buildBatterRadar con lineup confirmado genera shape estable y limita cards por equipo", async () => {
  const order = ["101", "102", "103", "104", "105", "106", "107"];
  const players = Object.fromEntries(order.map(id => [`ID${id}`, { person: { fullName: `Batter ${id}` } }]));
  const logsById = Object.fromEntries(order.map((id, idx) => [
    id,
    TEN_GAMES.map((g, gameIdx) => split(g.date, batting({
      h: idx < 2 ? 2 : (gameIdx % 3 === 0 ? 1 : 0),
      d: idx === 0 ? 1 : 0,
      hr: idx === 1 && gameIdx % 4 === 0 ? 1 : 0,
      rbi: idx < 3 ? 1 : 0,
    }))),
  ]));
  const fetcher = async (url) => {
    const id = String(url).match(/people\/(\d+)\/stats/)?.[1];
    return { ok: true, json: async () => ({ stats: [{ splits: logsById[id] ?? [] }] }) };
  };
  const savant = new Map(order.map((id, idx) => [id, {
    player_id: id,
    player_name: `Batter ${id}`,
    xwoba: idx < 2 ? "0.380" : "0.300",
    xba: idx < 2 ? "0.295" : "0.240",
    barrel_batted_rate: idx === 1 ? "15.0" : "6.0",
    hard_hit_percent: idx < 2 ? "49.0" : "35.0",
    exit_velocity_avg: idx < 2 ? "91.0" : "87.0",
    launch_angle: "14.0",
  }]));

  const radar = await buildBatterRadar({
    awayTeamName: "Away Team",
    homeTeamName: "Home Team",
    awayOrder: order,
    homeOrder: order.slice(0, 5),
    awayPlayers: players,
    homePlayers: players,
    savantMap: savant,
    getStatcastProfile: (map, q) => map.get(String(q.playerId)) ?? null,
    asOfISO: "2026-07-01T00:00:00Z",
    season: 2026,
    maxCardsPerTeam: 4,
    fetcher,
  });

  assert.equal(radar.status, "OK");
  assert.equal(radar.away.lineupConfirmed, true);
  assert.equal(radar.home.lineupConfirmed, true);
  assert.equal(radar.away.cards.length, 4);
  assert.equal(radar.home.cards.length, 4);
  assert.ok(radar.away.cards.every(c => Number(c.lineupSlot) <= 6), "solo slots 1-6 son candidatos F3");
  assert.ok(radar.away.cards.every(c => c.status === "PROP_PARA_REVISAR"));
  assert.ok(radar.away.cards.every(c => c.officialPick === false));
  assert.ok(radar.away.cards.every(c => Object.values(c.markets).every(m => m.line === null)));
  assert.equal(radar.away.cards[0].name, "Batter 101", "prioriza scores altos dentro del top lineup");
  const json = JSON.stringify(radar);
  assert.ok(!/"ev"|"cuota"|"valor"/i.test(json));
});

test("buildBatterRadar sin lineup confirmado no crashea ni inventa jugadores", async () => {
  const radar = await buildBatterRadar({
    awayTeamName: "Away Team",
    homeTeamName: "Home Team",
    awayOrder: [],
    homeOrder: [],
    asOfISO: "2026-07-01T00:00:00Z",
    fetcher: async () => { throw new Error("no deberia llamarse"); },
  });
  assert.equal(radar.status, "LINEUP_NO_CONFIRMADO");
  assert.equal(radar.away.lineupConfirmed, false);
  assert.equal(radar.home.lineupConfirmed, false);
  assert.deepEqual(radar.away.cards, []);
  assert.deepEqual(radar.home.cards, []);
  assert.match(radar.nota, /no se inventan jugadores/);
});

test("integración backend: index arma batterRadar post-modelo y evaluation/settle no lo consumen", () => {
  const indexSrc = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const evaluateSrc = readFileSync(new URL("../backtest/evaluate.js", import.meta.url), "utf8");
  const settleSrc = readFileSync(new URL("../backtest/settle.js", import.meta.url), "utf8");
  const iPrompt = indexSrc.indexOf("const prompt =");
  const iModel = indexSrc.indexOf("client.messages.create");
  const iRadar = indexSrc.indexOf("analysis.radar =");
  const iBatter = indexSrc.indexOf("analysis.batterRadar = await buildBatterRadar");
  const iLog = indexSrc.indexOf("output_json:");
  assert.ok(iPrompt > -1 && iModel > -1 && iRadar > -1 && iBatter > -1 && iLog > -1);
  assert.ok(iPrompt < iModel, "el prompt se construye antes del modelo");
  assert.ok(iModel < iBatter, "batterRadar no entra al prompt ni al request al modelo");
  assert.ok(iRadar < iBatter, "Radar de Ponches queda antes e intacto");
  assert.ok(iBatter < iLog, "batterRadar se guarda en output_json");
  assert.ok(!/batterRadar/.test(evaluateSrc), "evaluate no consume batterRadar");
  assert.ok(!/batterRadar/.test(settleSrc), "settle no consume batterRadar");
});
