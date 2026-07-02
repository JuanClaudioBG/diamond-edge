/*
 * Liquida resultados de análisis registrados en analysis_log.
 * Solo escribe resultado cuando el juego está Final (codedGameState === "F")
 * — nunca marca juegos en vivo, pospuestos o suspendidos.
 *
 * Uso: node backtest/settle.js
 */
import { getUnsettledAnalyses, settleAnalysis } from "../db.js";

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

const rows = getUnsettledAnalyses();
console.log(`Análisis sin liquidar: ${rows.length}`);

let settled = 0, skipped = 0;
for (const row of rows) {
  try {
    const r = await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${row.game_pk}`);
    const d = await r.json();
    const game = d.dates?.[0]?.games?.find(g => g.gamePk === row.game_pk)
              ?? d.dates?.flatMap(x => x.games ?? []).find(g => g.gamePk === row.game_pk);
    if (!game || game.status?.codedGameState !== "F") { skipped++; continue; }

    const hs = game.teams?.home?.score;
    const as = game.teams?.away?.score;
    if (hs == null || as == null || hs === as) { skipped++; continue; }

    const resultado = hs > as ? "home" : "away";
    settleAnalysis(row.id, resultado);
    settled++;
    console.log(`  #${row.id} gamePk=${row.game_pk} → ${resultado} (${as}-${hs})`);
  } catch (err) {
    console.error(`  #${row.id} error:`, err.message);
    skipped++;
  }
}
console.log(`Liquidados: ${settled} | Sin liquidar (no finales/sin datos): ${skipped}`);
