/*
 * Fase 2 de 2026-07-02.5 — regresión sobre el texto del prompt y la versión.
 * Estos tests leen server/index.js como fuente: si alguien borra o invierte
 * una regla, la suite falla.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";

const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");

test("LOGIC_VERSION es 2026-07-02.5 con historial documentado", () => {
  assert.match(src, /const LOGIC_VERSION = "2026-07-02\.5"/);
  assert.match(src, /\.5 = Statcast ofensivo real/, "el historial del bump debe estar documentado");
  const definitions = src.match(/const LOGIC_VERSION =/g);
  assert.equal(definitions.length, 1, "una sola definición de LOGIC_VERSION");
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
  assert.match(src, /Radar de Ponches con game logs reales: NO los conviertas en pick Prop/);
  assert.match(src, /revisar en Radar de Ponches/);
  assert.match(src, /Ningún prop se vuelve pick oficial sin línea y cuota verificadas/);
});
