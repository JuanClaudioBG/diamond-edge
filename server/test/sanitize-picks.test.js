/*
 * Sanitización financiera y semántica cuota-verificada ≠ valor-verificado.
 * Casos exigidos por la corrección de inconsistencias residuales.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPick, sanitizeFinancialClaims, sanitizeTotalNarrative } from "../verify-picks.js";

const HOME = "Texas Rangers";
const AWAY = "Detroit Tigers";

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

/* ═══ 1-2. RUN LINE SIN CUOTA: la razón no puede contener cuotas ni valor ═══ */

test("RL SIN CUOTA con razón 'El precio de +146 ofrece valor teórico' → sin +146 ni afirmación financiera", () => {
  const pick = {
    tipo: "Run Line",
    pick: "Texas Rangers -1.5",
    valor: "ALTO",
    razon: "El precio de +146 ofrece valor teórico contra nuestra proyección. Rangers tiene mejor bullpen ERA 3.20 y OPS .780 en casa.",
  };
  const v = verifyPick(pick, mkOdds(), HOME, AWAY);   // sin mercado de spreads
  assert.equal(v.valor, "SIN CUOTA");
  assert.ok(!v.razon.includes("+146"), `la cuota inventada sobrevivió: ${v.razon}`);
  assert.ok(!/ofrece valor/i.test(v.razon), "la afirmación financiera sobrevivió");
  assert.match(v.razon, /Cuota exacta no verificada\. Análisis cualitativo; no entra a ROI ni a la muestra oficial\./);
  // El razonamiento deportivo legítimo se conserva (ERA, OPS)
  assert.match(v.razon, /bullpen ERA 3\.20/);
  assert.match(v.razon, /OPS \.780/);
});

test("RL SIN CUOTA: 'ofrece valor teórico' se elimina aunque no haya cuota en el texto", () => {
  const pick = { tipo: "Run Line", pick: "Detroit Tigers +1.5", valor: "MEDIO", razon: "La línea ofrece valor teórico. Tigers 7-3 últimos 10." };
  const v = verifyPick(pick, mkOdds(), HOME, AWAY);
  assert.ok(!/valor te[oó]rico/i.test(v.razon));
  assert.match(v.razon, /Tigers 7-3 últimos 10/, "el dato deportivo se conserva");
});

/* ═══ 3-4. TOTAL CON CUOTA REAL PERO SIN PROBABILIDAD DEL MODELO ═══ */

test("Total verificado sin probabilidad del modelo → SEÑAL, no VALOR; evCalculado=false; disclaimer", () => {
  const odds = mkOdds({ totals: [
    { name: "Over", price: -102, point: 7.5 }, { name: "Under", price: -120, point: 7.5 },
  ]});
  const v = verifyPick({ tipo: "Total", pick: "Under 7.5", valor: "ALTO", razon: "Ambos abridores con xERA elite y viento en contra." }, odds, HOME, AWAY);
  assert.equal(v.verificado, true);
  assert.equal(v.cuotaReal, -120, "cuota exacta del Under, verificada");
  assert.equal(v.evCalculado, false);
  assert.equal(v.valor, "SEÑAL ALTA", "cuota verificada NO habilita badge financiero");
  assert.match(v.razon, /CUOTA VERIFICADA · EV NO CALCULADO/);
  assert.match(v.razon, /no existe probabilidad numérica del modelo/);
  assert.match(v.razon, /No entra a ROI ni a la muestra oficial/);
  assert.match(v.razon, /xERA elite/, "razonamiento deportivo conservado");
});

test("Total/RL verificados jamás retienen badge financiero VALOR ALTO/MEDIO/BAJO", () => {
  const odds = mkOdds({
    spreads: [{ name: HOME, price: +126, point: +1.5 }],
    totals:  [{ name: "Over", price: -105, point: 8.5 }],
  });
  for (const [pick, valorIn] of [
    [{ tipo: "Run Line", pick: "Texas Rangers +1.5", valor: "MEDIO", razon: "x" }, "SEÑAL MEDIA"],
    [{ tipo: "Total",    pick: "Over 8.5",           valor: "BAJO",  razon: "x" }, "SEÑAL BAJA"],
  ]) {
    const v = verifyPick(pick, odds, HOME, AWAY);
    assert.equal(v.verificado, true);
    assert.ok(!["ALTO", "MEDIO", "BAJO"].includes(v.valor), `badge financiero retenido: ${v.valor}`);
    assert.equal(v.valor, valorIn);
  }
});

/* ═══ 5. PROP con cuota inventada en la razón ═══ */

test("Prop cuya razón contiene cuota inventada → sanitizada, categoría intacta", () => {
  const pick = { tipo: "Prop", pick: "Eovaldi Over strikeouts", valor: "ALTO", razon: "A -115 es buen precio. Whiff% 31 y el rival poncha 26% vs derechos." };
  const v = verifyPick(pick, mkOdds(), HOME, AWAY);
  assert.equal(v.tipo, "Prop para revisar");
  assert.equal(v.valor, "SIN VERIFICAR");
  assert.ok(!v.razon.includes("-115"), "cuota inventada sobrevivió");
  assert.ok(!/buen precio/i.test(v.razon));
  assert.match(v.razon, /Whiff% 31/, "estadística deportiva conservada");
  assert.match(v.razon, /Línea y cuota no verificadas/);
});

/* ═══ 6. MONEYLINE intacto ═══ */

test("Moneyline verificado conserva cuota, probabilidad y EV sin cambios", () => {
  const pick = {
    tipo: "Moneyline", pick: "Texas Rangers ML", valor: "ALTO", riesgo: "MEDIO",
    razon: "Prob mercado 50.4% vs nuestra 57% — el EV lo calcula el servidor.",
  };
  const v = verifyPick(pick, mkOdds(), HOME, AWAY);
  assert.deepEqual(v, pick, "ML no debe ser tocado por la verificación ni la sanitización");
});

/* ═══ Sanitizador: conservador con datos deportivos ═══ */

test("sanitizeFinancialClaims conserva ERA/OPS/%/líneas ±1.5 y elimina solo cuotas americanas", () => {
  const txt = "ERA 2.95 y OPS .812 con K% 28.4. La línea -1.5 es alcanzable. A -146 el precio es atractivo.";
  const out = sanitizeFinancialClaims(txt);
  assert.match(out, /ERA 2\.95/);
  assert.match(out, /OPS \.812/);
  assert.match(out, /K% 28\.4/);
  assert.match(out, /línea -1\.5 es alcanzable/, "la línea deportiva ±1.5 NO es cuota americana");
  assert.ok(!out.includes("-146"));
  assert.ok(!/precio.*atractivo/i.test(out));
  assert.equal(sanitizeFinancialClaims(null), "");
  assert.equal(sanitizeFinancialClaims("Solo a +150 tiene sentido."), "", "si todo es financiero, no queda nada (el disclaimer del server cubre)");
});

/* ═══ Narrativa TOTAL DE CARRERAS: SEÑAL, sin afirmaciones de valor ═══ */

test("sanitizeTotalNarrative: VALOR→SEÑAL, sin 'tiene valor' ni cuotas, con aclaración de EV", () => {
  const t = sanitizeTotalNarrative({
    estimado: "7.5",
    recomendacion: "UNDER",
    razon: "El Under 7.5 tiene valor a -120. Ambos abridores con xERA élite y viento en contra. VALOR ALTO por convergencia de factores.",
  });
  assert.ok(!/tiene\s+valor/i.test(t.razon));
  assert.ok(!t.razon.includes("-120"));
  assert.ok(!/VALOR\s+ALTO/.test(t.razon), "el badge financiero no puede aparecer en la narrativa");
  assert.match(t.razon, /SEÑAL ALTA/);
  assert.match(t.razon, /xERA élite/, "razonamiento deportivo conservado");
  assert.match(t.razon, /El perfil deportivo favorece al Under, pero no existe una probabilidad numérica del modelo para calcular EV\./);
  assert.equal(t.estimado, "7.5", "los demás campos no se tocan");
});

test("sanitizeTotalNarrative: OVER y narrativa totalmente financiera → solo la aclaración fija", () => {
  const t = sanitizeTotalNarrative({ estimado: "9.5", recomendacion: "OVER", razon: "A -105 ofrece valor." });
  assert.equal(t.razon, "El perfil deportivo favorece al Over, pero no existe una probabilidad numérica del modelo para calcular EV.");
  assert.equal(sanitizeTotalNarrative(null), null, "sin totalCarreras pasa sin explotar");
});

/* ═══ Clasificaciones residuales: sustitución por lenguaje cualitativo ═══ */

test("frase literal 1: 'Pick de valor BAJO por precio inflado.' → señal baja + costo elevado, sin clasificación financiera", () => {
  const odds = mkOdds({ spreads: [{ name: HOME, price: +126, point: +1.5 }] });
  const pick = { tipo: "Run Line", pick: "Texas Rangers +1.5", valor: "BAJO", razon: "Pick de valor BAJO por precio inflado. Rangers domina en casa con OPS .790." };
  const v = verifyPick(pick, odds, HOME, AWAY);
  assert.equal(v.evCalculado, false);
  assert.ok(!/pick de valor/i.test(v.razon), `clasificación residual sobrevivió: ${v.razon}`);
  assert.ok(!/valor\s+bajo/i.test(v.razon));
  assert.ok(!/precio inflado/i.test(v.razon));
  assert.match(v.razon, /Señal baja por el costo elevado de la cuota/);
  assert.match(v.razon, /EV NO CALCULADO/, "la falta de EV queda explícita vía disclaimer");
  assert.match(v.razon, /OPS \.790/, "el razonamiento deportivo se conserva");
});

test("frase literal 2 (Prop): 'valor MEDIO por perfil sólido...' → señal media, sin clasificación financiera", () => {
  const pick = { tipo: "Prop", pick: "Eovaldi Over strikeouts", valor: "MEDIO", razon: "Cuota no disponible — valor MEDIO por perfil sólido pero sin precio de referencia para calcular EV." };
  const v = verifyPick(pick, mkOdds(), HOME, AWAY);
  assert.equal(v.tipo, "Prop para revisar");
  assert.ok(!/valor\s+MEDIO/i.test(v.razon), `clasificación residual sobrevivió: ${v.razon}`);
  assert.match(v.razon, /señal media por perfil sólido/);
  assert.match(v.razon, /sin precio de referencia para calcular EV/, "la explicación cualitativa se conserva");
  assert.match(v.razon, /Línea y cuota no verificadas\. No entra a ROI ni a la muestra oficial\./);
});

test("Moneyline -108: '(implícito 50%)' se ELIMINA — nunca se reinterpreta como sin vig", () => {
  const pick = { tipo: "Moneyline", pick: "Texas Rangers ML", valor: "MEDIO", riesgo: "MEDIO", razon: "A precio -108 (implícito 50%) el duelo es parejo." };
  const v = verifyPick(pick, mkOdds(), HOME, AWAY);
  assert.equal(v.valor, "MEDIO", "badge VALOR de Moneyline intacto");
  assert.equal(v.tipo, "Moneyline");
  assert.ok(!/impl[ií]cit/.test(v.razon), `'implícito' sobrevivió: ${v.razon}`);
  assert.ok(!/sin vig/.test(v.razon), "el % del LLM jamás debe relabelarse como probabilidad sin vig");
  assert.ok(!v.razon.includes("50%"), "el porcentaje del paréntesis se elimina, no se conserva relabelado");
  assert.match(v.razon, /A cuota -108 el duelo es parejo\./);
});

test("Moneyline asimétrico: el % implícito del LLM nunca se transforma en probabilidad sin vig", () => {
  // -150/+130: implícita cruda del favorito 60%, sin vig ≈ 58% — son distintas
  const pick = { tipo: "Moneyline", pick: "Texas Rangers ML", valor: "ALTO", riesgo: "BAJO", razon: "A precio -150 (probabilidad implícita 60%) el favorito está caro." };
  const v = verifyPick(pick, mkOdds(), HOME, AWAY);
  assert.ok(!/sin vig/.test(v.razon), `relabel prohibido: ${v.razon}`);
  assert.ok(!/60%/.test(v.razon), "el 60% crudo del LLM no debe sobrevivir con ninguna etiqueta");
  assert.match(v.razon, /A cuota -150 el favorito está caro\./);
});

test("Moneyline sin paréntesis implícito: idéntico salvo 'A precio' → 'A cuota'", () => {
  const pick = { tipo: "Moneyline", pick: "Texas Rangers ML", valor: "ALTO", riesgo: "MEDIO", razon: "A precio -120 el favorito se sostiene por el bullpen." };
  const v = verifyPick(pick, mkOdds(), HOME, AWAY);
  assert.equal(v.razon, "A cuota -120 el favorito se sostiene por el bullpen.");
  assert.deepEqual({ ...v, razon: null }, { ...pick, razon: null }, "ningún otro campo cambia");
});

test("Moneyline sin patrones problemáticos queda idéntico (regresión)", () => {
  const pick = { tipo: "Moneyline", pick: "Texas Rangers ML", valor: "ALTO", riesgo: "MEDIO", razon: "Prob mercado 50.4% vs nuestra 57% — el EV lo calcula el servidor." };
  assert.deepEqual(verifyPick(pick, mkOdds(), HOME, AWAY), pick);
});
