# Reglas de Integridad de Datos — Diamond Edge

**Versión:** 1.0 · 2026-07-02

## Comandos de diagnóstico

```bash
npm run audit-db      # integridad completa de picks.db (solo lectura, exit 1 si hay críticos)
npm run healthcheck   # estado operativo + conectividad de fuentes (exit 1 si hay críticos)
npm run test:server   # 42 tests: matemática de odds, métricas, dedup, ROI, bullpen, anti-leakage
```

## Esquema y campos

### `picks` (histórica + prospectiva)

| Campo | Obligatorio | Significado de NULL |
|---|---|---|
| `fecha` (YYYY-MM-DD local) | sí | — |
| `partido`, `tipo`, `pick` | sí | — |
| `valor`, `riesgo` | no | el análisis no lo emitió |
| `resultado` | no | pendiente de marcar (manual) |
| `analysis_id` | no | **pick histórico pre-2026-07-02** (94 filas) o guardado sin análisis |

### `analysis_log` (una fila por análisis ejecutado)

| Campo | Obligatorio | Significado de NULL |
|---|---|---|
| `created_at` | sí (auto) | — · **UTC sin sufijo** (convención SQLite `datetime('now')`) |
| `logic_version`, `model` | sí | si falta → fila corrupta (crítico en audit-db) |
| `game_pk` | debería | sin él no hay liquidación automática |
| `game_date` | debería | sin él `retro=NULL` → excluido de métricas |
| `retro` | sí | `0`=prospectivo confirmado · `1`=posterior al inicio · `NULL`=indeterminable (**nunca se asume prospectivo**) |
| `odds_json` | no | sin línea al momento del análisis → sin ROI para esa fila |
| `odds_fetched_at` | no | momento de captura de odds (cache ≤1 h; el snapshot interno trae `last_update` del bookmaker) |
| `llm_prob_home` | no | el modelo no emitió probabilidad válida → sin Brier para esa fila |
| `market_prob_home/away` | no | sin ambos lados del ML no se calcula prob justa |
| `ev_pct` | no | falta prob del modelo o del mercado |
| `resultado` | no | juego no liquidado · solo `home`/`away`, escrito únicamente por `settle.js` con estado Final |

## Políticas

**Timestamps/timezone.** `created_at` es UTC (sin marcador — al parsear en JS añadir `Z` o usar `datetime()` de SQLite). `game_date` es ISO-8601 con `Z`. `picks.fecha` es fecha *local* del usuario. La comparación prospectivo/retrospectivo se hace en el servidor con épocas (`Date.now()` vs `gameDate`), nunca comparando strings de distinta convención.

**NULL ≠ 0.** Un dato faltante queda NULL y la fila se excluye de la métrica que lo requiere, reportando cuántas se excluyeron. Está prohibido imputar cero, promedio o valor neutral. (Tests lo cubren: Brier/ROI/bullpen.)

**Duplicados.** Identidad de un análisis = `game_pk` + `created_at` + `logic_version`. Reanalizar un juego (cambio de pitcher, línea nueva) es **válido**: se agrega una fila nueva; `evaluate` usa el snapshot más reciente por `game_pk` por defecto (`--all-snapshots` para verlos todos); nada se borra. Varios picks del mismo análisis (`analysis_id` compartido) es normal. Dos juegos mismos equipos mismo día = `gamePk` distintos; las odds se emparejan por `commence_time` ±4 h.

**Retrospectivos.** `retro=1` y `retro=NULL` jamás entran a las métricas por defecto. `audit-db` verifica además que todo `retro=0` tenga `created_at` UTC < `game_date` (detector de falsos prospectivos).

**Cambios de pitcher.** El snapshot registra lo que se sabía al analizar (`sections_json` incluye si había probable). Si el pitcher cambia después, el análisis viejo NO se edita: se re-analiza y el dedup se encarga.

**Mercados.** El ROI automático cubre solo **moneyline** (cuota congelada del lado predicho). Run Line/Total/Props se registran como picks pero no tienen ROI automático; los props ni siquiera tienen línea real registrada (el modelo la estima — tratarlos como no verificables).

**Odds.** Fuente y hora quedan dentro de `odds_json` (bookmaker `key` + `last_update`) más `odds_fetched_at`. Prohibido rellenar odds faltantes con líneas actuales o de otro libro/momento.

**Calidad de datos.** `data_quality` = fracción de 17 fuentes con datos reales (pitchers probables, Savant×2, FanGraphs×2, clima, odds, lineup, splits×2, bullpen×2, plateo×2, fatiga×2); el detalle queda en `sections_json`. Una fuente caída baja el score y aparece como `false` — nunca se convierte en dato.

**Versiones.** Cualquier cambio de prompt, fuentes o reglas ⇒ bump de `LOGIC_VERSION` (historial en comentario de `server/index.js`). `evaluate` advierte cuando hay mezcla de versiones en la muestra.

## Señales de posible leakage (revisar si aparecen)

1. `audit-db` reporta "marcados prospectivos pero creados DESPUÉS del inicio" → bug del reloj o de `gameDate`.
2. Accuracy del modelo >> mercado con n chico → sospecha antes que celebración.
3. Filas `retro=0` con `game_date` NULL → imposible por diseño; si aparece, bug.
4. Bullpen con `gamesAnalyzed` que incluya el juego analizado → violaría `isUsableGame` (test lo cubre).
5. Brier que mejora mágicamente tras un cambio sin bump de versión → alguien tocó la lógica sin versionar.
