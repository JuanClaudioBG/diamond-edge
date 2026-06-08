import { fmtTime, fmtRec } from "../utils";

export default function GameHeader({ sel, gd }) {
  return (
    <div className="ghdr">
      <div className="ghdr-row">
        <div className="gt">
          <div className="gt-nm">{sel.teams.away.team.name}</div>
          <div className="gt-rec">{fmtRec(sel.teams.away.leagueRecord)}</div>
          {gd?.away.prob && <div className="gt-p">P: <b>{gd.away.prob.fullName}</b></div>}
        </div>
        <div className="gvs">
          <div className="gvs-t">VS</div>
          <div className="gvs-ti">{fmtTime(sel.gameDate)}</div>
        </div>
        <div className="gt h">
          <div className="gt-nm">{sel.teams.home.team.name}</div>
          <div className="gt-rec">{fmtRec(sel.teams.home.leagueRecord)}</div>
          {gd?.home.prob && <div className="gt-p">P: <b>{gd.home.prob.fullName}</b></div>}
        </div>
      </div>
    </div>
  );
}
