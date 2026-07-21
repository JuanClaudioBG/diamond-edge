import { useState, useEffect } from "react";
import { MLB, toDay } from "./utils";
import Sidebar      from "./components/Sidebar";
import GameHeader   from "./components/GameHeader";
import StatsTab     from "./components/StatsTab";
import AnalysisTab  from "./components/AnalysisTab";
import ParlayTab    from "./components/ParlayTab";
import HistorialTab from "./components/HistorialTab";

const API = "";

const getGameBanner = (gameDate) => {
  if (!gameDate) return null;
  const diff = Date.now() - new Date(gameDate).getTime();
  if (diff > 2 * 60 * 60 * 1000)
    return { type: "warn", msg: "⚠️ Este partido puede haber terminado — los datos podrían corresponder al día siguiente" };
  if (diff < 0 && Math.abs(diff) < 30 * 60 * 1000)
    return { type: "ok", msg: "🟢 Partido próximo — datos confirmados" };
  return null;
};

const normalizeType = (type) => {
  const t = String(type).toLowerCase().replace(/[\s_-]/g, "");
  if (t.startsWith("lastten") || t === "last10") return "lastTen";
  if (t === "home") return "home";
  if (t === "away") return "away";
  return type;
};

const getSplits = (data, teamId) => {
  for (const div of (data?.records ?? [])) {
    for (const tr of (div.teamRecords ?? [])) {
      if (Number(tr.team?.id) === Number(teamId)) {
        const s = {};
        for (const sr of (tr.records?.splitRecords ?? [])) {
          s[normalizeType(sr.type)] = { wins: sr.wins, losses: sr.losses };
        }
        return s;
      }
    }
  }
  return null;
};

export default function DiamondEdge() {
  const [date, setDate]         = useState(toDay());
  const [games, setGames]       = useState([]);
  const [sel, setSel]           = useState(null);
  const [gd, setGd]             = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [parlay, setParlay]     = useState([]);
  const [historial, setHistorial] = useState([]);
  const [evaluation, setEvaluation] = useState(null);
  const [ldGames, setLdGames]   = useState(true);
  const [ldGame, setLdGame]     = useState(false);
  const [analyzing, setAnal]    = useState(false);
  const [tab, setTab]           = useState("stats");
  const [err, setErr]           = useState(null);

  /* Fetch games */
  useEffect(() => {
    (async () => {
      setLdGames(true); setSel(null); setGd(null); setAnalysis(null); setErr(null);
      try {
        const r = await fetch(`${MLB}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,linescore`);
        const d = await r.json();
        setGames(d.dates?.[0]?.games || []);
      } catch { setGames([]); setErr("Error cargando juegos"); }
      finally { setLdGames(false); }
    })();
  }, [date]);

  /* Load historial on mount */
  useEffect(() => { loadHistorial(); }, []);

  const loadHistorial = async () => {
    try {
      const r = await fetch(`${API}/api/picks`);
      setHistorial(await r.json());
    } catch(e) { console.error("Error cargando historial:", e); }
    loadEvaluation();
  };

  const loadEvaluation = async () => {
    try {
      const r = await fetch(`${API}/api/evaluation`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setEvaluation(await r.json());
    } catch(e) { console.error("Error cargando evaluación:", e); setEvaluation(null); }
  };

  const pickGame = async (game) => {
    setSel(game); setGd(null); setAnalysis(null); setTab("stats"); setLdGame(true);
    try {
      const hid    = game.teams.home.team.id, aid = game.teams.away.team.id;
      const season = new Date(date).getFullYear();
      const standingsUrl = `${MLB}/standings?leagueId=103,104&season=${season}&date=${date}&standingsTypes=regularSeason`;
      const [hH, hP, aH, aP, stData] = await Promise.all([
        fetch(`${MLB}/teams/${hid}/stats?stats=season&group=hitting&season=${season}`).then(r=>r.json()).catch(()=>({})),
        fetch(`${MLB}/teams/${hid}/stats?stats=season&group=pitching&season=${season}`).then(r=>r.json()).catch(()=>({})),
        fetch(`${MLB}/teams/${aid}/stats?stats=season&group=hitting&season=${season}`).then(r=>r.json()).catch(()=>({})),
        fetch(`${MLB}/teams/${aid}/stats?stats=season&group=pitching&season=${season}`).then(r=>r.json()).catch(()=>({})),
        fetch(standingsUrl).then(r=>r.json()).catch(()=>null),
      ]);

      let hPS = null, aPS = null;
      const hProb = game.teams.home.probablePitcher;
      const aProb = game.teams.away.probablePitcher;
      if (hProb?.id) { try { const r = await fetch(`${MLB}/people/${hProb.id}/stats?stats=season&group=pitching&season=${season}`); const d = await r.json(); hPS = d.stats?.[0]?.splits?.[0]?.stat||null; } catch {} }
      if (aProb?.id) { try { const r = await fetch(`${MLB}/people/${aProb.id}/stats?stats=season&group=pitching&season=${season}`); const d = await r.json(); aPS = d.stats?.[0]?.splits?.[0]?.stat||null; } catch {} }

      setGd({
        home: { team: game.teams.home.team, rec: game.teams.home.leagueRecord, hit: hH.stats?.[0]?.splits?.[0]?.stat||{}, pit: hP.stats?.[0]?.splits?.[0]?.stat||{}, prob: hProb||null, ps: hPS, splits: getSplits(stData, hid) },
        away: { team: game.teams.away.team, rec: game.teams.away.leagueRecord, hit: aH.stats?.[0]?.splits?.[0]?.stat||{}, pit: aP.stats?.[0]?.splits?.[0]?.stat||{}, prob: aProb||null, ps: aPS, splits: getSplits(stData, aid) },
        game,
      });
    } catch(e) { console.error(e); }
    finally { setLdGame(false); }
  };

  const doAnalyze = async () => {
    if (!gd) return;
    setAnal(true); setTab("analysis");
    try {
      const res = await fetch(`${API}/api/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ home: gd.home, away: gd.away, gamePk: gd.game.gamePk, venue: gd.game.venue?.name, gameDate: gd.game.gameDate }),
      });
      setAnalysis(await res.json());
    } catch(e) { console.error(e); setAnalysis({ error: true }); }
    finally { setAnal(false); }
  };

  const addPick = async (pick) => {
    const partido = `${sel.teams.away.team.name} @ ${sel.teams.home.team.name}`;
    /* Ephemeral parlay */
    setParlay(p => [...p, { id: Date.now(), game: partido, ...pick }]);
    /* Persist to DB */
    try {
      await fetch(`${API}/api/picks`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fecha: toDay(), partido, tipo: pick.tipo, pick: pick.pick, valor: pick.valor, riesgo: pick.riesgo, analysis_id: analysis?.analysisId ?? null }),
      });
      loadHistorial();
    } catch(e) { console.error("Error guardando pick:", e); }
  };

  /* Los ÁNGULOS RADAR son efímeros: participan en el parlay, pero no se
     persisten ni entran al historial, settlement o ROI oficial. */
  const addSuggestedPick = (pick) => {
    const partido = `${sel.teams.away.team.name} @ ${sel.teams.home.team.name}`;
    setParlay(p => [...p, { id: Date.now(), game: partido, ...pick }]);
  };

  const rmPick = (id) => setParlay(p => p.filter(x => x.id !== id));

  const marcarResultado = async (id, resultado) => {
    try {
      await fetch(`${API}/api/picks/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultado }),
      });
      setHistorial(h => h.map(p => p.id === id ? { ...p, resultado } : p));
      loadEvaluation();   // las cards de evaluación no deben quedar desfasadas
    } catch(e) { console.error("Error marcando resultado:", e); }
  };

  const TABS = [
    { id: "stats",     lbl: "📊 Stats" },
    { id: "analysis",  lbl: "⚡ Análisis IA" },
    { id: "parlay",    lbl: `🎰 Parlay${parlay.length ? ` (${parlay.length})` : ""}` },
    { id: "historial", lbl: `📋 Historial${historial.length ? ` (${historial.length})` : ""}` },
  ];

  return (
    <div className="app">
      <header className="hdr">
        <div>
          <div className="hdr-logo">⚾ DIAMOND EDGE</div>
          <div className="hdr-sub">MLB Analytics · Parlay Intelligence</div>
        </div>
        <div className="hdr-r">
          <input type="date" className="dt-in" value={date} onChange={e => setDate(e.target.value)} />
          {parlay.length > 0 && (
            <div className="pb" onClick={() => setTab("parlay")}>🎰 PARLAY ({parlay.length})</div>
          )}
        </div>
      </header>

      <div className="body">
        <Sidebar games={games} sel={sel} ldGames={ldGames} err={err} onSelectGame={pickGame} />

        <main className="main">
          {/* Game header — only when game selected and not on historial */}
          {sel && tab !== "historial" && <GameHeader sel={sel} gd={gd} />}

          {/* Game time banner */}
          {sel && tab !== "historial" && (() => {
            const b = getGameBanner(sel.gameDate);
            return b ? <div className={`game-banner ${b.type}`}>{b.msg}</div> : null;
          })()}

          {/* Tabs — always visible */}
          <div className="tabs">
            {TABS.map(({ id, lbl }) => (
              <div key={id} className={`tab ${tab === id ? "on" : ""}`}
                onClick={() => {
                  setTab(id);
                  if (id === "analysis" && gd && !analysis && !analyzing) doAnalyze();
                }}>
                {lbl}
              </div>
            ))}
          </div>

          {/* Content */}
          <div className="tcont">
            {tab === "historial" ? (
              <HistorialTab picks={historial} evaluation={evaluation} onMarcarResultado={marcarResultado} />
            ) : !sel ? (
              <div className="empty">
                <div className="empty-ic">⚾</div>
                <div className="empty-hd">Selecciona un Partido</div>
                <div className="empty-sb">Elige un juego de la lista para ver estadísticas y análisis</div>
              </div>
            ) : ldGame ? (
              <div className="ld"><span className="sp" />CARGANDO ESTADÍSTICAS…</div>
            ) : (
              <>
                {tab === "stats"    && <StatsTab    gd={gd} onAnalyze={doAnalyze} setTab={setTab} analysis={analysis} analyzing={analyzing} />}
                {tab === "analysis" && <AnalysisTab analysis={analysis} analyzing={analyzing} onAnalyze={doAnalyze} onAddPick={addPick} onAddSuggestedPick={addSuggestedPick} />}
                {tab === "parlay"   && <ParlayTab   parlay={parlay} onRemovePick={rmPick} />}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
