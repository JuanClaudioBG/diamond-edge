export default function HistorialTab({ picks, onMarcarResultado }) {
  const total     = picks.length;
  const ganados   = picks.filter(p => p.resultado === "ganó").length;
  const perdidos  = picks.filter(p => p.resultado === "perdió").length;
  const pendientes = total - ganados - perdidos;
  const pct       = total > 0 ? Math.round((ganados / (ganados + perdidos || 1)) * 100) : 0;

  const desglose = picks.reduce((acc, p) => {
    if (!acc[p.tipo]) acc[p.tipo] = { total: 0, ganados: 0 };
    acc[p.tipo].total++;
    if (p.resultado === "ganó") acc[p.tipo].ganados++;
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
      {/* Stats */}
      <div className="hstats">
        {[
          { v: total,      l: "Total Picks",  cls: "dm" },
          { v: `${pct}%`,  l: "% Ganados",    cls: "gn" },
          { v: ganados,    l: "Ganados",       cls: "gn" },
          { v: perdidos,   l: "Perdidos",      cls: "rd" },
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
                  <span key={`${tipo}-v`} className="hbk-v">{d.ganados}/{d.total}</span>
                  <span key={`${tipo}-p`} className="hbk-v" style={{ color: d.ganados > 0 ? "var(--gn)" : "var(--dm)" }}>
                    {d.total > 0 ? `${Math.round((d.ganados / d.total) * 100)}%` : "–"}
                  </span>
                </>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Picks list */}
      {picks.map(p => (
        <div key={p.id} className="hpick">
          <div className="hpick-info">
            <div className="hpick-gm">{p.partido} · {p.fecha}</div>
            <div className="hpick-pk">{p.pick}</div>
            <div className="hpick-mt">{p.tipo} · Valor: {p.valor} · Riesgo: {p.riesgo}</div>
          </div>
          <div className="rbtns">
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
      ))}

      {pendientes > 0 && (
        <div style={{ fontFamily: "var(--fm)", fontSize: 9, color: "var(--mu)", textAlign: "center", letterSpacing: 1 }}>
          {pendientes} PICK{pendientes !== 1 ? "S" : ""} PENDIENTE{pendientes !== 1 ? "S" : ""} DE RESULTADO
        </div>
      )}
    </div>
  );
}
