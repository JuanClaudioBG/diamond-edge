import { findBatterPropLine } from "./player-props.js";

/** Serializa una sola vez el snapshot exacto usado por este análisis. */
export function freezePropsSnapshot(propsSnapshot, { eventId, frozenAt = new Date().toISOString() } = {}) {
  if (!propsSnapshot) return null;
  return JSON.stringify({
    schemaVersion: 1,
    source: "the-odds-api",
    eventId: eventId ?? propsSnapshot.id ?? null,
    frozenAt,
    payload: propsSnapshot,
  });
}

/**
 * Hook de persistencia para props oficiales seleccionados explícitamente.
 * No deriva candidatos del radar ni del output del modelo: solo considera
 * entradas con selected === true y exige matching exacto contra el snapshot.
 */
export function insertSelectedPropCandidates({
  candidates = [],
  propsSnapshot,
  propsJson,
  analysisId,
  fecha,
  partido,
  insertPickFn,
} = {}) {
  if (!Array.isArray(candidates) || !propsSnapshot || !propsJson || typeof insertPickFn !== "function") {
    return [];
  }

  const inserted = [];
  for (const candidate of candidates) {
    if (candidate?.selected !== true) continue;

    const player = String(candidate.player ?? "").trim();
    const market = String(candidate.market ?? "").trim();
    const side = candidate.side;
    const point = Number(candidate.point);
    if (!player || !market || !["Over", "Under"].includes(side) || !Number.isFinite(point)) continue;

    const verified = findBatterPropLine(propsSnapshot, { marketKey: market, playerName: player });
    const sidePrice = side === "Over" ? verified?.overPrice : verified?.underPrice;
    if (!verified || Number(verified.line) !== point || sidePrice == null) continue;

    const result = insertPickFn({
      fecha,
      partido,
      tipo: "Prop oficial",
      pick: candidate.pick ?? `${player} ${side} ${point}`,
      valor: candidate.valor ?? null,
      riesgo: candidate.riesgo ?? null,
      analysis_id: analysisId,
      player,
      market,
      side,
      point,
      props_json: propsJson,
    });
    inserted.push(Number(result.lastInsertRowid));
  }
  return inserted;
}
