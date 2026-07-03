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

      {analysis.radar && (
        <div className="acard">
          <div className="acard-hdr">🎯 Radar de Ponches</div>
          <div className="acard-b">
            {[analysis.radar.away, analysis.radar.home].filter(Boolean).map((r, i) => {
              const k = (v) => (v == null ? "–" : v);
              return (
                <div key={i} style={{ padding: "6px 0", borderBottom: i === 0 && analysis.radar.home && analysis.radar.away ? "1px solid var(--b1)" : "none", fontFamily: "var(--fm)", fontSize: 11, lineHeight: 1.7, color: "var(--dm)" }}>
                  {r.insufficient ? (
                    <><span style={{ color: "var(--tx)" }}>{r.name}</span> — Muestra insuficiente: {r.reason}</>
                  ) : !r.radarQualified ? (
                    <><span style={{ color: "var(--tx)" }}>{r.name}</span> — <span style={{ color: "var(--au)" }}>{r.compactNote}</span> <span style={{ color: "var(--mu)" }}>({r.score}/10 · aperturas válidas {r.sample.validKLast10}/{Math.min(r.sample.starts, 10)})</span></>
                  ) : (
                    <>
                      <div>
                        <span style={{ color: "var(--tx)", fontWeight: 600 }}>{r.name}</span>
                        {" — "}
                        <span style={{ color: "var(--gn)" }}>Perfil Radar calificado {r.score}/10</span>
                        <span style={{ color: "var(--mu)" }}> · aperturas válidas {r.sample.validKLast10}/{Math.min(r.sample.starts, 10)} (cobertura {Math.round(r.sample.coverage * 100)}%)</span>
                      </div>
                      <div>Últimas 5: <span style={{ color: "var(--cy)" }}>{r.sample.last5Ks.map(k).join(" · ")}</span>
                        {"  ·  "}Últimas 10: {r.sample.last10Ks.map(k).join(" ")}</div>
                      <div>Prom {k(r.sample.avgK)} · Mediana {k(r.sample.medianK)} · {k(r.sample.avgIP)} IP/apertura{r.sample.avgPitches != null ? ` · ${r.sample.avgPitches} pitches` : ""}</div>
                      <div>Últimas 10 (válidas {r.sample.validKLast10}): {[4, 5, 6, 7, 8].map(t => `${t}+ K: ${r.thresholds[t].hits}/${r.thresholds[t].n}`).join("  ·  ")}</div>
                      <div>ERA {k(r.season.era)} · xERA {k(r.season.xera)} · xFIP {k(r.season.xfip)} · K% {k(r.season.kPct)} · Whiff% {k(r.season.whiffPct)}</div>
                      {r.rival && <div>Rival: {r.rival.teamName} · K% ofensivo {k(r.rival.kPct)} · lineup {r.rival.lineupConfirmed ? "confirmado" : "no confirmado"}</div>}
                      {r.line ? (
                        <div style={{ color: "var(--cy)" }}>
                          Línea {r.line.point} ({r.line.bookTitle}{r.line.lastUpdate ? `, ${r.line.lastUpdate}` : ""})
                          {r.line.over && ` · Over ${r.line.over.price > 0 ? "+" : ""}${r.line.over.price}`}
                          {r.line.under && ` · Under ${r.line.under.price > 0 ? "+" : ""}${r.line.under.price}`}
                          {!r.line.complete && " · ⚠ solo un lado verificado"}
                          {r.line.vsLine?.last10 && ` — habría superado una línea de ${r.line.point} en ${r.line.vsLine.last10.hits} de sus últimas ${r.line.vsLine.last10.n} aperturas`}
                          {r.line.vsLine?.season && ` (temporada: ${r.line.vsLine.season.hits}/${r.line.vsLine.season.n})`}
                          <div style={{ color: "var(--mu)", fontSize: 10 }}>SEÑAL · {r.line.nota}</div>
                        </div>
                      ) : (
                        <div style={{ color: "var(--au)", fontSize: 10 }}>Línea no disponible · PROP PARA REVISAR — Análisis informativo. No entra a ROI, CLV ni a la muestra oficial.</div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
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

      {(() => {
        const all      = analysis.picks ?? [];
        const oficiales = all.filter(pk => pk.tipo !== "Prop para revisar");
        const revisar   = all.filter(pk => pk.tipo === "Prop para revisar");
        const fmtCuota  = (c) => (c > 0 ? `+${c}` : `${c}`);
        const chip      = (v) => (v === "SIN CUOTA" || v === "SIN VERIFICAR" || String(v).startsWith("SEÑAL")) ? v : `VALOR ${v}`;
        const pvCls     = (v) => v === "SEÑAL ALTA" ? "ALTO" : v === "SEÑAL MEDIA" ? "MEDIO" : v === "SEÑAL BAJA" ? "BAJO" : v;
        const Pick = ({ pk }) => (
          <div className="pick">
            <div className="pick-top">
              <span className="pick-tp">{pk.tipo}</span>
              <span className={`pv ${pvCls(pk.valor)}`}>{chip(pk.valor)}</span>
            </div>
            <div className="pick-tx">
              {pk.pick}
              {pk.cuotaReal != null && <span style={{ color: "var(--cy)", fontFamily: "var(--fm)", fontSize: 12 }}> · cuota real {fmtCuota(pk.cuotaReal)}</span>}
              {pk.verificado === false && pk.tipo !== "Prop para revisar" && <span style={{ color: "var(--au)", fontFamily: "var(--fm)", fontSize: 10 }}> · cuota no disponible</span>}
            </div>
            <div className="pick-rs">{pk.razon}</div>
            <button className="padd" onClick={() => onAddPick(pk)}>+ PARLAY</button>
          </div>
        );
        return (
          <>
            <div className="acard">
              <div className="acard-hdr">💰 Picks y Señales</div>
              <div className="acard-b">
                {oficiales.map((pk, i) => <Pick key={i} pk={pk} />)}
              </div>
            </div>
            {revisar.length > 0 && (
              <div className="acard">
                <div className="acard-hdr">🔍 Props para Revisar</div>
                <div className="acard-b">
                  <p style={{ fontSize: 10, color: "var(--mu)", fontFamily: "var(--fm)", marginBottom: 8 }}>
                    Línea y cuota no verificadas. No entra a ROI ni a la muestra oficial.
                  </p>
                  {revisar.map((pk, i) => <Pick key={i} pk={pk} />)}
                </div>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}
