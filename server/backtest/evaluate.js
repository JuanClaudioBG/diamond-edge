/*
 * Evaluación del log de predicciones contra resultados liquidados.
 *
 * Uso (desde server/):
 *   node backtest/evaluate.js
 *   node backtest/evaluate.js --from 2026-07-01 --to 2026-07-31
 *   node backtest/evaluate.js --confianza ALTA --team Yankees
 *   node backtest/evaluate.js --logic-version 2026-07-02.2
 *   node backtest/evaluate.js --include-retro     (retro y sin-gameDate excluidos por defecto)
 *   node backtest/evaluate.js --all-snapshots     (por defecto: último análisis por juego)
 *   node backtest/evaluate.js --min-quality 0.7
 *   node backtest/evaluate.js --csv out.csv --json out.json
 *
 * Reglas de integridad:
 *  - Solo retro=0 (prospectivo confirmado) entra por defecto; retro=1 y retro=NULL
 *    (sin gameDate) se excluyen y se reportan.
 *  - Reanálisis del mismo juego: se usa el snapshot MÁS RECIENTE por game_pk
 *    (los anteriores no se borran, solo no se doble-cuentan).
 *  - Filas sin probabilidad/odds se excluyen de las métricas que las requieren,
 *    reportando cuántas. Nunca se imputan ceros.
 *  - ROI usa exclusivamente la cuota registrada en odds_json ANTES del juego.
 *  - Exportar no sobrescribe archivos existentes sin avisar.
 */
import { writeFileSync, existsSync } from "fs";
import { getSettledAnalyses } from "../db.js";
import { unitProfit } from "./odds-math.js";

/* ── CLI args ────────────────────────────────────────────────────── */
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    const key = argv[i].slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    args[key] = val;
  }
}

/* ── Métricas probabilísticas ────────────────────────────────────── */
export function brier(rows) {
  const usable = rows.filter(r => r.llm_prob_home != null);
  if (!usable.length) return null;
  const s = usable.reduce((acc, r) => {
    const y = r.resultado === "home" ? 1 : 0;
    return acc + (r.llm_prob_home - y) ** 2;
  }, 0);
  return s / usable.length;
}

export function logLoss(rows) {
  const usable = rows.filter(r => r.llm_prob_home != null);
  if (!usable.length) return null;
  const eps = 1e-9;
  const s = usable.reduce((acc, r) => {
    const y = r.resultado === "home" ? 1 : 0;
    const p = Math.min(1 - eps, Math.max(eps, r.llm_prob_home));
    return acc - (y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }, 0);
  return s / usable.length;
}

export function marketBrier(rows) {
  const usable = rows.filter(r => r.market_prob_home != null);
  if (!usable.length) return null;
  const s = usable.reduce((acc, r) => {
    const y = r.resultado === "home" ? 1 : 0;
    return acc + (r.market_prob_home - y) ** 2;
  }, 0);
  return s / usable.length;
}

export function accuracy(rows, pickFn) {
  const usable = rows.filter(r => pickFn(r) != null);
  if (!usable.length) return { n: 0, acc: null };
  const hits = usable.filter(r => pickFn(r) === r.resultado).length;
  return { n: usable.length, acc: hits / usable.length, hits };
}

export function wilson(p, n, z = 1.96) {
  if (n === 0) return [null, null];
  const den = 1 + z * z / n;
  const ctr = (p + z * z / (2 * n)) / den;
  const rad = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [ctr - rad, ctr + rad];
}

/** log5 de Bill James sobre récords W-L (baseline B-Récord). */
export function log5Prob(hw, hl, aw, al) {
  const n1 = hw + hl, n2 = aw + al;
  if (!n1 || !n2) return null;
  const pa = hw / n1, pb = aw / n2;
  const num = pa * (1 - pb);
  const den = num + pb * (1 - pa);
  return den > 0 ? num / den : null;
}

export function calibrationBuckets(rows, k = 10) {
  const usable = rows.filter(r => r.llm_prob_home != null);
  const buckets = Array.from({ length: k }, () => ({ n: 0, pSum: 0, wins: 0 }));
  for (const r of usable) {
    const idx = Math.min(k - 1, Math.floor(r.llm_prob_home * k));
    const b = buckets[idx];
    b.n++;
    b.pSum += r.llm_prob_home;
    b.wins += r.resultado === "home" ? 1 : 0;
  }
  return buckets.map((b, i) => ({
    range: `${(i / k).toFixed(1)}–${((i + 1) / k).toFixed(1)}`,
    n: b.n,
    probMedia: b.n ? b.pSum / b.n : null,
    frecuenciaReal: b.n ? b.wins / b.n : null,
  }));
}

/* ── Selección de pick por fila ──────────────────────────────────── */
export const pickModelo = (r) => r.predicted_winner == null ? null
  : r.predicted_winner === r.home_team ? "home"
  : r.predicted_winner === r.away_team ? "away" : null;
const pickFavorito = (r) => r.market_prob_home == null ? null
  : r.market_prob_home >= 0.5 ? "home" : "away";
const pickRecord = (r) => {
  try {
    const c = JSON.parse(r.context_json ?? "{}");
    const p = log5Prob(c.homeRec?.wins, c.homeRec?.losses, c.awayRec?.wins, c.awayRec?.losses);
    return p == null ? null : p >= 0.5 ? "home" : "away";
  } catch { return null; }
};

/* ── Deduplicación: último snapshot por juego ────────────────────── */
export function dedupLatest(rows) {
  const byGame = new Map();
  const noPk = [];
  for (const r of rows) {
    if (r.game_pk == null) { noPk.push(r); continue; }
    const prev = byGame.get(r.game_pk);
    if (!prev || String(r.created_at) > String(prev.created_at)) byGame.set(r.game_pk, r);
  }
  return { rows: [...byGame.values(), ...noPk], duplicatesDropped: rows.length - byGame.size - noPk.length, noPk: noPk.length };
}

/* ── ROI a cuota registrada (1 unidad por pick del modelo) ───────── */
export function priceForPredicted(r) {
  // Replica la preferencia de bookmaker del servidor sobre el snapshot congelado
  try {
    const odds = JSON.parse(r.odds_json ?? "null");
    if (!odds?.bookmakers?.length) return null;
    const bk = odds.bookmakers.find(b => ["draftkings", "fanduel", "betmgm"].includes(b.key))
             ?? odds.bookmakers[0];
    const h2h = bk.markets?.find(m => m.key === "h2h");
    if (!h2h) return null;
    const side = pickModelo(r);
    if (!side) return null;
    const teamName = side === "home" ? r.home_team : r.away_team;
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");
    const out = h2h.outcomes.find(o => norm(o.name) === norm(teamName));
    return out?.price ?? null;
  } catch { return null; }
}

export function roiReport(rows) {
  // Solo filas con resultado, pick del modelo y cuota congelada pregame
  const bets = rows
    .map(r => ({ r, side: pickModelo(r), price: priceForPredicted(r) }))
    .filter(b => b.side && b.price != null && unitProfit(b.price) != null)
    .sort((x, y) => String(x.r.game_date).localeCompare(String(y.r.game_date)));
  if (!bets.length) return { n: 0 };

  let units = 0, wins = 0, peak = 0, maxDrawdown = 0;
  for (const b of bets) {
    const won = b.side === b.r.resultado;
    units += won ? unitProfit(b.price) : -1;
    if (won) wins++;
    peak = Math.max(peak, units);
    maxDrawdown = Math.max(maxDrawdown, peak - units);
  }
  return {
    n: bets.length,
    wins,
    units: Math.round(units * 100) / 100,
    roi: units / bets.length,                 // stake plano de 1 unidad → ROI = yield
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    excluidasSinCuota: rows.filter(r => pickModelo(r) && priceForPredicted(r) == null).length,
  };
}

/* ── Reporte ─────────────────────────────────────────────────────── */
function fmtPct(x) { return x == null ? "–" : (x * 100).toFixed(1) + "%"; }
function fmtNum(x) { return x == null ? "–" : x.toFixed(4); }
function flag(n)   { return n < 30 ? " ⚠ n<30 insuficiente" : ""; }

function safeWrite(path, content) {
  if (existsSync(path)) {
    const alt = `${path}.${Date.now()}`;
    console.warn(`⚠ ${path} ya existe — escribiendo en ${alt} para no sobrescribir`);
    writeFileSync(alt, content);
    return alt;
  }
  writeFileSync(path, content);
  return path;
}

function report(rowsAll) {
  let rows = rowsAll;
  const excluded = { retro: 0, retroDesconocido: 0, duplicados: 0, filtro: 0 };

  if (!args["include-retro"]) {
    excluded.retro            = rows.filter(r => r.retro === 1).length;
    excluded.retroDesconocido = rows.filter(r => r.retro == null).length;
    rows = rows.filter(r => r.retro === 0);   // solo prospectivo CONFIRMADO
  }
  if (!args["all-snapshots"]) {
    const d = dedupLatest(rows);
    excluded.duplicados = d.duplicatesDropped;
    rows = d.rows;
  }
  const before = rows.length;
  if (args.from)             rows = rows.filter(r => r.game_date >= args.from);
  if (args.to)               rows = rows.filter(r => r.game_date <= args.to + "T99");
  if (args.team)             rows = rows.filter(r => (r.home_team + " " + r.away_team).includes(args.team));
  if (args.confianza)        rows = rows.filter(r => r.confianza === args.confianza);
  if (args["logic-version"]) rows = rows.filter(r => r.logic_version === args["logic-version"]);
  if (args["min-quality"])   rows = rows.filter(r => (r.data_quality ?? 0) >= parseFloat(args["min-quality"]));
  excluded.filtro = before - rows.length;

  const versions = [...new Set(rows.map(r => r.logic_version))];
  const out = { filtros: { ...args }, excluidas: excluded, n: rows.length, versiones: versions, segmentos: {} };

  console.log(`\n═══ EVALUACIÓN (${rows.length} predicciones prospectivas liquidadas) ═══`);
  console.log(`Excluidas: retro=${excluded.retro} · sin gameDate=${excluded.retroDesconocido} · reanálisis=${excluded.duplicados} · filtros=${excluded.filtro}`);
  if (versions.length > 1 && !args["logic-version"]) {
    console.log(`⚠ MEZCLA DE VERSIONES: ${versions.join(", ")} — usa --logic-version para comparar limpio`);
  }
  console.log();
  if (rows.length === 0) {
    console.log("Sin datos suficientes. Corre el sistema en producción y ejecuta settle.js primero.");
    return { out, rows };
  }

  console.log("── Accuracy del ganador vs baselines ──");
  for (const [name, fn] of [["MODELO", pickModelo], ["B-Favorito", pickFavorito], ["B-Récord (log5)", pickRecord]]) {
    const { n, acc } = accuracy(rows, fn);
    const [lo, hi] = acc != null ? wilson(acc, n) : [null, null];
    console.log(`${name.padEnd(18)} n=${String(n).padEnd(5)} ${fmtPct(acc)}  IC95 [${fmtPct(lo)}, ${fmtPct(hi)}]${flag(n)}`);
    out.segmentos[name] = { n, acc };
  }

  console.log("\n── Métricas probabilísticas (prob. de victoria del LOCAL) ──");
  const b = brier(rows), ll = logLoss(rows), mb = marketBrier(rows);
  const nProb = rows.filter(r => r.llm_prob_home != null).length;
  console.log(`Brier modelo:   ${fmtNum(b)}  (n=${nProb}${flag(nProb)})`);
  console.log(`Brier mercado:  ${fmtNum(mb)}  ← el número a batir`);
  console.log(`Log loss:       ${fmtNum(ll)}`);
  console.log(`Filas sin probabilidad numérica excluidas: ${rows.length - nProb}`);
  out.brier = b; out.brierMercado = mb; out.logLoss = ll;

  console.log("\n── ROI a cuota registrada (1u por pick del modelo, moneyline) ──");
  const roi = roiReport(rows);
  if (roi.n === 0) {
    console.log("Sin apuestas evaluables (falta cuota congelada o resultado).");
  } else {
    console.log(`n=${roi.n} | récord ${roi.wins}-${roi.n - roi.wins} | unidades ${roi.units > 0 ? "+" : ""}${roi.units} | ROI/yield ${fmtPct(roi.roi)} | max drawdown ${roi.maxDrawdown}u${flag(roi.n)}`);
    if (roi.excluidasSinCuota) console.log(`Excluidas por falta de cuota congelada: ${roi.excluidasSinCuota}`);
  }
  out.roi = roi;

  console.log("\n── Calibración (deciles) ──");
  for (const bucket of calibrationBuckets(rows)) {
    if (!bucket.n) continue;
    console.log(`p∈${bucket.range}  n=${String(bucket.n).padEnd(4)} prob media ${fmtPct(bucket.probMedia)} vs real ${fmtPct(bucket.frecuenciaReal)}${flag(bucket.n)}`);
  }
  out.calibracion = calibrationBuckets(rows);

  console.log("\n── Por segmento (accuracy del modelo) ──");
  const segs = {
    "confianza=ALTA":  rows.filter(r => r.confianza === "ALTA"),
    "confianza=MEDIA": rows.filter(r => r.confianza === "MEDIA"),
    "confianza=BAJA":  rows.filter(r => r.confianza === "BAJA"),
    "pick=favorito":   rows.filter(r => pickModelo(r) && pickModelo(r) === pickFavorito(r)),
    "pick=underdog":   rows.filter(r => pickModelo(r) && pickFavorito(r) && pickModelo(r) !== pickFavorito(r)),
    "pick=local":      rows.filter(r => pickModelo(r) === "home"),
    "pick=visitante":  rows.filter(r => pickModelo(r) === "away"),
    "EV>+5%":          rows.filter(r => (r.ev_pct ?? -99) > 5),
    "calidad≥0.8":     rows.filter(r => (r.data_quality ?? 0) >= 0.8),
  };
  for (const [name, rs] of Object.entries(segs)) {
    const { n, acc } = accuracy(rs, pickModelo);
    if (n === 0) continue;
    console.log(`${name.padEnd(18)} n=${String(n).padEnd(5)} ${fmtPct(acc)}${flag(n)}`);
    out.segmentos[name] = { n, acc };
  }

  return { out, rows };
}

/* Solo ejecuta si se llama directo (permite importar las funciones en tests) */
if (import.meta.url === `file://${process.argv[1]}`) {
  const rowsRaw = getSettledAnalyses().map(r => ({
    ...r,
    llm_prob_home:    r.llm_prob_home    != null ? Number(r.llm_prob_home)    : null,
    market_prob_home: r.market_prob_home != null ? Number(r.market_prob_home) : null,
  }));
  const { out, rows } = report(rowsRaw) ?? {};
  if (args.json && out) {
    const p = safeWrite(args.json, JSON.stringify(out, null, 2));
    console.log(`\nJSON → ${p}`);
  }
  if (args.csv && rows) {
    const header = "id,created_at,game_date,home,away,logic_version,retro,data_quality,llm_prob_home,market_prob_home,predicted_winner,confianza,ev_pct,resultado";
    const lines = rows.map(r => [r.id, r.created_at, r.game_date, r.home_team, r.away_team, r.logic_version, r.retro, r.data_quality, r.llm_prob_home, r.market_prob_home, r.predicted_winner, r.confianza, r.ev_pct, r.resultado].map(v => v ?? "").join(","));
    const p = safeWrite(args.csv, [header, ...lines].join("\n"));
    console.log(`CSV → ${p}`);
  }
}
