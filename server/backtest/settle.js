/*
 * Liquida resultados de análisis y props oficiales.
 * Solo escribe resultado cuando el juego está Final (codedGameState === "F")
 * — nunca marca juegos en vivo, pospuestos o suspendidos.
 *
 * Uso: node backtest/settle.js
 */
import {
  getUnsettledAnalyses,
  settleAnalysis,
  getUnsettledOfficialProps,
  settleOfficialProp,
} from "../db.js";
import { gradeOfficialProp } from "../prop-settlement.js";

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

const finalGameCache = new Map();
async function getFinalGame(gamePk) {
  if (!finalGameCache.has(gamePk)) {
    finalGameCache.set(gamePk, (async () => {
      const r = await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}`);
      if (!r.ok) throw new Error(`schedule HTTP ${r.status}`);
      const d = await r.json();
      const game = d.dates?.[0]?.games?.find(g => g.gamePk === gamePk)
                ?? d.dates?.flatMap(x => x.games ?? []).find(g => g.gamePk === gamePk);
      return game?.status?.codedGameState === "F" ? game : null;
    })());
  }
  return finalGameCache.get(gamePk);
}

const analysisRows = getUnsettledAnalyses();
console.log(`Análisis sin liquidar: ${analysisRows.length}`);

let settledAnalyses = 0, skippedAnalyses = 0;
for (const row of analysisRows) {
  try {
    const game = await getFinalGame(row.game_pk);
    if (!game) { skippedAnalyses++; continue; }

    const hs = game.teams?.home?.score;
    const as = game.teams?.away?.score;
    if (hs == null || as == null || hs === as) { skippedAnalyses++; continue; }

    const resultado = hs > as ? "home" : "away";
    settleAnalysis(row.id, resultado);
    settledAnalyses++;
    console.log(`  #${row.id} gamePk=${row.game_pk} → ${resultado} (${as}-${hs})`);
  } catch (err) {
    console.error(`  #${row.id} error:`, err.message);
    skippedAnalyses++;
  }
}
console.log(`Análisis liquidados: ${settledAnalyses} | Sin liquidar: ${skippedAnalyses}`);

const propRows = getUnsettledOfficialProps();
console.log(`Props oficiales sin liquidar: ${propRows.length}`);
const propsByGame = new Map();
for (const row of propRows) {
  const gamePk = Number(row.game_pk);
  if (!propsByGame.has(gamePk)) propsByGame.set(gamePk, []);
  propsByGame.get(gamePk).push(row);
}

let settledProps = 0, skippedProps = 0;
for (const [gamePk, picks] of propsByGame) {
  try {
    const game = await getFinalGame(gamePk);
    if (!game) { skippedProps += picks.length; continue; }

    const r = await fetch(`${MLB_BASE}/game/${gamePk}/boxscore`);
    if (!r.ok) throw new Error(`boxscore HTTP ${r.status}`);
    const boxscore = await r.json();

    for (const pick of picks) {
      const grade = gradeOfficialProp(pick, boxscore);
      if (!grade.resultado) {
        skippedProps++;
        console.warn(`  Prop #${pick.id} pendiente: ${grade.reason}`);
        continue;
      }
      const write = settleOfficialProp(pick.id, grade.resultado);
      if (write.changes !== 1) {
        skippedProps++;
        continue;
      }
      settledProps++;
      const actual = grade.actual == null ? "DNP" : grade.actual;
      console.log(`  Prop #${pick.id} ${pick.player} ${pick.side} ${pick.point} (${pick.market}) → ${grade.resultado} · real ${actual}`);
    }
  } catch (err) {
    console.error(`  Props gamePk=${gamePk} error:`, err.message);
    skippedProps += picks.length;
  }
}
console.log(`Props liquidados: ${settledProps} | Sin liquidar: ${skippedProps}`);
