import express from "express";
import cors    from "cors";
import dotenv  from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "url";
import path from "path";
import { getAllPicks, insertPick, updateResultado, insertAnalysisLog } from "./db.js";
import { getBullpenFatigue, fmtBullpenFatigue } from "./bullpen.js";
import { americanToProb, devig } from "./backtest/odds-math.js";
import { verifyPicks, sanitizeTotalNarrative } from "./verify-picks.js";
import { getStrikeoutRadar } from "./radar.js";

dotenv.config();

/* Versionado de la lógica: cambiar en cada modificación del prompt o de las
   fuentes de datos, para que el backtest pueda comparar versiones entre sí.
   Historial: .1 = infraestructura inicial · .2 = match de odds por commence_time
   (dobles carteleras), clamp de probabilidad, retro desconocido = null ·
   .3 = fix cuotas inventadas: ambos lados de RL/Total en el prompt, regla de
   cuotas exactas, verificación de picks en código (verify-picks.js) ·
   .4 = sanitización financiera de razones en RL/Total/Props y separación
   cuota-verificada ≠ valor-verificado (SEÑAL en vez de VALOR sin EV). */
const LOGIC_VERSION = "2026-07-02.4";
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
    "&selections=xwoba,barrel_batted_rate,hard_hit_percent,whiff_percent,k_percent,bb_percent,exit_velocity_avg" +
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

const BATTER_FIELDS = [
  "xwoba", "barrel_batted_rate", "hard_hit_percent",
  "whiff_percent", "k_percent", "bb_percent", "exit_velocity_avg",
];

function buildBatterProfiles(map) {
  const teams = new Map();
  for (const row of map.values()) {
    const tid = row.team_id;
    if (!tid) continue;
    if (!teams.has(tid)) {
      teams.set(tid, { sums: Object.fromEntries(BATTER_FIELDS.map(f => [f, 0])), count: 0 });
    }
    const entry = teams.get(tid);
    for (const f of BATTER_FIELDS) {
      const v = parseFloat(row[f]);
      if (!isNaN(v)) entry.sums[f] += v;
    }
    entry.count++;
  }
  const profiles = new Map();
  for (const [tid, { sums, count }] of teams) {
    if (count === 0) continue;
    profiles.set(tid, Object.fromEntries(BATTER_FIELDS.map(f => [f, sums[f] / count])));
  }
  return profiles;
}

function fmtBatterTeam(profile, teamName) {
  if (!profile) return `${teamName}: sin datos Statcast de bateadores`;
  const p1 = (f) => parseFloat(profile[f]).toFixed(1);
  const p3 = (f) => parseFloat(profile[f]).toFixed(3);
  return (
    `${teamName}: xwOBA ${p3("xwoba")} | ` +
    `Barrel% ${p1("barrel_batted_rate")} | ` +
    `Hard Hit% ${p1("hard_hit_percent")} | ` +
    `Exit Velo ${p1("exit_velocity_avg")} mph | ` +
    `K% ${p1("k_percent")} | ` +
    `BB% ${p1("bb_percent")}`
  );
}

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
  const [savant, batterMap, boxscore, standingsMap, weather, hBullpen, aBullpen, fangraphsMap, aPlatoon, hPlatoon, oddsGame, hFatigue, aFatigue] = await Promise.all([
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
  ]);
  const batterProfiles = buildBatterProfiles(batterMap);
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

OFENSIVA STATCAST (por equipo, Baseball Savant ${new Date().getFullYear()}, mín 50 PA):
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
Evalúa estos 4 factores antes de asignar valor a un Total:
  1. xERA confirma ERA real de AMBOS pitchers (diferencia < 1.0 en cada uno)
  2. Clima sin viento superior a 20 km/h, o estadio con techo
  3. Lineup confirmado de ambos equipos (no vacío en MATCHUPS INDIVIDUALES)
  4. Convergencia entre Statcast de bateadores (xwOBA, barrel%) y el perfil del pitcher rival
Si se cumplen 3 o 4 factores → puedes marcar el Total como VALOR ALTO.
Si se cumplen menos de 3 → máximo VALOR MEDIO, y añade "⚠️ Total con incertidumbre alta" en el campo razon del pick.
Al reportar los factores usa EXACTAMENTE el formato "X cumplidos · Y parciales · Z no cumplidos". Un factor parcialmente cumplido NO cuenta como cumplido: solo los factores plenamente cumplidos suman para la regla de 3 (nunca describas 2 cumplidos + 1 parcial como "3 de 4 factores cumplidos").

REGLA DE CUOTAS EXACTAS (obligatoria):
Usa únicamente cuotas que aparezcan textualmente en LÍNEAS DE MERCADO, para el MISMO lado y la MISMA línea. NUNCA inventes, estimes, promedies ni derives la cuota del lado contrario (la cuota de Vis -1.5 NO es la de Vis +1.5 ni la de Loc +1.5 — son mercados distintos). Escribe los picks sin cuota en el texto: "Equipo +1.5" o "Under 8.5" (el servidor adjunta la cuota real verificada). Si recomiendas un lado cuya cuota NO está listada, di "cuota no disponible" en la razón y NO lo marques VALOR ALTO. Para Props NO existe línea de mercado en estos datos: nunca escribas una línea numérica estimada; describe el prop cualitativamente (p.ej. "Over strikeouts del abridor") y su justificación.

REGLA DE SOPORTE OFENSIVO:
Si el pitcher abridor tiene métricas dominantes (xERA bajo, K/9 alto) PERO su equipo tiene ofensiva débil en temporada (OPS por debajo de .700 o entre los peores del partido), NO asumas automáticamente que el dominio del pitcher se traduce en victoria del equipo. Separa el análisis: "el pitcher puede ganar el duelo individual" vs "el equipo puede ganar el partido". En estos casos, el Moneyline del equipo con el pitcher dominante debe bajar de confianza si su ofensiva no respalda, incluso si el pitcheo se ve favorable.

PROBABILIDAD Y VALOR:
Emite tu probabilidad de victoria del equipo LOCAL como número 0-100 en el campo probLocal (obligatorio). Sé honesto: si el partido es parejo, di 50-55, no exageres. El valor esperado contra el mercado se calcula fuera del modelo con tu probLocal — NO calcules EV tú mismo ni inventes probabilidades de mercado. Usa LÍNEAS DE MERCADO solo como referencia de qué espera el consenso: si tu lectura difiere mucho del mercado, explica POR QUÉ en factoresClave (el mercado suele tener razón).

Considera: ventaja de local, duelo de pitchers, matchup de bateadores vs pitcher titular, toros del bullpen. Al interpretar métricas: xERA vs ERA real indica suerte/regresión esperada; FIP mide rendimiento independiente de la defensa (FIP < ERA = pitcher con mala suerte); xFIP normaliza la tasa de HR al 10.5% de fly balls (xFIP < FIP = la tasa de HR regresará a la media); BABIP alto con LOB% bajo indica mala suerte defensiva o situacional; GB% alto reduce HR permitidos y favorece al pitcher en estadios grandes; barrel rate y exit velo miden calidad de contacto permitido; whiff% y K% miden dominancia; xwOBA es el indicador más predictivo de producción ofensiva futura; K/BB > 3.0 indica control élite. Responde ÚNICAMENTE JSON sin markdown ni texto extra:
{"resumen":"2 oraciones contexto clave","ventajaPitcheo":"VISITANTE|LOCAL|EQUILIBRADO","ventajaPitcheoTexto":"breve","ventajaOfensiva":"VISITANTE|LOCAL|EQUILIBRADO","ventajaOfensivaTexto":"breve","factoresClave":["f1","f2","f3"],"prediccion":{"ganador":"nombre equipo","probLocal":55,"confianza":"ALTA|MEDIA|BAJA","razon":"razón"},"totalCarreras":{"estimado":"9.5","recomendacion":"OVER|UNDER","razon":"razón"},"picks":[{"tipo":"Moneyline|Run Line|Total|Prop","pick":"descripción del pick","valor":"ALTO|MEDIO|BAJO","razon":"por qué tiene valor","riesgo":"BAJO|MEDIO|ALTO"}],"calificacionGeneral":7}`;

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

    /* ── Verificación de picks contra el snapshot de odds (en código):
       RL/Total solo con cuota exacta del mismo lado; props → "para revisar" ── */
    analysis.picks = verifyPicks(analysis.picks, oddsGame, h.team.name, a.team.name);
    analysis.totalCarreras = sanitizeTotalNarrative(analysis.totalCarreras);

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
    analysis.bullpen = (hFatigue || aFatigue)
      ? { home: hFatigue, away: aFatigue }
      : null;

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
          savantRow: aSavant, fgRow: aFG, oddsGame,
          rival: { teamName: h.team.name, kPct: teamKPct(h.hit), lineupConfirmed: hOrder.length > 0 },
        }) : Promise.resolve(null),
        h.prob?.id ? getStrikeoutRadar({
          pitcherId: h.prob.id, name: hName, seasonStats: h.ps,
          savantRow: hSavant, fgRow: hFG, oddsGame,
          rival: { teamName: a.team.name, kPct: teamKPct(a.hit), lineupConfirmed: aOrder.length > 0 },
        }) : Promise.resolve(null),
      ]);
      analysis.radar = (aRadar || hRadar) ? { away: aRadar, home: hRadar } : null;
    } catch (radarErr) {
      console.error("[Radar] Error:", radarErr.message);
      analysis.radar = null;
    }

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
        total_estimado:   analysis.totalCarreras?.estimado ?? null,
        total_reco:       analysis.totalCarreras?.recomendacion ?? null,
        ev_pct:           mercado?.evGanadorPct ?? null,
        context_json:     JSON.stringify({
          homeRec: h.rec ?? null, awayRec: a.rec ?? null, venue: venue ?? null,
          bullpenFatigue: { home: hFatigue, away: aFatigue },
        }),
        output_json:      JSON.stringify(analysis),
      });
      analysis.analysisId = Number(logResult.lastInsertRowid);
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
  const valid = [null, "ganó", "perdió"];
  if (!valid.includes(resultado)) {
    return res.status(400).json({ error: "resultado debe ser null, 'ganó' o 'perdió'." });
  }
  try {
    updateResultado(id, resultado);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error actualizando resultado:", err.message);
    res.status(500).json({ error: true });
  }
});

/* Catch-all: serve React app for any non-API route */
app.get("/{*path}", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

/* Warm up caches on boot */
Promise.all([getSavantMap(), getSavantBatterMap(), getStandingsMap(), getFangraphsMap()]);

app.listen(3001, () => {
  console.log("Diamond Edge server corriendo en http://localhost:3001");
});
