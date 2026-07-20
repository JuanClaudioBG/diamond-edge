import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import Database from "better-sqlite3";
import { freezePropsSnapshot, insertSelectedPropCandidates } from "../official-props.js";

const propsSnapshot = {
  id: "event-123",
  bookmakers: [{
    key: "draftkings",
    title: "DraftKings",
    markets: [{
      key: "batter_hits",
      outcomes: [
        { name: "Over", description: "Riley Greene", point: 0.5, price: -180 },
        { name: "Under", description: "Riley Greene", point: 0.5, price: 140 },
      ],
    }],
  }],
};

test("freezePropsSnapshot conserva el payload completo y metadatos de auditoría", () => {
  const json = freezePropsSnapshot(propsSnapshot, {
    eventId: "event-123",
    frozenAt: "2026-07-20T12:00:00.000Z",
  });
  assert.deepEqual(JSON.parse(json), {
    schemaVersion: 1,
    source: "the-odds-api",
    eventId: "event-123",
    frozenAt: "2026-07-20T12:00:00.000Z",
    payload: propsSnapshot,
  });
});

test("hook no inserta candidatos no seleccionados ni líneas que no coinciden", () => {
  const calls = [];
  const common = {
    propsSnapshot,
    propsJson: freezePropsSnapshot(propsSnapshot),
    analysisId: 42,
    fecha: "2026-07-20",
    partido: "Tigers @ Guardians",
    insertPickFn: row => { calls.push(row); return { lastInsertRowid: 1 }; },
  };

  const ids = insertSelectedPropCandidates({
    ...common,
    candidates: [
      { selected: false, player: "Riley Greene", market: "batter_hits", side: "Over", point: 0.5 },
      { selected: true, player: "Riley Greene", market: "batter_hits", side: "Over", point: 1.5 },
      { selected: true, player: "Riley Greene", market: "batter_hits", side: "Push", point: 0.5 },
    ],
  });

  assert.deepEqual(ids, []);
  assert.deepEqual(calls, []);
});

test("hook inserta un candidato explícito verificado con el mismo props_json congelado", () => {
  const propsJson = freezePropsSnapshot(propsSnapshot, { frozenAt: "2026-07-20T12:00:00.000Z" });
  let inserted = null;
  const ids = insertSelectedPropCandidates({
    candidates: [{
      selected: true,
      player: "Riley Greene",
      market: "batter_hits",
      side: "Over",
      point: 0.5,
      valor: "MEDIO",
      riesgo: "MEDIO",
    }],
    propsSnapshot,
    propsJson,
    analysisId: 42,
    fecha: "2026-07-20",
    partido: "Tigers @ Guardians",
    insertPickFn: row => { inserted = row; return { lastInsertRowid: 77 }; },
  });

  assert.deepEqual(ids, [77]);
  assert.deepEqual(inserted, {
    fecha: "2026-07-20",
    partido: "Tigers @ Guardians",
    tipo: "Prop oficial",
    pick: "Riley Greene Over 0.5",
    valor: "MEDIO",
    riesgo: "MEDIO",
    analysis_id: 42,
    player: "Riley Greene",
    market: "batter_hits",
    side: "Over",
    point: 0.5,
    props_json: propsJson,
  });
});

test("migraciones agregan las cinco columnas sin alterar una fila histórica", () => {
  const source = readFileSync(new URL("../db.js", import.meta.url), "utf8");
  const wanted = new Set(["player", "market", "side", "point", "props_json"]);
  const migrations = [...source.matchAll(/db\.exec\("(ALTER TABLE picks ADD COLUMN ([a-z_]+)[^"]*)"\)/g)]
    .filter(([, , column]) => wanted.has(column))
    .map(([, sql]) => sql);
  assert.equal(migrations.length, 5);

  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE picks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT NOT NULL,
      partido TEXT NOT NULL,
      tipo TEXT NOT NULL,
      pick TEXT NOT NULL
    );
    INSERT INTO picks (fecha, partido, tipo, pick)
    VALUES ('2026-07-19', 'A @ B', 'Moneyline', 'A ML');
  `);
  for (const sql of migrations) db.exec(sql);

  const columns = new Map(db.prepare("PRAGMA table_info(picks)").all().map(c => [c.name, c.type]));
  assert.deepEqual(
    Object.fromEntries([...wanted].map(name => [name, columns.get(name)])),
    { player: "TEXT", market: "TEXT", side: "TEXT", point: "REAL", props_json: "TEXT" },
  );
  const row = db.prepare("SELECT * FROM picks WHERE id = 1").get();
  assert.equal(row.pick, "A ML");
  for (const name of wanted) assert.equal(row[name], null);
  db.close();
});

test("el hook está después de insertAnalysisLog y parte de una lista servidor-only vacía", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const logAt = source.indexOf("const logResult = insertAnalysisLog");
  const hookAt = source.indexOf("const officialPropPickIds = insertSelectedPropCandidates");
  assert.ok(logAt > -1 && hookAt > logAt);
  assert.match(source, /const selectedPropCandidates = \[\];/);
  assert.doesNotMatch(source, /selectedPropCandidates\s*=\s*analysis\./);
});
