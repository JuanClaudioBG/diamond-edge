/*
 * Evaluación del log de predicciones contra resultados liquidados.
 *
 * Uso:
 *   node backtest/evaluate.js
 *   node backtest/evaluate.js --from 2026-07-01 --to 2026-07-31
 *   node backtest/evaluate.js --confianza ALTA --team Yankees
 *   node backtest/evaluate.js --logic-version 2026-07-02.1
 *   node backtest/evaluate.js --include-retro          (por defecto se excluyen)
 *   node backtest/evaluate.js --min-quality 0.7
 *   node backtest/evaluate.js --csv out.csv --json out.json
 *
 * Reglas: filas retro (predicción posterior al inicio) excluidas por defecto;
 * filas sin probabilidad o sin resultado se excluyen de las métricas que las
 * requieren y se reporta cuántas fueron. Celdas con n<30 se marcan insuficientes.
 */
import { writeFileSync } from "fs";
import { getSettledAnalyses } from "../db.js";

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

/* ── Métricas ────────────────────────────────────────────────────── */
export function brier(rows) {
  // resultado home=1; llm_prob_home en [0,1]
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

/* ── Selecciones de pick por fila ────────────────────────────────── */
const pickModelo   = (r) => r.predicted_winner == null ? null
  : r.predicted_winner === r.home_team ? "home"
  : r.predicted_winner === r.away_team ? "away" : null;
const pickFavorito = (r) => r.market_prob_home == null ? null
  : r.market_prob_home >= 0.5 ? "home" : "away";
const pickRecord   = (r) => {
  try {
    const c = JSON.parse(r.context_json ?? "{}");
    const p = log5Prob(c.homeRec?.wins, c.homeRec?.losses, c.awayRec?.wins, c.awayRec?.losses);
    return p == null ? null : p >= 0.5 ? "home" : "away";
  } catch { return null; }
};

/* ── Main ────────────────────────────────────────────────────────── */
function fmtPct(x) { return x == null ? "–" : (x * 100).toFixed(1) + "%"; }
function fmtNum(x) { return x == null ? "–" : x.toFixed(4); }
function flag(n)   { return n < 30 ? " ⚠ n<30 insuficiente" : ""; }

function report(rowsAll) {
  let rows = rowsAll;
  const excluded = { retro: 0, filtro: 0 };

  if (!args["include-retro"]) {
    excluded.retro = rows.filter(r => r.retro === 1).length;
    rows = rows.filter(r => r.retro !== 1);
  }
  const before = rows.length;
  if (args.from)            rows = rows.filter(r => r.game_date >= args.from);
  if (args.to)              rows = rows.filter(r => r.game_date <= args.to + "T99");
  if (args.team)            rows = rows.filter(r => (r.home_team + " " + r.away_team).includes(args.team));
  if (args.confianza)       rows = rows.filter(r => r.confianza === args.confianza);
  if (args["logic-version"]) rows = rows.filter(r => r.logic_version === args["logic-version"]);
  if (args["min-quality"])  rows = rows.filter(r => (r.data_quality ?? 0) >= parseFloat(args["min-quality"]));
  excluded.filtro = before - rows.length;

  const out = { filtros: { ...args }, excluidas: excluded, n: rows.length, segmentos: {} };

  console.log(`\n═══ EVALUACIÓN (${rows.length} predicciones liquidadas, ${excluded.retro} retro excluidas) ═══\n`);
  if (rows.length === 0) {
    console.log("Sin datos suficientes. Corre el sistema en producción y ejecuta settle.js primero.");
    return out;
  }

  const segments = [
    ["MODELO",            rows, pickModelo],
    ["B-Favorito",        rows, pickFavorito],
    ["B-Récord (log5)",   rows, pickRecord],
  ];
  console.log("── Accuracy del ganador vs baselines ──");
  for (const [name, rs, fn] of segments) {
    const { n, acc } = accuracy(rs, fn);
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

  return out;
}

/* Solo ejecuta si se llama directo (permite importar las funciones en tests) */
if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = getSettledAnalyses().map(r => ({
    ...r,
    llm_prob_home:    r.llm_prob_home    != null ? Number(r.llm_prob_home)    : null,
    market_prob_home: r.market_prob_home != null ? Number(r.market_prob_home) : null,
  }));
  const out = report(rows);
  if (args.json) { writeFileSync(args.json, JSON.stringify(out, null, 2)); console.log(`\nJSON → ${args.json}`); }
  if (args.csv) {
    const header = "id,created_at,game_date,home,away,logic_version,retro,data_quality,llm_prob_home,market_prob_home,predicted_winner,confianza,ev_pct,resultado";
    const lines = rows.map(r => [r.id, r.created_at, r.game_date, r.home_team, r.away_team, r.logic_version, r.retro, r.data_quality, r.llm_prob_home, r.market_prob_home, r.predicted_winner, r.confianza, r.ev_pct, r.resultado].map(v => v ?? "").join(","));
    writeFileSync(args.csv, [header, ...lines].join("\n"));
    console.log(`CSV → ${args.csv}`);
  }
}
