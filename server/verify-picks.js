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

/* Moneyline: un porcentaje "implícito" escrito por el LLM no puede
   reinterpretarse como probabilidad sin vig (solo coinciden en mercados
   simétricos). El paréntesis se ELIMINA completo — la probabilidad sin vig
   oficial vive únicamente en la tarjeta "Modelo vs Mercado", calculada por
   el servidor. Cambio lingüístico conservado: "A precio" → "A cuota".
   Badge VALOR, cuota, probabilidad del modelo y EV quedan intactos. */
export function fixMoneylineWording(text) {
  return String(text ?? "")
    .replace(/\s*\((?:probabilidad\s+)?impl[ií]cit[oa]\s+(?:de\s+)?\d+(?:\.\d+)?\s*%\)/gi, "")
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
    /* Solo redacción de "implícito" — badge, cuota, probabilidad y EV intactos */
    return pick?.razon != null ? { ...pick, razon: fixMoneylineWording(pick.razon) } : { ...pick };
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
