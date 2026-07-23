import { useState } from "react";
import { fmtPct, fmtRoi, fmtUnits, fmtRecordLine, fmtBrier } from "../evaluation-display";

/* Sección Evaluación Moneyball: la MUESTRA OFICIAL es la protagonista;
   el histórico total queda como contexto. Tolerante a evaluation null. */
function EvaluacionMoneyball({ ev }) {
  const [expandida, setExpandida] = useState(false);
  if (!ev) {
    return (
      <div style={{ fontFamily: "var(--fm)", fontSize: 9, color: "var(--mu)", letterSpacing: 1, textAlign: "center" }}>
        📐 EVALUACIÓN NO DISPONIBLE
      </div>
    );
  }
  const of  = ev.officialSample ?? {};
  const roi = of.roiML ?? {};
  const roiProps = of.roiProps ?? {};
  const oa  = ev.officialAnalyses ?? {};
  const vs  = ev.byVerificationStatus ?? {};
  const propsOficiales = vs.propsOficiales ?? {};
  const dup = ev.duplicates ?? {};

  return (
    <div className="acard">
      <div className="acard-hdr">📐 Evaluación Moneyball</div>
      <div className="acard-b">
        {/* Protagonista: muestra oficial */}
        <div className="hstats" style={{ marginBottom: 10 }}>
          {[
            { v: of.n ?? "–",                l: "Picks oficiales", cls: "gn" },
            { v: fmtRecordLine(of),          l: "Récord oficial",  cls: "dm" },
            { v: fmtPct(of.winRate),         l: "Win rate oficial", cls: of.winRate >= 0.5 ? "gn" : "rd" },
            { v: fmtRoi(roi.roi),            l: `ROI ML (${roi.n ?? 0} picks)`, cls: (roi.roi ?? 0) >= 0 ? "gn" : "rd" },
          ].map(({ v, l, cls }) => (
            <div key={l} className="hst">
              <div className={`hst-v ${cls}`}>{v}</div>
              <div className="hst-l">{l}</div>
            </div>
          ))}
        </div>
        <div style={{ fontFamily: "var(--fm)", fontSize: 10, color: "var(--dm)", marginBottom: 8 }}>
          Unidades ML: {fmtUnits(roi.units)} · Brier modelo {fmtBrier(oa.brier)} vs mercado {fmtBrier(oa.brierMercado)} ({oa.n ?? 0} análisis)
          {(of.n ?? 0) > 0 && of.n < 30 && <span style={{ color: "var(--au)" }}> · ⚠ n&lt;30: insuficiente para conclusiones</span>}
        </div>

        {/* Props oficiales: bucket financiero independiente de Moneyline */}
        <div style={{ fontFamily: "var(--fm)", fontSize: 10, color: "var(--ac)", margin: "12px 0 6px", letterSpacing: 1 }}>
          ⚾ PROPS OFICIALES · BUCKET INDEPENDIENTE
        </div>
        <div className="hstats" style={{ marginBottom: 6 }}>
          {[
            { v: fmtRecordLine(propsOficiales), l: `Récord Props (${propsOficiales.n ?? 0})`, cls: "dm" },
            { v: fmtPct(propsOficiales.winRate), l: "Win rate Props", cls: propsOficiales.winRate >= 0.5 ? "gn" : "rd" },
            { v: fmtRoi(roiProps.roi), l: `ROI Props (${roiProps.n ?? 0} apuestas)`, cls: (roiProps.roi ?? 0) >= 0 ? "gn" : "rd" },
            { v: fmtUnits(roiProps.units), l: "Unidades Props", cls: (roiProps.units ?? 0) >= 0 ? "gn" : "rd" },
          ].map(({ v, l, cls }) => (
            <div key={l} className="hst">
              <div className={`hst-v ${cls}`}>{v}</div>
              <div className="hst-l">{l}</div>
            </div>
          ))}
        </div>
        <div style={{ fontFamily: "var(--fm)", fontSize: 9, color: "var(--mu)", marginBottom: 10 }}>
          Push {roiProps.pushes ?? 0} · Void {roiProps.voids ?? 0} · Pendientes {roiProps.pendientes ?? 0} · Sin cuota válida {roiProps.excluidosSinCuota ?? 0}
        </div>
        <div style={{ fontFamily: "var(--fm)", fontSize: 9, color: "var(--mu)", marginBottom: 10 }}>
          Histórico total (contexto): {ev.overall?.n ?? 0} picks · win rate {fmtPct(ev.overall?.winRate)} — incluye picks históricos sin cuota, no auditable para ROI.
        </div>

        {/* Por versión */}
        <div className="hbk" style={{ marginBottom: 10 }}>
          {Object.entries(ev.byLogicVersion ?? {}).map(([ver, r]) => (
            <>
              <span key={`${ver}-t`} className="hbk-t">{ver}</span>
              <span key={`${ver}-r`} className="hbk-v">{fmtRecordLine(r)} ({r.n})</span>
              <span key={`${ver}-p`} className="hbk-v" style={{ color: r.winRate >= 0.5 ? "var(--gn)" : "var(--dm)" }}>{fmtPct(r.winRate)}</span>
            </>
          ))}
        </div>

        {/* Por estatus de verificación */}
        <div className="hbk" style={{ marginBottom: 10 }}>
          {[
            ["ML verificado (entra a ROI)", vs.mlVerificado],
            ["Props oficiales (ROI propio)", vs.propsOficiales],
            ["Señales RL/Total (sin EV)",   vs.senalesRLTotal],
            ["Ángulos Radar (tracking manual)", vs.propsSugeridos],
            ["Props para revisar",          vs.propsParaRevisar],
            ["Props legado",                vs.propsLegado],
            ["Histórico sin registro",      vs.historicoSinRegistro],
          ].map(([lbl, r]) => r && r.n > 0 && (
            <>
              <span key={`${lbl}-t`} className="hbk-t">{lbl}</span>
              <span key={`${lbl}-r`} className="hbk-v">{fmtRecordLine(r)}</span>
              <span key={`${lbl}-p`} className="hbk-v" style={{ color: r.winRate >= 0.5 ? "var(--gn)" : "var(--dm)" }}>{fmtPct(r.winRate)}</span>
            </>
          ))}
        </div>

        {/* Alertas */}
        {(ev.warnings ?? []).map((w, i) => (
          <div key={i} style={{ fontFamily: "var(--fm)", fontSize: 9, color: w.level === "warning" ? "var(--au)" : "var(--mu)", padding: "2px 0" }}>
            {w.level === "warning" ? "⚠" : "·"} {w.msg}
          </div>
        ))}

        {/* Auditoría expandida */}
        <button className="rbtn gano" style={{ marginTop: 8, borderColor: "var(--b2)", color: "var(--dm)" }}
          onClick={() => setExpandida(e => !e)}>
          {expandida ? "OCULTAR AUDITORÍA" : "VER AUDITORÍA EXPANDIDA"}
        </button>
        {expandida && (
          <div style={{ fontFamily: "var(--fm)", fontSize: 9, color: "var(--dm)", marginTop: 8, lineHeight: 1.8 }}>
            <div>Duplicados exactos: {(dup.exactos ?? []).length === 0 ? "ninguno" :
              (dup.exactos ?? []).map(d => `ids [${d.ids.join(", ")}]`).join(" · ")}</div>
            <div>Reanálisis por juego: {(dup.reanalisis ?? []).length === 0 ? "ninguno" :
              (dup.reanalisis ?? []).map(r => `gamePk ${r.gamePk} ×${r.n}`).join(" · ")}</div>
            <div>Picks de análisis supersedidos (cuentan como apuestas): {(dup.supersededPicks ?? []).length === 0 ? "ninguno" : `ids [${dup.supersededPicks.join(", ")}]`}</div>
            <div>Discrepancias manual vs settle: {(ev.discrepancias ?? []).length === 0 ? "ninguna" :
              ev.discrepancias.map(d => `pick ${d.pickId}: manual "${d.manual}" vs settle "${d.settle}"`).join(" · ")}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function HistorialTab({ picks, evaluation, onMarcarResultado }) {
  const total     = picks.length;
  const ganados   = picks.filter(p => p.resultado === "ganó").length;
  const perdidos  = picks.filter(p => p.resultado === "perdió").length;
  const pushes    = picks.filter(p => p.resultado === "push").length;
  const voids     = picks.filter(p => p.resultado === "void").length;
  const pendientes = picks.filter(p => p.resultado == null).length;
  const pct       = ganados + perdidos > 0 ? Math.round((ganados / (ganados + perdidos)) * 100) : 0;

  const desglose = picks.reduce((acc, p) => {
    if (!acc[p.tipo]) acc[p.tipo] = { total: 0, ganados: 0, perdidos: 0, pushes: 0, voids: 0 };
    acc[p.tipo].total++;
    if (p.resultado === "ganó") acc[p.tipo].ganados++;
    if (p.resultado === "perdió") acc[p.tipo].perdidos++;
    if (p.resultado === "push") acc[p.tipo].pushes++;
    if (p.resultado === "void") acc[p.tipo].voids++;
    return acc;
  }, {});

  if (total === 0) return (
    <div className="pcont">
      <div className="pmt">
        <div className="pmt-i">📋</div>
        <div className="pmt-h">HISTORIAL VACÍO</div>
        <div className="pmt-s">Los picks que agregues al parlay quedarán guardados aquí</div>
      </div>
    </div>
  );

  return (
    <div className="hcont">
      {/* Evaluación Moneyball — muestra oficial como protagonista */}
      <EvaluacionMoneyball ev={evaluation} />

      {/* Stats */}
      <div className="hstats">
        {[
          { v: total,      l: "Total Picks",  cls: "dm" },
          { v: `${pct}%`,  l: "% Ganados",    cls: "gn" },
          { v: ganados,    l: "Ganados",       cls: "gn" },
          { v: perdidos,   l: "Perdidos",      cls: "rd" },
          { v: pushes,     l: "Push",           cls: "dm" },
          { v: voids,      l: "Void",           cls: "dm" },
          { v: pendientes, l: "Pendientes",     cls: "dm" },
        ].map(({ v, l, cls }) => (
          <div key={l} className="hst">
            <div className={`hst-v ${cls}`}>{v}</div>
            <div className="hst-l">{l}</div>
          </div>
        ))}
      </div>

      {/* Desglose por tipo */}
      {Object.keys(desglose).length > 0 && (
        <div className="acard">
          <div className="acard-hdr">Desglose por Tipo</div>
          <div className="acard-b" style={{ padding: "8px 12px" }}>
            <div className="hbk">
              {Object.entries(desglose).map(([tipo, d]) => (
                <>
                  <span key={`${tipo}-t`} className="hbk-t">{tipo}</span>
                  <span key={`${tipo}-v`} className="hbk-v">{d.ganados}/{d.ganados + d.perdidos}</span>
                  <span key={`${tipo}-p`} className="hbk-v" style={{ color: d.ganados > 0 ? "var(--gn)" : "var(--dm)" }}>
                    {d.ganados + d.perdidos > 0 ? `${Math.round((d.ganados / (d.ganados + d.perdidos)) * 100)}%` : "–"}
                  </span>
                </>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Picks list */}
      {picks.map(p => {
        const radarSuggested = String(p.tipo ?? "").toLowerCase() === "prop sugerido";
        return (
        <div key={p.id} className={`hpick${radarSuggested ? " radar-history" : ""}`}>
          <div className="hpick-info">
            <div className="hpick-gm">{p.partido} · {p.fecha}</div>
            <div className="hpick-pk">{p.pick}</div>
            <div className="hpick-mt">
              {radarSuggested && <span className="history-radar-tag">ÁNGULO RADAR</span>}
              {p.tipo} · Valor: {p.valor} · Riesgo: {p.riesgo}
            </div>
          </div>
          <div className="rbtns">
            {p.resultado === "push" && <span className="rbtn on">PUSH</span>}
            {p.resultado === "void" && <span className="rbtn on">VOID</span>}
            <button
              className={`rbtn gano${p.resultado === "ganó" ? " on" : ""}`}
              onClick={() => onMarcarResultado(p.id, p.resultado === "ganó" ? null : "ganó")}
            >
              GANÓ
            </button>
            <button
              className={`rbtn perdio${p.resultado === "perdió" ? " on" : ""}`}
              onClick={() => onMarcarResultado(p.id, p.resultado === "perdió" ? null : "perdió")}
            >
              PERDIÓ
            </button>
          </div>
        </div>
      );})}

      {pendientes > 0 && (
        <div style={{ fontFamily: "var(--fm)", fontSize: 9, color: "var(--mu)", textAlign: "center", letterSpacing: 1 }}>
          {pendientes} PICK{pendientes !== 1 ? "S" : ""} PENDIENTE{pendientes !== 1 ? "S" : ""} DE RESULTADO
        </div>
      )}
    </div>
  );
}
