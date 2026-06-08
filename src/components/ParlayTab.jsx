export default function ParlayTab({ parlay, onRemovePick }) {
  return (
    <div className="pcont">
      {parlay.length === 0 ? (
        <div className="pmt">
          <div className="pmt-i">🎰</div>
          <div className="pmt-h">PARLAY VACÍO</div>
          <div className="pmt-s">Analiza partidos y agrega picks con el botón + PARLAY</div>
        </div>
      ) : (
        <>
          {parlay.map(p => (
            <div key={p.id} className="pi">
              <div className="pi-info">
                <div className="pi-gm">{p.game}</div>
                <div className="pi-pk">{p.pick}</div>
                <div className="pi-mt">{p.tipo} · Valor: {p.valor} · Riesgo: {p.riesgo}</div>
              </div>
              <button className="pi-rm" onClick={() => onRemovePick(p.id)}>✕</button>
            </div>
          ))}
          <div className="pfoot">
            <div className="pf-cnt">{parlay.length} picks seleccionados</div>
            <div className="pf-ttl">PARLAY {parlay.length}-TEAM</div>
            <p style={{ fontSize: 12, color: "var(--dm)", lineHeight: 1.6, marginBottom: 10 }}>
              {parlay.length >= 2
                ? `Los ${parlay.length} picks deben ganar para cobrar. Más picks = más pago y más riesgo.`
                : "Agrega al menos 2 picks para armar un parlay."}
            </p>
            <div className="pf-w">⚠ Apuesta solo lo que puedas perder</div>
          </div>
        </>
      )}
    </div>
  );
}
