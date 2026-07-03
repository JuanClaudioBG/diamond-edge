/*
 * Healthcheck operativo diario — SOLO LECTURA sobre la DB, más pruebas de
 * conectividad de fuentes externas. Sale con código 1 ante error crítico.
 * Uso (desde server/): node backtest/healthcheck.js
 */
import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let criticals = 0, warnings = 0;
const crit = (m) => { criticals++; console.log(`  ✗ CRÍTICO: ${m}`); };
const warn = (m) => { warnings++;  console.log(`  ⚠ ${m}`); };
const ok   = (m) => console.log(`  ✓ ${m}`);

console.log("═══ HEALTHCHECK DIAMOND EDGE ═══\n");

/* ── Versión lógica activa (leída del código fuente, sin arrancar server) ── */
let logicVersion = "?";
try {
  const src = readFileSync(join(__dirname, "..", "index.js"), "utf8");
  logicVersion = src.match(/LOGIC_VERSION\s*=\s*"([^"]+)"/)?.[1] ?? "?";
  ok(`LOGIC_VERSION activa: ${logicVersion}`);
} catch { crit("no se pudo leer index.js para LOGIC_VERSION"); }

/* ── Base de datos ───────────────────────────────────────────────── */
let db;
try {
  db = new Database(join(__dirname, "..", "picks.db"), { readonly: true });
  ok("conexión a picks.db");
} catch (e) {
  crit(`sin conexión a picks.db: ${e.message}`);
  console.log(`\n═══ ${criticals} críticos · ${warnings} warnings ═══`);
  process.exit(1);
}
const q = (sql, ...p) => db.prepare(sql).get(...p);

const today = new Date().toISOString().split("T")[0];
console.log("\n── Actividad de hoy (UTC) ──");
console.log(`  análisis hoy: ${q("SELECT COUNT(*) n FROM analysis_log WHERE date(created_at) = ?", today).n}`);
console.log(`  picks hoy:    ${q("SELECT COUNT(*) n FROM picks WHERE date(fecha_creacion) = ?", today).n}`);

console.log("\n── Integridad rápida ──");
const orphan = q("SELECT COUNT(*) n FROM picks WHERE analysis_id IS NOT NULL AND analysis_id NOT IN (SELECT id FROM analysis_log)").n;
orphan ? crit(`${orphan} picks con analysis_id huérfano`) : ok("sin picks huérfanos");

const badProb = q("SELECT COUNT(*) n FROM analysis_log WHERE llm_prob_home IS NOT NULL AND (llm_prob_home < 0 OR llm_prob_home > 1)").n;
badProb ? crit(`${badProb} probabilidades inválidas`) : ok("probabilidades en rango");

const noOdds = q("SELECT COUNT(*) n FROM analysis_log WHERE odds_json IS NULL").n;
noOdds ? warn(`${noOdds} análisis sin odds (evaluables predictivamente, NO en ROI)`) : ok("todos los análisis tienen odds");

const noProb = q("SELECT COUNT(*) n FROM analysis_log WHERE llm_prob_home IS NULL").n;
noProb ? warn(`${noProb} análisis sin probabilidad numérica del modelo`) : ok("todos los análisis tienen probLocal");

const lowQ = q("SELECT COUNT(*) n FROM analysis_log WHERE data_quality < 0.7").n;
lowQ ? warn(`${lowQ} análisis con calidad de datos < 0.7`) : ok("calidad de datos ≥ 0.7 en todos");

console.log("\n── Control temporal ──");
const retro   = q("SELECT COUNT(*) n FROM analysis_log WHERE retro = 1").n;
const unknown = q("SELECT COUNT(*) n FROM analysis_log WHERE retro IS NULL").n;
console.log(`  retrospectivos acumulados: ${retro} · sin clasificar: ${unknown}`);
if (unknown) warn("hay análisis sin gameDate — no entran a métricas prospectivas");

console.log("\n── Liquidación ──");
const pending = q("SELECT COUNT(*) n FROM analysis_log WHERE resultado IS NULL AND game_pk IS NOT NULL AND retro = 0").n;
const oldPending = q(`
  SELECT COUNT(*) n FROM analysis_log
  WHERE resultado IS NULL AND game_pk IS NOT NULL
    AND datetime(replace(replace(game_date,'T',' '),'Z','')) < datetime('now','-1 day')
`).n;
console.log(`  juegos pendientes de liquidar: ${pending}`);
oldPending ? warn(`${oldPending} juegos terminaron hace >24h sin liquidar — corre: npm run settle`) : ok("sin liquidaciones atrasadas");
const lastSettle = q("SELECT MAX(created_at) t FROM analysis_log WHERE resultado IS NOT NULL").t;
console.log(`  último análisis liquidado (created_at): ${lastSettle ?? "ninguno aún"}`);

/* ── Closing lines (CLV) ─────────────────────────────────────────── */
console.log("\n── Líneas de cierre (CLV) ──");
try {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const needed = db.prepare(
    "SELECT DISTINCT game_pk FROM analysis_log WHERE retro = 0 AND game_pk IS NOT NULL AND substr(game_date,1,10) = ?"
  ).all(yesterday);
  if (!needed.length) {
    ok(`sin juegos prospectivos ayer (${yesterday}) — nada que cerrar`);
  } else {
    const stat = (status) => db.prepare(
      `SELECT COUNT(DISTINCT game_pk) n FROM closing_lines WHERE capture_status = ? AND game_pk IN (SELECT DISTINCT game_pk FROM analysis_log WHERE retro = 0 AND substr(game_date,1,10) = ?)`
    ).get(status, yesterday).n;
    const valid = stat("valid_close");
    const cov   = valid / needed.length;
    console.log(`  juegos de ayer que requerían cierre: ${needed.length} · válidos: ${valid} · cobertura: ${(cov * 100).toFixed(0)}%`);
    const detail = { stale: stat("stale"), post_start: stat("post_start_invalid"), book_missing: stat("book_missing"), market_missing: stat("market_missing"), api_error: stat("api_error"), pospuestos: stat("game_postponed") };
    const parts = Object.entries(detail).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
    if (parts.length) console.log(`  incidencias: ${parts.join(" · ")}`);
    if (valid < needed.length) warn(`${needed.length - valid} cierres faltantes ayer — CLV NULL para esos juegos (no se inventan líneas). Corre npm run close antes de cada tanda de juegos.`);
    else ok("cobertura de cierre completa ayer");
  }
} catch (e) { warn(`no se pudo evaluar cobertura de cierres: ${e.message}`); }

/* ── Fuentes externas (conectividad real) ────────────────────────── */
console.log("\n── Fuentes externas ──");
const probe = async (name, url, checkFn) => {
  try {
    const ctl = AbortSignal.timeout(10000);
    const r = await fetch(url, { signal: ctl });
    if (!r.ok) { warn(`${name}: HTTP ${r.status}`); return; }
    const okContent = checkFn ? checkFn(await r.text()) : true;
    okContent ? ok(`${name}: responde`) : warn(`${name}: respuesta inesperada`);
  } catch (e) { warn(`${name}: ${e.message}`); }
};
await probe("MLB Stats API", "https://statsapi.mlb.com/api/v1/schedule?sportId=1");
await probe("Baseball Savant", "https://baseballsavant.mlb.com/leaderboard/custom?year=" + new Date().getFullYear() + "&type=pitcher&filter=&min=0&selections=xera&chart=false&csv=true", t => t.includes(","));
await probe("Open-Meteo", "https://api.open-meteo.com/v1/forecast?latitude=40&longitude=-100&current=temperature_2m");
console.log("  (Odds API y FireCrawl requieren key — se validan al primer análisis del día)");
console.log("  caches en memoria (Savant/FanGraphs/odds/bullpen) viven en el proceso del server — se validan al arrancarlo");

console.log(`\n═══ RESULTADO: ${criticals} críticos · ${warnings} warnings ═══`);
process.exit(criticals > 0 ? 1 : 0);
