/*
 * Reglas del prompt y versionado — regresión de contratos estratégicos.
 * Estos tests leen server/index.js como fuente: si alguien borra o invierte
 * una regla, la suite falla.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";

const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");

test("LOGIC_VERSION es 2026-07-23.8 con historial documentado", () => {
  assert.match(src, /const LOGIC_VERSION = "2026-07-23\.8"/);
  assert.match(src, /\.5 = Statcast ofensivo real/, "el historial del bump debe estar documentado");
  assert.match(src, /\.6 = Totales requieren 4\/4 para señal alta/, "el cambio estratégico debe quedar documentado");
  assert.match(src, /\.7 = picks sugeridos no oficiales desde Radar de Bateadores\/Ponches/, "la integración de Radar debe quedar documentada");
  assert.match(src, /\.8 = umbrales EV ML 3\/6\/10/, "los nuevos umbrales y la abstención deben quedar documentados");
  const definitions = src.match(/const LOGIC_VERSION =/g);
  assert.equal(definitions.length, 1, "una sola definición de LOGIC_VERSION");
});

test("prompt: pitcher con menos de 30 IP recibe regresión 40% y advertencia exacta", () => {
  assert.match(src, /REGLA DE MUESTRA PEQUEÑA DEL PITCHER/);
  assert.match(src, /menos de 30 IP en la temporada/);
  assert.match(src, /métrica ajustada = media de referencia \+ 0\.60 × \(métrica observada − media de referencia\)/);
  assert.match(src, /NO multipliques directamente la métrica por 0\.60/);
  assert.match(src, /concede únicamente 60% del peso analítico/);
  assert.match(src, /MUESTRA PEQUEÑA — métricas con baja confianza estadística/);
  assert.match(src, /Exactamente 30 IP no activa esta penalización/);
  assert.match(src, /IP ausente se trata como confianza desconocida/);
});

test("prompt: Totales requieren 4/4; con menos bajan a BAJO y llevan ambas notas", () => {
  assert.match(src, /ÚNICAMENTE si se cumplen 4 de 4 factores puedes usar "ALTO"/);
  assert.match(src, /Si se cumplen 0, 1, 2 o 3 factores, usa OBLIGATORIAMENTE "BAJO"/);
  assert.match(src, /no uses "MEDIO"/);
  assert.match(src, /⚠️ Total con incertidumbre alta — no recomendado para parlay/);
  assert.match(src, /Este pick es referencial — la estrategia óptima del sistema favorece Props de pitchers y Moneylines correlacionados sobre Totales con incertidumbre/);
  assert.match(src, /solo 4 factores plenamente cumplidos satisfacen la regla de 4\/4/);
  assert.doesNotMatch(src, /Si se cumplen 3 o 4 factores/);
  assert.doesNotMatch(src, /Si se cumplen menos de 3/);
});

test("prompt: reglas explícitas de LOB% en ambas direcciones, sin certezas", () => {
  assert.match(src, /LOB% bajo \(<~68%\) PUEDE sugerir mejora futura/);
  assert.match(src, /no garantía/);
  assert.match(src, /NUNCA una razón automática de empeoramiento del ERA/);
  assert.match(src, /LOB% alto \(>~78%\) sugiere riesgo de regresión negativa/);
  assert.match(src, /K% alto puede sostener PARCIALMENTE un LOB% alto/);
  assert.match(src, /jamás afirmes la regresión como certeza/);
});

test("prompt: dirección ERA vs xERA/FIP explícita en ambos sentidos + señales mixtas", () => {
  assert.match(src, /xERA MENOR que ERA = los resultados reales fueron PEORES que el proceso → posible MEJORA/);
  assert.match(src, /xERA MAYOR que ERA = los resultados reales fueron MEJORES que el proceso → posible DETERIORO/);
  assert.match(src, /FIP MENOR que ERA → posible mejora\. FIP MAYOR que ERA → posible deterioro\./);
  assert.match(src, /menos de ~0\.50\) NO justifican conclusiones fuertes/);
  assert.match(src, /señales mixtas/);
  assert.match(src, /baja confianza/);
  // El fragmento ambiguo viejo debe haber desaparecido
  assert.ok(!src.includes("xERA vs ERA real indica suerte/regresión esperada"), "la frase ambigua original fue reemplazada");
});

test("prompt: coherencia con mercado oficial — sin cuotas inventadas ni EV recalculado", () => {
  assert.match(src, /REGLA DE COHERENCIA CON MERCADO OFICIAL/);
  assert.match(src, /ÚNICA fuente oficial de cuota, probabilidad sin vig y EV/);
  assert.match(src, /No inventes cuotas, no recalcules EV/);
  assert.match(src, /probabilidad implícita bruta como si fuera probabilidad sin vig/);
  assert.match(src, /ventaja moderada identificada por el modelo/);
  assert.match(src, /nunca "valor claro", "apuesta obligada"/);
});

test("prompt: rankings no verificados prohibidos con alternativas de lenguaje", () => {
  assert.match(src, /REGLA ANTI-RANKINGS/);
  assert.match(src, /PROHIBIDO afirmar posiciones de liga/);
  assert.match(src, /"lidera MLB"/);
  assert.match(src, /"top 5", "top 10"/);
  assert.match(src, /NO recibe rankings calculados/);
  assert.match(src, /K\/9 de élite \(11\.2\)/, "debe ofrecer el lenguaje sustituto con valor real");
});

test("esquema: totalCarreras.proyectado presente con estimado como alias compatible", () => {
  assert.match(src, /"totalCarreras":\{"proyectado":"8\.9","estimado":"8\.9","recomendacion":"OVER\|UNDER","razon":"razón"\}/);
  assert.match(src, /REGLA DE TOTAL PROYECTADO VS LÍNEA REAL/);
  assert.match(src, /NO es la línea del sportsbook/);
  assert.match(src, /Nunca copies la línea del mercado como proyección/);
  // Compatibilidad en código: log y espejo bidireccional
  assert.match(src, /analysis\.totalCarreras\?\.estimado \?\? analysis\.totalCarreras\?\.proyectado \?\? null/);
  assert.match(src, /proyectado \?\?= analysis\.totalCarreras\.estimado/);
});

test("prompt: props de K de abridores remiten al Radar, sin pick oficial sin línea", () => {
  assert.match(src, /se validan posteriormente en el Radar de Ponches/);
  assert.match(src, /componente estratégico sin point ni cuota/);
  assert.match(src, /no debes convertirlos aquí en un pick Prop oficial/);
  assert.match(src, /Ningún prop se vuelve pick oficial sin línea y cuota verificadas/);
});

test("prompt: pitcher dominante prioriza parlay correlacionado ML + Over Ks con guardas", () => {
  assert.match(src, /REGLA DE CORRELACIÓN PITCHER DOMINANTE/);
  assert.match(src, /simultáneamente xERA bajo, Whiff% alto y K\/9 alto/);
  assert.match(src, /después de aplicar la REGLA DE SOPORTE OFENSIVO/);
  assert.match(src, /Moneyline del equipo \+ Over Ks del mismo pitcher/);
  assert.match(src, /Parlay correlacionado prioritario: \[Equipo\] Moneyline \+ Over Ks de \[Pitcher\] — validar línea y cuota en Radar de Ponches/);
  assert.match(src, /No inventes point ni cuota del Over Ks/);
  assert.match(src, /Si la ofensiva no respalda el Moneyline, no fuerces la correlación/);
});
