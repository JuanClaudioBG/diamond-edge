# Resultados de Backtest — Diamond Edge

**Última actualización:** 2026-07-02

## Estado: sin backtest histórico válido posible

No existen snapshots pregame anteriores a 2026-07-02 (las probabilidades del modelo, las cuotas al momento del pick y la versión de la lógica no se registraban — hallazgos C-2/C-3 de la auditoría). **No se simularon resultados**: aplicar cuotas o stats actuales a juegos pasados fabricaría métricas ficticias.

## Lo único medible con datos reales existentes

Fuente: `picks.db`, 94 picks (2026-05-31 → 2026-07-01), 86 con resultado marcado manualmente por el usuario.

| Segmento | Récord | Hit rate | IC 95% (Wilson) |
|---|---|---|---|
| **Total** | 53/86 | **61.6%** | [51%, 71%] |
| Moneyline | 19/36 | 52.8% | [37%, 68%] |
| Prop | 25/36 | 69.4% | [53%, 82%] |
| Total (O/U) | 5/10 | 50.0% | [24%, 76%] |
| Run Line | 4/4 | 100% | [51%, 100%] ⚠ anécdota |
| valor=ALTO | 35/53 | 66.0% | [53%, 77%] |
| valor=MEDIO | 18/33 | 54.5% | [38%, 70%] |
| riesgo=BAJO | 29/41 | 70.7% | [56%, 82%] |
| riesgo=MEDIO | 24/45 | 53.3% | [39%, 67%] |

### Interpretación honesta

- **Nada de esto demuestra rentabilidad.** Sin cuotas por pick, 61.6% puede ser ganador o perdedor. Moneyline al 52.8% es probablemente **negativo** si predominaron favoritos (break-even de un favorito −150 es 60%).
- Los intervalos de confianza de todos los segmentos se traslapan con 50%. Con n≈36 por mercado, la muestra no alcanza para afirmar skill.
- La ordenación ALTO > MEDIO (66% vs 54.5%) y riesgo BAJO > MEDIO (70.7% vs 53.3%) es direccionalmente alentadora pero no significativa (p≈0.2).
- Los resultados fueron marcados a mano, sin verificación contra marcadores oficiales.

## Métricas bloqueadas y su desbloqueador

| Métrica | Bloqueada por | Desbloqueada desde |
|---|---|---|
| Brier, log loss, calibración | sin probabilidad numérica histórica | 2026-07-02 (campo `probLocal` + `analysis_log`) |
| ROI, yield, unidades, drawdown | sin cuota al momento del pick | 2026-07-02 (`odds_json` por análisis) |
| CLV | sin línea de cierre | pendiente (roadmap P1: job de captura al primer pitch) |
| Favorito vs underdog, rangos de odds/edge | sin cuotas históricas | 2026-07-02 |
| Comparación vs baselines | sin registro reproducible | 2026-07-02 (`evaluate.js`) |

## Cómo regenerar este reporte cuando haya datos

```bash
cd server
node backtest/settle.js      # liquidar juegos finalizados
node backtest/evaluate.js    # imprime métricas; --csv/--json para exportar
```

`evaluate.js` marca cada celda con n<30 como insuficiente. El criterio de éxito predefinido está en `BACKTEST_METHODOLOGY.md`: el modelo debe batir el Brier de la probabilidad de mercado sin vig, o mostrar ROI > 0 no atribuible a azar, con ≥300 predicciones no-retro.
