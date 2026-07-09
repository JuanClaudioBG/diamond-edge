/*
 * Perfiles ofensivos por equipo — Fase 1 de 2026-07-02.5.
 * Bug original: el CSV de Savant no trae team_id y buildBatterProfiles
 * agrupaba por row.team_id → mapa siempre vacío.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBatterProfiles, fmtBatterTeam, fmtBatterCoverage, BATTER_FIELDS,
  findBatterStatcastRow, getBatterStatcastProfile, normalizeBatterName,
} from "../batter-profiles.js";

/* Fixture: filas estilo CSV Savant (player_id, pa + métricas; SIN team_id) */
const row = (pid, pa, xwoba, kPct) => ({
  player_id: String(pid), pa: pa != null ? String(pa) : undefined,
  xwoba: xwoba != null ? String(xwoba) : "",
  k_percent: kPct != null ? String(kPct) : "",
  barrel_batted_rate: "8.0", hard_hit_percent: "40.0",
  whiff_percent: "24.0", bb_percent: "9.0", exit_velocity_avg: "89.0",
});
const savantMap = (rows) => new Map(rows.map(r => [r.player_id, r]));
const teamMap   = (pairs) => new Map(pairs.map(([p, t]) => [String(p), String(t)]));

test("CSV sin team_id + playerTeamMap: agrupa correctamente por equipo", () => {
  const { profiles, meta } = buildBatterProfiles(
    savantMap([row(1, 100, 0.300, 20), row(2, 100, 0.340, 25), row(3, 100, 0.400, 30)]),
    teamMap([[1, 147], [2, 147], [3, 119]])
  );
  assert.equal(profiles.size, 2);
  assert.ok(Math.abs(profiles.get("147").xwoba - 0.320) < 1e-9, "promedio del equipo 147");
  assert.ok(Math.abs(profiles.get("119").xwoba - 0.400) < 1e-9);
  assert.equal(meta.source, "mlb_current_team");
});

test("jugador sin currentTeam verificable se excluye (no se agrupa en equipo fantasma)", () => {
  const { profiles, meta } = buildBatterProfiles(
    savantMap([row(1, 100, 0.300, 20), row(99, 100, 0.900, 5)]),  // 99 sin equipo
    teamMap([[1, 147]])
  );
  assert.equal(profiles.size, 1);
  assert.equal(meta.eligiblePlayers, 2);
  assert.equal(meta.matchedPlayers, 1);
  assert.equal(meta.coverage, 0.5);
  assert.ok(Math.abs(profiles.get("147").xwoba - 0.300) < 1e-9, "el no mapeado no contamina");
});

test("PA pondera: 300 PA pesa el triple que 100 PA", () => {
  const { profiles } = buildBatterProfiles(
    savantMap([row(1, 300, 0.400, 20), row(2, 100, 0.200, 20)]),
    teamMap([[1, 147], [2, 147]])
  );
  // (0.400·300 + 0.200·100) / 400 = 0.350 — no el promedio simple 0.300
  assert.ok(Math.abs(profiles.get("147").xwoba - 0.350) < 1e-9);
});

test("pa inválido o ausente usa peso 1", () => {
  const { profiles } = buildBatterProfiles(
    savantMap([
      { ...row(1, null, 0.400, 20) },                 // pa undefined
      { ...row(2, 0, 0.200, 20) },                    // pa 0 → inválido
      { ...row(3, 100, 0.300, 20), pa: "abc" },       // pa no numérico
    ]),
    teamMap([[1, 147], [2, 147], [3, 147]])
  );
  // Todos peso 1 → promedio simple (0.4+0.2+0.3)/3 = 0.300
  assert.ok(Math.abs(profiles.get("147").xwoba - 0.300) < 1e-9);
});

test("métrica null/no numérica no contamina: peso POR MÉTRICA", () => {
  const { profiles } = buildBatterProfiles(
    savantMap([
      row(1, 200, 0.400, null),     // sin k_percent
      row(2, 200, null, 30),        // sin xwoba
    ]),
    teamMap([[1, 147], [2, 147]])
  );
  const p = profiles.get("147");
  assert.ok(Math.abs(p.xwoba - 0.400) < 1e-9, "xwoba solo del jugador 1, sin dividir por peso del 2");
  assert.ok(Math.abs(p.k_percent - 30) < 1e-9, "k_percent solo del jugador 2");
  assert.ok(Math.abs(p.barrel_batted_rate - 8.0) < 1e-9, "métrica común: promedio de ambos");
});

test("mapa jugador→equipo vacío → perfiles vacíos sin crash (fallback igual que hoy)", () => {
  const { profiles, meta } = buildBatterProfiles(
    savantMap([row(1, 100, 0.300, 20)]),
    new Map()
  );
  assert.equal(profiles.size, 0);
  assert.equal(meta.matchedPlayers, 0);
  assert.equal(meta.coverage, 0);
  // savantMap vacío también
  const empty = buildBatterProfiles(new Map(), teamMap([[1, 147]]));
  assert.equal(empty.profiles.size, 0);
  const nulls = buildBatterProfiles(null, null);
  assert.equal(nulls.profiles.size, 0, "entradas null no explotan");
});

test("coverage metadata correcta con cobertura parcial", () => {
  const { meta } = buildBatterProfiles(
    savantMap([row(1, 100, 0.3, 20), row(2, 100, 0.3, 20), row(3, 100, 0.3, 20), row(4, 100, 0.3, 20)]),
    teamMap([[1, 147], [2, 147], [3, 119]])
  );
  assert.equal(meta.eligiblePlayers, 4);
  assert.equal(meta.matchedPlayers, 3);
  assert.equal(meta.coverage, 0.75);
});

test("fmtBatterTeam: con datos formatea, sin datos mantiene mensaje actual; cobertura solo con matches", () => {
  const { profiles, meta } = buildBatterProfiles(
    savantMap([row(1, 100, 0.320, 22.5)]),
    teamMap([[1, 147]])
  );
  const s = fmtBatterTeam(profiles.get("147"), "Yankees");
  assert.match(s, /Yankees: xwOBA 0\.320/);
  assert.match(s, /K% 22\.5/);
  assert.equal(fmtBatterTeam(undefined, "Mets"), "Mets: sin datos Statcast de bateadores");
  assert.match(fmtBatterCoverage(meta), /1\/1 bateadores mapeados \(100%, fuente mlb_current_team, ponderado por PA\)/);
  assert.equal(fmtBatterCoverage({ matchedPlayers: 0 }), "", "sin matches no hay nota de cobertura");
  assert.equal(fmtBatterCoverage(null), "");
});

test("BATTER_FIELDS sin cambios de contrato (7 métricas, pa NO es métrica)", () => {
  assert.equal(BATTER_FIELDS.length, 7);
  assert.ok(!BATTER_FIELDS.includes("pa"), "pa es peso, no métrica promediada");
});

test("Statcast player-level: player_id es la fuente preferida sobre nombre", () => {
  const rows = savantMap([
    { ...row(100, 100, 0.300, 20), player_name: "Nombre Repetido", xba: "0.250" },
    { ...row(200, 100, 0.390, 18), player_name: "Nombre Repetido", xba: "0.310", launch_angle: "14.2" },
  ]);
  const found = findBatterStatcastRow(rows, { playerId: 200, name: "Nombre Repetido" });
  assert.equal(found.player_id, "200");
  const profile = getBatterStatcastProfile(rows, { playerId: 200, name: "Nombre Repetido" });
  assert.equal(profile.playerId, "200");
  assert.equal(profile.xba, 0.310);
  assert.equal(profile.xwoba, 0.390);
  assert.equal(profile.launchAngle, 14.2);
});

test("Statcast player-level: fallback por nombre normalizado y formato 'Apellido, Nombre'", () => {
  const rows = savantMap([
    { ...row(300, 80, 0.345, 22), "last_name, first_name": "Judge, Aaron", xba: "0.301" },
  ]);
  assert.equal(normalizeBatterName("Áaron   Judge"), "aaron judge");
  const found = findBatterStatcastRow(rows, { name: "Aaron Judge" });
  assert.equal(found.player_id, "300");
  const reverse = findBatterStatcastRow(rows, { name: "Judge Aaron" });
  assert.equal(reverse.player_id, "300");
});

test("Statcast player-level: métrica ausente vuelve null explícito", () => {
  const rows = savantMap([
    {
      player_id: "400",
      player_name: "Partial Batter",
      xwoba: "0.333",
      barrel_batted_rate: "",
      hard_hit_percent: "not-a-number",
      exit_velocity_avg: "90.1",
    },
  ]);
  const profile = getBatterStatcastProfile(rows, { playerId: 400 });
  assert.equal(profile.xba, null);
  assert.equal(profile.xwoba, 0.333);
  assert.equal(profile.barrelPct, null);
  assert.equal(profile.hardHitPct, null);
  assert.equal(profile.exitVelo, 90.1);
  assert.equal(profile.kPct, null);
  assert.equal(profile.bbPct, null);
  assert.equal(profile.whiffPct, null);
});

test("Statcast player-level: sin match devuelve null sin afectar agregado por equipo", () => {
  const rows = savantMap([row(1, 100, 0.300, 20)]);
  assert.equal(getBatterStatcastProfile(rows, { playerId: 999, name: "No Existe" }), null);
  const { profiles } = buildBatterProfiles(rows, teamMap([[1, 147]]));
  assert.ok(Math.abs(profiles.get("147").xwoba - 0.300) < 1e-9);
});
