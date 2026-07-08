/*
 * Fase 3 de 2026-07-02.5 — enforcement en código de las reglas del prompt:
 * anti-rankings, hype financiero, cuota oficial en ML, línea de mercado
 * autoritaria en el total. El LLM puede desobedecer; el código no.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeUnverifiedRankings, degradeHypeLanguage, stripMismatchedOdds,
  sanitizeNarratives, attachMarketTotalLine, verifyPick,
} from "../verify-picks.js";

const HOME = "Texas Rangers";
const AWAY = "Detroit Tigers";
const mkOdds = ({ h2h = [-110, -110], totals = null } = {}) => ({
  home_team: HOME, away_team: AWAY,
  bookmakers: [{
    key: "fanduel", title: "FanDuel", last_update: "2026-07-04T18:00:00Z",
    markets: [
      { key: "h2h", outcomes: [{ name: HOME, price: h2h[0] }, { name: AWAY, price: h2h[1] }] },
      ...(totals ? [{ key: "totals", outcomes: totals }] : []),
    ],
  }],
});

/* ═══ 1. Anti-rankings ═══ */

test("anti-rankings elimina claims de liga/MLB y los reemplaza con lenguaje seguro", () => {
  assert.equal(
    sanitizeUnverifiedRankings("Skubal lidera MLB en K% y domina."),
    "Skubal presenta métricas de élite en K% y domina."
  );
  assert.equal(
    sanitizeUnverifiedRankings("Es top 5 de la liga en whiff%."),
    "Es de élite en whiff%."
  );
  assert.ok(!/top-10 de MLB/i.test(sanitizeUnverifiedRankings("Su xERA es top-10 de MLB.")));
  assert.ok(!/líder de la liga/i.test(sanitizeUnverifiedRankings("líder de la liga en ponches")));
  assert.ok(!/mejor de la MLB/i.test(sanitizeUnverifiedRankings("el mejor de la MLB en GB%")));
  assert.ok(!/número uno de la liga/i.test(sanitizeUnverifiedRankings("número uno de la liga")));
});

test("anti-rankings NO toca métricas legítimas ni rankings internos del equipo", () => {
  const legit = "K% 27.3 y K/9 11.2 con récord 7-3; es el líder del bullpen y su Whiff% 31.0 destaca. ERA 2.95, xERA 3.10, LOB% 74.";
  assert.equal(sanitizeUnverifiedRankings(legit), legit, "cero falsos positivos");
});

/* ═══ Hype financiero ═══ */

test("hype se degrada a lenguaje moderado sin tocar el resto", () => {
  assert.equal(degradeHypeLanguage("Hay valor claro en este lado."), "Hay ventaja moderada en este lado.");
  assert.match(degradeHypeLanguage("Es una apuesta obligada."), /opción con ventaja moderada/);
  assert.match(degradeHypeLanguage("Esto es free money."), /ventaja moderada/);
  assert.match(degradeHypeLanguage("Un lock del día."), /opción con ventaja moderada/);
  assert.equal(degradeHypeLanguage("gran valor por el pitcheo"), "ventaja moderada por el pitcheo");
  assert.equal(degradeHypeLanguage("El bullpen aporta valor defensivo."), "El bullpen aporta valor defensivo.", "'valor' sin hype no se toca");
});

/* ═══ 2. Moneyline con cuota oficial ═══ */

test("ML recibe cuotaReal del LADO del pick (away pick → cuota away)", () => {
  const odds = mkOdds({ h2h: [-150, 130] });
  const vHome = verifyPick({ tipo: "Moneyline", pick: "Texas Rangers ML", valor: "ALTO", razon: "x" }, odds, HOME, AWAY);
  assert.equal(vHome.cuotaReal, -150);
  const vAway = verifyPick({ tipo: "Moneyline", pick: "Detroit Tigers ML", valor: "MEDIO", razon: "x" }, odds, HOME, AWAY);
  assert.equal(vAway.cuotaReal, 130);
  assert.equal(vAway.valor, "MEDIO", "badge VALOR intacto");
  assert.ok(!("ev" in vAway) && !("evCalculado" in vAway), "el EV estructurado no se toca aquí");
});

test("ML sin snapshot → sin cuotaReal, sin crash, razón sin tokens intacta", () => {
  const v = verifyPick({ tipo: "Moneyline", pick: "Texas Rangers ML", valor: "ALTO", razon: "El bullpen descansado sostiene la ventaja." }, null, HOME, AWAY);
  assert.equal(v.cuotaReal, undefined);
  assert.match(v.razon, /bullpen descansado/);
});

/* ═══ 3. Cuotas narrativas distintas a la congelada ═══ */

test("ML: oración con cuota DISTINTA a la congelada se elimina; la coincidente y las métricas sobreviven", () => {
  const pick = {
    tipo: "Moneyline", pick: "Texas Rangers ML", valor: "ALTO",
    razon: "A -145 sigue siendo jugable. La cuota -120 refleja el duelo. K% 27.3 y LOB% 74 respaldan el proceso.",
  };
  const v = verifyPick(pick, mkOdds({ h2h: [-120, 100] }), HOME, AWAY);
  assert.ok(!v.razon.includes("-145"), `cuota ajena sobrevivió: ${v.razon}`);
  assert.match(v.razon, /La cuota -120 refleja el duelo\./, "la cuota congelada real sí puede citarse");
  assert.match(v.razon, /K% 27\.3 y LOB% 74/, "métricas deportivas intactas");
});

test("stripMismatchedOdds: 'probabilidad implícita' bruta se elimina siempre", () => {
  const out = stripMismatchedOdds("La probabilidad implícita es 54%. El xFIP 3.20 domina.", -110);
  assert.ok(!/impl[ií]cita/.test(out));
  assert.match(out, /xFIP 3\.20/);
});

/* ═══ 4. Total: línea de mercado autoritaria ═══ */

test("lineaMercado viene de totals.point del snapshot; narrativa con línea distinta se corrige", () => {
  const odds = mkOdds({ totals: [{ name: "Over", price: -105, point: 8.5 }, { name: "Under", price: -115, point: 8.5 }] });
  const t = attachMarketTotalLine(
    { proyectado: "9.2", estimado: "9.2", recomendacion: "OVER", razon: "La línea de 9.5 es alcanzable con estos bullpens." },
    odds
  );
  assert.equal(t.lineaMercado, 8.5);
  assert.ok(!t.razon.includes("9.5"), `línea ajena sobrevivió: ${t.razon}`);
  assert.match(t.razon, /[Ll]ínea de 8\.5 es alcanzable/);
  assert.equal(t.proyectado, "9.2", "proyectado intacto");
  assert.equal(t.estimado, "9.2", "estimado (compat) intacto");
});

test("narrativa que cita la línea CORRECTA queda idéntica", () => {
  const odds = mkOdds({ totals: [{ name: "Over", price: -105, point: 8.5 }] });
  const t = attachMarketTotalLine({ proyectado: "7.8", razon: "Bajo la línea de 8.5 hay margen." }, odds);
  assert.equal(t.razon, "Bajo la línea de 8.5 hay margen.");
});

test("sin totals.point → lineaMercado null, sin crash, menciones de línea despersonalizadas", () => {
  const t = attachMarketTotalLine({ proyectado: "8.9", razon: "La línea de 9 parece corta." }, mkOdds());
  assert.equal(t.lineaMercado, null);
  assert.ok(!/l[ií]nea de 9/i.test(t.razon), "sin línea verificada no se citan números de línea");
  assert.match(t.razon, /la línea del mercado/);
  assert.equal(attachMarketTotalLine(null, mkOdds()), null, "totalCarreras ausente no explota");
  assert.equal(attachMarketTotalLine({ proyectado: "8" }, null).lineaMercado, null, "snapshot ausente no explota");
});

/* ═══ Sanitización global del análisis ═══ */

test("sanitizeNarratives limpia resumen, factoresClave, razones y picks a la vez", () => {
  const analysis = {
    resumen: "Skubal lidera MLB en ponches y es valor claro.",
    ventajaPitcheoTexto: "El mejor de la liga.",
    factoresClave: ["Top 5 de la liga en xwOBA", "K% 27.3 del abridor", 42],
    prediccion: { ganador: "X", razon: "apuesta obligada por el pitcheo" },
    totalCarreras: { razon: "gran valor en el Under" },
    picks: [{ tipo: "Moneyline", razon: "free money contra este bullpen" }],
  };
  sanitizeNarratives(analysis);
  assert.equal(analysis.resumen, "Skubal presenta métricas de élite en ponches y es ventaja moderada.");
  assert.ok(!/mejor de la liga/i.test(analysis.ventajaPitcheoTexto));
  assert.ok(!/top 5 de la liga/i.test(analysis.factoresClave[0]));
  assert.equal(analysis.factoresClave[1], "K% 27.3 del abridor", "factor legítimo intacto");
  assert.equal(analysis.factoresClave[2], 42, "elementos no-string no explotan");
  assert.match(analysis.prediccion.razon, /opción con ventaja moderada/);
  assert.match(analysis.totalCarreras.razon, /ventaja moderada/);
  assert.match(analysis.picks[0].razon, /ventaja moderada/);
  assert.equal(sanitizeNarratives(null), null, "análisis nulo no explota");
});
