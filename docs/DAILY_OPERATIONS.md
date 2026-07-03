# Operación Diaria — Diamond Edge

**Versión:** 1.0 · 2026-07-02 · Complementa `BACKTEST_METHODOLOGY.md` y `DATA_INTEGRITY_CHECKS.md`

Todos los comandos `npm run <x>` funcionan **desde la raíz del proyecto** (delegan a `server/` vía `--prefix`). Si trabajas dentro de `server/`, usa los mismos nombres ahí.

## Rutina diaria

### 1. Arrancar

```bash
npm run build            # solo si cambió el frontend
cd server && npm start   # backend + frontend en http://localhost:3001
```

El arranque debe mostrar los 4 warm-ups: `[Savant] ... pitchers`, `[Savant] Batter ...`, `[Standings] Cargados: 30`, `[FanGraphs] ...`. Si alguno falta, esa fuente está caída (el análisis continúa con calidad reducida).

### 2. Healthcheck (antes de analizar)

```bash
npm run healthcheck
```

Reporta: versión lógica, conexión DB, actividad de hoy, integridad rápida, retrospectivos, liquidaciones atrasadas y conectividad de fuentes. **Código de salida ≠ 0 = hay un crítico; no operes hasta resolverlo.**

### 3. Analizar y registrar picks

- Analiza **antes del primer pitch**. El servidor marca `retro=1` automáticamente si llegas tarde y ese análisis no contará en las métricas prospectivas.
- Cada análisis queda auto-registrado en `analysis_log` (verás `[Calidad] NN%` en el log del server).
- Al presionar **+ PARLAY** el pick se guarda enlazado vía `analysis_id`.
- Verifica el registro: `npm run audit-db` → "prospectivos enlazados" debe subir.

### 3b. Capturar líneas de cierre (antes de cada tanda de juegos)

```bash
npm run close                # captura real (1 crédito Odds API por corrida)
npm run close -- --dry-run   # ensayo: muestra qué haría sin escribir nada
```

Correr **~10-15 minutos antes** del inicio de cada tanda de juegos (los juegos MLB se agrupan en 4-6 horarios por día — una corrida por tanda basta; el cierre válido exige quedar a 0-30 min del inicio). Una corrida a T−45 sirve como ensayo o snapshot temprano, pero **no cuenta como cierre válido**. Correr dos veces (p.ej. T−25 y T−10) es válido y mejor: se conservan ambos snapshots y evaluate usa el más cercano al inicio. Solo captura cierres del mismo sportsbook de la entrada; un cierre perdido deja CLV NULL para ese juego (visible en healthcheck al día siguiente) — nunca se inventa ni se sustituye con otro book. Capturas posteriores al inicio quedan invalidadas.

### 4. Liquidar (al día siguiente, o esa noche)

```bash
npm run settle
```

Solo liquida juegos con estado **Final**. Pospuestos/suspendidos quedan pendientes (correcto — se liquidarán cuando se jueguen, mismo `gamePk`; si se reprograma con otro gamePk el análisis queda sin liquidar y así debe quedarse).

### 5. Evaluar

```bash
npm run evaluate                                   # métricas acumuladas
cd server && node backtest/evaluate.js --from 2026-07-01 --to 2026-07-07   # una semana
cd server && node backtest/evaluate.js --logic-version 2026-07-02.2        # una versión
cd server && node backtest/evaluate.js --csv out.csv --json out.json       # exportar
```

La exportación **no sobrescribe** archivos existentes (escribe variante con timestamp y avisa).

### 6. Backup (mínimo semanal; ideal diario)

```bash
npm run backup-db      # crea server/backups/picks-<timestamp>.db
npm run list-backups   # verifica que existe y su tamaño
```

Restauración manual (nunca automática): parar servidor → `cp server/backups/picks-<ts>.db server/picks.db` → `npm run audit-db`.

## Situaciones especiales

| Situación | Qué hacer |
|---|---|
| **Juego pospuesto** | Nada. `settle` no lo liquidará (no es Final). Si se reprograma con el mismo gamePk se liquidará al jugarse; el análisis seguirá siendo válido solo si el pitcheo no cambió — usa tu criterio para el pick, la métrica registra lo que el modelo vio. |
| **Cambio de pitcher anunciado** | Re-analiza el partido. El nuevo análisis es un *reanálisis legítimo*: `evaluate` usa automáticamente el snapshot más reciente por juego, el anterior se conserva pero no se doble-cuenta. |
| **Doble cartelera** | Cada juego tiene su propio `gamePk`. Las odds se emparejan por `commence_time` (±4 h); si el juego 2 aún no tiene línea, el análisis se registra sin odds (evaluable predictivamente, no en ROI). |
| **Análisis después del primer pitch** | Queda `retro=1` y excluido de métricas prospectivas. No lo uses para apostar. |
| **Pick tipo Prop** | La línea de prop **no viene de nuestros datos** (el modelo la estima). Los props no tienen EV verificable ni entran al ROI — se rastrean solo por hit rate manual. |

## Cómo leer las métricas

- **Brier Score** (0 = perfecto, 0.25 = moneda al aire): mide qué tan buenas son las *probabilidades*, no solo los aciertos. **El objetivo único de la muestra: Brier del modelo < Brier del mercado.**
- **Log Loss**: como Brier pero castiga más la sobreconfianza equivocada. ln(2)≈0.693 = moneda al aire.
- **Calibración**: en el decil p∈0.6–0.7 el equipo local debe ganar ~60-70% de las veces. Desviaciones sistemáticas = modelo sobre/subconfiado (corregible con Platt/isotónica cuando n≥300).
- **ROI/unidades**: a cuota congelada pregame, stake plano 1u sobre el pick del modelo. Positivo sostenido con IC que excluya el azar = edge real. Un ROI de +20% con n=15 no significa nada.
- **CLV** (puntos de probabilidad sin vig): positivo = tu línea de entrada anticipó el movimiento al cierre. Es la métrica de skill que converge más rápido (~50-100 picks vs 300+ para ROI), pero **no garantiza rentabilidad** — el vig puede comerse un CLV pequeño. Solo moneyline, mismo book, y con n<30 es ruido.
- **vs Mercado**: si `B-Favorito` o el Brier del mercado ganan al modelo, el mercado es mejor predictor y el sistema no debe apostar contra él.
- **Por LOGIC_VERSION**: nunca compares métricas mezclando versiones; `evaluate` advierte si hay mezcla.

## Reglas de la muestra prospectiva (no negociables)

1. Análisis válido = generado **antes** del primer pitch.
2. Todo cambio de prompt/fuentes/lógica ⇒ **bump de `LOGIC_VERSION`** en `server/index.js` (documentado en el comentario del historial).
3. **No se cambia la lógica durante la muestra** salvo bug objetivo demostrado (documentarlo en el historial de versiones).
4. Datos faltantes permanecen `NULL` — jamás se rellenan.
5. Retrospectivos jamás entran al resultado principal.
6. Los mercados se evalúan por separado (ML en ROI; props solo hit-rate).
7. No se reconstruyen cuotas históricas. Nunca.
8. Los 94 picks históricos son intocables (era pre-log; solo sirven de contexto).
9. No se declara edge hasta ≥300 predicciones prospectivas liquidadas y Brier < mercado (criterio predefinido en `BACKTEST_METHODOLOGY.md`).
10. Bullpen fatigue sigue siendo informativo hasta demostrar mejora en backtest.
