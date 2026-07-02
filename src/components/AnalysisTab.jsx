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

      {analysis.mercado && (
        <div className="acard">
          <div className="acard-hdr">📈 Modelo vs Mercado ({analysis.mercado.book})</div>
          <div className="acard-b">
            <div className="hbk">
              <span className="hbk-t">Prob. mercado (local, sin vig)</span>
              <span className="hbk-v">{analysis.mercado.probMercadoLocal}%</span>
              <span className="hbk-v" />
              <span className="hbk-t">Prob. modelo (local)</span>
              <span className="hbk-v">{analysis.mercado.probModeloLocal ?? "–"}%</span>
              <span className="hbk-v" />
              <span className="hbk-t">EV del ganador predicho</span>
              <span className="hbk-v" style={{ color: (analysis.mercado.evGanadorPct ?? 0) > 5 ? "var(--gn)" : (analysis.mercado.evGanadorPct ?? 0) < 0 ? "var(--rd)" : "var(--au)" }}>
                {analysis.mercado.evGanadorPct != null ? `${analysis.mercado.evGanadorPct > 0 ? "+" : ""}${analysis.mercado.evGanadorPct}%` : "–"}
              </span>
              <span className="hbk-v" />
            </div>
            <p style={{ fontSize: 10, color: "var(--mu)", marginTop: 8, fontFamily: "var(--fm)" }}>
              EV calculado por el servidor contra la línea real. Positivo = el modelo ve más probabilidad que el mercado.
            </p>
          </div>
        </div>
      )}

      {analysis.bullpen && (
        <div className="acard">
          <div className="acard-hdr">🧯 Fatiga de Bullpen (experimental)</div>
          <div className="acard-b">
            {[["Visitante", analysis.bullpen.away], ["Local", analysis.bullpen.home]].map(([lbl, b]) => (
              <div key={lbl} style={{ fontSize: 11, color: "var(--dm)", fontFamily: "var(--fm)", padding: "4px 0", lineHeight: 1.6 }}>
                <span style={{ color: lbl === "Local" ? "var(--gn)" : "var(--cy)" }}>{lbl}:</span>{" "}
                {b
                  ? <>Disponibilidad {b.availabilityScore}/100 · Alto leverage {b.highLeverageAvail ?? "–"}/100 · Riesgo fatiga <span style={{ color: b.fatigueRisk > 40 ? "var(--rd)" : "var(--dm)" }}>{b.fatigueRisk}/100</span>
                      {b.likelyUnavailable?.length > 0 && <> · Prob. fuera: {b.likelyUnavailable.join(", ")}</>}</>
                  : "sin datos suficientes"}
              </div>
            ))}
            <p style={{ fontSize: 10, color: "var(--mu)", marginTop: 6, fontFamily: "var(--fm)" }}>
              Indicador informativo (uso últimos 7 días). Aún sin validación contra resultados — no altera los picks.
            </p>
          </div>
        </div>
      )}

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
