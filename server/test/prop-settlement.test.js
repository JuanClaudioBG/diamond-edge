import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { extractOfficialPropStat, gradeOfficialProp } from "../prop-settlement.js";

const batter = (fullName, batting) => ({ person: { fullName }, stats: { batting } });
const boxscore = (awayPlayers = {}, homePlayers = {}) => ({
  teams: { away: { players: awayPlayers }, home: { players: homePlayers } },
});
const line = (over = {}) => ({
  player: "Riley Greene",
  market: "batter_hits",
  side: "Over",
  point: 1.5,
  ...over,
});

const RILEY_STATS = {
  plateAppearances: 4,
  atBats: 4,
  hits: 2,
  doubles: 1,
  triples: 0,
  homeRuns: 1,
  rbi: 3,
};
const RILEY_BOX = boxscore({ ID1: batter("Riley Greene", RILEY_STATS) });

test("Over/Under se resuelven contra la estadística real del boxscore", () => {
  assert.equal(gradeOfficialProp(line(), RILEY_BOX).resultado, "ganó");
  assert.equal(gradeOfficialProp(line({ point: 2.5 }), RILEY_BOX).resultado, "perdió");
  assert.equal(gradeOfficialProp(line({ side: "Under", point: 2.5 }), RILEY_BOX).resultado, "ganó");
  assert.equal(gradeOfficialProp(line({ side: "Under", point: 1.5 }), RILEY_BOX).resultado, "perdió");
});

test("igualdad exacta con línea entera produce push para ambos lados", () => {
  const over = gradeOfficialProp(line({ point: 2 }), RILEY_BOX);
  const under = gradeOfficialProp(line({ side: "Under", point: 2 }), RILEY_BOX);
  assert.deepEqual({ resultado: over.resultado, actual: over.actual }, { resultado: "push", actual: 2 });
  assert.equal(under.resultado, "push");
});

test("los cuatro mercados oficiales usan el campo correcto; TB se deriva sin doble contar hits", () => {
  assert.equal(gradeOfficialProp(line({ market: "batter_hits", point: 1.5 }), RILEY_BOX).actual, 2);
  assert.equal(gradeOfficialProp(line({ market: "batter_total_bases", point: 5.5 }), RILEY_BOX).actual, 6);
  assert.equal(gradeOfficialProp(line({ market: "batter_home_runs", point: 0.5 }), RILEY_BOX).actual, 1);
  assert.equal(gradeOfficialProp(line({ market: "batter_rbis", point: 2.5 }), RILEY_BOX).actual, 3);
});

test("DNP/scratch: jugador ausente o presente sin PA queda void", () => {
  const absent = gradeOfficialProp(line(), boxscore({ ID2: batter("Otro Jugador", RILEY_STATS) }));
  assert.deepEqual(absent, { status: "void", reason: "dnp_o_scratch", resultado: "void", actual: null });

  const noPa = gradeOfficialProp(line(), boxscore({ ID1: batter("Riley Greene", {
    plateAppearances: 0, atBats: 0, hits: 0,
  }) }));
  assert.deepEqual(noPa, { status: "void", reason: "sin_plate_appearance", resultado: "void", actual: null });

  const emptyBatting = gradeOfficialProp(line(), boxscore({ ID1: batter("Riley Greene", {}) }));
  assert.equal(emptyBatting.resultado, "void");
});

test("una aparición solo por base por bolas cuenta como PA y el cero se liquida, no se anula", () => {
  const walkOnly = boxscore({ ID1: batter("Riley Greene", {
    atBats: 0, baseOnBalls: 1, hits: 0,
  }) });
  const result = gradeOfficialProp(line({ point: 0.5 }), walkOnly);
  assert.equal(result.resultado, "perdió");
  assert.equal(result.actual, 0);
  assert.equal(result.plateAppearances, 1);
});

test("boxscore incompleto, jugador ambiguo o estadística faltante permanecen pendientes", () => {
  assert.deepEqual(extractOfficialPropStat({}, line()), { status: "pending", reason: "boxscore_incompleto" });

  const duplicate = boxscore(
    { ID1: batter("Riley Greene", RILEY_STATS) },
    { ID2: batter("Riley Greene", RILEY_STATS) },
  );
  assert.equal(gradeOfficialProp(line(), duplicate).reason, "jugador_ambiguo");

  const missing = boxscore({ ID1: batter("Riley Greene", { plateAppearances: 2, atBats: 2 }) });
  assert.equal(gradeOfficialProp(line(), missing).reason, "estadistica_ausente");
});

test("línea o mercado inválido nunca se liquidan como pérdida", () => {
  assert.deepEqual(gradeOfficialProp(line({ side: "Push" }), RILEY_BOX), {
    status: "pending", reason: "linea_invalida",
  });
  assert.equal(gradeOfficialProp(line({ market: "batter_desconocido" }), RILEY_BOX).reason, "estadistica_ausente");
});

test("integración: settle confirma Final antes del boxscore y usa escritura idempotente", () => {
  const settle = readFileSync(new URL("../backtest/settle.js", import.meta.url), "utf8");
  const db = readFileSync(new URL("../db.js", import.meta.url), "utf8");
  assert.match(settle, /codedGameState === "F"/);
  assert.match(settle, /game\/\$\{gamePk\}\/boxscore/);
  assert.match(settle, /gradeOfficialProp\(pick, boxscore\)/);
  assert.match(db, /getUnsettledOfficialProps/);
  assert.match(db, /AND resultado IS NULL[\s\S]*lower\(trim\(tipo\)\) = 'prop oficial'/);
});
