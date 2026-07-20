import { computeTotalBases } from "./batter-radar.js";
import { normPlayerName } from "./player-props.js";

const numberOrNull = (value) => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function plateAppearances(batting) {
  const official = numberOrNull(batting?.plateAppearances);
  if (official != null) return official;

  const keys = ["atBats", "baseOnBalls", "hitByPitch", "sacFlies", "sacBunts", "catcherInterferences"];
  const values = keys.map(key => numberOrNull(batting?.[key]));
  if (values.every(value => value == null)) return null;
  return values.reduce((sum, value) => sum + (value ?? 0), 0);
}

function boxscorePlayers(boxscore) {
  const away = boxscore?.teams?.away?.players;
  const home = boxscore?.teams?.home?.players;
  const valid = away && typeof away === "object" && home && typeof home === "object";
  if (!valid) return null;
  return [...Object.values(away), ...Object.values(home)].filter(Boolean);
}

function marketStat(batting, market) {
  if (market === "batter_hits") return numberOrNull(batting?.hits);
  if (market === "batter_home_runs") return numberOrNull(batting?.homeRuns);
  if (market === "batter_rbis") return numberOrNull(batting?.rbi ?? batting?.runsBattedIn);
  if (market === "batter_total_bases") {
    return computeTotalBases({
      hits: batting?.hits,
      doubles: batting?.doubles,
      triples: batting?.triples,
      homeRuns: batting?.homeRuns,
      totalBases: batting?.totalBases,
    });
  }
  return null;
}

/** Extrae una estadística oficial o clasifica el caso como DNP/dato pendiente. */
export function extractOfficialPropStat(boxscore, { player, market } = {}) {
  const players = boxscorePlayers(boxscore);
  if (!players) return { status: "pending", reason: "boxscore_incompleto" };

  const target = normPlayerName(player);
  if (!target) return { status: "pending", reason: "jugador_invalido" };
  const matches = players.filter(entry => normPlayerName(entry?.person?.fullName) === target);
  if (matches.length === 0) return { status: "void", reason: "dnp_o_scratch" };
  if (matches.length > 1) return { status: "pending", reason: "jugador_ambiguo" };

  const batting = matches[0]?.stats?.batting;
  if (!batting || Object.keys(batting).length === 0) {
    return { status: "void", reason: "sin_plate_appearance" };
  }
  const pa = plateAppearances(batting);
  if (pa === 0) return { status: "void", reason: "sin_plate_appearance" };
  if (pa == null) return { status: "pending", reason: "plate_appearances_ausente" };

  const actual = marketStat(batting, market);
  if (actual == null) return { status: "pending", reason: "estadistica_ausente" };
  return { status: "stat", actual, plateAppearances: pa };
}

/** Resuelve un prop oficial sin acceso a DB ni red. */
export function gradeOfficialProp(pick, boxscore) {
  const side = pick?.side;
  const point = numberOrNull(pick?.point);
  if (!["Over", "Under"].includes(side) || point == null) {
    return { status: "pending", reason: "linea_invalida" };
  }

  const extracted = extractOfficialPropStat(boxscore, pick);
  if (extracted.status === "pending") return extracted;
  if (extracted.status === "void") {
    return { ...extracted, resultado: "void", actual: null };
  }

  const { actual } = extracted;
  if (actual === point) {
    return { status: "settled", resultado: "push", actual, plateAppearances: extracted.plateAppearances };
  }
  const won = side === "Over" ? actual > point : actual < point;
  return {
    status: "settled",
    resultado: won ? "ganó" : "perdió",
    actual,
    plateAppearances: extracted.plateAppearances,
  };
}
