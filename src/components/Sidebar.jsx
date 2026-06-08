import { fmtTime } from "../utils";

export default function Sidebar({ games, sel, ldGames, err, onSelectGame }) {
  return (
    <aside className="side">
      <div className="side-hdr">{ldGames ? "CARGANDO…" : `${games.length} JUEGOS`}</div>
      <div className="side-list">
        {ldGames ? (
          <div className="ld"><span className="sp" />CARGANDO</div>
        ) : games.length === 0 ? (
          <div style={{ padding: "16px", fontFamily: "var(--fm)", fontSize: 10, color: "var(--dm)", textAlign: "center" }}>
            {err || "No hay juegos este día"}
          </div>
        ) : games.map(g => (
          <div key={g.gamePk} className={`gc ${sel?.gamePk === g.gamePk ? "sel" : ""}`} onClick={() => onSelectGame(g)}>
            <div className="gc-time">{fmtTime(g.gameDate)}</div>
            <div className="gc-row">
              <span className="gc-nm">{g.teams.away.team.name}</span>
              <span className="gc-rec">{g.teams.away.leagueRecord ? `${g.teams.away.leagueRecord.wins}-${g.teams.away.leagueRecord.losses}` : ""}</span>
            </div>
            <div className="gc-sep">@</div>
            <div className="gc-row">
              <span className="gc-nm h">{g.teams.home.team.name}</span>
              <span className="gc-rec">{g.teams.home.leagueRecord ? `${g.teams.home.leagueRecord.wins}-${g.teams.home.leagueRecord.losses}` : ""}</span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
