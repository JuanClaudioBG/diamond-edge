/*
 * Captura de líneas de cierre (moneyline) para CLV — operación MANUAL.
 *
 * Uso (desde server/, o desde la raíz con npm run close):
 *   node backtest/capture-closing.js              captura real (1 crédito Odds API si hay objetivos)
 *   node backtest/capture-closing.js --dry-run    solo lectura: muestra qué haría, no escribe nada
 *
 * Reglas:
 *  - Solo análisis prospectivos (retro=0) sin liquidar.
 *  - El horario del juego se RELEE de MLB Schedule al capturar (cambios de
 *    horario y dobles carteleras se resuelven contra el horario actual).
 *  - Solo mercado h2h y solo el sportsbook exacto de la entrada.
 *  - Idempotencia por duplicado exacto: una segunda corrida idéntica no
 *    inserta; una captura válida MÁS CERCANA al inicio sí se guarda (las
 *    filas previas se conservan, nunca se sobrescriben).
 *  - analysis_log NUNCA se modifica; solo se insertan filas en closing_lines.
 *
 * MOMENTO RECOMENDADO: ~10-15 minutos antes de cada tanda de juegos.
 * Una corrida a T−45 sirve como ensayo o snapshot temprano (early_snapshot),
 * pero NO cuenta como cierre válido (ventana válida: 0-30 min antes).
 */
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import {
  getPendingCloseTargets, getAllClosingLines, insertClosingLine,
} from "../db.js";
import {
  preferredBookKey, classifyCapture, shouldSkipCapture, shouldInsertCapture,
  matchOddsGame, extractClose,
} from "./clv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const MLB_BASE  = "https://statsapi.mlb.com/api/v1";
const ODDS_URL  = () =>
  `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american`;
/* Ventana de acción: juegos que empiezan en ≤45 min (para llegar a la ventana
   válida de 30) o que empezaron hace ≤60 min (para registrar post_start una vez). */
const ACT_BEFORE_MIN = 45;
const ACT_AFTER_MIN  = 60;

export async function runCapture({
  dryRun  = false,
  fetcher = fetch,
  now     = () => new Date(),
  insert  = insertClosingLine,
  targets = getPendingCloseTargets,
  existing = getAllClosingLines,
  log     = console.log,
} = {}) {
  const nowDate = now();
  const nowISO  = nowDate.toISOString();
  const summary = { saved: 0, skipped: 0, outOfWindow: 0, invalid: 0, errors: 0, credits: 0 };

  /* 1. Identidades pendientes: (game_pk, book de entrada) */
  const pending = targets();
  const identities = new Map(); // `${game_pk}|${book}` → { game_pk, book, home, away, game_date }
  for (const a of pending) {
    let book = null;
    try { book = preferredBookKey(JSON.parse(a.odds_json)); } catch { /* snapshot corrupto */ }
    if (!book) continue;
    const key = `${a.game_pk}|${book}`;
    if (!identities.has(key)) {
      identities.set(key, { game_pk: a.game_pk, book, home: a.home_team, away: a.away_team, game_date: a.game_date });
    }
  }
  log(`Objetivos de cierre: ${identities.size} identidades (game_pk+book) de ${pending.length} análisis pendientes`);
  if (!identities.size) return summary;

  const allExisting = existing();
  const existingFor = (id) => allExisting.filter(
    r => r.game_pk === id.game_pk && r.book_key === id.book && r.market === "h2h"
  );

  /* 2. Releer horario actual por juego y decidir cuáles actúan ahora */
  const actionable = [];
  for (const id of identities.values()) {
    if (shouldSkipCapture(existingFor(id), nowISO)) {
      summary.skipped++;
      log(`  ↷ omitido gamePk=${id.game_pk} ${id.book}: nada puede mejorar (post-start/pospuesto-hoy/juego ya iniciado con cierre válido)`);
      continue;
    }
    let sched = null;
    try {
      const r = await fetcher(`${MLB_BASE}/schedule?sportId=1&gamePk=${id.game_pk}`);
      const d = await r.json();
      sched = d.dates?.flatMap(x => x.games ?? []).find(g => g.gamePk === id.game_pk) ?? null;
    } catch (e) {
      summary.errors++;
      log(`  ✗ gamePk=${id.game_pk}: error MLB Schedule (${e.message}) — sin captura, se reintenta después`);
      continue;
    }
    if (!sched) { summary.errors++; log(`  ✗ gamePk=${id.game_pk}: no aparece en MLB Schedule`); continue; }

    const state = sched.status?.codedGameState;
    if (state === "D" || /postponed|suspended/i.test(sched.status?.detailedState ?? "")) {
      summary.invalid++;
      log(`  ⚠ gamePk=${id.game_pk}: pospuesto/suspendido — registrado, CLV no aplicable hoy`);
      if (!dryRun) insert(mkRow(id, nowISO, sched.gameDate, null, { status: "game_postponed" }, {}));
      continue;
    }

    const startISO = sched.gameDate;                      // horario ACTUAL, no el congelado
    const mbs = (new Date(startISO).getTime() - nowDate.getTime()) / 60000;
    if (mbs > ACT_BEFORE_MIN) {
      summary.outOfWindow++;
      log(`  · gamePk=${id.game_pk} ${id.book}: empieza en ${Math.round(mbs)} min — fuera de ventana, reintentar más cerca del inicio`);
      continue;
    }
    if (mbs < -ACT_AFTER_MIN) {
      summary.outOfWindow++;
      log(`  · gamePk=${id.game_pk}: empezó hace ${Math.round(-mbs)} min — demasiado tarde incluso para registrar post-start`);
      continue;
    }
    actionable.push({ id, startISO, mbs });
  }
  if (!actionable.length) {
    log(`Nada dentro de la ventana de acción (≤${ACT_BEFORE_MIN} min antes del inicio). 0 créditos usados.`);
    log(`Recomendación: corre npm run close ~10-15 min antes de cada tanda de juegos (cierre válido = 0-30 min antes).`);
    return summary;
  }

  /* 3. UNA sola llamada a Odds API (h2h = 1 crédito) para todos los juegos */
  let oddsGames = null;
  let creditsUsed = "?";
  try {
    const r = await fetcher(ODDS_URL());
    creditsUsed = r.headers?.get?.("x-requests-last") ?? "1";
    summary.credits = Number(creditsUsed) || 1;
    oddsGames = await r.json();
    if (!Array.isArray(oddsGames)) throw new Error(`respuesta inesperada: ${JSON.stringify(oddsGames).slice(0, 120)}`);
  } catch (e) {
    summary.errors++;
    log(`  ✗ Odds API caída (${e.message}) — se registra api_error por identidad accionable`);
    for (const { id, startISO, mbs } of actionable) {
      if (!dryRun) insert(mkRow(id, nowISO, startISO, mbs, { status: "api_error" }, {}));
      summary.invalid++;
    }
    return summary;
  }

  /* 4. Capturar por identidad */
  for (const { id, startISO, mbs } of actionable) {
    const game = matchOddsGame(oddsGames, id.home, id.away, startISO);
    const ext  = game ? extractClose(game, id.book, id.home, id.away) : { status: "market_missing" };
    const staleness = ext.status === "ok" && ext.lastUpdate != null
      ? (nowDate.getTime() - new Date(ext.lastUpdate).getTime()) / 60000
      : null;
    const status = ext.status === "ok"
      ? classifyCapture({ minutesBeforeStart: mbs, stalenessMinutes: staleness })
      : (mbs < 0 ? "post_start_invalid" : ext.status);

    const row = mkRow(id, nowISO, startISO, mbs, { ...ext, status }, { staleness, game });
    const decision = shouldInsertCapture(existingFor(id), row);
    if (!decision.insert) {
      summary.skipped++;
      log(`  ↷ gamePk=${id.game_pk} ${id.book}: no insertado (${decision.reason})`);
      continue;
    }
    const tag = status === "valid_close" ? "✓" : "⚠";
    log(`  ${tag} gamePk=${id.game_pk} ${id.book}: ${status}` +
        (ext.status === "ok" ? ` | H ${ext.oddsHome} / A ${ext.oddsAway} | nv ${(ext.probHomeNv * 100).toFixed(1)}%/${(ext.probAwayNv * 100).toFixed(1)}% | ${mbs.toFixed(1)} min antes | staleness ${staleness?.toFixed(1) ?? "?"} min` : "") +
        (dryRun ? "  [dry-run: NO guardado]" : ""));
    if (!dryRun) insert(row);
    status === "valid_close" ? summary.saved++ : summary.invalid++;
  }

  log(`\nResumen: guardados=${summary.saved} · no-válidos registrados=${summary.invalid} · omitidos=${summary.skipped} · fuera de ventana=${summary.outOfWindow} · errores=${summary.errors} · créditos Odds API=${summary.credits}${dryRun ? " · DRY-RUN (cero escrituras)" : ""}`);
  return summary;
}

function mkRow(id, capturedAt, startISO, mbs, ext, extra) {
  return {
    game_pk:              id.game_pk,
    book_key:             id.book,
    market:               "h2h",
    captured_at:          capturedAt,
    book_last_update:     ext.lastUpdate ?? null,
    game_start_time:      startISO,
    minutes_before_start: mbs != null ? Math.round(mbs * 100) / 100 : null,
    staleness_minutes:    extra?.staleness != null ? Math.round(extra.staleness * 100) / 100 : null,
    odds_home:            ext.oddsHome ?? null,
    odds_away:            ext.oddsAway ?? null,
    close_prob_home_nv:   ext.probHomeNv ?? null,
    close_prob_away_nv:   ext.probAwayNv ?? null,
    odds_json:            JSON.stringify(extra?.game ?? {}),
    capture_status:       ext.status,
  };
}

/* CLI */
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("── DRY-RUN: solo lectura, no se escribe nada en picks.db ──");
  runCapture({ dryRun }).catch(e => { console.error("Error fatal:", e.message); process.exit(1); });
}
