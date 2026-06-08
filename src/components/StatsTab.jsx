import { dsp, cmp, fmtRec } from "../utils";

function SC({ title, rows, aa, ha }) {
  return (
    <div className="sc">
      <div className="sc-hdr">{title}</div>
      <div className="sc-lbls">
        <span className="sc-l a">{aa}</span>
        <span className="sc-l c">STAT</span>
        <span className="sc-l h">{ha}</span>
      </div>
      {rows.map(({ lbl, av, hv, hi = true }) => {
        const [ac, hc] = cmp(av, hv, hi);
        return (
          <div key={lbl} className="sr">
            <span className={`sv ${ac}`}>{dsp(av)}</span>
            <span className="sr-lbl">{lbl}</span>
            <span className={`sv ${hc}`}>{dsp(hv)}</span>
          </div>
        );
      })}
    </div>
  );
}

const fmtLastTen = (splits) => {
  const r = splits?.lastTen;
  if (!r) return "–";
  const tag = r.wins >= 7 ? " 🔥" : r.wins <= 3 ? " ❄️" : "";
  return `${r.wins}-${r.losses}${tag}`;
};
const fmtSplit = (splits, type) => {
  const r = splits?.[type];
  return r ? `${r.wins}-${r.losses}` : "–";
};

export default function StatsTab({ gd, onAnalyze, setTab, analysis, analyzing }) {
  if (!gd) return null;
  const { home: h, away: a } = gd;
  const aa = a.team.abbreviation || a.team.name.slice(0, 3).toUpperCase();
  const ha = h.team.abbreviation || h.team.name.slice(0, 3).toUpperCase();
  return (
    <>
      <div className="sgrid">
        <SC title="⚔️ Pitchers Probables" aa={aa} ha={ha} rows={[
          { lbl: "ERA",  av: a.ps?.era,               hv: h.ps?.era,               hi: false },
          { lbl: "WHIP", av: a.ps?.whip,              hv: h.ps?.whip,              hi: false },
          { lbl: "IP",   av: a.ps?.inningsPitched,    hv: h.ps?.inningsPitched,    hi: true },
          { lbl: "SO",   av: a.ps?.strikeOuts,        hv: h.ps?.strikeOuts,        hi: true },
          { lbl: "BB",   av: a.ps?.baseOnBalls,       hv: h.ps?.baseOnBalls,       hi: false },
          { lbl: "K/9",  av: a.ps?.strikeoutsPer9Inn, hv: h.ps?.strikeoutsPer9Inn, hi: true },
          { lbl: "HR-A", av: a.ps?.homeRuns,          hv: h.ps?.homeRuns,          hi: false },
        ]} />
        <SC title="🏏 Ofensiva de Equipo" aa={aa} ha={ha} rows={[
          { lbl: "AVG", av: a.hit.avg,        hv: h.hit.avg,        hi: true },
          { lbl: "OBP", av: a.hit.obp,        hv: h.hit.obp,        hi: true },
          { lbl: "SLG", av: a.hit.slg,        hv: h.hit.slg,        hi: true },
          { lbl: "OPS", av: a.hit.ops,        hv: h.hit.ops,        hi: true },
          { lbl: "HR",  av: a.hit.homeRuns,   hv: h.hit.homeRuns,   hi: true },
          { lbl: "R",   av: a.hit.runs,       hv: h.hit.runs,       hi: true },
          { lbl: "K",   av: a.hit.strikeOuts, hv: h.hit.strikeOuts, hi: false },
        ]} />
        <SC title="🔥 Pitcheo de Equipo" aa={aa} ha={ha} rows={[
          { lbl: "ERA",  av: a.pit.era,         hv: h.pit.era,         hi: false },
          { lbl: "WHIP", av: a.pit.whip,        hv: h.pit.whip,        hi: false },
          { lbl: "SO",   av: a.pit.strikeOuts,  hv: h.pit.strikeOuts,  hi: true },
          { lbl: "BB",   av: a.pit.baseOnBalls, hv: h.pit.baseOnBalls, hi: false },
          { lbl: "HR-A", av: a.pit.homeRuns,    hv: h.pit.homeRuns,    hi: false },
        ]} />
        <div className="sc">
          <div className="sc-hdr">📍 Info del Partido</div>
          {[
            { l: "Estadio",     v: gd.game.venue?.name || "–" },
            { l: "Pitcher Vis", v: a.prob?.fullName || "TBD", c: { color: "var(--cy)" } },
            { l: "Pitcher Loc", v: h.prob?.fullName || "TBD", c: { color: "var(--gn)" } },
            { l: "Record Vis",  v: fmtRec(a.rec) || "–" },
            { l: "Record Loc",  v: fmtRec(h.rec) || "–" },
            { l: "Últ 10",  v: `${fmtLastTen(a.splits)} · ${fmtLastTen(h.splits)}` },
            { l: "Casa",    v: `Vis ${fmtSplit(a.splits, "home")} · Loc ${fmtSplit(h.splits, "home")}` },
            { l: "Visita",  v: `Vis ${fmtSplit(a.splits, "away")} · Loc ${fmtSplit(h.splits, "away")}` },
          ].map(({ l, v, c }) => (
            <div key={l} className="ir">
              <span className="ir-l">{l}</span>
              <span className="ir-v" style={c}>{v}</span>
            </div>
          ))}
        </div>
      </div>
      <button className="abtn" onClick={() => { setTab("analysis"); if (!analysis && !analyzing) onAnalyze(); }}>
        ⚡ ANALIZAR CON IA MONEYBALL
      </button>
    </>
  );
}
