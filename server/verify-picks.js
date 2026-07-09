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
  const clean = (t) => degradeHypeLanguage(sanitizeUnverifiedRankings(fixMetricComparisons(fixMoneylineWording(t))));
  if (typeof analysis.resumen === "string") analysis.resumen = clean(analysis.resumen);
  if (typeof analysis.ventajaPitcheoTexto === "string") analysis.ventajaPitcheoTexto = clean(analysis.ventajaPitcheoTexto);
  if (typeof analysis.ventajaOfensivaTexto === "string") analysis.ventajaOfensivaTexto = clean(analysis.ventajaOfensivaTexto);
  if (Array.isArray(analysis.factoresClave)) {
    analysis.factoresClave = analysis.factoresClave.map(f => typeof f === "string" ? clean(f) : f);
  }
  if (typeof analysis.prediccion?.razon === "string") analysis.prediccion.razon = clean(analysis.prediccion.razon);
  if (typeof analysis.totalCarreras?.razon === "string") analysis.totalCarreras.razon = clean(analysis.totalCarreras.razon);
  if (Array.isArray(analysis.picks)) {
    for (const p of analysis.picks) if (typeof p?.razon === "string") p.razon = clean(p.razon);
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

/**
 * Moneyline con EV del servidor ≤ 0 jamás puede presentarse como pick de
 * valor (VALOR ALTO/MEDIO/BAJO). Se degrada a "SIN VALOR" conservando
 * cuotaReal, verificado y el objeto mercado intactos.
 * EV por lado desde los campos existentes de mercado (en puntos %):
 *   local:     probModeloLocal − probMercadoLocal
 *   visitante: (100 − probModeloLocal) − probMercadoVisitante
 */
export function enforceMlValueConsistency(picks, mercado, homeName, awayName) {
  if (!Array.isArray(picks) || !mercado || mercado.probModeloLocal == null) return picks;
  return picks.map(pick => {
    if (!norm(pick?.tipo).startsWith("moneyline")) return pick;
    const team = teamInText(pick.pick, homeName, awayName);
    if (team == null) return pick;                                  // lado no mapeable: no tocar
    const side = team === homeName ? "home" : "away";
    const ev = side === "home"
      ? mercado.probModeloLocal - mercado.probMercadoLocal
      : (100 - mercado.probModeloLocal) - mercado.probMercadoVisitante;
    if (!Number.isFinite(ev) || ev > 0) return pick;                // EV positivo: badge intacto en esta fase
    const evTxt = `${ev > 0 ? "+" : ""}${(Math.round(ev * 10) / 10).toFixed(1)}`;
    return {
      ...pick,
      valor: "SIN VALOR",
      razon: `EV del servidor: ${evTxt}% — la cuota paga menos que la probabilidad estimada; no es pick de valor. ${pick.razon ?? ""}`.trim(),
    };
  });
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
 * La dirección del total la dictan los números del servidor, no la prosa:
 *   proyectado − lineaMercado ≥ +0.3 → OVER · ≤ −0.3 → UNDER ·
 *   |gap| < 0.3 → senalClara:false (sin dirección fuerte fabricada).
 * Un pick de Total que contradiga la dirección deja de ser recomendación
 * activa: SEÑAL NO OFICIAL + noOficial:true, conservando pick, cuotaReal,
 * verificado y razón como auditoría.
 * Puro: devuelve { totalCarreras, picks } nuevos; sin números no toca nada.
 */
export const TOTAL_DIRECTION_GAP = 0.3;

export function enforceTotalDirection(totalCarreras, picks) {
  const proy  = parseFloat(totalCarreras?.proyectado ?? totalCarreras?.estimado);
  const linea = totalCarreras?.lineaMercado != null ? Number(totalCarreras.lineaMercado) : NaN;
  if (!Number.isFinite(proy) || !Number.isFinite(linea)) {
    return { totalCarreras, picks };
  }
  const gap = proy - linea;
  let t = { ...totalCarreras };
  let dir = null;
  if (Math.abs(gap) < TOTAL_DIRECTION_GAP) {
    t.senalClara = false;                                           // muy cerca: sin dirección fuerte
  } else {
    dir = gap > 0 ? "OVER" : "UNDER";
    if (t.recomendacion !== dir) {
      t.recomendacion = dir;
      t.razon = `Dirección corregida por el servidor: proyección ${proy} vs línea ${linea} → ${dir}. ${t.razon ?? ""}`.trim();
    }
  }
  let outPicks = picks;
  if (dir && Array.isArray(picks)) {
    outPicks = picks.map(pick => {
      if (!norm(pick?.tipo).startsWith("total")) return pick;
      const m = String(pick.pick ?? "").match(/\b(over|under)\b/i);
      if (!m) return pick;
      const side = m[1].toUpperCase();
      if (side === dir) return pick;                                // coherente: intacto
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

/**
 * La narrativa no puede contradecir sus propios números.
 * Patrones ESTRECHOS (métrica + número + comparador + ERA + número):
 *  - "xERA 4.78 supera ERA 5.40" (falso: 4.78 < 5.40) → verbo corregido.
 *  - "FIP mayor que ERA … peores que el proceso" → mapeo semántico corregido
 *    (mayor = resultados MEJORES que el proceso → posible deterioro).
 * Métricas sueltas ("xERA 3.10", "K/9 11.2") jamás se tocan.
 */
const CMP_ABOVE = /supera(?:\s+(?:a|al|el|su))?|es\s+mayor\s+que|mayor\s+que|por\s+encima\s+de(?:l)?|excede(?:\s+(?:a|al|el|su))?/i;

export function fixMetricComparisons(text) {
  let out = String(text ?? "");

  /* Comparación numérica explícita metric A <cmp> ERA B */
  out = out.replace(
    /\b(xERA|xFIP|FIP)\s+(\d+(?:\.\d+)?)\s+(supera(?:\s+(?:a|al|el|su))?|es\s+mayor\s+que|mayor\s+que|por\s+encima\s+de(?:l)?|excede(?:\s+(?:a|al|el|su))?|es\s+menor\s+que|menor\s+que|(?:está\s+)?por\s+debajo\s+de(?:l)?)\s+(?:el\s+|su\s+)?ERA(?:\s+de)?\s+(\d+(?:\.\d+)?)/gi,
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

/* Moneyline: un porcentaje "implícito" escrito por el LLM no puede
   reinterpretarse como probabilidad sin vig (solo coinciden en mercados
   simétricos). El paréntesis se ELIMINA completo — la probabilidad sin vig
   oficial vive únicamente en la tarjeta "Modelo vs Mercado", calculada por
   el servidor. Cambio lingüístico conservado: "A precio" → "A cuota".
   Badge VALOR, cuota, probabilidad del modelo y EV quedan intactos. */
export function fixMoneylineWording(text) {
  return String(text ?? "")
    /* "(implícita ~55.7%)" — palabra primero */
    .replace(/\s*\((?:prob(?:abilidad)?\.?\s+)?impl[ií]cit[oa]\s+~?\s*(?:de\s+)?~?\s*\d+(?:[.,]\d+)?\s*%\)/gi, "")
    /* "(46.3% implícito)" — número primero */
    .replace(/\s*\(\s*~?\d+(?:[.,]\d+)?\s*%\s+impl[ií]cit[oa]s?\s*\)/gi, "")
    .replace(/\b([Aa]) precio\b/g, "$1 cuota");
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

/** Lado verificado: cuota real, badge degradado a señal, EV no calculable. */
function verifiedResult(pick, out) {
  return {
    ...pick,
    verificado:  true,
    cuotaReal:   out.price,
    lineaReal:   out.point,
    evCalculado: false,
    valor:       SENAL[pick.valor] ?? "SEÑAL",
    razon:       `${VERIFIED_NOTE} ${sanitizeFinancialClaims(pick.razon)}`.trim(),
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
