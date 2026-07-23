/*
 * Verificación de picks contra el snapshot de odds congelado — en código,
 * nunca confiando en las cuotas que el LLM escriba en texto.
 *
 * Reglas:
 *  - Moneyline: no se toca (allí sí existen probLocal, mercado sin vig y EV
 *    calculado por el servidor).
 *  - Run Line / Total: la cuota SOLO puede venir del outcome exacto
 *    (mismo equipo/lado Y misma línea) del bookmaker registrado.
 *      · Lado no listado → "SIN CUOTA", análisis cualitativo, sin cuota heredada.
 *      · Lado listado → cuota real adjunta, PERO no existe probabilidad numérica
 *        del modelo para estos mercados, así que el EV no es calculable:
 *        el badge financiero (VALOR ALTO/MEDIO/BAJO) se convierte en señal
 *        cualitativa (SEÑAL ALTA/MEDIA/BAJA) y se marca evCalculado=false.
 *  - Prop: sin fuente de líneas → SIEMPRE "Prop para revisar", sin cuota,
 *    sin EV, fuera de ROI.
 *  - Sanitización financiera: en RL/Total/Props la razón del LLM se limpia
 *    de cuotas americanas y afirmaciones de valor ANTES de mostrarse — se
 *    conserva solo el razonamiento deportivo. Aplicada en código, post-parseo.
 */

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
const UNVERIFIED_NOTE = "⚠️ Cuota exacta no verificada. Análisis cualitativo; no entra a ROI ni a la muestra oficial.";
const VERIFIED_NOTE   = "CUOTA VERIFICADA · EV NO CALCULADO — La línea y cuota coinciden con el mercado registrado, pero no existe probabilidad numérica del modelo para calcular EV. No entra a ROI ni a la muestra oficial.";
const PROP_NOTE       = "⚠️ Línea y cuota no verificadas. No entra a ROI ni a la muestra oficial.";

/* Badge financiero → señal cualitativa (RL/Total sin EV calculable) */
const SENAL = { ALTO: "SEÑAL ALTA", MEDIO: "SEÑAL MEDIA", BAJO: "SEÑAL BAJA" };

/* Cuota americana: signo + 3-4 dígitos enteros (+146, -120).
   NO matchea líneas deportivas (+1.5), ERA (3.15), porcentajes (59.4%). */
const ODDS_TOKEN = /[+-]\d{3,4}(?!\.?\d)/;
const FINANCIAL_CLAIM = /(ofrece\s+valor|valor\s+te[oó]rico|precio\s+atractivo|probabilidad\s+impl[ií]cita|ev\s+positivo|valor\s+esperado|valor\s+real|rentab|cuota\s+atractiva|buen\s+precio|momio)/i;

/* Clasificaciones financieras residuales → lenguaje cualitativo equivalente.
   Se sustituye (no se borra la oración) para conservar el razonamiento. */
const SENAL_WORD = { alto: "alta", alta: "alta", medio: "media", media: "media", bajo: "baja", baja: "baja" };

export function replaceFinancialLanguage(text) {
  const senal = (match, grado) =>
    (match[0] === match[0].toUpperCase() ? "Señal " : "señal ") + SENAL_WORD[grado.toLowerCase()];
  return String(text ?? "")
    .replace(/\bpicks?\s+de\s+valor\s+(alto|alta|medio|media|bajo|baja)\b/gi, senal)
    .replace(/\bvalor\s+(alto|alta|medio|media|bajo|baja)\b/gi, senal)
    .replace(/\b(?:el\s+)?precio\s+inflado\b/gi, "el costo elevado de la cuota")
    .replace(/\bmejor\s+valor\b/gi, "mejor perfil cualitativo");
}

/**
 * Sanitización en dos pasos: primero sustituye clasificaciones financieras
 * residuales por lenguaje cualitativo (la oración sobrevive), luego elimina
 * las oraciones que aún contengan cuotas americanas o afirmaciones de valor,
 * conservando el razonamiento deportivo (ERA, OPS, %, ±1.5…).
 */
export function sanitizeFinancialClaims(text) {
  if (!text) return "";
  const sentences = replaceFinancialLanguage(text).split(/(?<=[.!?])\s+/);
  return sentences
    .filter(s => !ODDS_TOKEN.test(s) && !FINANCIAL_CLAIM.test(s))
    .join(" ")
    .trim();
}

/* ─── Enforcement .5: rankings, hype y cuotas narrativas ─────────── */

/**
 * Rankings de liga/MLB no verificables → lenguaje seguro con el mismo resto
 * de la oración. Patrones ESTRECHOS: exigen contexto MLB/liga para no tocar
 * "líder del bullpen", "K% 27.3", "récord 7-3" ni métricas legítimas.
 */
export function sanitizeUnverifiedRankings(text) {
  return String(text ?? "")
    .replace(/\blidera\s+(?:la\s+)?(?:MLB|liga)\b/gi, "presenta métricas de élite")
    .replace(/\bl[ií]der\s+de\s+(?:la\s+)?(?:MLB|liga)\b/gi, "perfil de élite")
    .replace(/\b(?:el\s+)?mejor\s+de\s+(?:la\s+)?(?:MLB|liga)\b/gi, "de élite")
    .replace(/\bn[úu]mero\s+uno\s+de\s+(?:la\s+)?(?:MLB|liga)\b/gi, "de élite")
    .replace(/#\s?1\s+de\s+(?:la\s+)?(?:MLB|liga)\b/gi, "de élite")
    .replace(/\btop[-\s]?\d+\s+(?:de|en)\s+(?:la\s+)?(?:MLB|liga)\b/gi, "de élite");
}

/** Lenguaje de hype financiero → moderado. No toca el EV estructurado. */
export function degradeHypeLanguage(text) {
  return String(text ?? "")
    .replace(/\bvalor\s+claro\b/gi, "ventaja moderada")
    .replace(/\bgran\s+valor\b/gi, "ventaja moderada")
    .replace(/\bapuesta\s+obligada\b/gi, "opción con ventaja moderada")
    .replace(/\bfree\s+money\b/gi, "ventaja moderada")
    .replace(/\block\b/g, "opción con ventaja moderada");
}

/**
 * Pulido estrecho: evita la frase rara "no una apuesta de ventaja..." sin
 * borrar la idea importante de edge bajo. No toca cuotas, equipos ni métricas.
 */
export function fixAwkwardValueWording(text) {
  return String(text ?? "")
    .replace(
      /\bVentaja\s+moderada\s+identificada\s+por\s+el\s+modelo,\s*no\s+(?:es\s+)?una\s+apuesta\s+de\s+ventaja\s+(?:moderada|alta|baja)\.?/gi,
      "Ventaja identificada por el modelo, pero edge de mercado bajo."
    )
    .replace(
      /\bno\s+(?:es\s+)?una\s+apuesta\s+de\s+ventaja\s+(?:moderada|alta|baja)\b/gi,
      "edge de mercado bajo"
    );
}

/**
 * Si el servidor/LLM ya marcó UNDER, "margen sobre la línea" invierte el
 * sentido visual. Solo reescribe el texto; conserva proyección, margen y línea.
 */
export function fixUnderTotalMarginWording(text, recommendation) {
  if (recommendation !== "UNDER") return String(text ?? "");
  return String(text ?? "").replace(
    /\b((?:Proyecci[oó]n|proyecci[oó]n)[^.!?]*?\d+(?:[.,]\d+)?\s+carreras?)\s+(?:ofrece|tiene|presenta)\s+(?:un\s+)?margen\s+de\s+(\d+(?:[.,]\d+)?)\s+sobre\s+la\s+l[ií]nea\s+(\d+(?:[.,]\d+)?)/g,
    "$1 queda $2 por debajo de la línea $3"
  );
}

/**
 * Comparaciones numéricas contra la línea de total. Solo actúa si la frase
 * trae contexto de proyección/carreras y dos números claros.
 */
export function fixTotalLineComparisonWording(text) {
  return String(text ?? "").replace(
    /\b((?:Proyecci[oó]n|proyecci[oó]n)[^.!?]*?(\d+(?:[.,]\d+)?)[^.!?]*?\b(?:carreras?)?[^.!?]*?\b(?:est[áa]\s+|queda\s+)?(?:marginalmente\s+)?)por\s+(debajo|encima)\s+de\s+la\s+l[ií]nea(?:\s+de)?\s+(\d+(?:[.,]\d+)?)/gi,
    (m, prefix, aStr, dir, bStr) => {
      const a = parseFloat(String(aStr).replace(",", "."));
      const b = parseFloat(String(bStr).replace(",", "."));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return m;
      const actual = a > b ? "encima" : "debajo";
      return dir.toLowerCase() === actual ? m : `${prefix}por ${actual} de la línea ${bStr}`;
    }
  );
}

/**
 * Narrativa de Moneyline: elimina oraciones que citen una cuota americana
 * DISTINTA a la congelada, o que hablen de probabilidad implícita bruta.
 * La cuota real (si coincide) y los porcentajes deportivos sobreviven.
 */
export function stripMismatchedOdds(text, allowedPrice) {
  if (!text) return text ?? "";
  const sentences = String(text).split(/(?<=[.!?])\s+/);
  return sentences.filter(s => {
    if (/impl[ií]cit[oa]/i.test(s)) return false;
    const tokens = s.match(/[+-]\d{3,4}(?!\.?\d)/g) ?? [];
    return tokens.every(t => allowedPrice != null && Number(t) === Number(allowedPrice));
  }).join(" ").trim();
}

/**
 * Sanitización global de campos narrativos del análisis (rankings + hype).
 * Muta el objeto recibido y lo devuelve. Los campos estructurados del
 * servidor (mercado, EV, cuotaReal, lineaMercado) no se tocan.
 */
export function sanitizeNarratives(analysis) {
  if (!analysis || typeof analysis !== "object") return analysis;
  /* fixMoneylineWording también aquí: la implícita bruta entre paréntesis
     confunde junto a la probabilidad sin vig oficial, en CUALQUIER campo */
  const clean = (t) => fixTotalLineComparisonWording(fixAwkwardValueWording(degradeHypeLanguage(sanitizeUnverifiedRankings(sanitizeOffensiveComparisons(fixMetricComparisons(fixMoneylineWording(t)))))));
  if (typeof analysis.resumen === "string") analysis.resumen = clean(analysis.resumen);
  if (typeof analysis.ventajaPitcheoTexto === "string") analysis.ventajaPitcheoTexto = clean(analysis.ventajaPitcheoTexto);
  if (typeof analysis.ventajaOfensivaTexto === "string") analysis.ventajaOfensivaTexto = clean(analysis.ventajaOfensivaTexto);
  if (Array.isArray(analysis.factoresClave)) {
    analysis.factoresClave = analysis.factoresClave.map(f => typeof f === "string" ? clean(f) : f);
  }
  if (typeof analysis.prediccion?.razon === "string") analysis.prediccion.razon = clean(analysis.prediccion.razon);
  if (typeof analysis.totalCarreras?.razon === "string") {
    analysis.totalCarreras.razon = fixUnderTotalMarginWording(
      clean(analysis.totalCarreras.razon),
      analysis.totalCarreras.recomendacion
    );
  }
  if (Array.isArray(analysis.picks)) {
    for (const p of analysis.picks) {
      if (typeof p?.razon !== "string") continue;
      const side = norm(p.tipo).startsWith("total") && /\bunder\b/i.test(p.pick ?? "") ? "UNDER" : null;
      p.razon = fixUnderTotalMarginWording(clean(p.razon), side);
    }
  }
  return analysis;
}

/**
 * Línea de mercado AUTORITARIA para el total, desde totals.point del book
 * preferido del snapshot congelado. La narrativa no puede citar una línea
 * distinta: se corrige al valor real, o se despersonaliza si no hay línea.
 */
export function attachMarketTotalLine(totalCarreras, oddsGame) {
  if (!totalCarreras) return totalCarreras;
  const bk     = preferredBook(oddsGame);
  const totals = bk?.markets?.find(m => m.key === "totals");
  const rawPoint = totals?.outcomes?.find(o => o.point != null)?.point;
  const lineaMercado = rawPoint != null ? Number(rawPoint) : null;
  const t = { ...totalCarreras, lineaMercado };
  if (typeof t.razon === "string" && t.razon) {
    t.razon = t.razon.replace(
      /l[ií]nea(?:\s+(?:de|del)(?:\s+mercado)?)?\s+(?:de\s+)?(\d+(?:\.\d+)?)/gi,
      (m, num) => lineaMercado != null
        ? (Number(num) === lineaMercado ? m : m.replace(num, String(lineaMercado)))
        : "la línea del mercado"
    );
  }
  return t;
}

/* ─── Enforcement de consistencia de salida (misma .5) ────────────
   El LLM puede emitir badges/direcciones/verbos que contradicen los
   números del propio servidor. Estas funciones PURAS hacen cumplir los
   contratos ya existentes — no recalculan probabilidades ni EV: solo
   LEEN el objeto mercado ya calculado y los campos ya inyectados. */

/** Clasificación autoritaria del servidor. Los límites son no ambiguos:
 * <3 SIN VALOR · [3,6) BAJO · [6,10] MEDIO · >10 ALTO. */
export function classifyMlEv(ev) {
  if (!Number.isFinite(ev)) return null;
  if (ev < 3) return "SIN VALOR";
  if (ev < 6) return "BAJO";
  if (ev <= 10) return "MEDIO";
  return "ALTO";
}

/** Ambos edges ML desde probabilidades de mercado sin vig y del modelo. */
export function moneylineEdges(mercado) {
  const raw = [mercado?.probModeloLocal, mercado?.probMercadoLocal, mercado?.probMercadoVisitante];
  if (raw.some(v => v === null || v === undefined || v === "")) return null;
  const [modelHome, marketHome, marketAway] = raw.map(Number);
  if (![modelHome, marketHome, marketAway].every(Number.isFinite)) return null;
  return {
    home: modelHome - marketHome,
    away: (100 - modelHome) - marketAway,
  };
}

/**
 * Clasifica cada Moneyline exclusivamente por su EV del servidor, sin aceptar
 * que el badge emitido por el LLM eleve o reduzca el nivel. Conserva cuota,
 * verificación y la razón deportiva original.
 * EV por lado desde los campos existentes de mercado (en puntos %):
 *   local:     probModeloLocal − probMercadoLocal
 *   visitante: (100 − probModeloLocal) − probMercadoVisitante
 */
export function enforceMlValueConsistency(picks, mercado, homeName, awayName) {
  if (!Array.isArray(picks) || !moneylineEdges(mercado)) return picks;
  return picks.map(pick => {
    if (!norm(pick?.tipo).startsWith("moneyline")) return pick;
    const team = teamInText(pick.pick, homeName, awayName);
    if (team == null) return pick;                                  // lado no mapeable: no tocar
    const side = team === homeName ? "home" : "away";
    const edges = moneylineEdges(mercado);
    const ev = edges[side];
    if (!Number.isFinite(ev)) return pick;
    const evTxt = `${ev > 0 ? "+" : ""}${(Math.round(ev * 10) / 10).toFixed(1)}`;
    const valor = classifyMlEv(ev);
    const note = valor === "SIN VALOR"
      ? `EV del servidor: ${evTxt}% — edge insuficiente; no se recomienda como apuesta.`
      : valor === "BAJO"
        ? `EV del servidor: ${evTxt}% — valor bajo según umbral 3%-<6%.`
        : valor === "MEDIO"
          ? `EV del servidor: ${evTxt}% — valor medio según umbral 6%-10%.`
          : `EV del servidor: ${evTxt}% — valor alto según umbral superior a 10%.`;
    return { ...pick, valor, razon: `${note} ${pick.razon ?? ""}`.trim() };
  });
}

export const ML_ABSTENTION_REASON = "Edge insuficiente para recomendar una apuesta en este partido — ambas probabilidades dentro del margen de error del modelo";

/**
 * Si ningún lado ML alcanza 3%, agrega una sola tarjeta informativa de
 * abstención. Se calculan ambos lados aunque el LLM haya emitido un solo ML.
 */
export function appendMlAbstention(picks, mercado) {
  if (!Array.isArray(picks)) return picks;
  const edges = moneylineEdges(mercado);
  if (!edges) return picks;
  const withoutPrevious = picks.filter(p =>
    p?.abstencion !== true && norm(p?.tipo) !== "sinpickrecomendado"
  );
  if (edges.home >= 3 || edges.away >= 3) return withoutPrevious;
  return [...withoutPrevious, {
    tipo: "Sin pick recomendado",
    pick: "Abstenerse en Moneyline",
    valor: "SIN VALOR",
    riesgo: "N/A",
    abstencion: true,
    razon: ML_ABSTENTION_REASON,
  }];
}

/**
 * Ninguna narrativa final conserva "implícita/implícito": el LLM escribe la
 * implícita BRUTA (con vig) junto a la probabilidad sin vig oficial y las
 * dos se confunden. Si el porcentaje coincide (±0.2 pp) con probMercadoLocal
 * o probMercadoVisitante del snapshot, se re-etiqueta como lo que ES:
 * "probabilidad de mercado sin vig X%". Si NO coincide (implícita bruta
 * genuina), el número se elimina y queda la frase genérica "probabilidad de
 * mercado" — jamás se reinterpreta un número del LLM como sin vig.
 * mercado null → nada coincide → solo limpieza genérica. Puro sobre texto.
 */
const IMPLIED_TOLERANCE_PP = 0.2;

export function relabelImpliedNoVig(text, mercado) {
  let out = String(text ?? "");
  const noVig = [mercado?.probMercadoLocal, mercado?.probMercadoVisitante]
    .filter(v => Number.isFinite(v));
  const matchesNoVig = (numStr) => {
    const n = parseFloat(String(numStr).replace(",", "."));
    return Number.isFinite(n) && noVig.some(v => Math.abs(v - n) <= IMPLIED_TOLERANCE_PP);
  };
  const relabeled = (num) => matchesNoVig(num)
    ? `probabilidad de mercado sin vig ${num}%`
    : "probabilidad de mercado";
  /* "probabilidad implícita [de] [~]54.7%" — palabra primero */
  out = out.replace(
    /(?:la\s+)?prob(?:abilidad)?\.?\s+impl[ií]cit[oa]\s+(?:de\s+)?~?\s*(\d+(?:[.,]\d+)?)\s*%/gi,
    (m, num) => relabeled(num)
  );
  /* "[~]54.7% implícito" — número primero */
  out = out.replace(
    /(?:~\s*)?(\d+(?:[.,]\d+)?)\s*%\s+impl[ií]cit[oa]s?/gi,
    (m, num) => relabeled(num)
  );
  /* Red final: cualquier "implícita/o" restante (sin número adyacente)
     se neutraliza — la palabra no sobrevive en la narrativa final */
  out = out
    .replace(/\bprob(?:abilidad)?\.?\s+impl[ií]cit[oa]s?\b/gi, "probabilidad de mercado")
    .replace(/\bimpl[ií]cit[oa]s?\b/gi, "de mercado");
  return out;
}

/**
 * Aplica relabelImpliedNoVig a TODOS los campos narrativos del análisis.
 * Vive separado de sanitizeNarratives porque necesita el objeto mercado,
 * que se calcula DESPUÉS. Muta el objeto recibido y lo devuelve; los
 * campos no-string quedan intactos.
 */
export function relabelImpliedNoVigNarratives(analysis, mercado) {
  if (!analysis || typeof analysis !== "object") return analysis;
  const clean = (t) => typeof t === "string" ? relabelImpliedNoVig(t, mercado) : t;
  analysis.resumen             = clean(analysis.resumen);
  analysis.ventajaPitcheoTexto = clean(analysis.ventajaPitcheoTexto);
  analysis.ventajaOfensivaTexto = clean(analysis.ventajaOfensivaTexto);
  if (Array.isArray(analysis.factoresClave)) {
    analysis.factoresClave = analysis.factoresClave.map(clean);
  }
  if (analysis.prediccion)    analysis.prediccion.razon    = clean(analysis.prediccion.razon);
  if (analysis.totalCarreras) analysis.totalCarreras.razon = clean(analysis.totalCarreras.razon);
  if (Array.isArray(analysis.picks)) {
    for (const p of analysis.picks) if (p) p.razon = clean(p.razon);
  }
  return analysis;
}

/**
 * La dirección del total la dicta el signo de proyectado − lineaMercado:
 * positivo → OVER · negativo → UNDER · cero → conserva la recomendación.
 * La intensidad se clasifica por separado en enforceTotalProjectionMargin.
 * Un pick que contradiga la dirección numérica queda como SEÑAL NO OFICIAL.
 */
export function enforceTotalDirection(totalCarreras, picks) {
  const proy  = parseFloat(totalCarreras?.proyectado ?? totalCarreras?.estimado);
  const linea = totalCarreras?.lineaMercado != null ? Number(totalCarreras.lineaMercado) : NaN;
  if (!Number.isFinite(proy) || !Number.isFinite(linea)) {
    return { totalCarreras, picks };
  }
  const gap = proy - linea;
  let t = { ...totalCarreras };
  const dir = gap > 0 ? "OVER" : gap < 0 ? "UNDER" : null;
  if (dir) {
    if (t.recomendacion !== dir) {
      t.recomendacion = dir;
      t.razon = `Dirección corregida por el servidor: proyección ${proy} vs línea ${linea} → ${dir}. ${t.razon ?? ""}`.trim();
    }
  }
  let outPicks = picks;
  if (Array.isArray(picks) && dir) {
    outPicks = picks.map(pick => {
      if (!norm(pick?.tipo).startsWith("total")) return pick;
      const m = String(pick.pick ?? "").match(/\b(over|under)\b/i);
      if (!m) return pick;
      const side = m[1].toUpperCase();
      if (side === dir) return pick;
      return {
        ...pick,
        valor: "SEÑAL NO OFICIAL",
        noOficial: true,
        razon: `⚠️ Pick inconsistente con la dirección del servidor (proyección ${proy} vs línea ${linea} → ${dir}). ${pick.razon ?? ""}`.trim(),
      };
    });
  }
  return { totalCarreras: t, picks: outPicks };
}

export const TOTAL_MIN_PROJECTION_MARGIN = 1.5;
export const TOTAL_MARGIN_NOTE = "⚠️ Margen insuficiente — proyección dentro del rango de error del modelo vs línea de mercado";

function completedTotalFactors(totalCarreras) {
  const factors = totalCarreras?.factores;
  if (!factors || typeof factors !== "object") return null;
  const values = [factors.cumplidos, factors.parciales, factors.noCumplidos];
  if (values.some(v => !Number.isInteger(v) || v < 0 || v > 4)) return null;
  if (values.reduce((sum, value) => sum + value, 0) !== 4) return null;
  return factors.cumplidos;
}

function appendOnce(text, note) {
  const base = String(text ?? "").trim();
  if (base.includes(note)) return base;
  return base ? `${base} ${note}` : note;
}

/**
 * Clasificación autoritaria del Total usando distancia vs mercado y factores:
 * |spread| < 1.5 → BAJA · >= 1.5 con 4/4 → ALTA · con 3/4 → MEDIA.
 * Conteo ausente/inválido o 0-2/4 → BAJA. El spread firmado se conserva a
 * una decimal para presentación, pero el umbral se evalúa sin redondear.
 */
export function enforceTotalProjectionMargin(totalCarreras, picks) {
  const proy  = parseFloat(totalCarreras?.proyectado ?? totalCarreras?.estimado);
  const linea = totalCarreras?.lineaMercado != null ? Number(totalCarreras.lineaMercado) : NaN;
  if (!Number.isFinite(proy) || !Number.isFinite(linea)) {
    return { totalCarreras, picks };
  }

  const spread = proy - linea;
  const insufficient = Math.abs(spread) < TOTAL_MIN_PROJECTION_MARGIN;
  const fulfilled = completedTotalFactors(totalCarreras);
  const valor = insufficient
    ? "SEÑAL BAJA"
    : fulfilled === 4
      ? "SEÑAL ALTA"
      : fulfilled === 3
        ? "SEÑAL MEDIA"
        : "SEÑAL BAJA";
  const t = {
    ...totalCarreras,
    spreadModeloMercado: Math.round(spread * 10) / 10,
    razon: insufficient ? appendOnce(totalCarreras?.razon, TOTAL_MARGIN_NOTE) : totalCarreras?.razon,
  };

  const outPicks = Array.isArray(picks)
    ? picks.map(pick => {
      if (!norm(pick?.tipo).startsWith("total")) return pick;
      if (pick.noOficial === true || pick.valor === "SEÑAL NO OFICIAL") return pick;
      return {
        ...pick,
        valor,
        razon: insufficient ? appendOnce(pick.razon, TOTAL_MARGIN_NOTE) : pick.razon,
      };
    })
    : picks;

  return { totalCarreras: t, picks: outPicks };
}

/**
 * La narrativa no puede contradecir sus propios números.
 * Patrones ESTRECHOS (métrica + número + comparador + ERA + número):
 *  - "xERA 4.78 supera ERA 5.40" (falso: 4.78 < 5.40) → verbo corregido.
 *  - "FIP mayor que ERA … peores que el proceso" → mapeo semántico corregido
 *    (mayor = resultados MEJORES que el proceso → posible deterioro).
 * Métricas sueltas ("xERA 3.10", "K/9 11.2") jamás se tocan.
 */
const CMP_ABOVE = /supera(?:\s+(?:a|al|el|su))?|es\s+mayor\s+que|mayor\s+que|por\s+encima\s+de(?:l)?|excede(?:\s+(?:a|al|el|su))?/i;

export function fixPitchingThresholdWording(text) {
  return String(text ?? "").replace(
    /\bERA(?:\s+de)?\s+(\d+(?:\.\d+)?)\s+((?:est[áa]\s+)?por\s+(encima|debajo)\s+de(?:l)?)(?:\s+(?:umbral|regla))?(?:\s+de)?\s+(\d+(?:\.\d+)?)/gi,
    (m, aStr, cmp, dir, bStr) => {
      const a = parseFloat(aStr), b = parseFloat(bStr);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return m;
      const actual = a > b ? "encima" : "debajo";
      if (dir.toLowerCase() === actual) return m;
      return `ERA ${aStr} está por ${actual} de ${bStr}`;
    }
  );
}

export function fixMetricComparisons(text) {
  let out = fixPitchingThresholdWording(text);

  /* Comparación numérica explícita metric A <cmp> ERA B. Tolera "de" entre
     métrica y número ("xERA de 4.62 supera ERA 5.13") y "está por encima". */
  const CMP_VERBS = "supera(?:\\s+(?:a|al|el|su))?|es\\s+mayor\\s+que|mayor\\s+que|(?:está\\s+)?por\\s+encima\\s+de(?:l)?|excede(?:\\s+(?:a|al|el|su))?|es\\s+menor\\s+que|menor\\s+que|(?:está\\s+)?por\\s+debajo\\s+de(?:l)?";
  out = out.replace(
    new RegExp(`\\b(xERA|xFIP|FIP)(?:\\s+de)?\\s+(\\d+(?:\\.\\d+)?)\\s+(${CMP_VERBS})\\s+(?:el\\s+|su\\s+)?ERA(?:\\s+de)?\\s+(\\d+(?:\\.\\d+)?)`, "gi"),
    (m, metric, aStr, cmp, bStr) => {
      const a = parseFloat(aStr), b = parseFloat(bStr);
      const saysAbove = CMP_ABOVE.test(cmp);
      const isAbove   = a > b;
      if (saysAbove === isAbove) return m;                          // verbo correcto: intacto
      return isAbove
        ? `${metric} ${aStr} está por encima del ERA ${bStr}`
        : `${metric} ${aStr} está por debajo del ERA ${bStr}`;
    }
  );

  /* Espejo: ERA A <cmp> xERA/xFIP/FIP B — misma corrección de verbo */
  out = out.replace(
    new RegExp(`\\bERA(?:\\s+de)?\\s+(\\d+(?:\\.\\d+)?)\\s+(${CMP_VERBS})\\s+(?:el\\s+|su\\s+)?(xERA|xFIP|FIP)(?:\\s+de)?\\s+(\\d+(?:\\.\\d+)?)`, "gi"),
    (m, aStr, cmp, metric, bStr) => {
      const a = parseFloat(aStr), b = parseFloat(bStr);
      const saysAbove = CMP_ABOVE.test(cmp);
      const isAbove   = a > b;
      if (saysAbove === isAbove) return m;
      return isAbove
        ? `ERA ${aStr} está por encima del ${metric} ${bStr}`
        : `ERA ${aStr} está por debajo del ${metric} ${bStr}`;
    }
  );

  /* Mapeo semántico: mayor que ERA = resultados MEJORES que el proceso;
     menor que ERA = resultados PEORES que el proceso */
  out = out.replace(
    /\b(xERA|xFIP|FIP)\s+(mayor|menor)\s+que\s+(?:el\s+|su\s+)?ERA\b([^.!?]*?)\b(peores|mejores)(\s+que\s+el\s+proceso)/gi,
    (m, metric, cmp, middle, word, tail) => {
      const correcto = cmp.toLowerCase() === "mayor" ? "mejores" : "peores";
      return word.toLowerCase() === correcto ? m : `${metric} ${cmp} que ERA${middle}${correcto}${tail}`;
    }
  );

  return out;
}

const OFFENSIVE_METRIC = "OPS|AVG|OBP|SLG|xwOBA|Barrel%|Hard Hit%|Exit Velo";
const TEAM_WORD = "[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.'-]*";
const TEAM_NAME = `${TEAM_WORD}(?:\\s+${TEAM_WORD}){0,3}`;
const LEAD_CLAIM = "(?:tiene|presenta|muestra|posee|registra)?\\s*(?:mejor|lidera|supera|est[áa]\\s+por\\s+encima|aventaja)";
const OFFENSIVE_CONTRADICTION = new RegExp(
  `\\b(${TEAM_NAME})\\s+${LEAD_CLAIM}\\s+([^.!?]*?\\b(${OFFENSIVE_METRIC})\\b[^.!?]*?)` +
  `\\(?\\s*(\\d+(?:\\.\\d+)?|\\.\\d+)\\s*(%)?\\s+vs\\s+(\\d+(?:\\.\\d+)?|\\.\\d+)\\s*(%)?` +
  `([^.!?]*?\\ba\\s+favor\\s+de\\s+(${TEAM_NAME}))?[^.!?]*`,
  "gi"
);

/**
 * Comparaciones ofensivas entre equipos: si la oración afirma que A tiene la
 * mejor métrica pero los dos números claros favorecen al equipo B nombrado,
 * se corrige con una frase segura. Sin equipo B confiable, se elimina solo
 * esa oración. Métricas sueltas y tablas quedan intactas.
 */
export function sanitizeOffensiveComparisons(text) {
  if (text == null) return "";
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map(sentence => {
      if (!sentence || sentence.includes("|")) return sentence;
      return sentence.replace(
        OFFENSIVE_CONTRADICTION,
        (m, teamA, _middle, metric, aStr, aPct, bStr, bPct, _favChunk, teamB) => {
          const a = parseFloat(aStr), b = parseFloat(bStr);
          if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) return m;
          if (!teamB) return "";
          const pct = aPct || bPct ? "%" : "";
          return `${teamB} tiene mejor ${metric} de temporada (${bStr}${pct} vs ${aStr}${pct}), aunque la diferencia general es mínima`;
        }
      );
    })
    .filter(s => s.trim() && !/^[\s.!?]*$/.test(s))
    .join(" ")
    .trim();
}

/* Moneyline: un porcentaje "implícito" escrito por el LLM no puede
   reinterpretarse como probabilidad sin vig (solo coinciden en mercados
   simétricos). El paréntesis se ELIMINA completo — la probabilidad sin vig
   oficial vive únicamente en la tarjeta "Modelo vs Mercado", calculada por
   el servidor. Cambio lingüístico conservado: "A precio" → "A cuota".
   Badge VALOR, cuota, probabilidad del modelo y EV quedan intactos. */
export function fixMoneylineWording(text) {
  return fixAwkwardValueWording(String(text ?? "")
    /* "(implícita ~55.7%)" — palabra primero */
    .replace(/\s*\((?:prob(?:abilidad)?\.?\s+)?impl[ií]cit[oa]\s+~?\s*(?:de\s+)?~?\s*\d+(?:[.,]\d+)?\s*%\)/gi, "")
    /* "(46.3% implícito)" — número primero */
    .replace(/\s*\(\s*~?\d+(?:[.,]\d+)?\s*%\s+impl[ií]cit[oa]s?\s*\)/gi, "")
    .replace(/\b([Aa]) precio\b/g, "$1 cuota"));
}

function preferredBook(oddsGame) {
  if (!oddsGame?.bookmakers?.length) return null;
  return oddsGame.bookmakers.find(b => ["draftkings", "fanduel", "betmgm"].includes(b.key))
      ?? oddsGame.bookmakers[0];
}

/** Extrae el equipo mencionado en el texto del pick (home o away). */
function teamInText(text, homeName, awayName) {
  const t = norm(text);
  if (t.includes(norm(homeName))) return homeName;
  if (t.includes(norm(awayName))) return awayName;
  return null;
}

/** Primera línea con formato ±N.5 en el texto (p.ej. "-1.5" de "Tigers -1.5"). */
function pointInText(text) {
  const m = String(text ?? "").match(/([+-]\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/* Frases de "cuota no disponible" escritas por el LLM ANTES de que el
   servidor adjuntara la cuota real: en un pick verificado son contradictorias
   y se eliminan a nivel de oración. Solo narrativa; los campos estructurados
   (cuotaReal, verificado, valor, evCalculado) no pasan por aquí. */
const STALE_ODDS_CLAIM = /(cuota\s+no\s+disponible|no\s+est[áa]\s+listad[ao]|l[ií]neas\s+de\s+mercado\s+no\s+(?:incluyen|listan)|el\s+servidor\s+adjuntar[áa]|\bsin\s+cuota\b|no\s+hay\s+cuota)/i;
const VERIFIED_FALLBACK_RAZON = "Cuota verificada por el servidor; no existe EV porque no hay probabilidad numérica del modelo para este mercado.";

export function stripContradictoryOddsClaims(text) {
  if (!text) return "";
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .filter(s => !STALE_ODDS_CLAIM.test(s))
    .join(" ")
    .trim();
}

/* Run Line caro sin EV calculado: la cuota se conserva tal cual, pero el
   lenguaje no puede sonar confiado — advertencia fija, sin cambiar categoría. */
export const RL_EXPENSIVE_PRICE = -180;

/** Lado verificado: cuota real, badge degradado a señal, EV no calculable. */
function verifiedResult(pick, out) {
  let razon = stripContradictoryOddsClaims(sanitizeFinancialClaims(pick.razon));
  if (!razon) razon = VERIFIED_FALLBACK_RAZON;
  if (norm(pick.tipo).startsWith("runline") && out.price <= RL_EXPENSIVE_PRICE) {
    razon = `${razon} Precio elevado (${out.price}); sin EV calculado no se puede confirmar valor.`;
  }
  return {
    ...pick,
    verificado:  true,
    cuotaReal:   out.price,
    lineaReal:   out.point,
    evCalculado: false,
    valor:       SENAL[pick.valor] ?? "SEÑAL",
    razon:       `${VERIFIED_NOTE} ${razon}`.trim(),
  };
}

function unverifiedResult(pick) {
  return {
    ...pick,
    verificado:  false,
    cuotaReal:   null,
    evCalculado: false,
    valor:       "SIN CUOTA",
    razon:       `${UNVERIFIED_NOTE} ${sanitizeFinancialClaims(pick.razon)}`.trim(),
  };
}

function verifyRunLine(pick, oddsGame, homeName, awayName) {
  const bk      = preferredBook(oddsGame);
  const spreads = bk?.markets?.find(m => m.key === "spreads");
  const team    = teamInText(pick.pick, homeName, awayName);
  const point   = pointInText(pick.pick);

  if (spreads && team != null && point != null) {
    const out = spreads.outcomes?.find(
      o => norm(o.name) === norm(team) && Number(o.point) === point
    );
    if (out && out.price != null) return verifiedResult(pick, out);
  }
  return unverifiedResult(pick);
}

function verifyTotal(pick, oddsGame) {
  const bk     = preferredBook(oddsGame);
  const totals = bk?.markets?.find(m => m.key === "totals");
  const m      = String(pick.pick ?? "").match(/(over|under)[^\d]*(\d+(?:\.\d+)?)/i);
  const side   = m ? (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) : null;
  const point  = m ? parseFloat(m[2]) : null;

  if (totals && side && point != null) {
    const out = totals.outcomes?.find(o => o.name === side && Number(o.point) === point);
    if (out && out.price != null) return verifiedResult(pick, out);
  }
  return unverifiedResult(pick);
}

export function verifyPick(pick, oddsGame, homeName, awayName) {
  const tipo = norm(pick?.tipo);
  if (tipo.startsWith("prop")) {
    return {
      ...pick,
      tipo:        "Prop para revisar",
      verificado:  false,
      cuotaReal:   null,
      evCalculado: false,
      valor:       "SIN VERIFICAR",
      razon:       `${PROP_NOTE} ${sanitizeFinancialClaims(pick.razon)}`.trim(),
    };
  }
  if (tipo.startsWith("runline")) return verifyRunLine(pick, oddsGame, homeName, awayName);
  if (tipo.startsWith("total"))   return verifyTotal(pick, oddsGame);
  if (tipo.startsWith("moneyline")) {
    /* Cuota OFICIAL adjunta desde el snapshot congelado (lado del pick).
       Badge VALOR, probLocal y EV del servidor quedan intactos; la narrativa
       no puede citar una cuota distinta a la congelada ni "implícitas". */
    const bk   = preferredBook(oddsGame);
    const h2h  = bk?.markets?.find(m => m.key === "h2h");
    const team = teamInText(pick.pick, homeName, awayName);
    const out  = team != null
      ? h2h?.outcomes?.find(o => norm(o.name) === norm(team))
      : null;
    const cuotaReal = out?.price ?? null;
    const res = { ...pick };
    if (res.razon != null) {
      res.razon = stripMismatchedOdds(fixMoneylineWording(res.razon), cuotaReal);
    }
    if (cuotaReal != null) {
      res.cuotaReal  = cuotaReal;
      res.verificado = true;
    }
    return res;
  }
  return { ...pick }; // tipos desconocidos: sin cambios
}

export function verifyPicks(picks, oddsGame, homeName, awayName) {
  if (!Array.isArray(picks)) return picks;
  return picks.map(p => verifyPick(p, oddsGame, homeName, awayName));
}

/**
 * Narrativa de TOTAL DE CARRERAS: no existe probabilidad numérica del modelo
 * para el total, así que la redacción no puede afirmar valor financiero.
 * Convierte VALOR→SEÑAL, elimina oraciones con cuotas o afirmaciones de valor
 * y cierra con la aclaración fija de EV no calculable.
 */
export function sanitizeTotalNarrative(totalCarreras) {
  if (!totalCarreras) return totalCarreras;
  let razon = String(totalCarreras.razon ?? "")
    .replace(/\bVALOR\s+ALT[OA]\b/gi,  "SEÑAL ALTA")
    .replace(/\bVALOR\s+MEDI[OA]\b/gi, "SEÑAL MEDIA")
    .replace(/\bVALOR\s+BAJ[OA]\b/gi,  "SEÑAL BAJA");
  razon = razon
    .split(/(?<=[.!?])\s+/)
    .filter(s => !ODDS_TOKEN.test(s) && !FINANCIAL_CLAIM.test(s) && !/tiene\s+valor/i.test(s))
    .join(" ")
    .trim();
  const lado = totalCarreras.recomendacion === "UNDER" ? "Under"
             : totalCarreras.recomendacion === "OVER"  ? "Over"
             : "total recomendado";
  const nota = `El perfil deportivo favorece al ${lado}, pero no existe una probabilidad numérica del modelo para calcular EV.`;
  return { ...totalCarreras, razon: razon ? `${razon} ${nota}` : nota };
}
