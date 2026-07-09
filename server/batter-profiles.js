/*
 * Perfiles ofensivos Statcast por equipo.
 *
 * El CSV de Baseball Savant NO trae team_id (solo player_id), así que la
 * agrupación por equipo usa un mapa verificable player_id → currentTeam.id
 * construido desde MLB Stats API (/sports/1/players, un solo call, cache 24h).
 *
 * Promedios ponderados por PA (peso 1 si pa falta o es inválido), con
 * acumulador de peso POR MÉTRICA: una métrica ausente en un bateador no
 * arrastra el peso de las demás. Bateador sin equipo verificable se excluye.
 *
 * Limitación documentada: currentTeam es "hoy" — un jugador traspasado
 * arrastra sus stats de temporada al equipo nuevo (sesgo pequeño).
 */

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

export const BATTER_FIELDS = [
  "xwoba", "barrel_batted_rate", "hard_hit_percent",
  "whiff_percent", "k_percent", "bb_percent", "exit_velocity_avg",
];

export const BATTER_PLAYER_STATCAST_FIELDS = [
  "xba", "xwoba", "barrelPct", "hardHitPct", "exitVelo",
  "launchAngle", "kPct", "bbPct", "whiffPct",
];

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function normalizeBatterName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9, ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameCandidates(row) {
  const raw = [
    row?.name,
    row?.player_name,
    row?.batter_name,
    row?.["last_name, first_name"],
    row?.last_name && row?.first_name ? `${row.first_name} ${row.last_name}` : null,
  ].filter(Boolean);
  const out = new Set();
  for (const name of raw) {
    const n = normalizeBatterName(name);
    if (!n) continue;
    out.add(n);
    if (n.includes(",")) {
      const [last, first] = n.split(",").map(p => p.trim()).filter(Boolean);
      if (first && last) {
        out.add(`${first} ${last}`);
        out.add(`${last} ${first}`);
      }
    }
  }
  return out;
}

function rowValue(row, ...keys) {
  for (const key of keys) {
    const v = num(row?.[key]);
    if (v != null) return v;
  }
  return null;
}

function rowsFromSavant(savant) {
  if (!savant) return [];
  if (savant instanceof Map) return [...savant.values()];
  if (Array.isArray(savant)) return savant;
  if (typeof savant === "object") return Object.values(savant);
  return [];
}

export function normalizeBatterStatcastRow(row) {
  if (!row) return null;
  return {
    playerId: row.player_id != null ? String(row.player_id) : null,
    name: row.name ?? row.player_name ?? row.batter_name ?? row["last_name, first_name"] ?? null,
    xba: rowValue(row, "xba", "expected_batting_avg", "batting_avg"),
    xwoba: rowValue(row, "xwoba"),
    barrelPct: rowValue(row, "barrel_batted_rate", "barrel_percent", "barrelPct"),
    hardHitPct: rowValue(row, "hard_hit_percent", "hardHitPct"),
    exitVelo: rowValue(row, "exit_velocity_avg", "exitVelo"),
    launchAngle: rowValue(row, "launch_angle", "launch_angle_avg", "launchAngle"),
    kPct: rowValue(row, "k_percent", "kPct"),
    bbPct: rowValue(row, "bb_percent", "bbPct"),
    whiffPct: rowValue(row, "whiff_percent", "whiffPct"),
  };
}

export function findBatterStatcastRow(savant, { playerId = null, name = null } = {}) {
  const rows = rowsFromSavant(savant);
  if (!rows.length) return null;

  if (playerId != null) {
    const id = String(playerId);
    const match = rows.find(row => String(row?.player_id ?? "") === id);
    if (match) return match;
  }

  const wanted = normalizeBatterName(name);
  if (!wanted) return null;
  return rows.find(row => nameCandidates(row).has(wanted)) ?? null;
}

export function getBatterStatcastProfile(savant, { playerId = null, name = null } = {}) {
  return normalizeBatterStatcastRow(findBatterStatcastRow(savant, { playerId, name }));
}

/* ── Mapa jugador → equipo (cache 24h) ───────────────────────────── */
const TEAM_MAP_TTL_MS = 24 * 60 * 60 * 1000;
let playerTeamCache = { map: null, fetchedAt: 0 };

export async function getPlayerTeamMap(fetcher = fetch) {
  const now = Date.now();
  if (playerTeamCache.map && now - playerTeamCache.fetchedAt < TEAM_MAP_TTL_MS) {
    return playerTeamCache.map;
  }
  try {
    const season = new Date().getFullYear();
    const r = await fetcher(`${MLB_BASE}/sports/1/players?season=${season}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const people = d?.people;
    if (!Array.isArray(people)) throw new Error("estructura inesperada (sin people[])");
    const map = new Map();
    for (const p of people) {
      if (p?.id != null && p?.currentTeam?.id != null) {
        map.set(String(p.id), String(p.currentTeam.id));
      }
    }
    playerTeamCache = { map, fetchedAt: now };
    console.log(`[PlayerTeam] Mapa jugador→equipo cargado: ${map.size} jugadores`);
    return map;
  } catch (err) {
    console.error("[PlayerTeam] Error:", err.message);
    /* Fallback seguro: mapa viejo si existe, si no vacío — sin crash */
    return playerTeamCache.map ?? new Map();
  }
}

/* ── Perfiles por equipo (puro) ──────────────────────────────────── */

/**
 * @param savantMap  Map<player_id, rowCSV> del leaderboard de bateadores
 * @param playerTeamMap Map<String(player_id), String(team_id)>
 * @returns { profiles: Map<team_id, {métrica: promedio}>, meta }
 */
export function buildBatterProfiles(savantMap, playerTeamMap) {
  const empty = {
    profiles: new Map(),
    meta: { source: "mlb_current_team", eligiblePlayers: savantMap?.size ?? 0, matchedPlayers: 0, coverage: 0 },
  };
  if (!savantMap?.size || !playerTeamMap?.size) return empty;

  const teams = new Map(); // tid → { sums: {f}, weights: {f} }
  let matched = 0;

  for (const row of savantMap.values()) {
    const tid = playerTeamMap.get(String(row.player_id));
    if (!tid) continue;                       // sin equipo verificable → fuera
    matched++;

    const paRaw = parseFloat(row.pa);
    const weight = Number.isFinite(paRaw) && paRaw > 0 ? paRaw : 1;  // pa inválido → peso 1

    if (!teams.has(tid)) {
      teams.set(tid, {
        sums:    Object.fromEntries(BATTER_FIELDS.map(f => [f, 0])),
        weights: Object.fromEntries(BATTER_FIELDS.map(f => [f, 0])),
      });
    }
    const entry = teams.get(tid);
    for (const f of BATTER_FIELDS) {
      const v = parseFloat(row[f]);
      if (Number.isFinite(v)) {               // métrica ausente no contamina
        entry.sums[f]    += v * weight;
        entry.weights[f] += weight;           // peso POR MÉTRICA
      }
    }
  }

  const profiles = new Map();
  for (const [tid, { sums, weights }] of teams) {
    const profile = {};
    let any = false;
    for (const f of BATTER_FIELDS) {
      if (weights[f] > 0) { profile[f] = sums[f] / weights[f]; any = true; }
    }
    if (any) profiles.set(tid, profile);
  }

  const eligible = savantMap.size;
  return {
    profiles,
    meta: {
      source: "mlb_current_team",
      eligiblePlayers: eligible,
      matchedPlayers: matched,
      coverage: eligible ? Math.round((matched / eligible) * 100) / 100 : 0,
    },
  };
}

export function fmtBatterTeam(profile, teamName) {
  if (!profile) return `${teamName}: sin datos Statcast de bateadores`;
  const p1 = (f) => (profile[f] != null ? profile[f].toFixed(1) : "–");
  const p3 = (f) => (profile[f] != null ? profile[f].toFixed(3) : "–");
  return (
    `${teamName}: xwOBA ${p3("xwoba")} | ` +
    `Barrel% ${p1("barrel_batted_rate")} | ` +
    `Hard Hit% ${p1("hard_hit_percent")} | ` +
    `Exit Velo ${p1("exit_velocity_avg")} mph | ` +
    `K% ${p1("k_percent")} | ` +
    `BB% ${p1("bb_percent")}`
  );
}

/** Nota de cobertura para el encabezado de la sección (una sola vez). */
export function fmtBatterCoverage(meta) {
  if (!meta || !meta.matchedPlayers) return "";
  return ` — ${meta.matchedPlayers}/${meta.eligiblePlayers} bateadores mapeados (${Math.round(meta.coverage * 100)}%, fuente ${meta.source}, ponderado por PA)`;
}
