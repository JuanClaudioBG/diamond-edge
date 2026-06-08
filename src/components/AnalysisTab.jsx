import { advCls, advLbl } from "../utils";

export default function AnalysisTab({ analysis, analyzing, onAnalyze, onAddPick }) {
  if (analyzing) return <div className="ld"><span className="sp" />ANALIZANDO CON IA…</div>;

  if (!analysis) return (
    <div className="acont">
      <div className="acard">
        <div className="acard-hdr">Motor Moneyball / Sabermetrics IA</div>
        <div className="acard-b" style={{ paddingBottom: 0 }}>
          <p style={{ fontSize: 13, color: "var(--dm)", lineHeight: 1.6, marginBottom: 12 }}>
            La IA analizará el duelo de pitchers, matchups ofensivos, records de temporada y otros factores para generar picks con valor real para tu parlay.
          </p>
        </div>
      </div>
      <button className="abtn" onClick={onAnalyze}>⚡ ANALIZAR PARTIDO CON IA</button>
    </div>
  );

  if (analysis.error) return (
    <div className="acont">
      <div className="acard">
        <div className="acard-b" style={{ color: "var(--rd)", fontFamily: "var(--fm)", fontSize: 12 }}>
          Error en análisis. Intenta de nuevo.
        </div>
      </div>
      <button className="abtn" onClick={onAnalyze}>↺ REINTENTAR</button>
    </div>
  );

  const sc = analysis.calificacionGeneral || 5;
  const scC = sc >= 7 ? "var(--gn)" : sc >= 5 ? "var(--au)" : "var(--rd)";

  return (
    <div className="acont">
      <div className="acard">
        <div className="acard-hdr">📊 Análisis Moneyball</div>
        <div className="acard-b">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
            <p style={{ fontSize: 12, color: "var(--dm)", lineHeight: 1.6, flex: 1 }}>{analysis.resumen}</p>
            <div style={{ textAlign: "center", flexShrink: 0 }}>
              <div style={{ fontFamily: "var(--fh)", fontSize: 28, color: scC, lineHeight: 1 }}>{sc}</div>
              <div style={{ fontFamily: "var(--fm)", fontSize: 8, color: "var(--mu)", letterSpacing: 1 }}>/10</div>
            </div>
          </div>
          <div className="adv-row">
            {[
              { l: "Pitcheo",  v: analysis.ventajaPitcheo,  s: analysis.ventajaPitcheoTexto },
              { l: "Ofensiva", v: analysis.ventajaOfensiva, s: analysis.ventajaOfensivaTexto },
            ].map(({ l, v, s }) => {
              const cls = advCls(v);
              return (
                <div key={l} className={`adv ${cls}`}>
                  <div className="adv-l">{l}</div>
                  <div className={`adv-v ${cls}`}>{advLbl(v)}</div>
                  {s && <div className="adv-s">{s}</div>}
                </div>
              );
            })}
          </div>
          <ul className="fac">{analysis.factoresClave?.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      </div>

      <div className="acard">
        <div className="acard-hdr">🎯 Predicción</div>
        <div className="acard-b">
          <div className="pr">
            <div>
              <div style={{ fontFamily: "var(--fm)", fontSize: 8, color: "var(--mu)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 3 }}>Ganador predicho</div>
              <div className="pw">{analysis.prediccion?.ganador}</div>
            </div>
            <span className={`conf ${analysis.prediccion?.confianza}`}>{analysis.prediccion?.confianza}</span>
          </div>
          <p style={{ fontSize: 12, color: "var(--dm)", lineHeight: 1.5 }}>{analysis.prediccion?.razon}</p>
        </div>
      </div>

      <div className="acard">
        <div className="acard-hdr">🔢 Total de Carreras</div>
        <div className="acard-b">
          <div className="tot-row">
            <span className={`tot ${analysis.totalCarreras?.recomendacion}`}>
              {analysis.totalCarreras?.recomendacion} {analysis.totalCarreras?.estimado}
            </span>
            <p style={{ fontSize: 12, color: "var(--dm)", lineHeight: 1.5 }}>{analysis.totalCarreras?.razon}</p>
          </div>
        </div>
      </div>

      <div className="acard">
        <div className="acard-hdr">💰 Picks con Valor</div>
        <div className="acard-b">
          {analysis.picks?.map((pk, i) => (
            <div key={i} className="pick">
              <div className="pick-top">
                <span className="pick-tp">{pk.tipo}</span>
                <span className={`pv ${pk.valor}`}>VALOR {pk.valor}</span>
              </div>
              <div className="pick-tx">{pk.pick}</div>
              <div className="pick-rs">{pk.razon}</div>
              <button className="padd" onClick={() => onAddPick(pk)}>+ PARLAY</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
