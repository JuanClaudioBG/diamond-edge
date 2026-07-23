import express from "express";
import cors    from "cors";
import dotenv  from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "url";
import path from "path";
import { getAllPicks, insertPick, updateResultado, insertAnalysisLog, getAllAnalyses } from "./db.js";
import { buildEvaluation } from "./evaluation.js";
import { getBullpenFatigue, fmtBullpenFatigue } from "./bullpen.js";
import { americanToProb, devig } from "./backtest/odds-math.js";
import { verifyPicks, sanitizeTotalNarrative, sanitizeNarratives, attachMarketTotalLine, appendMlAbstention, enforceMlValueConsistency, enforceTotalDirection, enforceTotalProjectionMargin, relabelImpliedNoVigNarratives } from "./verify-picks.js";
import { getStrikeoutRadar } from "./radar.js";
import { buildBatterRadar } from "./batter-radar.js";
import { getPlayerTeamMap, buildBatterProfiles, fmtBatterTeam, fmtBatterCoverage, getBatterStatcastProfile } from "./batter-profiles.js";
import { fetchEventRadarProps, verifyBatterRadarLines } from "./player-props.js";
import { freezePropsSnapshot, insertSelectedPropCandidates } from "./official-props.js";
import { buildRadarSuggestedPicks } from "./radar-suggestions.js";

dotenv.config();

/* Versionado de la lógica: cambiar en cada modificación del prompt o de las
   fuentes de datos, para que el backtest pueda comparar versiones entre sí.
   Historial: .1 = infraestructura inicial · .2 = match de odds por commence_time
   (dobles carteleras), clamp de probabilidad, retro desconocido = null ·
   .3 = fix cuotas inventadas: ambos lados de RL/Total en el prompt, regla de
   cuotas exactas, verificación de picks en código (verify-picks.js) ·
   .4 = sanitización financiera de razones en RL/Total/Props y separación
   cuota-verificada ≠ valor-verificado (SEÑAL en vez de VALOR sin EV) ·
   .5 = Statcast ofensivo real (player_id→currentTeam, ponderado por PA),
   reglas explícitas de LOB%, dirección ERA vs xERA/FIP, coherencia narrativa
   con mercado oficial, total proyectado separado de línea real, bloqueo de
   rankings no verificados, props de K de abridores remitidos al Radar.
   Enforcement de consistencia de salida: ML sin valor con EV≤0, dirección
   del total y comparaciones métricas — misma .5 (solo post-proceso) ·
   .6 = Totales requieren 4/4 para señal alta, nota estratégica obligatoria
   con incertidumbre y prioridad de parlay correlacionado ML + Over Ks ·
   .7 = picks sugeridos no oficiales desde Radar de Bateadores/Ponches,
   con línea real y canal de parlay aislado del ROI ·
   .8 = umbrales EV ML 3/6/10, regresión 40% para pitchers con <30 IP
   y abstención automática cuando ningún lado ML alcanza 3% ·
   .9 = margen mínimo de proyección de 1.5 carreras para Totales, señal
   autoritaria por spread y factores, y spread modelo vs mercado visible. */
const LOGIC_VERSION = "2026-07-23.9";
const MODEL         = "claude-sonnet-4-6";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST      = path.join(__dirname, "../dist");

const app      = express();
const client   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MLB_BASE = "https://statsapi.mlb.com/api/v1";

app.use(cors());
app.use(express.json());
app.use(express.static(DIST));

/* ─── Baseball Savant leaderboard cache ─────────────────────────── */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let savantCache = { map: null, fetchedAt: 0 };

function savantURL() {
  const year = new Date().getFullYear();
  return (
    "https://baseballsavant.mlb.com/leaderboard/custom" +
    `?year=${year}&type=pitcher&filter=&min=0` +
    "&selections=xera,exit_velocity_avg,barrel_batted_rate,hard_hit_percent,whiff_percent,xwoba,k_percent,bb_percent" +
    "&chart=false&csv=true"
  );
}

function parseCSVLine(line) {
  const fields = [];
  let current  = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"')             { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ""; }
    else                        { current += ch; }
  }
  fields.push(current.trim());
  return fields;
}

function parseLeaderboardCSV(csv) {
  const lines   = csv.replace(/\r/g, "").trim().split("\n");
  if (lines.length < 2) return new Map();
  const headers = parseCSVLine(lines[0]);
  const map     = new Map();
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const row  = Object.fromEntries(headers.map((h, j) => [h, vals[j] ?? ""]));
    if (row.player_id) map.set(row.player_id, row);
  }
  return map;
}

async function getSavantMap() {
  const now = Date.now();
  if (savantCache.map && now - savantCache.fetchedAt < CACHE_TTL_MS) {
    return savantCache.map;
  }
  try {
    const res  = await fetch(savantURL());
    const csv  = await res.text();
    const map  = parseLeaderboardCSV(csv);
    savantCache = { map, fetchedAt: now };
    console.log(`[Savant] Leaderboard cargado: ${map.size} pitchers`);
    return map;
  } catch (err) {
    console.error("[Savant] Error fetching leaderboard:", err.message);
    return savantCache.map ?? new Map();
  }
}

function fmtSavant(row, name) {
  if (!row) return `${name}: sin datos Statcast suficientes`;
  const d = (v) => (v && v !== "" ? v : "–");
  return (
    `${name}: xERA ${d(row.xera)} | ` +
    `Exit Velo ${d(row.exit_velocity_avg)} mph | ` +
    `Barrel% ${d(row.barrel_batted_rate)} | ` +
    `Hard Hit% ${d(row.hard_hit_percent)} | ` +
    `Whiff% ${d(row.whiff_percent)} | ` +
    `xwOBA ${d(row.xwoba)} | ` +
    `K% ${d(row.k_percent)} | ` +
    `BB% ${d(row.bb_percent)}`
  );
}

/* ─── FanGraphs leaderboard cache ───────────────────────────────── */
function normalizeName(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

function lookupFangraphs(map, fullName) {
  if (!fullName || !map) return null;
  const key = normalizeName(fullName);
  if (map.has(key)) return map.get(key);
  // Partial match: every token in the query must appear in the stored key
  const tokens = key.split(" ").filter(Boolean);
  for (const [storedKey, row] of map) {
    if (tokens.every(t => storedKey.includes(t))) return row;
  }
  return null;
}

async function scrapeFangraphs() {
  const year = new Date().getFullYear();
  const url  = (
    `https://www.fangraphs.com/leaders/major-league` +
    `?pos=all&stats=pit&lg=all&qual=0&type=8&season=${year}&pageitems=500`
  );
  const res  = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      url,
      formats:         ["markdown"],
      onlyMainContent: true,
      waitFor:         8000,
    }),
  });
  const json = await res.json();
  return json.data?.markdown ?? "";
}

function parseFangraphsMarkdown(markdown) {
  // Column indices (0-based) after splitting a table row by "|" and trimming:
  // 0:rank  1:name  2:team  3:W  4:L  5:SV  6:G  7:GS  8:IP  9:--
  // 10:K/9  11:BB/9  12:HR/9  13:BABIP  14:LOB%  15:GB%  16:HR/FB  17:--
  // 18:vFA  19:--  20:ERA  21:xERA  22:FIP  23:xFIP  24:--  25:WAR
  const map = new Map();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    if (cells.length < 26) continue;
    if (!/^\d+$/.test(cells[0])) continue;   // skip header / separator rows
    const nameMatch = cells[1].match(/\[([^\]]+)\]/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    map.set(normalizeName(name), {
      name,
      fip:    cells[22],
      xfip:   cells[23],
      war:    cells[25],
      babip:  cells[13],
      lobpct: cells[14],
      gbpct:  cells[15],
    });
  }
  return map;
}

let fangraphsCache = { map: null, fetchedAt: 0 };

async function getFangraphsMap() {
  const now = Date.now();
  if (fangraphsCache.map && now - fangraphsCache.fetchedAt < CACHE_TTL_MS) {
    return fangraphsCache.map;
  }
  try {
    const markdown = await scrapeFangraphs();
    const map      = parseFangraphsMarkdown(markdown);
    fangraphsCache = { map, fetchedAt: now };
    console.log(`[FanGraphs] Leaderboard cargado: ${map.size} pitchers`);
    return map;
  } catch (err) {
    console.error("[FanGraphs] Error:", err.message);
    return fangraphsCache.map ?? new Map();
  }
}

function fmtFangraphs(row, name) {
  if (!row) return `${name}: sin datos FanGraphs`;
  const d = (v) => (v && v !== "" ? v : "–");
  return (
    `${name}: FIP ${d(row.fip)} | xFIP ${d(row.xfip)} | WAR ${d(row.war)} | ` +
    `BABIP ${d(row.babip)} | LOB% ${d(row.lobpct)} | GB% ${d(row.gbpct)}`
  );
}

/* ─── Baseball Savant batter leaderboard cache ───────────────────── */
let savantBatterCache = { map: null, fetchedAt: 0 };

function savantBatterURL() {
  const year = new Date().getFullYear();
  return (
    "https://baseballsavant.mlb.com/leaderboard/custom" +
    `?year=${year}&type=batter&filter=&min=50` +
    "&selections=pa,xwoba,barrel_batted_rate,hard_hit_percent,whiff_percent,k_percent,bb_percent,exit_velocity_avg" +
    "&chart=false&csv=true"
  );
}

async function getSavantBatterMap() {
  const now = Date.now();
  if (savantBatterCache.map && now - savantBatterCache.fetchedAt < CACHE_TTL_MS) {
    return savantBatterCache.map;
  }
  try {
    const res = await fetch(savantBatterURL());
    const csv = await res.text();
    const map = parseLeaderboardCSV(csv);
    savantBatterCache = { map, fetchedAt: now };
    console.log(`[Savant] Batter leaderboard cargado: ${map.size} bateadores`);
    return map;
  } catch (err) {
    console.error("[Savant] Error fetching batter leaderboard:", err.message);
    return savantBatterCache.map ?? new Map();
  }
}

/* buildBatterProfiles / fmtBatterTeam viven en batter-profiles.js:
   el CSV de Savant no trae team_id, la agrupación usa el mapa verificable
   player_id → currentTeam.id de MLB Stats API, ponderada por PA. */

/* ─── MLB Standings cache (4 h TTL) ─────────────────────────────── */
const STANDINGS_TTL_MS = 4 * 60 * 60 * 1000;
let standingsCache = { map: null, fetchedAt: 0 };

function buildStandingsMap(data) {
  const map = new Map();
  for (const division of (data?.records ?? [])) {
    for (const tr of (division.teamRecords ?? [])) {
      const tid = String(tr.team?.id);
      if (!tid) continue;
      const splits = {};
      for (const sr of (tr.records?.splitRecords ?? [])) {
        splits[sr.type] = { wins: sr.wins, losses: sr.losses };
      }
      map.set(tid, splits);
    }
  }
  return map;
}

async function getStandingsMap() {
  const now = Date.now();
  if (standingsCache.map && now - standingsCache.fetchedAt < STANDINGS_TTL_MS) {
    return standingsCache.map;
  }
  try {
    const res  = await fetch(`${MLB_BASE}/standings?leagueId=103,104&season=${new Date().getFullYear()}`);
    const data = await res.json();
    const map  = buildStandingsMap(data);
    standingsCache = { map, fetchedAt: now };
    console.log(`[Standings] Cargados: ${map.size} equipos`);
    return map;
  } catch (err) {
    console.error("[Standings] Error fetching standings:", err.message);
    return standingsCache.map ?? new Map();
  }
}

/* ─── MLB Stadiums + Weather ─────────────────────────────────────── */
// ofb = outfield bearing (degrees from home plate toward center field)
// roof: "dome" | "retractable" | undefined (open air)
const STADIUMS = {
  "Oriole Park at Camden Yards": { lat: 39.2839,  lon: -76.6218,  ofb: 35  },
  "Fenway Park":                 { lat: 42.3467,  lon: -71.0972,  ofb: 55  },
  "Yankee Stadium":              { lat: 40.8296,  lon: -73.9262,  ofb: 310 },
  "Tropicana Field":             { lat: 27.7683,  lon: -82.6534,  ofb: 140, roof: "dome"        },
  "Rogers Centre":               { lat: 43.6414,  lon: -79.3894,  ofb: 10,  roof: "retractable" },
  "Guaranteed Rate Field":       { lat: 41.8300,  lon: -87.6339,  ofb: 350 },
  "Progressive Field":           { lat: 41.4962,  lon: -81.6852,  ofb: 35  },
  "Comerica Park":               { lat: 42.3390,  lon: -83.0485,  ofb: 25  },
  "Kauffman Stadium":            { lat: 39.0517,  lon: -94.4803,  ofb: 10  },
  "Target Field":                { lat: 44.9817,  lon: -93.2781,  ofb: 300 },
  "Minute Maid Park":            { lat: 29.7573,  lon: -95.3555,  ofb: 340, roof: "retractable" },
  "Angel Stadium":               { lat: 33.8003,  lon: -117.8827, ofb: 0   },
  "Sutter Health Park":          { lat: 38.5802,  lon: -121.5017, ofb: 340 },
  "T-Mobile Park":               { lat: 47.5914,  lon: -122.3325, ofb: 340, roof: "retractable" },
  "Globe Life Field":            { lat: 32.7473,  lon: -97.0831,  ofb: 25,  roof: "retractable" },
  "Truist Park":                 { lat: 33.8908,  lon: -84.4677,  ofb: 5   },
  "loanDepot park":              { lat: 25.7781,  lon: -80.2197,  ofb: 350, roof: "retractable" },
  "Citi Field":                  { lat: 40.7571,  lon: -73.8458,  ofb: 315 },
  "Citizens Bank Park":          { lat: 39.9061,  lon: -75.1665,  ofb: 340 },
  "Nationals Park":              { lat: 38.8730,  lon: -77.0074,  ofb: 335 },
  "Wrigley Field":               { lat: 41.9484,  lon: -87.6553,  ofb: 45  },
  "Great American Ball Park":    { lat: 39.0979,  lon: -84.5082,  ofb: 0   },
  "American Family Field":       { lat: 43.0280,  lon: -87.9712,  ofb: 340, roof: "retractable" },
  "PNC Park":                    { lat: 40.4468,  lon: -80.0057,  ofb: 335 },
  "Busch Stadium":               { lat: 38.6226,  lon: -90.1929,  ofb: 30  },
  "Chase Field":                 { lat: 33.4453,  lon: -112.0667, ofb: 330, roof: "retractable" },
  "Coors Field":                 { lat: 39.7559,  lon: -104.9942, ofb: 20  },
  "Dodger Stadium":              { lat: 34.0739,  lon: -118.2400, ofb: 330 },
  "Petco Park":                  { lat: 32.7076,  lon: -117.1570, ofb: 310 },
  "Oracle Park":                 { lat: 37.7786,  lon: -122.3893, ofb: 15  },
};

function matchStadium(venueName) {
  if (!venueName) return null;
  if (STADIUMS[venueName]) return { ...STADIUMS[venueName], name: venueName };
  const lower = venueName.toLowerCase();
  for (const [key, val] of Object.entries(STADIUMS)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return { ...val, name: key };
    }
  }
  return null;
}

function degToCardinal(deg) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

function angleDiff(a, b) {
  return Math.abs(((a - b) + 180) % 360 - 180);
}

async function fetchWeather(venueName) {
  const stadium = matchStadium(venueName);
  if (!stadium) return null;
  try {
    const url = (
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${stadium.lat}&longitude=${stadium.lon}` +
      `&current=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation_probability` +
      `&wind_speed_unit=kmh&temperature_unit=celsius&timezone=auto`
    );
    const res  = await fetch(url);
    const data = await res.json();
    const cur  = data.current;
    if (!cur) return null;

    const temp     = Math.round(cur.temperature_2m);
    const windSpd  = Math.round(cur.wind_speed_10m);
    const windDir  = cur.wind_direction_10m;
    const rainPct  = cur.precipitation_probability ?? 0;
    const cardinal = degToCardinal(windDir);

    let hrWarn = "";
    if (!stadium.roof && windSpd > 20) {
      const blowingToward = (windDir + 180) % 360;
      if (angleDiff(blowingToward, stadium.ofb) <= 45) hrWarn = " ⚠️ viento favorable a HR";
    }

    const roofNote = stadium.roof === "dome"        ? " 🏟️ techo fijo"
                   : stadium.roof === "retractable" ? " 🏟️ techo retráctil"
                   : "";

    return `${stadium.name}: ${temp}°C | Viento ${windSpd} km/h → ${cardinal}${hrWarn} | Lluvia ${rainPct}%${roofNote}`;
  } catch (err) {
    console.error("[Weather] Error:", err.message);
    return null;
  }
}

/* ─── The Odds API ──────────────────────────────────────────────── */
const ODDS_TTL_MS   = 60 * 60 * 1000; // 1h cache
const ODDS_API_BASE = "https://api.the-odds-api.com/v4/sports/baseball_mlb/odds";
let oddsCache = { games: null, fetchedAt: 0 };

async function getOddsCache() {
  const now = Date.now();
  if (oddsCache.games && now - oddsCache.fetchedAt < ODDS_TTL_MS) return oddsCache.games;
  try {
    const r = await fetch(
      `${ODDS_API_BASE}/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`
    );
    const data = await r.json();
    if (Array.isArray(data)) oddsCache = { games: data, fetchedAt: now };
    return oddsCache.games ?? [];
  } catch {
    return oddsCache.games ?? [];
  }
}

function normTeam(name) {
  return String(name).toLowerCase().replace(/[^a-z]/g, "");
}

async function getOddsForGame(homeTeamName, awayTeamName, gameDate = null) {
  const games = await getOddsCache();
  const hn = normTeam(homeTeamName);
  const an = normTeam(awayTeamName);
  let candidates = games.filter(g => normTeam(g.home_team) === hn && normTeam(g.away_team) === an);
  if (!candidates.length) {
    candidates = games.filter(g =>
      normTeam(g.home_team).includes(hn.slice(-7)) && normTeam(g.away_team).includes(an.slice(-7)));
  }
  if (!candidates.length) return null;
  /* Dobles carteleras: mismo par de equipos dos veces el mismo día.
     Con gameDate elegimos el juego cuyo commence_time esté más cerca;
     si difiere > 4 h del inicio real, ninguna línea corresponde a este juego. */
  if (gameDate && candidates.length >= 1) {
    const target = new Date(gameDate).getTime();
    const scored = candidates
      .map(g => ({ g, diff: Math.abs(new Date(g.commence_time).getTime() - target) }))
      .sort((x, y) => x.diff - y.diff);
    return scored[0].diff <= 4 * 60 * 60 * 1000 ? scored[0].g : null;
  }
  return candidates[0];
}

function getOddsFetchedAt() {
  return oddsCache.fetchedAt ? new Date(oddsCache.fetchedAt).toISOString() : null;
}

/** Probabilidades implícitas sin vig del moneyline. null si no hay línea. */
function marketProbs(oddsGame, homeTeamName, awayTeamName) {
  if (!oddsGame?.bookmakers?.length) return null;
  const bk = oddsGame.bookmakers.find(b => ["draftkings","fanduel","betmgm"].includes(b.key))
           ?? oddsGame.bookmakers[0];
  const h2h = bk.markets?.find(m => m.key === "h2h");
  if (!h2h) return null;
  const hOut = h2h.outcomes.find(o => normTeam(o.name) === normTeam(homeTeamName));
  const aOut = h2h.outcomes.find(o => normTeam(o.name) === normTeam(awayTeamName));
  if (!hOut || !aOut) return null;                       // sin ambos lados no hay prob justa
  const dv = devig(hOut.price, aOut.price);
  if (!dv) return null;
  return { home: dv.a, away: dv.b, book: bk.title ?? bk.key, homePrice: hOut.price, awayPrice: aOut.price };
}

function fmtOddsSection(oddsGame, homeTeamName, awayTeamName) {
  if (!oddsGame?.bookmakers?.length) return "LÍNEAS DE MERCADO: no disponibles";
  const bk = oddsGame.bookmakers.find(b => ["draftkings","fanduel","betmgm"].includes(b.key))
           ?? oddsGame.bookmakers[0];
  const h2h     = bk.markets?.find(m => m.key === "h2h");
  const spreads = bk.markets?.find(m => m.key === "spreads");
  const totals  = bk.markets?.find(m => m.key === "totals");
  const lines   = [];

  if (h2h) {
    const aOut = h2h.outcomes.find(o => normTeam(o.name) === normTeam(awayTeamName));
    const hOut = h2h.outcomes.find(o => normTeam(o.name) === normTeam(homeTeamName));
    if (aOut && hOut) {
      const ap = americanToProb(aOut.price), hp = americanToProb(hOut.price);
      const tot = ap + hp;
      const apV = (ap / tot * 100).toFixed(1), hpV = (hp / tot * 100).toFixed(1);
      const fmt = (p) => (p > 0 ? "+" : "") + p;
      lines.push(`Moneyline: Vis ${fmt(aOut.price)} (prob real ${apV}%) | Loc ${fmt(hOut.price)} (prob real ${hpV}%)`);
    }
  }
  const fp = (p) => (p > 0 ? "+" : "") + p;
  if (spreads) {
    /* AMBOS lados con su cuota exacta — cada lado tiene precio propio */
    const aOut = spreads.outcomes.find(o => normTeam(o.name) === normTeam(awayTeamName));
    const hOut = spreads.outcomes.find(o => normTeam(o.name) === normTeam(homeTeamName));
    const parts = [];
    if (aOut?.price != null) parts.push(`Vis ${fp(aOut.point)} (${fp(aOut.price)})`);
    if (hOut?.price != null) parts.push(`Loc ${fp(hOut.point)} (${fp(hOut.price)})`);
    if (parts.length) lines.push(`Run Line: ${parts.join(" | ")}${parts.length < 2 ? " — el otro lado NO tiene cuota disponible" : ""}`);
  }
  if (totals) {
    const over  = totals.outcomes.find(o => o.name === "Over");
    const under = totals.outcomes.find(o => o.name === "Under");
    const parts = [];
    if (over?.price != null)  parts.push(`Over ${over.point} (${fp(over.price)})`);
    if (under?.price != null) parts.push(`Under ${under.point} (${fp(under.price)})`);
    if (parts.length) lines.push(`Total: ${parts.join(" | ")}${parts.length < 2 ? " — el otro lado NO tiene cuota disponible" : ""}`);
  }

  return `LÍNEAS DE MERCADO (${bk.title ?? bk.key}):\n${lines.join("\n") || "sin líneas disponibles"}`;
}

/* ─── FIP calculator (MLB Stats API data) ───────────────────────── */
const FIP_CONST = 3.15; // 2024-2026 MLB average

function parseIP(ip) {
  if (!ip) return 0;
  const [full = "0", thirds = "0"] = String(ip).split(".");
  return parseInt(full) + parseInt(thirds) / 3;
}

function fmtDerived(s, name) {
  if (!s) return `${name}: sin datos suficientes`;
  const ip = parseIP(s.inningsPitched);
  if (ip < 1) return `${name}: sin datos suficientes`;
  const hr  = parseFloat(s.homeRuns)    || 0;
  const bb  = parseFloat(s.baseOnBalls) || 0;
  const hbp = parseFloat(s.hitBatsmen)  || 0;
  const so  = parseFloat(s.strikeOuts)  || 0;
  const fip = ((13 * hr + 3 * (bb + hbp) - 2 * so) / ip + FIP_CONST).toFixed(2);
  const k9  = ((so / ip) * 9).toFixed(1);
  const bb9 = ((bb / ip) * 9).toFixed(1);
  const hr9 = ((hr / ip) * 9).toFixed(2);
  const kbb = bb > 0 ? (so / bb).toFixed(2) : "–";
  return `${name}: FIP ${fip} | K/9 ${k9} | BB/9 ${bb9} | HR/9 ${hr9} | K/BB ${kbb}`;
}

/* ─── Prompt helpers ─────────────────────────────────────────────── */
const fmtRec = (r) => (r ? `${r.wins}–${r.losses}` : "");
const ps  = (s, p) => s
  ? `${p?.fullName || "TBD"} — ERA ${s.era} WHIP ${s.whip} IP ${s.inningsPitched} SO ${s.strikeOuts} BB ${s.baseOnBalls} K/9 ${s.strikeoutsPer9Inn || "N/A"}`
  : `${p?.fullName || "TBD"} — sin datos`;
const hs  = (t, x) => `${t.name}: AVG ${x.avg || "–"} OBP ${x.obp || "–"} SLG ${x.slg || "–"} OPS ${x.ops || "–"} HR ${x.homeRuns || "–"} R ${x.runs || "–"} K ${x.strikeOuts || "–"}`;
const pts = (t, x) => `${t.name}: ERA ${x.era || "–"} WHIP ${x.whip || "–"} SO ${x.strikeOuts || "–"} BB ${x.baseOnBalls || "–"} HR-A ${x.homeRuns || "–"}`;

function fmtForm(splits, teamName) {
  if (!splits) return `${teamName}: sin datos de forma`;
  const l10 = splits.lastTen;
  const hm  = splits.home;
  const aw  = splits.away;
  let l10str = "–";
  if (l10) {
    const tag  = l10.wins >= 7 ? " 🔥" : l10.wins <= 3 ? " ❄️" : "";
    l10str = `${l10.wins}-${l10.losses}${tag}`;
  }
  return (
    `${teamName}: Últimos 10: ${l10str} | ` +
    `Casa: ${hm ? `${hm.wins}-${hm.losses}` : "–"} | ` +
    `Visita: ${aw ? `${aw.wins}-${aw.losses}` : "–"}`
  );
}

function fmtMatchupLine(m) {
  const ab    = parseInt(m.vs?.atBats || 0);
  const vsStr = `vsTeam: AVG ${m.vs?.avg || "–"} | HR ${m.vs?.homeRuns || 0} | OPS ${m.vs?.ops || "–"} (${ab} AB)`;
  const szStr = m.sz
    ? `2026: AVG ${m.sz.avg || "–"} | OPS ${m.sz.ops || "–"}`
    : "2026: sin datos";
  return `${m.name} — ${vsStr} | ${szStr}`;
}

function fmtMatchups(matchups, teamName, opposingName) {
  const qualified = matchups
    .filter(m => m.vs && parseInt(m.vs.atBats || 0) >= 10)
    .sort((x, y) => parseFloat(y.vs.ops || 0) - parseFloat(x.vs.ops || 0));
  if (qualified.length === 0) {
    return `${teamName} vs ${opposingName}: sin matchups con ≥10 AB histórico`;
  }
  const top  = qualified.slice(0, Math.min(3, qualified.length));
  const rest = qualified.slice(top.length);
  const bot  = rest.length > 0 ? rest.slice(-Math.min(3, rest.length)).reverse() : [];
  const lines = [
    `FAVORABLE ${teamName} vs ${opposingName} (top OPS histórico):`,
    ...top.map((m, i) => `  ${i + 1}. ${fmtMatchupLine(m)}`),
  ];
  if (bot.length > 0) {
    lines.push(`DESFAVORABLE ${teamName} vs ${opposingName} (peor OPS histórico):`);
    lines.push(...bot.map((m, i) => `  ${i + 1}. ${fmtMatchupLine(m)}`));
  }
  return lines.join("\n");
}

/* ─── Endpoint ───────────────────────────────────────────────────── */
app.post("/api/analyze", async (req, res) => {
  const { home: h, away: a, gamePk, venue, gameDate } = req.body;
  if (!h || !a) return res.status(400).json({ error: "Se requieren datos de home y away." });

  const season = new Date().getFullYear();
  const [savant, batterMap, boxscore, standingsMap, weather, hBullpen, aBullpen, fangraphsMap, aPlatoon, hPlatoon, oddsGame, hFatigue, aFatigue, playerTeamMap] = await Promise.all([
    getSavantMap(),
    getSavantBatterMap(),
    gamePk
      ? fetch(`${MLB_BASE}/game/${gamePk}/boxscore`).then(r => r.json()).catch(() => null)
      : Promise.resolve(null),
    getStandingsMap(),
    fetchWeather(venue),
    fetch(`${MLB_BASE}/teams/${h.team.id}/stats?stats=season&group=pitching&season=${season}&playerPool=BULLPEN`).then(r => r.json()).catch(() => null),
    fetch(`${MLB_BASE}/teams/${a.team.id}/stats?stats=season&group=pitching&season=${season}&playerPool=BULLPEN`).then(r => r.json()).catch(() => null),
    getFangraphsMap(),
    a.prob?.id ? fetch(`${MLB_BASE}/people/${a.prob.id}/stats?stats=statSplits&group=pitching&season=${season}&sitCodes=vl,vr`).then(r => r.json()).catch(() => null) : Promise.resolve(null),
    h.prob?.id ? fetch(`${MLB_BASE}/people/${h.prob.id}/stats?stats=statSplits&group=pitching&season=${season}&sitCodes=vl,vr`).then(r => r.json()).catch(() => null) : Promise.resolve(null),
    getOddsForGame(h.team.name, a.team.name, gameDate),
    getBullpenFatigue(h.team.id).catch(() => null),
    getBullpenFatigue(a.team.id).catch(() => null),
    getPlayerTeamMap(),
  ]);
  const { profiles: batterProfiles, meta: batterMeta } = buildBatterProfiles(batterMap, playerTeamMap);
  const aSavant = a.prob?.id ? savant.get(String(a.prob.id)) : null;
  const hSavant = h.prob?.id ? savant.get(String(h.prob.id)) : null;
  const aName   = a.prob?.fullName || "Visitante TBD";
  const hName   = h.prob?.fullName || "Local TBD";
  const aFG     = lookupFangraphs(fangraphsMap, aName);
  const hFG     = lookupFangraphs(fangraphsMap, hName);

  /* ── Lineup & individual batter matchups ──────────────────────── */
  const aOrder   = boxscore?.teams?.away?.battingOrder ?? [];
  const hOrder   = boxscore?.teams?.home?.battingOrder ?? [];
  const aPlayers = boxscore?.teams?.away?.players ?? {};
  const hPlayers = boxscore?.teams?.home?.players ?? {};

  const fetchBatter = async (pid, opposingTeamId, players) => {
    const name = players[`ID${pid}`]?.person?.fullName ?? String(pid);
    const [vsRes, szRes] = await Promise.all([
      fetch(`${MLB_BASE}/people/${pid}/stats?stats=vsTeam&group=hitting&opposingTeamId=${opposingTeamId}`).then(r => r.json()).catch(() => null),
      fetch(`${MLB_BASE}/people/${pid}/stats?stats=season&group=hitting&season=${season}`).then(r => r.json()).catch(() => null),
    ]);
    return {
      name,
      vs: vsRes?.stats?.[0]?.splits?.[0]?.stat ?? null,
      sz: szRes?.stats?.[0]?.splits?.[0]?.stat ?? null,
    };
  };

  const [aMatchups, hMatchups] = await Promise.all([
    Promise.all(aOrder.map(pid => fetchBatter(pid, h.team.id, aPlayers))),
    Promise.all(hOrder.map(pid => fetchBatter(pid, a.team.id, hPlayers))),
  ]);

  console.log(`[Lineup] ${a.team.name}: ${aOrder.length} bat | ${h.team.name}: ${hOrder.length} bat`);

  const lineupAvailable = aOrder.length > 0 || hOrder.length > 0;
  const matchupSection  = lineupAvailable
    ? `MATCHUPS INDIVIDUALES (lineup confirmado):\n${fmtMatchups(aMatchups, a.team.name, h.team.name)}\n${fmtMatchups(hMatchups, h.team.name, a.team.name)}`
    : "MATCHUPS INDIVIDUALES: Lineup no disponible aún";

  const aSplits       = standingsMap.get(String(a.team.id));
  const hSplits       = standingsMap.get(String(h.team.id));
  const formSection   = `FORMA RECIENTE Y SPLITS:\n${fmtForm(aSplits, a.team.name)}\n${fmtForm(hSplits, h.team.name)}`;
  const weatherSection = `CLIMA Y CONDICIONES:\n${weather ?? "datos no disponibles"}`;

  const fmtBullpen = (data, teamName) => {
    const st = data?.stats?.[0]?.splits?.[0]?.stat;
    if (!st) return `${teamName}: datos no disponibles`;
    const era  = st.era        != null ? Number(st.era).toFixed(2)  : "–";
    const whip = st.whip       != null ? Number(st.whip).toFixed(2) : "–";
    const hld  = st.holds      != null ? st.holds      : "–";
    const bs   = st.blownSaves != null ? st.blownSaves : "–";
    return `${teamName}: ERA ${era} | WHIP ${whip} | Holds ${hld} | Blown Saves ${bs}`;
  };
  const bullpenSection = `BULLPEN (relievers únicamente):\n${fmtBullpen(aBullpen, a.team.name)}\n${fmtBullpen(hBullpen, h.team.name)}`;

  const fmtPlatoon = (data, name) => {
    if (!data) return `${name}: sin datos de plateo`;
    const splits = data.stats?.[0]?.splits ?? [];
    const vl = splits.find(s => s.split?.code === "vl")?.stat;
    const vr = splits.find(s => s.split?.code === "vr")?.stat;
    const side = (s, label) => s
      ? `${label}: AVG ${s.avg || "–"} | OPS ${s.ops || "–"} | WHIP ${s.whip || "–"} | K ${s.strikeOuts || 0} | BB ${s.baseOnBalls || 0} | HR ${s.homeRuns || 0}`
      : `${label}: sin datos`;
    return `${name} — ${side(vl, "vs Zurdos")} / ${side(vr, "vs Diestros")}`;
  };
  const platoonSection = `SPLITS POR PLATEO (temporada ${season}):\n${fmtPlatoon(aPlatoon, aName)}\n${fmtPlatoon(hPlatoon, hName)}`;
  const oddsSection    = fmtOddsSection(oddsGame, h.team.name, a.team.name);
  const fatigueSection =
    `FATIGA DE BULLPEN (indicador experimental de DISPONIBILIDAD, ventana 7 días — úsalo solo como contexto secundario, no como driver principal de ningún pick):\n` +
    `${fmtBullpenFatigue(aFatigue, a.team.name)}\n${fmtBullpenFatigue(hFatigue, h.team.name)}`;

  /* Calidad de datos: fracción de fuentes que llegaron con datos reales */
  const sections = {
    pitcherAway:   !!a.prob?.id,     pitcherHome:  !!h.prob?.id,
    savantAway:    !!aSavant,        savantHome:   !!hSavant,
    fangraphsAway: !!aFG,            fangraphsHome: !!hFG,
    weather:       !!weather,        odds:          !!oddsGame,
    lineup:        lineupAvailable,
    splitsAway:    !!(aSplits && Object.keys(aSplits).length),
    splitsHome:    !!(hSplits && Object.keys(hSplits).length),
    bullpenAway:   !!aBullpen?.stats?.[0]?.splits?.[0]?.stat,
    bullpenHome:   !!hBullpen?.stats?.[0]?.splits?.[0]?.stat,
    platoonAway:   !!aPlatoon,       platoonHome:  !!hPlatoon,
    fatigueAway:   !!aFatigue,       fatigueHome:  !!hFatigue,
  };
  const dataQuality = Object.values(sections).filter(Boolean).length / Object.keys(sections).length;
  /* retro: 1 = análisis posterior al inicio (excluido de métricas prospectivas),
     0 = prospectivo confirmado, null = sin gameDate → NO se asume prospectivo. */
  const retro = gameDate ? (Date.now() > new Date(gameDate).getTime() ? 1 : 0) : null;

  console.log(`[Weather] ${venue ?? "sin venue"}:`, weather ?? "sin datos");
  console.log(`[Odds]    ${a.team.name} @ ${h.team.name}:`, oddsGame ? "encontrado" : "sin datos");
  console.log(`[Calidad] ${(dataQuality * 100).toFixed(0)}% de fuentes con datos${retro ? " · ⚠ análisis posterior al inicio (retro)" : ""}`);

  const prompt = `Eres analista MLB estilo Moneyball/FanGraphs. Analiza este partido y genera picks con valor real para apuestas deportivas.

PARTIDO: ${a.team.name} (${fmtRec(a.rec)}) @ ${h.team.name} (${fmtRec(h.rec)})

LANZADORES PROBABLES:
Visitante: ${ps(a.ps, a.prob)}
Local: ${ps(h.ps, h.prob)}

OFENSIVA TEMPORADA:
${hs(a.team, a.hit)}
${hs(h.team, h.hit)}

${formSection}

${weatherSection}

OFENSIVA STATCAST (por equipo, Baseball Savant ${new Date().getFullYear()}, mín 50 PA${fmtBatterCoverage(batterMeta)}):
${fmtBatterTeam(batterProfiles.get(String(a.team.id)), a.team.name)}
${fmtBatterTeam(batterProfiles.get(String(h.team.id)), h.team.name)}

PITCHEO EQUIPO (temporada):
${pts(a.team, a.pit)}
${pts(h.team, h.pit)}

${bullpenSection}

${fatigueSection}

STATCAST AVANZADO (Baseball Savant ${new Date().getFullYear()}):
${fmtSavant(aSavant, aName)}
${fmtSavant(hSavant, hName)}

FANGRAPHS AVANZADO (${new Date().getFullYear()}, pitchers calificados):
${fmtFangraphs(aFG, aName)}
${fmtFangraphs(hFG, hName)}

MÉTRICAS DERIVADAS (calculadas de MLB Stats API):
${fmtDerived(a.ps, aName)}
${fmtDerived(h.ps, hName)}

${platoonSection}

${matchupSection}

${oddsSection}

REGLAS PARA RUN LINE:
Si el bullpen del equipo favorito tiene ERA > 4.50 → añade "⚠️ Bullpen frágil — riesgo Run Line" en el campo razon del pick de Run Line correspondiente.

REGLAS PARA PICKS DE TOTAL (OVER/UNDER):
Evalúa estos 4 factores antes de asignar señal a un Total:
  1. xERA confirma ERA real de AMBOS pitchers (diferencia < 1.0 en cada uno)
  2. Clima sin viento superior a 20 km/h, o estadio con techo
  3. Lineup confirmado de ambos equipos (no vacío en MATCHUPS INDIVIDUALES)
  4. Convergencia entre Statcast de bateadores (xwOBA, barrel%) y el perfil del pitcher rival
Reporta el conteo estructurado en totalCarreras.factores con enteros que sumen exactamente 4: cumplidos, parciales y noCumplidos. Al explicarlo en razon usa EXACTAMENTE el formato "X cumplidos · Y parciales · Z no cumplidos". Un factor parcialmente cumplido NO cuenta como cumplido.
Aplica la REGLA DE MARGEN MÍNIMO DE PROYECCIÓN usando la línea real de LÍNEAS DE MERCADO:
- Si |proyección − línea| < 1.5 carreras, usa OBLIGATORIAMENTE "BAJO", sin importar cuántos factores se cumplan, e incluye textualmente en razon: "⚠️ Margen insuficiente — proyección dentro del rango de error del modelo vs línea de mercado".
- Si |proyección − línea| >= 1.5 y se cumplen 4 de 4 factores, usa "ALTO"; el servidor lo mostrará como SEÑAL ALTA.
- Si |proyección − línea| >= 1.5 y se cumplen 3 de 4 factores, usa "MEDIO"; el servidor lo mostrará como SEÑAL MEDIA.
- Si |proyección − línea| >= 1.5 y se cumplen 0, 1 o 2 factores, usa "BAJO" e incluye textualmente en razon: "⚠️ Total con incertidumbre alta — no recomendado para parlay. Este pick es referencial — la estrategia óptima del sistema favorece Props de pitchers y Moneylines correlacionados sobre Totales con incertidumbre".
El límite exacto de 1.5 carreras sí cuenta como margen suficiente. El servidor recalcula el spread y la señal de forma autoritaria; no inventes una línea ausente.

REGLA DE CUOTAS EXACTAS (obligatoria):
Usa únicamente cuotas que aparezcan textualmente en LÍNEAS DE MERCADO, para el MISMO lado y la MISMA línea. NUNCA inventes, estimes, promedies ni derives la cuota del lado contrario (la cuota de Vis -1.5 NO es la de Vis +1.5 ni la de Loc +1.5 — son mercados distintos). Escribe los picks sin cuota en el texto: "Equipo +1.5" o "Under 8.5" (el servidor adjunta la cuota real verificada). Si recomiendas un lado cuya cuota NO está listada, di "cuota no disponible" en la razón y NO lo marques VALOR ALTO. Para Props NO existe línea de mercado en los datos enviados a este prompt: nunca escribas una línea numérica ni una cuota estimada. Ningún prop se vuelve pick oficial sin línea y cuota verificadas. Los ángulos de strikeouts de ABRIDORES se validan posteriormente en el Radar de Ponches; puedes recomendarlos como componente estratégico sin point ni cuota, pero no debes convertirlos aquí en un pick Prop oficial.

REGLA DE SOPORTE OFENSIVO:
Si el pitcher abridor tiene métricas dominantes (xERA bajo, K/9 alto) PERO su equipo tiene ofensiva débil en temporada (OPS por debajo de .700 o entre los peores del partido), NO asumas automáticamente que el dominio del pitcher se traduce en victoria del equipo. Separa el análisis: "el pitcher puede ganar el duelo individual" vs "el equipo puede ganar el partido". En estos casos, el Moneyline del equipo con el pitcher dominante debe bajar de confianza si su ofensiva no respalda, incluso si el pitcheo se ve favorable.

REGLA DE CORRELACIÓN PITCHER DOMINANTE:
Si un mismo abridor presenta simultáneamente xERA bajo, Whiff% alto y K/9 alto en los datos del duelo, y el Moneyline de su equipo también queda respaldado después de aplicar la REGLA DE SOPORTE OFENSIVO, prioriza recomendar la combinación correlacionada Moneyline del equipo + Over Ks del mismo pitcher sobre un Total incierto o sobre ambos picks presentados como ángulos independientes.
Incluye en factoresClave: "Parlay correlacionado prioritario: [Equipo] Moneyline + Over Ks de [Pitcher] — validar línea y cuota en Radar de Ponches".
No inventes point ni cuota del Over Ks y no lo agregues como pick Prop oficial desde este prompt. Si la ofensiva no respalda el Moneyline, no fuerces la correlación: conserva únicamente el ángulo de ponches para revisión en el Radar.

PROBABILIDAD Y VALOR:
Emite tu probabilidad de victoria del equipo LOCAL como número 0-100 en el campo probLocal (obligatorio). Sé honesto: si el partido es parejo, di 50-55, no exageres. El valor esperado contra el mercado se calcula fuera del modelo con tu probLocal — NO calcules EV tú mismo ni inventes probabilidades de mercado. Usa LÍNEAS DE MERCADO solo como referencia de qué espera el consenso: si tu lectura difiere mucho del mercado, explica POR QUÉ en factoresClave (el mercado suele tener razón).

REGLA DE COHERENCIA CON MERCADO OFICIAL:
La tarjeta estructurada del servidor es la ÚNICA fuente oficial de cuota, probabilidad sin vig y EV. No inventes cuotas, no recalcules EV, y no presentes probabilidad implícita bruta como si fuera probabilidad sin vig (son números distintos salvo mercados simétricos). Si hablas del mercado, hazlo en términos generales o citando textualmente los valores de LÍNEAS DE MERCADO. Con edge pequeño usa lenguaje moderado ("ventaja moderada identificada por el modelo") — nunca "valor claro", "apuesta obligada" ni equivalentes.

REGLA DE TOTAL PROYECTADO VS LÍNEA REAL:
totalCarreras.proyectado es TU proyección de carreras esperadas del juego — un número tuyo, derivado del análisis. NO es la línea del sportsbook: la línea real solo existe en LÍNEAS DE MERCADO y la verifica el servidor. Repite el mismo número en estimado (compatibilidad). Nunca copies la línea del mercado como proyección ni presentes tu proyección como si fuera la línea real. La señal Over/Under contra la línea real verificada la construye el servidor, no tú.

REGLA DE MUESTRA PEQUEÑA DEL PITCHER:
Si un pitcher tiene menos de 30 IP en la temporada, aplica una regresión a la media del 40% antes de usar métricas extremas como xERA, FIP o Hard Hit% para evaluar Moneyline, Run Line o Total.
La regresión reduce en 40% la distancia entre la métrica observada y una referencia neutral:
métrica ajustada = media de referencia + 0.60 × (métrica observada − media de referencia).
NO multipliques directamente la métrica por 0.60, porque eso puede mejorar artificialmente métricas donde un número bajo es favorable. Si no existe una media verificable en los datos, no inventes una cifra ajustada: concede únicamente 60% del peso analítico a esa métrica.
Incluye textualmente en factoresClave y en cualquier razón que dependa de ese pitcher: "MUESTRA PEQUEÑA — métricas con baja confianza estadística".
Exactamente 30 IP no activa esta penalización. IP ausente se trata como confianza desconocida, nunca como muestra suficiente.

REGLAS DE DIRECCIÓN ERA vs xERA/FIP (obligatorias, no las inviertas):
- xERA MENOR que ERA = los resultados reales fueron PEORES que el proceso → posible MEJORA futura del ERA.
- xERA MAYOR que ERA = los resultados reales fueron MEJORES que el proceso → posible DETERIORO futuro.
- FIP MENOR que ERA → posible mejora. FIP MAYOR que ERA → posible deterioro.
- Diferencias pequeñas (menos de ~0.50) NO justifican conclusiones fuertes.
- Si xERA, FIP y xFIP apuntan en direcciones distintas, di "señales mixtas" — no elijas la que convenga a tu narrativa.
- Con muestras pequeñas (pocas aperturas o IP), etiqueta toda conclusión de regresión como baja confianza.

REGLAS DE INTERPRETACIÓN LOB%:
- LOB% bajo (<~68%) PUEDE sugerir mejora futura si se normaliza — es una posibilidad, no garantía, y NUNCA una razón automática de empeoramiento del ERA.
- LOB% alto (>~78%) sugiere riesgo de regresión negativa del ERA.
- Un K% alto puede sostener PARCIALMENTE un LOB% alto, pero no lo vuelve sostenible en automático.
- En muestras pequeñas usa lenguaje cauteloso ("podría regresar"), jamás afirmes la regresión como certeza.

REGLA ANTI-RANKINGS:
PROHIBIDO afirmar posiciones de liga que los datos no incluyen: "lidera MLB", "lidera la liga", "mejor de la liga", "número uno", "top 5", "top 10" o similares. Este análisis NO recibe rankings calculados. Describe con el valor real: "K/9 de élite (11.2)", "perfil de ponches fuerte", "métrica destacada entre los datos del duelo".

Considera: ventaja de local, duelo de pitchers, matchup de bateadores vs pitcher titular, toros del bullpen. Al interpretar métricas: xERA y FIP miden el proceso independiente de suerte y defensa (la dirección de la regresión está en REGLAS DE DIRECCIÓN — respétala); xFIP normaliza la tasa de HR al 10.5% de fly balls (xFIP < FIP = la tasa de HR regresará a la media); BABIP alto con LOB% bajo PUEDE indicar mala suerte defensiva o situacional (ver REGLAS DE INTERPRETACIÓN LOB%); GB% alto reduce HR permitidos y favorece al pitcher en estadios grandes; barrel rate y exit velo miden calidad de contacto permitido; whiff% y K% miden dominancia; xwOBA es el indicador más predictivo de producción ofensiva futura; K/BB > 3.0 indica control élite. Responde ÚNICAMENTE JSON sin markdown ni texto extra:
{"resumen":"2 oraciones contexto clave","ventajaPitcheo":"VISITANTE|LOCAL|EQUILIBRADO","ventajaPitcheoTexto":"breve","ventajaOfensiva":"VISITANTE|LOCAL|EQUILIBRADO","ventajaOfensivaTexto":"breve","factoresClave":["f1","f2","f3"],"prediccion":{"ganador":"nombre equipo","probLocal":55,"confianza":"ALTA|MEDIA|BAJA","razon":"razón"},"totalCarreras":{"proyectado":"8.9","estimado":"8.9","recomendacion":"OVER|UNDER","factores":{"cumplidos":4,"parciales":0,"noCumplidos":0},"razon":"razón"},"picks":[{"tipo":"Moneyline|Run Line|Total|Prop","pick":"descripción del pick","valor":"ALTO|MEDIO|BAJO","razon":"por qué tiene valor","riesgo":"BAJO|MEDIO|ALTO"}],"calificacionGeneral":7}`;

  try {
    console.log("Modelo enviado a Anthropic:", MODEL);
    console.log(`[Statcast]  ${aName}:`, aSavant ? "encontrado" : "sin datos");
    console.log(`[Statcast]  ${hName}:`, hSavant ? "encontrado" : "sin datos");
    console.log(`[FanGraphs] ${aName}:`, aFG     ? "encontrado" : "sin datos");
    console.log(`[FanGraphs] ${hName}:`, hFG     ? "encontrado" : "sin datos");

    const message = await client.messages.create({
      model:       MODEL,
      max_tokens:  4096,
      temperature: 0,
      messages:    [{ role: "user", content: prompt }],
    });

    const txt = message.content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");

    const analysis = JSON.parse(txt.replace(/```json|```/g, "").trim());
    /* Punto de integración para una selección explícita futura. Esta lista es
       propiedad del servidor y NO se alimenta del LLM ni del Batter Radar. */
    const selectedPropCandidates = [];

    /* ── Verificación de picks contra el snapshot de odds (en código):
       RL/Total solo con cuota exacta del mismo lado; props → "para revisar" ── */
    analysis.picks = verifyPicks(analysis.picks, oddsGame, h.team.name, a.team.name);
    analysis.totalCarreras = sanitizeTotalNarrative(analysis.totalCarreras);
    /* Compatibilidad: proyectado (nuevo, .5) y estimado (legado) se espejan */
    if (analysis.totalCarreras) {
      analysis.totalCarreras.proyectado ??= analysis.totalCarreras.estimado ?? null;
      analysis.totalCarreras.estimado   ??= analysis.totalCarreras.proyectado ?? null;
    }
    /* Línea de mercado autoritaria (totals.point del snapshot) — la narrativa
       no puede citar otra línea; null sin crash cuando no hay totals. */
    analysis.totalCarreras = attachMarketTotalLine(analysis.totalCarreras, oddsGame);
    /* La dirección del total la dictan proyectado vs lineaMercado (recién
       inyectada); un pick de Total contradictorio deja de ser recomendación
       activa (SEÑAL NO OFICIAL, conservado como auditoría) */
    const dirFix = enforceTotalDirection(analysis.totalCarreras, analysis.picks);
    analysis.totalCarreras = dirFix.totalCarreras;
    analysis.picks = dirFix.picks;
    /* El signo anterior fija la dirección; ahora el spread absoluto y el
       conteo estructurado 4/4 fijan autoritariamente la intensidad. */
    const marginFix = enforceTotalProjectionMargin(analysis.totalCarreras, analysis.picks);
    analysis.totalCarreras = marginFix.totalCarreras;
    analysis.picks = marginFix.picks;
    /* Rankings no verificados, hype financiero y comparaciones métricas
       contradictorias fuera de TODA la narrativa */
    sanitizeNarratives(analysis);

    /* ── EV calculado en código (no por el LLM) ─────────────────── */
    const mkt = marketProbs(oddsGame, h.team.name, a.team.name);
    /* Validación: probabilidad numérica en [0,100]; extremos <1% o >99% son
       sospechosos en MLB (nadie es 99% en beisbol) → se acotan y se advierte. */
    const rawProb = Number(analysis.prediccion?.probLocal);
    let llmProbHome = Number.isFinite(rawProb) && rawProb >= 0 && rawProb <= 100 ? rawProb / 100 : null;
    if (llmProbHome != null && (llmProbHome < 0.01 || llmProbHome > 0.99)) {
      console.warn(`[Prob] probLocal extrema (${rawProb}) — acotada a [1,99]`);
      llmProbHome = Math.min(0.99, Math.max(0.01, llmProbHome));
    }
    if (llmProbHome == null) {
      console.warn(`[Prob] probLocal inválida o ausente: ${JSON.stringify(analysis.prediccion?.probLocal)}`);
    }

    let mercado = null;
    if (mkt) {
      const winner     = analysis.prediccion?.ganador ?? "";
      const winnerIsHome = winner === h.team.name ||
        (winner && !winner.includes(a.team.name) && h.team.name.includes(winner));
      const pModelo  = llmProbHome != null ? (winnerIsHome ? llmProbHome : 1 - llmProbHome) : null;
      const pMercado = winnerIsHome ? mkt.home : mkt.away;
      mercado = {
        book:               mkt.book,
        probMercadoLocal:   Math.round(mkt.home * 1000) / 10,
        probMercadoVisitante: Math.round(mkt.away * 1000) / 10,
        probModeloLocal:    llmProbHome != null ? Math.round(llmProbHome * 1000) / 10 : null,
        evGanadorPct:       pModelo != null ? Math.round((pModelo - pMercado) * 1000) / 10 : null,
      };
    }
    analysis.mercado = mercado;
    /* ML con EV del servidor ≤ 0 jamás sale como pick de valor — requiere
       mercado ya calculado, por eso vive AQUÍ y no dentro de verifyPicks */
    analysis.picks = enforceMlValueConsistency(analysis.picks, mercado, h.team.name, a.team.name);
    analysis.picks = appendMlAbstention(analysis.picks, mercado);
    /* Ninguna narrativa final conserva "implícita": coincide con la sin vig
       del snapshot → se re-etiqueta; no coincide → frase genérica. También
       requiere mercado ya calculado, por eso vive aquí y no en sanitizeNarratives */
    relabelImpliedNoVigNarratives(analysis, mercado);
    analysis.bullpen = (hFatigue || aFatigue)
      ? { home: hFatigue, away: aFatigue }
      : null;

    /* ── Snapshot unificado de props por evento: bateadores + ponches.
       Es la única fuente de líneas/cuotas para ambos Radares. Se congela
       para el hook oficial existente, pero no convierte sugerencias en picks. */
    let propsSnapshot = null;
    let frozenPropsJson = null;
    try {
      if (oddsGame?.id) {
        propsSnapshot = await fetchEventRadarProps({
          eventId: oddsGame.id,
          apiKey: process.env.ODDS_API_KEY,
        });
        if (propsSnapshot) {
          frozenPropsJson = freezePropsSnapshot(propsSnapshot, { eventId: oddsGame.id });
        }
      }
    } catch (propsErr) {
      console.error("[RadarProps] Error:", propsErr.message);
    }

    /* ── Radar de Ponches: informativo, calculado en código con game logs
       reales. NO entra al prompt (cero cambio de modelo), ni a ROI/CLV. ── */
    try {
      /* K% ofensivo del rival: SO/PA de team hitting (normalizado por PA).
         El perfil Savant por equipo no es usable: su CSV no trae team_id. */
      const teamKPct = (hit) => {
        const so = Number(hit?.strikeOuts), pa = Number(hit?.plateAppearances);
        return Number.isFinite(so) && Number.isFinite(pa) && pa > 0
          ? Math.round((so / pa) * 1000) / 10
          : null;
      };
      const [aRadar, hRadar] = await Promise.all([
        a.prob?.id ? getStrikeoutRadar({
          pitcherId: a.prob.id, name: aName, seasonStats: a.ps,
          savantRow: aSavant, fgRow: aFG, oddsGame: propsSnapshot ?? oddsGame,
          rival: { teamName: h.team.name, kPct: teamKPct(h.hit), lineupConfirmed: hOrder.length > 0 },
        }) : Promise.resolve(null),
        h.prob?.id ? getStrikeoutRadar({
          pitcherId: h.prob.id, name: hName, seasonStats: h.ps,
          savantRow: hSavant, fgRow: hFG, oddsGame: propsSnapshot ?? oddsGame,
          rival: { teamName: a.team.name, kPct: teamKPct(a.hit), lineupConfirmed: aOrder.length > 0 },
        }) : Promise.resolve(null),
      ]);
      analysis.radar = (aRadar || hRadar) ? { away: aRadar, home: hRadar } : null;
    } catch (radarErr) {
      console.error("[Radar] Error:", radarErr.message);
      analysis.radar = null;
    }

    /* ── Batter Props Radar v1: informativo, desde lineup confirmado y game
       logs reales. NO entra al prompt, no consulta props/odds, no crea picks
       oficiales, no calcula EV ni participa en ROI/CLV. ── */
    try {
      analysis.batterRadar = await buildBatterRadar({
        awayTeamName: a.team.name,
        homeTeamName: h.team.name,
        awayOrder: aOrder,
        homeOrder: hOrder,
        awayPlayers: aPlayers,
        homePlayers: hPlayers,
        savantMap: batterMap,
        getStatcastProfile: getBatterStatcastProfile,
        asOfISO: gameDate ?? new Date().toISOString(),
        season,
        maxCardsPerTeam: 4,
      });
    } catch (batterRadarErr) {
      console.error("[BatterRadar] Error:", batterRadarErr.message);
      analysis.batterRadar = {
        status: "NO_DISPONIBLE",
        away: { teamName: a.team.name, lineupConfirmed: aOrder.length > 0, cards: [] },
        home: { teamName: h.team.name, lineupConfirmed: hOrder.length > 0, cards: [] },
        nota: "Batter Radar no disponible; no se inventan jugadores ni mercados.",
      };
    }

    if (analysis.batterRadar && propsSnapshot) {
      analysis.batterRadar = verifyBatterRadarLines(analysis.batterRadar, propsSnapshot);
    }

    /* Sugerencias calculadas en servidor y congeladas en output_json.
       Nunca se insertan automáticamente ni alimentan selectedPropCandidates;
       la UI puede persistir una selección explícita como "Prop sugerido". */
    analysis.suggestedPicks = buildRadarSuggestedPicks({
      batterRadar: analysis.batterRadar,
      radar: analysis.radar,
    });

    /* ── Registro para backtest (ver docs/BACKTEST_METHODOLOGY.md) ── */
    try {
      const logResult = insertAnalysisLog({
        game_pk:          gamePk ?? null,
        game_date:        gameDate ?? null,
        home_team:        h.team.name,
        away_team:        a.team.name,
        logic_version:    LOGIC_VERSION,
        model:            MODEL,
        retro,
        data_quality:     Math.round(dataQuality * 100) / 100,
        sections_json:    JSON.stringify(sections),
        odds_json:        oddsGame ? JSON.stringify(oddsGame) : null,
        odds_fetched_at:  oddsGame ? getOddsFetchedAt() : null,
        market_prob_home: mkt?.home ?? null,
        market_prob_away: mkt?.away ?? null,
        llm_prob_home:    llmProbHome,
        predicted_winner: analysis.prediccion?.ganador ?? null,
        confianza:        analysis.prediccion?.confianza ?? null,
        calificacion:     analysis.calificacionGeneral ?? null,
        total_estimado:   analysis.totalCarreras?.estimado ?? analysis.totalCarreras?.proyectado ?? null,
        total_reco:       analysis.totalCarreras?.recomendacion ?? null,
        ev_pct:           mercado?.evGanadorPct ?? null,
        context_json:     JSON.stringify({
          homeRec: h.rec ?? null, awayRec: a.rec ?? null, venue: venue ?? null,
          bullpenFatigue: { home: hFatigue, away: aFatigue },
        }),
        output_json:      JSON.stringify(analysis),
      });
      const analysisId = Number(logResult.lastInsertRowid);
      analysis.analysisId = analysisId;

      /* Hook Fase 1: solo persiste candidatos marcados selected:true por un
         selector explícito del servidor. La colección está vacía por defecto;
         nunca convierte automáticamente el radar o el output del LLM. */
      const officialPropPickIds = insertSelectedPropCandidates({
        candidates: selectedPropCandidates,
        propsSnapshot,
        propsJson: frozenPropsJson,
        analysisId,
        fecha: gameDate ? String(gameDate).slice(0, 10) : new Date().toISOString().slice(0, 10),
        partido: `${a.team.name} @ ${h.team.name}`,
        insertPickFn: insertPick,
      });
      if (officialPropPickIds.length) analysis.officialPropPickIds = officialPropPickIds;
    } catch (logErr) {
      console.error("[Log] Error registrando análisis:", logErr.message);
    }

    res.json(analysis);
  } catch (err) {
    console.error("Error llamando a Anthropic:", err.message);
    res.status(500).json({ error: true });
  }
});

/* ─── Picks / Historial endpoints ───────────────────────────────── */
app.get("/api/picks", (_req, res) => {
  try {
    res.json(getAllPicks());
  } catch (err) {
    console.error("Error leyendo picks:", err.message);
    res.status(500).json({ error: true });
  }
});

app.post("/api/picks", (req, res) => {
  const { fecha, partido, tipo, pick, valor, riesgo, analysis_id = null } = req.body;
  if (!fecha || !partido || !tipo || !pick) {
    return res.status(400).json({ error: "Faltan campos requeridos." });
  }
  try {
    const result = insertPick({ fecha, partido, tipo, pick, valor, riesgo, analysis_id });
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch (err) {
    console.error("Error insertando pick:", err.message);
    res.status(500).json({ error: true });
  }
});

app.patch("/api/picks/:id", (req, res) => {
  const id        = Number(req.params.id);
  const { resultado } = req.body;
  const valid = [null, "ganó", "perdió", "push", "void"];
  if (!valid.includes(resultado)) {
    return res.status(400).json({ error: "resultado debe ser null, 'ganó', 'perdió', 'push' o 'void'." });
  }
  try {
    updateResultado(id, resultado);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error actualizando resultado:", err.message);
    res.status(500).json({ error: true });
  }
});

/* Evaluación Moneyball: métricas separadas y auditables (solo lectura).
   DEBE registrarse antes del catch-all o devolvería index.html. */
app.get("/api/evaluation", (_req, res) => {
  try {
    res.json(buildEvaluation({ picks: getAllPicks(), analyses: getAllAnalyses() }));
  } catch (err) {
    console.error("Error en /api/evaluation:", err.message);
    res.status(500).json({ error: "No se pudo calcular la evaluación." });
  }
});

/* Catch-all: serve React app for any non-API route */
app.get("/{*path}", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

/* Warm up caches on boot */
Promise.all([getSavantMap(), getSavantBatterMap(), getStandingsMap(), getFangraphsMap(), getPlayerTeamMap()]);

app.listen(3001, () => {
  console.log("Diamond Edge server corriendo en http://localhost:3001");
});
