/*
 * Auditoría de integridad de picks.db — SOLO LECTURA.
 * Uso (desde server/): node backtest/audit-db.js
 * Sale con código 1 si hay errores críticos de integridad.
 */
import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, "..", "picks.db"), { readonly: true });

const q1 = (sql) => db.prepare(sql).get();
const qa = (sql) => db.prepare(sql).all();

let criticals = 0, warnings = 0;
const crit = (msg) => { criticals++; console.log(`  ✗ CRÍTICO: ${msg}`); };
const warn = (msg) => { warnings++;  console.log(`  ⚠ warning: ${msg}`); };
const ok   = (msg) => console.log(`  ✓ ${msg}`);

console.log("═══ AUDITORÍA DE picks.db (solo lectura) ═══\n");

/* ── Conteos base ────────────────────────────────────────────────── */
const nPicks    = q1("SELECT COUNT(*) n FROM picks").n;
const nAnalyses = q1("SELECT COUNT(*) n FROM analysis_log").n;
const historic  = q1("SELECT COUNT(*) n FROM picks WHERE analysis_id IS NULL").n;
const linked    = nPicks - historic;
console.log("── Conteos ──");
console.log(`  picks totales: ${nPicks} (históricos sin análisis: ${historic} · prospectivos enlazados: ${linked})`);
console.log(`  análisis registrados: ${nAnalyses}`);

/* ── Integridad referencial ──────────────────────────────────────── */
console.log("\n── Integridad referencial ──");
const orphans = q1("SELECT COUNT(*) n FROM picks WHERE analysis_id IS NOT NULL AND analysis_id NOT IN (SELECT id FROM analysis_log)").n;
orphans ? crit(`${orphans} picks apuntan a analysis_id inexistente`) : ok("sin picks huérfanos");

const noPickAnalyses = q1("SELECT COUNT(*) n FROM analysis_log WHERE id NOT IN (SELECT analysis_id FROM picks WHERE analysis_id IS NOT NULL)").n;
console.log(`  análisis sin pick asociado: ${noPickAnalyses} (normal: no todo análisis genera pick)`);

/* ── Campos obligatorios en analysis_log ─────────────────────────── */
console.log("\n── Campos de analysis_log ──");
for (const [campo, sql, critico] of [
  ["logic_version ausente", "SELECT COUNT(*) n FROM analysis_log WHERE logic_version IS NULL", true],
  ["model ausente",         "SELECT COUNT(*) n FROM analysis_log WHERE model IS NULL", true],
  ["created_at ausente",    "SELECT COUNT(*) n FROM analysis_log WHERE created_at IS NULL", true],
  ["game_pk ausente",       "SELECT COUNT(*) n FROM analysis_log WHERE game_pk IS NULL", false],
  ["game_date ausente",     "SELECT COUNT(*) n FROM analysis_log WHERE game_date IS NULL", false],
  ["odds ausentes",         "SELECT COUNT(*) n FROM analysis_log WHERE odds_json IS NULL", false],
  ["probabilidad LLM ausente", "SELECT COUNT(*) n FROM analysis_log WHERE llm_prob_home IS NULL", false],
  ["output_json ausente",   "SELECT COUNT(*) n FROM analysis_log WHERE output_json IS NULL", false],
]) {
  const n = q1(sql).n;
  if (n === 0) ok(`${campo}: 0`);
  else critico ? crit(`${campo}: ${n}`) : warn(`${campo}: ${n} (excluidas de las métricas que lo requieren)`);
}

/* ── Probabilidades válidas ──────────────────────────────────────── */
const badProb = q1("SELECT COUNT(*) n FROM analysis_log WHERE llm_prob_home IS NOT NULL AND (llm_prob_home < 0 OR llm_prob_home > 1)").n;
badProb ? crit(`${badProb} probabilidades fuera de [0,1]`) : ok("probabilidades LLM en rango [0,1]");
const extremeProb = q1("SELECT COUNT(*) n FROM analysis_log WHERE llm_prob_home IS NOT NULL AND (llm_prob_home < 0.01 OR llm_prob_home > 0.99)").n;
if (extremeProb) warn(`${extremeProb} probabilidades extremas (<1% o >99%) — sospechosas en MLB`);

/* ── Retro / prospectivo ─────────────────────────────────────────── */
console.log("\n── Control temporal ──");
const retroRows   = q1("SELECT COUNT(*) n FROM analysis_log WHERE retro = 1").n;
const unknownRetro = q1("SELECT COUNT(*) n FROM analysis_log WHERE retro IS NULL").n;
const prospective = q1("SELECT COUNT(*) n FROM analysis_log WHERE retro = 0").n;
console.log(`  prospectivos: ${prospective} · retrospectivos: ${retroRows} · desconocidos (sin gameDate): ${unknownRetro}`);
if (unknownRetro) warn(`${unknownRetro} análisis sin clasificar retro/prospectivo — no entran a métricas`);

/* retro=0 verificable: created_at (UTC) debe ser < game_date */
const falseProspective = qa(`
  SELECT id, created_at, game_date FROM analysis_log
  WHERE retro = 0 AND game_date IS NOT NULL
    AND datetime(created_at) > datetime(replace(replace(game_date,'T',' '),'Z',''))
`);
falseProspective.length
  ? crit(`${falseProspective.length} análisis marcados prospectivos pero creados DESPUÉS del inicio: ids ${falseProspective.map(r => r.id).join(", ")}`)
  : ok("todos los retro=0 fueron creados antes del inicio del juego (created_at UTC < game_date)");

/* ── Resultados liquidados ───────────────────────────────────────── */
console.log("\n── Liquidación ──");
const pendientes = q1("SELECT COUNT(*) n FROM analysis_log WHERE resultado IS NULL AND game_pk IS NOT NULL").n;
const liquidados = q1("SELECT COUNT(*) n FROM analysis_log WHERE resultado IS NOT NULL").n;
const badResult  = q1("SELECT COUNT(*) n FROM analysis_log WHERE resultado IS NOT NULL AND resultado NOT IN ('home','away')").n;
console.log(`  liquidados: ${liquidados} · pendientes: ${pendientes}`);
badResult ? crit(`${badResult} resultados con valor inválido (≠ home/away)`) : ok("resultados solo home/away");

/* ── Duplicados / reanálisis ─────────────────────────────────────── */
console.log("\n── Duplicados ──");
const dups = qa("SELECT game_pk, COUNT(*) n FROM analysis_log WHERE game_pk IS NOT NULL GROUP BY game_pk HAVING n > 1");
if (dups.length) {
  console.log(`  reanálisis detectados (VÁLIDOS, evaluate usa el último): ${dups.map(d => `gamePk ${d.game_pk}×${d.n}`).join(", ")}`);
} else ok("un análisis por juego");

const dupPicks = qa(`
  SELECT partido, tipo, pick, COUNT(*) n FROM picks
  GROUP BY fecha, partido, tipo, pick HAVING n > 1
`);
dupPicks.length
  ? warn(`${dupPicks.length} picks idénticos repetidos el mismo día (¿doble clic?): revisar manualmente`)
  : ok("sin picks duplicados exactos");

/* ── Formatos de fecha ───────────────────────────────────────────── */
console.log("\n── Formatos ──");
const badFecha = q1("SELECT COUNT(*) n FROM picks WHERE fecha NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'").n;
badFecha ? crit(`${badFecha} picks con fecha en formato inesperado`) : ok("picks.fecha uniforme YYYY-MM-DD");
console.log("  nota: analysis_log.created_at es UTC sin sufijo (convención SQLite); game_date es ISO con Z");

/* ── Resumen ─────────────────────────────────────────────────────── */
console.log(`\n═══ RESULTADO: ${criticals} críticos · ${warnings} warnings ═══`);
process.exit(criticals > 0 ? 1 : 0);
