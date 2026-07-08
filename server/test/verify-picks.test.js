import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPick, verifyPicks } from "../verify-picks.js";

const HOME = "Texas Rangers";
const AWAY = "Detroit Tigers";

/** Snapshot con mercados configurables. */
const mkOdds = ({ spreads = null, totals = null } = {}) => ({
  home_team: HOME, away_team: AWAY,
  bookmakers: [{
    key: "fanduel", title: "FanDuel", last_update: "2026-07-02T18:00:00Z",
    markets: [
      { key: "h2h", outcomes: [{ name: HOME, price: -110 }, { name: AWAY, price: -110 }] },
      ...(spreads ? [{ key: "spreads", outcomes: spreads }] : []),
      ...(totals  ? [{ key: "totals",  outcomes: totals  }] : []),
    ],
  }],
});

/* ═══ 1. RUN LINE: prohibido invertir el signo conservando la cuota ═══ */

test("RL invertido (BUG original): solo existe Vis -1.5 → pedir Vis +1.5 NUNCA hereda esa cuota", () => {
  // El snapshot solo tiene Tigers -1.5 (-152) y Rangers +1.5 (+126)... no:
  // reproducimos el caso reportado — solo el lado -1.5 del visitante listado.
  const odds = mkOdds({ spreads: [{ name: AWAY, price: -152, point: -1.5 }] });
  const pick = { tipo: "Run Line", pick: "Detroit Tigers +1.5", valor: "ALTO", razon: "x" };
  const v = verifyPick(pick, odds, HOME, AWAY);
  assert.equal(v.verificado, false);
  assert.equal(v.cuotaReal, null, "jamás debe heredar -152 (ni +152) del lado -1.5");
  assert.equal(v.valor, "SIN CUOTA", "sin cuota exacta no hay clasificación financiera");
  assert.match(v.razon, /no verificada/);
});

test("RL correcto: el lado exacto existe → usa SU cuota, no la del contrario", () => {
  const odds = mkOdds({ spreads: [
    { name: AWAY, price: -152, point: -1.5 },
    { name: HOME, price: +126, point: +1.5 },
  ]});
  const vAway = verifyPick({ tipo: "Run Line", pick: "Detroit Tigers -1.5", valor: "MEDIO", razon: "x" }, odds, HOME, AWAY);
  assert.equal(vAway.verificado, true);
  assert.equal(vAway.cuotaReal, -152);
  const vHome = verifyPick({ tipo: "Run Line", pick: "Texas Rangers +1.5", valor: "MEDIO", razon: "x" }, odds, HOME, AWAY);
  assert.equal(vHome.verificado, true);
  assert.equal(vHome.cuotaReal, +126, "el lado +1.5 usa su propia cuota (+126), nunca -152");
});

test("RL con línea distinta a la listada (misma dirección) tampoco verifica", () => {
  const odds = mkOdds({ spreads: [{ name: AWAY, price: -152, point: -1.5 }] });
  const v = verifyPick({ tipo: "Run Line", pick: "Detroit Tigers -2.5", valor: "ALTO", razon: "x" }, odds, HOME, AWAY);
  assert.equal(v.verificado, false);
  assert.equal(v.cuotaReal, null);
});

test("RL sin mercado de spreads en el snapshot → SIN CUOTA", () => {
  const v = verifyPick({ tipo: "Run Line", pick: "Detroit Tigers +1.5", valor: "ALTO", razon: "x" }, mkOdds(), HOME, AWAY);
  assert.equal(v.verificado, false);
  assert.equal(v.valor, "SIN CUOTA");
});

/* ═══ 2. PROPS: sin línea real jamás son picks oficiales ═══ */

test("Prop → 'Prop para revisar', sin cuota, sin valor financiero, con disclaimer", () => {
  const pick = { tipo: "Prop", pick: "Nathan Eovaldi Over strikeouts — línea de mercado estimada 5.5-6.0 K", valor: "ALTO", riesgo: "BAJO", razon: "domina el whiff%" };
  const v = verifyPick(pick, mkOdds(), HOME, AWAY);
  assert.equal(v.tipo, "Prop para revisar");
  assert.equal(v.verificado, false);
  assert.equal(v.cuotaReal, null);
  assert.equal(v.valor, "SIN VERIFICAR", "un prop sin línea real no puede tener VALOR ALTO");
  assert.match(v.razon, /Línea y cuota no verificadas\. No entra a ROI ni a la muestra oficial\./);
  assert.match(v.razon, /domina el whiff%/, "la razón original se conserva tras el disclaimer");
});

test("Prop nunca lleva EV: verifyPick no añade campos de EV y anula cuota aunque el texto traiga números", () => {
  const v = verifyPick({ tipo: "Prop", pick: "Over 6.5 K (-115)", valor: "MEDIO", razon: "x" }, mkOdds(), HOME, AWAY);
  assert.equal(v.cuotaReal, null, "el -115 del texto es invención del LLM, no del snapshot");
  assert.ok(!("ev" in v) && !("evPct" in v));
});

/* ═══ 3. TOTALES: prohibido asumir la cuota del lado contrario ═══ */

test("Total (BUG original): solo Over -102 listado → Under 7.5 NO hereda 'precio similar'", () => {
  const odds = mkOdds({ totals: [{ name: "Over", price: -102, point: 7.5 }] });
  const v = verifyPick({ tipo: "Total", pick: "Under 7.5", valor: "ALTO", razon: "pitcheo dominante" }, odds, HOME, AWAY);
  assert.equal(v.verificado, false);
  assert.equal(v.cuotaReal, null, "la cuota del Over jamás se asigna al Under");
  assert.equal(v.valor, "SIN CUOTA");
  assert.match(v.razon, /no verificada/);
});

test("Total con ambos lados: cada lado su cuota exacta", () => {
  const odds = mkOdds({ totals: [
    { name: "Over",  price: -102, point: 7.5 },
    { name: "Under", price: -118, point: 7.5 },
  ]});
  const vU = verifyPick({ tipo: "Total", pick: "Under 7.5", valor: "MEDIO", razon: "x" }, odds, HOME, AWAY);
  assert.equal(vU.verificado, true);
  assert.equal(vU.cuotaReal, -118, "Under usa -118, no el -102 del Over");
  const vO = verifyPick({ tipo: "Total", pick: "Over 7.5", valor: "MEDIO", razon: "x" }, odds, HOME, AWAY);
  assert.equal(vO.cuotaReal, -102);
});

test("Total con línea distinta a la listada no verifica", () => {
  const odds = mkOdds({ totals: [
    { name: "Over", price: -102, point: 7.5 }, { name: "Under", price: -118, point: 7.5 },
  ]});
  const v = verifyPick({ tipo: "Total", pick: "Under 8.5", valor: "ALTO", razon: "x" }, odds, HOME, AWAY);
  assert.equal(v.verificado, false);
});

/* ═══ Moneyline y lote completo ═══ */

test("Moneyline conserva sus campos y recibe cuotaReal del snapshot (badge/EV intactos)", () => {
  const pick = { tipo: "Moneyline", pick: "Texas Rangers ML", valor: "ALTO", razon: "x" };
  const v = verifyPick(pick, mkOdds(), HOME, AWAY);
  assert.deepEqual(v, { ...pick, cuotaReal: -110, verificado: true });
});

test("verifyPicks procesa el lote y sin odds todo RL/Total queda SIN CUOTA", () => {
  const picks = [
    { tipo: "Moneyline", pick: "Texas Rangers ML", valor: "ALTO", razon: "a" },
    { tipo: "Run Line",  pick: "Detroit Tigers +1.5", valor: "ALTO", razon: "b" },
    { tipo: "Total",     pick: "Under 7.5", valor: "MEDIO", razon: "c" },
    { tipo: "Prop",      pick: "Eovaldi Over Ks", valor: "ALTO", razon: "d" },
  ];
  const out = verifyPicks(picks, null, HOME, AWAY);  // sin snapshot de odds
  assert.equal(out[0].valor, "ALTO");                 // ML intacto
  assert.equal(out[1].valor, "SIN CUOTA");
  assert.equal(out[2].valor, "SIN CUOTA");
  assert.equal(out[3].tipo, "Prop para revisar");
  assert.equal(verifyPicks(null, null, HOME, AWAY), null, "picks ausentes pasan sin explotar");
});
