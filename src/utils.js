export const MLB = "https://statsapi.mlb.com/api/v1";
export const toDay = () => new Date().toISOString().split("T")[0];

export const fmtTime = (s) => {
  try { return new Date(s).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: true }); }
  catch { return "--:--"; }
};
export const fmtRec = (r) => r ? `${r.wins}–${r.losses}` : "";
export const dsp = (v) => (v == null || v === "" || v === "-.---" || v === "-") ? "–" : String(v);
export const cmp = (a, b, hi = true) => {
  const na = parseFloat(a), nb = parseFloat(b);
  if (isNaN(na) || isNaN(nb) || na === nb) return ["", ""];
  return hi ? [na > nb ? "g" : "bd", nb > na ? "g" : "bd"] : [na < nb ? "g" : "bd", nb < na ? "g" : "bd"];
};
export const advCls = (v = "") => {
  const u = v.toUpperCase();
  if (u.startsWith("V")) return "V";
  if (u.startsWith("L")) return "L";
  return "E";
};
export const advLbl = (v = "") => {
  const u = v.toUpperCase();
  if (u.startsWith("V")) return "VISITANTE";
  if (u.startsWith("L")) return "LOCAL";
  return "EQUILIBRADO";
};
