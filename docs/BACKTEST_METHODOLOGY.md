# Metodología de Backtesting — Diamond Edge

**Versión:** 1.0 · 2026-07-02

## Principio rector

No existe forma honesta de backtestear el sistema hacia atrás: las fuentes (MLB API, Savant, FanGraphs, Odds API) devuelven el **estado actual**, no snapshots históricos pregame, y fabricarlos con datos de hoy violaría la regla de no usar información futura. Por lo tanto el diseño es **forward-testing con registro completo**: cada análisis se congela en el momento en que ocurre, y la evaluación se hace sobre ese archivo congelado.

## Qué se registra (tabla `analysis_log`, `server/picks.db`)

| Campo | Contenido | Para qué |
|---|---|---|
| `created_at` | timestamp del análisis | separar fecha de predicción vs fecha de juego |
| `game_pk`, `game_date` | identificador MLB y hora de inicio | liquidación automática y guard de leakage |
| `home_team`, `away_team` | nombres | filtros |
| `logic_version` | constante `LOGIC_VERSION` del server | comparar versiones del modelo entre sí |
| `model` | id del modelo Anthropic | ídem |
| `retro` | 1 si `created_at > game_date` | **excluir de la evaluación por defecto** (look-ahead) |
| `data_quality` | fracción 0-1 de secciones del prompt con datos reales | rendimiento por calidad de datos |
| `sections_json` | qué secciones estaban pobladas | ablaciones futuras |
| `odds_json` | snapshot crudo del bookmaker usado | reproducibilidad, ROI |
| `market_prob_home/away` | probabilidad implícita **sin vig** | baseline de mercado, EV |
| `llm_prob_home` | probabilidad numérica emitida por el modelo | Brier, log loss, calibración |
| `predicted_winner`, `confianza`, `calificacion` | salida del modelo | segmentaciones |
| `ev_pct` | EV calculado **en código** | rendimiento por rango de edge |
| `context_json` | récords, venue, scores de bullpen | baselines y ablaciones |
| `output_json` | respuesta completa del LLM | repetir/auditar cualquier experimento |
| `resultado` | `home` / `away` (liquidación) | verdad terreno |

Los picks agregados al parlay guardan `analysis_id`, enlazando cada pick con el snapshot completo que lo generó.

## Reglas anti-leakage

1. **Separación de fechas:** `created_at` (predicción) y `game_date` (juego) se guardan siempre; si la predicción es posterior al inicio, `retro=1` y `evaluate.js` la excluye salvo `--include-retro`.
2. **Liquidación solo con juegos finalizados:** `settle.js` únicamente escribe `resultado` cuando `codedGameState === "F"`.
3. **Sin imputación silenciosa:** datos faltantes quedan como `NULL`; las métricas que los requieren excluyen la fila y reportan cuántas se excluyeron. Nunca se convierten en ceros.
4. **Sin cuotas retroactivas:** el ROI solo se calcula sobre filas cuyo `odds_json` fue capturado antes del juego. No hay modo de inyectar cuotas actuales a juegos pasados.
5. **Tests automatizados** (`server/test/`) cubren estas reglas.

## Herramientas

```bash
cd server
node backtest/settle.js            # liquida resultados de juegos finalizados (MLB API por gamePk)
node backtest/evaluate.js          # métricas agregadas sobre el log liquidado
node backtest/evaluate.js --from 2026-07-01 --to 2026-07-31 --confianza ALTA
node backtest/evaluate.js --csv out.csv --json out.json
node --test                        # suite de pruebas
```

### Métricas que produce `evaluate.js`

- Accuracy del ganador predicho, global y por segmento (confianza, favorito/underdog según mercado, local/visitante, rango de EV, rango de calidad de datos, `logic_version`).
- **Brier score** y **log loss** sobre `llm_prob_home`.
- **Curva de calibración** en deciles (prob. media vs frecuencia real, con n por bucket).
- Comparación contra **líneas base**:
  - **B-Mercado:** probabilidad implícita sin vig (el estándar a batir; si el modelo no lo supera, no hay edge).
  - **B-Favorito:** elegir siempre al favorito del mercado.
  - **B-Récord (log5):** probabilidad derivada solo de los récords W-L de ambos equipos.
- Tamaños de muestra e intervalos de Wilson 95% en cada celda; toda celda con n<30 se marca `⚠ insuficiente`.

### Repetibilidad

Un experimento = (`logic_version`, conjunto de filas del log). Como los inputs (`sections_json`, `odds_json`, `context_json`, `output_json`) están congelados, cualquier métrica es recomputable bit a bit. Comparar dos versiones = correr `evaluate.js` filtrado por cada `logic_version` sobre el mismo rango de fechas.

## Criterio de éxito (predefinido, para evitar racionalización posterior)

Con ≥ 300 predicciones no-retro liquidadas:
- El modelo aporta valor **solo si** su Brier es menor que el de B-Mercado en la misma muestra, o su ROI a cuota registrada es > 0 con IC que excluya lo explicable por azar.
- Si el modelo no supera a B-Mercado, la conclusión correcta es usar la probabilidad de mercado y limitar el LLM a análisis cualitativo.

## Limitaciones conocidas

- La cobertura empieza el 2026-07-02; no hay datos hacia atrás.
- La cuota registrada es la del momento del análisis, no la de cierre; el CLV requiere un job adicional que re-capture la línea al primer pitch (roadmap P1).
- El LLM no es determinista incluso con `temperature: 0` exacto entre versiones de modelo; `logic_version` + `model` acotan pero no eliminan esta variación.
