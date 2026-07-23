/*
 * Consistencia de salida v5 (F1) — funciones puras de enforcement.
 * Reproduce los tres bugs observados en Dodgers vs Rockies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendMlAbstention, classifyMlEv, enforceMlValueConsistency,
  enforceTotalDirection, fixMetricComparisons, ML_ABSTENTION_REASON,
  TOTAL_DIRECTION_GAP,
} from "../verify-picks.js";

const HOME = "Los Angeles Dodgers";
const AWAY = "Colorado Rockies";

/* mercado real del caso: local sin vig 69%, modelo 67% → EV local −2% */
const MERCADO_DODGERS = {
  book: "FanDuel",
  probMercadoLocal: 69, probMercadoVisitante: 31,
  probModeloLocal: 67, evGanadorPct: -2,
};

const mlPick = (over = {}) => ({
  tipo: "Moneyline", pick: `${HOME} ML`, valor: "MEDIO", riesgo: "BAJO",
  razon: "El pitcheo favorece al local.", cuotaReal: -255, verificado: true,
  ...over,
});

/* ═══ 1. Umbrales autoritarios de EV Moneyline ═══ */
test("classifyMlEv respeta exactamente <3, [3,6), [6,10] y >10", () => {
  assert.equal(classifyMlEv(-5), "SIN VALOR");
  assert.equal(classifyMlEv(0), "SIN VALOR");
  assert.equal(classifyMlEv(2.9), "SIN VALOR");
  assert.equal(classifyMlEv(3), "BAJO");
  assert.equal(classifyMlEv(5.9), "BAJO");
  assert.equal(classifyMlEv(6), "MEDIO");
  assert.equal(classifyMlEv(10), "MEDIO");
  assert.equal(classifyMlEv(10.1), "ALTO");
  assert.equal(classifyMlEv(NaN), null);
});

test("ML con EV −2% (mercado 69 vs modelo 67) → SIN VALOR, cuotaReal y verificado conservados", () => {
  const [out] = enforceMlValueConsistency([mlPick()], MERCADO_DODGERS, HOME, AWAY);
  assert.equal(out.valor, "SIN VALOR");
  assert.equal(out.cuotaReal, -255, "la cuota congelada se conserva");
  assert.equal(out.verificado, true);
  assert.match(out.razon, /EV del servidor: -2\.0% — edge insuficiente; no se recomienda como apuesta\./);
  assert.match(out.razon, /El pitcheo favorece al local\./, "la razón original se conserva tras la nota");
});

test("clasificación del servidor reemplaza el valor del LLM en todas las bandas", () => {
  const mercado = { ...MERCADO_DODGERS, probModeloLocal: 69.3 };
  const [out] = enforceMlValueConsistency([mlPick({ valor: "MEDIO" })], mercado, HOME, AWAY);
  assert.equal(out.valor, "SIN VALOR");
  assert.equal(out.cuotaReal, -255);
  assert.equal(out.verificado, true);
  assert.match(out.razon, /edge insuficiente/);

  const bands = [
    [72, "BAJO", /valor bajo/],       // +3
    [75, "MEDIO", /valor medio/],     // +6
    [79, "MEDIO", /valor medio/],     // +10
    [79.1, "ALTO", /valor alto/],     // +10.1
  ];
  for (const [probModeloLocal, valor, note] of bands) {
    const [classified] = enforceMlValueConsistency(
      [mlPick({ valor: valor === "ALTO" ? "BAJO" : "ALTO" })],
      { ...MERCADO_DODGERS, probModeloLocal }, HOME, AWAY
    );
    assert.equal(classified.valor, valor);
    assert.match(classified.razon, note);
  }
});

/* ═══ 3. Visitante usa EV espejado ═══ */
test("ML visitante: EV = (100−probModeloLocal) − probMercadoVisitante", () => {
  // visitante: (100−67) − 31 = +2 → SIN VALOR
  const [vAway] = enforceMlValueConsistency(
    [mlPick({ pick: `${AWAY} ML`, valor: "BAJO" })], MERCADO_DODGERS, HOME, AWAY);
  assert.equal(vAway.valor, "SIN VALOR");
  // modelo local 74 → visitante 26 − 31 = −5 → SIN VALOR
  const [vNeg] = enforceMlValueConsistency(
    [mlPick({ pick: `${AWAY} ML`, valor: "MEDIO" })],
    { ...MERCADO_DODGERS, probModeloLocal: 74 }, HOME, AWAY);
  assert.equal(vNeg.valor, "SIN VALOR");
  assert.match(vNeg.razon, /EV del servidor: -5\.0%/);
});

/* ═══ 4. Abstención ML ═══ */
test("ambos edges bajo 3% agregan una abstención exacta e idempotente", () => {
  const mercado = { probModeloLocal: 51, probMercadoLocal: 50, probMercadoVisitante: 50 };
  const once = appendMlAbstention([mlPick()], mercado);
  const abstention = once.find(p => p.abstencion === true);
  assert.deepEqual(abstention, {
    tipo: "Sin pick recomendado",
    pick: "Abstenerse en Moneyline",
    valor: "SIN VALOR",
    riesgo: "N/A",
    abstencion: true,
    razon: ML_ABSTENTION_REASON,
  });
  const twice = appendMlAbstention(once, mercado);
  assert.equal(twice.filter(p => p.abstencion).length, 1);
});

test("edge exacto de 3% evita abstención; mercado incompleto no fabrica tarjeta", () => {
  const atThreshold = appendMlAbstention([], {
    probModeloLocal: 53, probMercadoLocal: 50, probMercadoVisitante: 50,
  });
  assert.deepEqual(atThreshold, []);
  const original = [mlPick()];
  assert.equal(appendMlAbstention(original, { probModeloLocal: 51, probMercadoLocal: 50 }), original);
});

/* ═══ 5. mercado null / lado no mapeable / no-ML: no tocar ═══ */
test("mercado null, probModelo ausente, lado no mapeable o pick no-ML → intactos", () => {
  const pick = mlPick();
  assert.deepEqual(enforceMlValueConsistency([pick], null, HOME, AWAY), [pick]);
  assert.deepEqual(enforceMlValueConsistency([pick], { probMercadoLocal: 69, probModeloLocal: null }, HOME, AWAY), [pick]);
  const raro = mlPick({ pick: "Equipo Desconocido ML" });
  assert.deepEqual(enforceMlValueConsistency([raro], MERCADO_DODGERS, HOME, AWAY)[0], raro);
  const rl = { tipo: "Run Line", pick: `${HOME} -1.5`, valor: "SEÑAL MEDIA", razon: "x" };
  assert.deepEqual(enforceMlValueConsistency([rl], MERCADO_DODGERS, HOME, AWAY)[0], rl);
  assert.equal(enforceMlValueConsistency(null, MERCADO_DODGERS, HOME, AWAY), null, "picks null no explota");
});

/* ═══ 5. Caso literal del Total: proyección 9.2, línea 10, OVER → UNDER ═══ */
test("total proyectado 9.2 vs línea 10 con recomendacion OVER → corregida a UNDER con nota", () => {
  const { totalCarreras: t } = enforceTotalDirection(
    { proyectado: "9.2", estimado: "9.2", lineaMercado: 10, recomendacion: "OVER", razon: "proyección 9.2 por debajo de línea 10." },
    []
  );
  assert.equal(t.recomendacion, "UNDER");
  assert.match(t.razon, /Dirección corregida por el servidor: proyección 9\.2 vs línea 10 → UNDER\./);
  assert.match(t.razon, /proyección 9\.2 por debajo de línea 10\./, "razón original conservada");
});

/* ═══ 6. Dirección coherente: intacta ═══ */
test("total proyectado 10.8 vs línea 10 con OVER → intacto, sin nota", () => {
  const original = { proyectado: "10.8", lineaMercado: 10, recomendacion: "OVER", razon: "x" };
  const { totalCarreras: t } = enforceTotalDirection(original, []);
  assert.equal(t.recomendacion, "OVER");
  assert.ok(!/corregida/.test(t.razon));
  assert.ok(!("senalClara" in t) || t.senalClara !== false);
});

/* ═══ 7. Gap chico → señal no clara ═══ */
test(`|gap| < ${TOTAL_DIRECTION_GAP} → senalClara:false, sin dirección fabricada`, () => {
  const { totalCarreras: t } = enforceTotalDirection(
    { proyectado: "9.9", lineaMercado: 10, recomendacion: "UNDER", razon: "x" }, []);
  assert.equal(t.senalClara, false);
  assert.equal(t.recomendacion, "UNDER", "la recomendación no se reescribe cuando no hay dirección fuerte");
  // Sin números → nada
  const input = { recomendacion: "OVER", razon: "x" };
  const { totalCarreras: same } = enforceTotalDirection(input, []);
  assert.deepEqual(same, input);
});

test("gap insuficiente 8.6 vs 8.5 degrada pick Total a noOficial y no queda activo para parlay", () => {
  const pick = { tipo: "Total", pick: "Under 8.5", valor: "SEÑAL MEDIA", razon: "u", cuotaReal: +102, verificado: true };
  const { totalCarreras: t, picks } = enforceTotalDirection(
    { proyectado: "8.6", lineaMercado: 8.5, recomendacion: "UNDER", senalClara: false, razon: "cerca" },
    [pick]
  );
  assert.equal(t.senalClara, false);
  assert.equal(t.recomendacion, "UNDER", "no se inventa OVER con gap pequeño");
  assert.equal(picks[0].valor, "SEÑAL NO OFICIAL");
  assert.equal(picks[0].noOficial, true);
  assert.equal(picks[0].pick, "Under 8.5");
  assert.equal(picks[0].cuotaReal, +102);
  assert.equal(picks[0].verificado, true);
  assert.match(picks[0].razon, /Gap del total insuficiente; la proyección queda demasiado cerca de la línea para validar una señal/);
  assert.equal(pickBadge(picks[0]).activo, false);
});

test("total claro coherente: 7.8 vs 8.5 Under y 9.2 vs 8.5 Over siguen intactos", () => {
  const under = { tipo: "Total", pick: "Under 8.5", valor: "SEÑAL MEDIA", razon: "u", cuotaReal: -110 };
  const over  = { tipo: "Total", pick: "Over 8.5", valor: "SEÑAL MEDIA", razon: "o", cuotaReal: -105 };
  const u = enforceTotalDirection({ proyectado: "7.8", lineaMercado: 8.5, recomendacion: "UNDER", razon: "x" }, [under]);
  const o = enforceTotalDirection({ proyectado: "9.2", lineaMercado: 8.5, recomendacion: "OVER", razon: "y" }, [over]);
  assert.deepEqual(u.picks[0], under);
  assert.deepEqual(o.picks[0], over);
  assert.ok(!("senalClara" in u.totalCarreras) || u.totalCarreras.senalClara !== false);
  assert.ok(!("senalClara" in o.totalCarreras) || o.totalCarreras.senalClara !== false);
});

/* ═══ 8. Pick Total contradictorio → SEÑAL NO OFICIAL; coherente → intacto ═══ */
test("pick Total que contradice la dirección del servidor → SEÑAL NO OFICIAL + noOficial, auditoría conservada; el coherente queda intacto", () => {
  const contradictorio = { tipo: "Total", pick: "Over 10", valor: "SEÑAL MEDIA", razon: "y", cuotaReal: -110, verificado: true };
  const coherente      = { tipo: "Total", pick: "Under 10", valor: "SEÑAL MEDIA", razon: "z", cuotaReal: -114 };
  const { picks } = enforceTotalDirection(
    { proyectado: "9.2", lineaMercado: 10, recomendacion: "UNDER", razon: "x" },
    [contradictorio, coherente]
  );
  assert.equal(picks[0].valor, "SEÑAL NO OFICIAL");
  assert.equal(picks[0].noOficial, true);
  assert.match(picks[0].razon, /⚠️ Pick inconsistente con la dirección del servidor \(proyección 9\.2 vs línea 10 → UNDER\)\./);
  assert.equal(picks[0].pick, "Over 10", "el pick original se conserva como auditoría");
  assert.equal(picks[0].cuotaReal, -110, "cuota verificada conservada");
  assert.equal(picks[0].verificado, true, "verificado conservado");
  assert.match(picks[0].razon, /y$/, "razón original conservada tras la nota");
  assert.deepEqual(picks[1], coherente, "el pick coherente no se toca ni gana noOficial");
});

/* ═══ 9-10. Comparaciones numéricas en narrativa ═══ */
test("'xERA 4.78 supera ERA 5.40' (falso) → verbo corregido; el verdadero queda intacto", () => {
  const falso = fixMetricComparisons("Su xERA 4.78 supera ERA 5.40, señal de riesgo.");
  assert.ok(!/supera/.test(falso), `verbo contradictorio sobrevivió: ${falso}`);
  assert.match(falso, /xERA 4\.78 está por debajo del ERA 5\.40/);
  assert.match(falso, /señal de riesgo/, "el resto de la oración se conserva");

  const verdadero = "Su xERA 5.80 supera ERA 4.20, señal de riesgo.";
  assert.equal(fixMetricComparisons(verdadero), verdadero, "comparación correcta intacta");

  // También la dirección inversa mal redactada
  const inverso = fixMetricComparisons("El FIP 5.10 está por debajo del ERA 3.90 del abridor.");
  assert.match(inverso, /FIP 5\.10 está por encima del ERA 3\.90/);
});

test("threshold wording de pitcheo corrige ERA vs umbral sin tocar líneas ni cuotas", () => {
  const bajo = fixMetricComparisons("Regla de bullpen: ERA 4.24 por encima de 4.50 activa cautela.");
  assert.match(bajo, /ERA 4\.24 está por debajo de 4\.50/);
  const alto = fixMetricComparisons("Métrica de pitcheo: ERA 5.10 por debajo de 4.50 es mala señal.");
  assert.match(alto, /ERA 5\.10 está por encima de 4\.50/);
  const intacto = "Cuota +102 y línea -1.5 quedan intactas.";
  assert.equal(fixMetricComparisons(intacto), intacto);
});

/* ═══ 11. Mapeo semántico proceso/resultados ═══ */
test("'FIP mayor que ERA … peores que el proceso' → corregido a 'mejores'", () => {
  const out = fixMetricComparisons("FIP mayor que ERA confirma que los resultados han sido peores que el proceso.");
  assert.match(out, /mejores que el proceso/);
  assert.ok(!/peores que el proceso/.test(out));
  const out2 = fixMetricComparisons("xERA menor que ERA indica resultados mejores que el proceso.");
  assert.match(out2, /peores que el proceso/, "menor que ERA = resultados peores que el proceso");
  const correcto = "FIP mayor que ERA sugiere resultados mejores que el proceso.";
  assert.equal(fixMetricComparisons(correcto), correcto, "mapeo correcto intacto");
});

/* ═══ 11b. Caso real Corey Sproat: "de" entre métrica y número + espejo ERA-primero ═══ */
test("'xERA de 4.62 supera ERA 5.13 en 0.51' (falso: 4.62 < 5.13) → verbo corregido, resto intacto", () => {
  const out = fixMetricComparisons("Corey Sproat xERA de 4.62 supera ERA 5.13 en 0.51 este año.");
  assert.ok(!/supera/.test(out), `verbo contradictorio sobrevivió: ${out}`);
  assert.match(out, /xERA 4\.62 está por debajo del? ERA 5\.13 en 0\.51/, "números y cola 'en 0.51' se conservan");
});

test("'xERA 5.20 está por debajo de ERA 4.10' (falso: 5.20 > 4.10) → corregido a por encima", () => {
  const out = fixMetricComparisons("Su xERA 5.20 está por debajo de ERA 4.10, señal engañosa.");
  assert.match(out, /xERA 5\.20 está por encima del? ERA 4\.10/);
  assert.match(out, /señal engañosa/, "el resto de la oración se conserva");
});

test("espejo ERA-primero: 'ERA 5.13 está por debajo del xERA 4.62' (falso) → corregido; el correcto queda intacto", () => {
  const out = fixMetricComparisons("ERA de 5.13 está por debajo del xERA 4.62 del abridor.");
  assert.match(out, /ERA 5\.13 está por encima del xERA 4\.62/);
  const correcto = "ERA 5.13 supera xERA 4.62 con regresión esperada.";
  assert.equal(fixMetricComparisons(correcto), correcto, "comparación ERA-primero verdadera intacta");
  const correctoDe = "Corey Sproat xERA de 4.62 está por debajo del ERA 5.13 en 0.51.";
  assert.equal(fixMetricComparisons(correctoDe), correctoDe, "la frase ya corregida no se re-toca");
});

test("sanitizeNarratives aplica la corrección con 'de' en resumen/factores/razones/picks", () => {
  const analysis = {
    resumen: "Corey Sproat xERA de 4.62 supera ERA 5.13 en 0.51.",
    factoresClave: ["ERA de 5.13 menor que su xERA 4.62"],
    prediccion: { razon: "xERA de 4.62 supera ERA 5.13." },
    picks: [{ tipo: "Moneyline", razon: "Su xERA de 4.62 supera ERA 5.13 del rival." }],
  };
  sanitizeNarratives(analysis);
  assert.match(analysis.resumen, /está por debajo del? ERA 5\.13/);
  assert.match(analysis.factoresClave[0], /ERA 5\.13 está por encima del xERA 4\.62/);
  assert.match(analysis.prediccion.razon, /está por debajo del? ERA 5\.13/);
  assert.match(analysis.picks[0].razon, /está por debajo del? ERA 5\.13/);
});

/* ═══ 12. Métricas sueltas jamás se tocan ═══ */
test("métricas sueltas y comparaciones sin ambos números quedan intactas", () => {
  const legit = "xERA 3.10 con K/9 11.2 y Whiff% 27.9; su ERA 5.40 preocupa. La línea -1.5 es viable.";
  assert.equal(fixMetricComparisons(legit), legit);
  assert.equal(fixMetricComparisons(null), "");
  assert.equal(fixMetricComparisons("El xERA supera al ERA según la tendencia."),
    "El xERA supera al ERA según la tendencia.",
    "sin números no se actúa (patrón estrecho)");
});

/* ═══ F2: integración en el flujo real ═══ */
import { readFileSync } from "fs";
import { sanitizeNarratives } from "../verify-picks.js";
import { totalDisplay } from "../../src/analysis-display.js";

test("orden de integración en index.js: enforceTotalDirection tras attachMarketTotalLine, enforceMl tras mercado", () => {
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const iAttach  = src.indexOf("attachMarketTotalLine(analysis.totalCarreras");
  const iDirFix  = src.indexOf("enforceTotalDirection(analysis.totalCarreras");
  const iMercado = src.indexOf("analysis.mercado = mercado");
  const iMlFix   = src.indexOf("enforceMlValueConsistency(analysis.picks");
  const iAbstain = src.indexOf("appendMlAbstention(analysis.picks");
  assert.ok(iAttach > -1 && iDirFix > -1 && iMercado > -1 && iMlFix > -1 && iAbstain > -1, "las cinco llamadas existen");
  assert.ok(iAttach < iDirFix, "la dirección se corrige DESPUÉS de inyectar lineaMercado");
  assert.ok(iMercado < iMlFix, "el enforcement de ML corre DESPUÉS de calcular mercado");
  assert.ok(iMlFix < iAbstain, "la abstención se agrega DESPUÉS de clasificar los Moneylines");
  assert.match(src, /misma \.5 \(solo post-proceso\)/, "el historial documenta que pertenece a la .5 sin bump");
});

test("pipeline: ML degradado tras mercado + dirección del total corregida, encadenados como en index.js", () => {
  // Simula el orden real: attach ya puso lineaMercado; luego dirección; luego mercado; luego ML
  const analysis = {
    totalCarreras: { proyectado: "9.2", estimado: "9.2", lineaMercado: 10, recomendacion: "OVER", razon: "r" },
    picks: [
      { tipo: "Moneyline", pick: `${HOME} ML`, valor: "MEDIO", razon: "m", cuotaReal: -255, verificado: true },
      { tipo: "Total", pick: "Over 10", valor: "SEÑAL MEDIA", razon: "t" },
    ],
  };
  const dirFix = enforceTotalDirection(analysis.totalCarreras, analysis.picks);
  analysis.totalCarreras = dirFix.totalCarreras;
  analysis.picks = dirFix.picks;
  analysis.picks = enforceMlValueConsistency(analysis.picks, MERCADO_DODGERS, HOME, AWAY);
  analysis.picks = appendMlAbstention(analysis.picks, MERCADO_DODGERS);
  assert.equal(analysis.totalCarreras.recomendacion, "UNDER");
  assert.equal(analysis.picks[0].valor, "SIN VALOR", "ML con EV −2% degradado en el pipeline");
  assert.equal(analysis.picks[1].valor, "SEÑAL NO OFICIAL", "Total contradictorio degradado en el pipeline");
  assert.equal(analysis.picks[1].noOficial, true);
  assert.equal(analysis.picks[2].tipo, "Sin pick recomendado");
  assert.equal(analysis.picks[2].razon, ML_ABSTENTION_REASON);
});

test("sanitizeNarratives ahora corrige comparaciones métricas en razones y factores", () => {
  const analysis = {
    resumen: "Su xERA 4.78 supera ERA 5.40 este año.",
    factoresClave: ["FIP mayor que ERA confirma resultados peores que el proceso"],
    prediccion: { razon: "xERA 3.10 sólido." },
    picks: [{ tipo: "Moneyline", razon: "El xERA 4.78 supera ERA 5.40 del rival." }],
  };
  sanitizeNarratives(analysis);
  assert.match(analysis.resumen, /xERA 4\.78 está por debajo del ERA 5\.40/);
  assert.match(analysis.factoresClave[0], /mejores que el proceso/);
  assert.equal(analysis.prediccion.razon, "xERA 3.10 sólido.", "métrica suelta intacta");
  assert.match(analysis.picks[0].razon, /está por debajo del ERA 5\.40/);
});

test("sanitizeNarratives corrige la comparación ofensiva literal Detroit/Oakland OPS", () => {
  const analysis = {
    ventajaOfensivaTexto: "Detroit tiene mejor OPS de temporada (.713 vs .732 a favor de Oakland). El resto queda.",
  };
  sanitizeNarratives(analysis);
  assert.match(analysis.ventajaOfensivaTexto, /Oakland tiene mejor OPS de temporada \(\.732 vs \.713\), aunque la diferencia general es mínima\./);
  assert.ok(!/Detroit tiene mejor OPS/.test(analysis.ventajaOfensivaTexto));
  assert.match(analysis.ventajaOfensivaTexto, /El resto queda\./);
});

test("sanitizeNarratives no toca métricas ofensivas sueltas", () => {
  const analysis = {
    resumen: "Detroit trae OPS .713 y xwOBA .321 en la muestra reciente.",
  };
  sanitizeNarratives(analysis);
  assert.equal(analysis.resumen, "Detroit trae OPS .713 y xwOBA .321 en la muestra reciente.");
});

test("sanitizeNarratives deja intacta una comparación ofensiva correcta", () => {
  const analysis = {
    ventajaOfensivaTexto: "Oakland tiene mejor OPS de temporada (.732 vs .713 a favor de Detroit).",
  };
  sanitizeNarratives(analysis);
  assert.equal(analysis.ventajaOfensivaTexto, "Oakland tiene mejor OPS de temporada (.732 vs .713 a favor de Detroit).");
});

test("sanitizeNarratives no toca frases ofensivas sin equipos claros", () => {
  const analysis = {
    resumen: "Mejor OPS de temporada (.713 vs .732) sin contexto suficiente.",
  };
  sanitizeNarratives(analysis);
  assert.equal(analysis.resumen, "Mejor OPS de temporada (.713 vs .732) sin contexto suficiente.");
});

test("sanitizeNarratives pule frase rara de Moneyline sin tocar campos estructurados", () => {
  const analysis = {
    picks: [{
      tipo: "Moneyline",
      categoria: "Moneyline",
      pick: "Milwaukee Brewers ML",
      valor: "BAJO",
      razon: "Ventaja moderada identificada por el modelo, no una apuesta de ventaja moderada.",
      cuotaReal: -126,
      verificado: true,
      ev: 0.3,
    }],
  };
  sanitizeNarratives(analysis);
  assert.equal(analysis.picks[0].razon, "Ventaja identificada por el modelo, pero edge de mercado bajo.");
  assert.equal(analysis.picks[0].tipo, "Moneyline");
  assert.equal(analysis.picks[0].categoria, "Moneyline");
  assert.equal(analysis.picks[0].pick, "Milwaukee Brewers ML");
  assert.equal(analysis.picks[0].cuotaReal, -126);
  assert.equal(analysis.picks[0].verificado, true);
  assert.equal(analysis.picks[0].ev, 0.3);
});

test("sanitizeNarratives corrige margen de Under: queda por debajo de la línea", () => {
  const analysis = {
    totalCarreras: {
      proyectado: "7.8",
      lineaMercado: 8.5,
      recomendacion: "UNDER",
      razon: "Proyección interna de 7.8 carreras ofrece margen de 0.7 sobre la línea 8.5.",
    },
  };
  sanitizeNarratives(analysis);
  assert.equal(
    analysis.totalCarreras.razon,
    "Proyección interna de 7.8 carreras queda 0.7 por debajo de la línea 8.5."
  );
  assert.equal(analysis.totalCarreras.proyectado, "7.8");
  assert.equal(analysis.totalCarreras.lineaMercado, 8.5);
  assert.equal(analysis.totalCarreras.recomendacion, "UNDER");
});

test("sanitizeNarratives corrige narrativa matemática falsa contra línea de total", () => {
  const arriba = {
    totalCarreras: {
      proyectado: "8.6",
      lineaMercado: 8.5,
      recomendacion: "UNDER",
      razon: "Proyección propia de 8.6 carreras está marginalmente por debajo de la línea de 8.5.",
    },
  };
  sanitizeNarratives(arriba);
  assert.match(arriba.totalCarreras.razon, /8\.6 carreras está marginalmente por encima de la línea 8\.5/);

  const abajo = {
    totalCarreras: {
      proyectado: "7.8",
      lineaMercado: 8.5,
      recomendacion: "UNDER",
      razon: "Proyección propia de 7.8 carreras está por encima de la línea 8.5.",
    },
  };
  sanitizeNarratives(abajo);
  assert.match(abajo.totalCarreras.razon, /7\.8 carreras está por debajo de la línea 8\.5/);
});

test("sanitizeNarratives no cambia margen sobre la línea cuando la dirección es Over", () => {
  const analysis = {
    totalCarreras: {
      proyectado: "9.2",
      lineaMercado: 8.5,
      recomendacion: "OVER",
      razon: "Proyección interna de 9.2 carreras ofrece margen de 0.7 sobre la línea 8.5.",
    },
  };
  sanitizeNarratives(analysis);
  assert.equal(
    analysis.totalCarreras.razon,
    "Proyección interna de 9.2 carreras ofrece margen de 0.7 sobre la línea 8.5."
  );
});

test("sanitizeNarratives no toca Moneyline EV ni Batter Radar", () => {
  const batterRadar = {
    status: "OK",
    away: { cards: [{ name: "A", markets: { hits: { status: "PROP_PARA_REVISAR" } } }] },
    home: { cards: [] },
  };
  const analysis = {
    batterRadar,
    picks: [{
      tipo: "Moneyline",
      pick: "Dodgers ML",
      valor: "BAJO",
      razon: "Ventaja moderada identificada por el modelo, no una apuesta de ventaja moderada.",
      cuotaReal: -120,
      verificado: true,
      ev: 0.3,
    }],
  };
  sanitizeNarratives(analysis);
  assert.equal(analysis.picks[0].cuotaReal, -120);
  assert.equal(analysis.picks[0].ev, 0.3);
  assert.equal(analysis.picks[0].valor, "BAJO");
  assert.deepEqual(analysis.batterRadar, batterRadar);
});

test("totalDisplay: senalClara=false → SEÑAL NO CLARA; dirección corregida se muestra", () => {
  const noClara = totalDisplay({ proyectado: "9.9", lineaMercado: 10, recomendacion: "UNDER", senalClara: false });
  assert.equal(noClara.senal, "SEÑAL NO CLARA");
  assert.equal(noClara.proyeccion, "9.9");
  assert.equal(noClara.lineaReal, 10);
  const corregida = totalDisplay({ proyectado: "9.2", lineaMercado: 10, recomendacion: "UNDER" });
  assert.equal(corregida.senal, "UNDER 10", "la dirección corregida por el servidor es la que se muestra");
});

/* ═══ F3: bug real encontrado en e2e (Brewers @ Cardinals, analysisId 38) ═══ */
test("implícita bruta con ~ en prediccion.razon → eliminada por sanitizeNarratives en cualquier campo", () => {
  const analysis = {
    prediccion: { razon: "El mercado pone a Milwaukee en -126 (prob implícita ~55.7%), lo que deja poco margen." },
    factoresClave: ["A -126 (probabilidad implícita ~55,7%) el margen es corto"],
  };
  sanitizeNarratives(analysis);
  assert.ok(!/impl[ií]cit/i.test(analysis.prediccion.razon), `sobrevivió: ${analysis.prediccion.razon}`);
  assert.ok(!/55[.,]7/.test(analysis.prediccion.razon), "el número bruto no debe quedar con otra etiqueta");
  assert.match(analysis.prediccion.razon, /en -126, lo que deja poco margen\./, "el resto de la frase intacto");
  assert.ok(!/impl[ií]cit/i.test(analysis.factoresClave[0]), "también en factores, con coma decimal y 'probabilidad'");
});

test("variante invertida '(46.3% implícito)' (vista en analysisId 40) → también eliminada", () => {
  const analysis = { prediccion: { razon: "ligeramente por debajo del mercado (46.3% implícito), sin divergencia suficiente." } };
  sanitizeNarratives(analysis);
  assert.ok(!/impl[ií]cit/i.test(analysis.prediccion.razon), `sobrevivió: ${analysis.prediccion.razon}`);
  assert.match(analysis.prediccion.razon, /por debajo del mercado, sin divergencia suficiente\./);
});

/* ═══ Pulido visual: Total contradictorio no es pick activo + relabel de implícita ═══ */
import { relabelImpliedNoVig, relabelImpliedNoVigNarratives } from "../verify-picks.js";
import { pickBadge } from "../../src/analysis-display.js";

const MERCADO_547 = { probMercadoLocal: 54.7, probMercadoVisitante: 45.3, probModeloLocal: 56 };

test("pickBadge: pick noOficial → activo:false, clase neutra NOOF, texto SEÑAL NO OFICIAL", () => {
  const b = pickBadge({ tipo: "Total", pick: "Under 7", valor: "SEÑAL NO OFICIAL", noOficial: true });
  assert.equal(b.activo, false);
  assert.equal(b.clase, "NOOF");
  assert.equal(b.texto, "SEÑAL NO OFICIAL");
});

test("pickBadge: SIN VALOR y abstención quedan inactivos; picks válidos conservan su clase", () => {
  assert.deepEqual(pickBadge({ valor: "MEDIO" }), { texto: "VALOR MEDIO", clase: "MEDIO", activo: true });
  assert.deepEqual(pickBadge({ valor: "SEÑAL ALTA" }), { texto: "SEÑAL ALTA", clase: "ALTO", activo: true });
  assert.deepEqual(pickBadge({ valor: "SIN VALOR" }), { texto: "SIN VALOR", clase: "BAJO", activo: false });
  assert.deepEqual(pickBadge({ tipo: "Sin pick recomendado", valor: "SIN VALOR", abstencion: true }), { texto: "ABSTENERSE", clase: "NOOF", activo: false });
  assert.deepEqual(pickBadge({ valor: "SIN CUOTA" }), { texto: "SIN CUOTA", clase: "SIN CUOTA", activo: true });
  assert.equal(pickBadge(null).activo, false, "pick null jamás es activo");
});

test("AnalysisTab solo ofrece + PARLAY cuando pickBadge está activo", () => {
  const tab = readFileSync(new URL("../../src/components/AnalysisTab.jsx", import.meta.url), "utf8");
  assert.match(tab, /badge\.activo && <button className="padd"/);
  assert.match(tab, /Recomendación de abstención — no es una apuesta y no se agrega al parlay/);
  assert.match(tab, /Edge por debajo del umbral mínimo — no se agrega al parlay/);
});

test("relabelImpliedNoVig: 'probabilidad implícita 54.7%' que coincide con sin vig → re-etiquetada", () => {
  const out = relabelImpliedNoVig("El mercado asigna probabilidad implícita 54.7% al local.", MERCADO_547);
  assert.equal(out, "El mercado asigna probabilidad de mercado sin vig 54.7% al local.");
});

test("relabelImpliedNoVig: '54.7% implícito' (número primero) y coma decimal '45,3%' → corregidos", () => {
  const invertido = relabelImpliedNoVig("con 54.7% implícito a favor.", MERCADO_547);
  assert.equal(invertido, "con probabilidad de mercado sin vig 54.7% a favor.");
  const coma = relabelImpliedNoVig("prob. implícita de 45,3% para el visitante.", MERCADO_547);
  assert.equal(coma, "probabilidad de mercado sin vig 45,3% para el visitante.");
});

test("relabelImpliedNoVig: número que NO coincide con sin vig → no conserva 'implícita' ni el número etiquetado", () => {
  const out = relabelImpliedNoVig("El mercado pone probabilidad implícita 55.7% al favorito.", MERCADO_547);
  assert.ok(!/impl[ií]cit/i.test(out), `sobrevivió: ${out}`);
  assert.ok(!/55\.7/.test(out), "el número bruto no queda re-etiquetado como sin vig");
  assert.match(out, /probabilidad de mercado/);
});

test("relabelImpliedNoVig: mercado null → no crash y limpieza genérica sin 'implícita'", () => {
  const out = relabelImpliedNoVig("prob implícita ~55.7% y una ventaja implícita del local.", null);
  assert.ok(!/impl[ií]cit/i.test(out), `sobrevivió: ${out}`);
  assert.equal(relabelImpliedNoVig(null, null), "", "texto null no explota");
  assert.equal(relabelImpliedNoVig("sin menciones raras.", null), "sin menciones raras.", "texto limpio intacto");
});

test("relabelImpliedNoVigNarratives: recorre todos los campos narrativos sin tocar no-strings", () => {
  const analysis = {
    resumen: "probabilidad implícita 54.7% domina.",
    ventajaPitcheoTexto: "el 45.3% implícito del visitante.",
    ventajaOfensivaTexto: null,
    factoresClave: ["prob implícita 54.7% del local", 42],
    prediccion: { razon: "prob. implícita de 54.7%." },
    totalCarreras: { razon: "sin cambios.", lineaMercado: 7 },
    picks: [{ razon: "implícita 54.7% de nuevo", cuotaReal: -142 }],
  };
  relabelImpliedNoVigNarratives(analysis, MERCADO_547);
  const narrativa = [analysis.resumen, analysis.ventajaPitcheoTexto, analysis.factoresClave[0],
    analysis.prediccion.razon, analysis.picks[0].razon].join(" | ");
  assert.ok(!/impl[ií]cit/i.test(narrativa), `sobrevivió: ${narrativa}`);
  assert.match(analysis.resumen, /sin vig 54\.7%/);
  assert.match(analysis.ventajaPitcheoTexto, /sin vig 45\.3%/);
  assert.equal(analysis.ventajaOfensivaTexto, null, "no-string intacto");
  assert.equal(analysis.factoresClave[1], 42, "factor no-string intacto");
  assert.equal(analysis.totalCarreras.lineaMercado, 7, "campos estructurados intactos");
  assert.equal(analysis.picks[0].cuotaReal, -142);
  assert.equal(relabelImpliedNoVigNarratives(null, MERCADO_547), null, "analysis null no explota");
});

test("orden de integración: relabelImpliedNoVigNarratives corre DESPUÉS del cálculo de mercado", () => {
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const iMercado = src.indexOf("analysis.mercado = mercado");
  const iRelabel = src.indexOf("relabelImpliedNoVigNarratives(analysis, mercado)");
  assert.ok(iMercado > -1 && iRelabel > -1, "ambas llamadas existen");
  assert.ok(iMercado < iRelabel, "el relabel necesita el mercado ya calculado");
});
