# FinceptTerminal - Web App Context

## Descripción General
FinceptTerminal es una aplicación web enfocada en proporcionar señales de trading en el corto plazo (intradía, operaciones que duran un día o como máximo una semana). Su objetivo principal es analizar activos altamente volátiles para capturar subidas (o bajadas) mediante umbrales y estrategias basadas en indicadores técnicos.

## Arquitectura y Estructura
La aplicación separa claramente las responsabilidades:
- **`src/services/api.ts`**: Encargado de la obtención de datos (klines/velas Binance y Yahoo Finance), resúmenes de tickers, earnings y noticias con capa de deduplicación in-memory y colapso de peticiones en vuelo.
- **`src/utils/strategyEvaluators.ts`**: **Single Source of Truth (SSOT)** que encapsula el 100% de la lógica de evaluación pura de las 5 estrategias (`evaluateConfluenciaAt`, `evaluateScoringAt`, `evaluateStandardVotingAt`, `evaluateVCMESniperAt`, `evaluateMultifractalMTFAt`) en tiempo $O(1)$ con precomputación de series.
- **`src/utils/indicators.ts`**: Contiene toda la lógica matemática de los indicadores técnicos (RMA RSI, MACD, VWAP, Bollinger Bands, ATR, Supertrend, StochRSI, S/R, Volume Composition, Andian Oscillator) y delega la toma de decisiones al evaluador SSOT.
- **`src/utils/tradeSimulator.ts`**: Motor puro y centralizado de simulación de operaciones (`simulateTrade`). Gestiona ejecuciones multi-nivel (TP1/TP2/TP3), trailing Chandelier, time-stops, emergency exit, cálculo de $R$ neto uniforme ($R_{\text{net}} = \frac{\text{netPnlPct}/100}{\text{initialRiskPct}}$) y fricción ($0.08\%$).
- **`src/utils/backtester.ts`**: Lógica de simulación histórica y backtesting pre-indexado $O(N)$ para evaluar el rendimiento de las 5 estrategias con partición Walk-Forward (70/30), métricas de riesgo ($MDD_R$, Sortino, rachas) y helpers canónicos de cooldown (`getStrategyCooldownCandles`, `getStrategyCooldownMs`).
- **`src/utils/tournament.ts`**: Torneo de ventaja estadística QVE (Quantitative Value Edge) que rankea estrategias con normalización temporal $\sqrt{t}$, regularización Bayesiana de PF ($\max(0, c.resolved) \times 0.4$), penalización por drawdown, gating Walk-Forward y estado FLAT (`bestStrategy: 'NONE'`) cuando ningún motor demuestra edge positivo.
- **`src/utils/alertTracker.ts`**: Motor de tracking en vivo de alertas, deduplicación persistente atómica por vela (`dedupKey`), auditoría de estados (`OPEN`, `TP1_HIT`, `TP1_CLOSED`, `TP1_BE_CLOSED`, `TP2_HIT`, `TP2_CLOSED`, `SL_HIT`, `EXPIRED`) y cálculo de estadísticas netas de sesión.
- **`src/components/`**: Componentes de React para la UI (`MarketRadar`, `Chart`, `SignalPanel`, `Watchlist`, `MarketTicker`, `HelpModal`).
- **`src/App.tsx`**: Contenedor principal que maneja el estado global, escaneo en background cada 60s con throttling sincronizado, alertas del sistema operativo y selector de vistas (Gráfico / Radar).

## Indicadores Técnicos Implementados y Corregidos
Recientemente se han realizado optimizaciones críticas en la matemática y lógica de los indicadores para operar de manera realista:
1. **RSI (Relative Strength Index)**: Utiliza suavizado RMA (Welles Wilder's Smoothing) en lugar de un simple promedio (SMA) para preservar el contexto histórico de la volatilidad. Incluye detección de **Pendiente (RSI Slope)** para filtrar señales en contra del momentum inmediato.
2. **VWAP (Volume Weighted Average Price)**: Implementado para un entorno intradiario. Se reinicia en cada sesión diaria a las 00:00 UTC para criptomonedas, y a las 9:30 AM EST (apertura de NYSE) para acciones estadounidenses.
3. **MACD**: Modificado para actuar como un trigger direccional. Se buscan cruces de la línea MACD y la línea de señal en las últimas 3 velas. Cuenta con un **filtro de desaceleración de histograma** que invalida señales si el momentum ya está decayendo.
4. **EMA 200 y EMA 50 (Filtro de Tendencia Macro)**: Integrados en la escala diaria (1D) y horaria (1H) para establecer el bias direccional. Evitan operar en contra de la tendencia principal.
5. **ADX (14) con Suavizado Wilder (RMA)**: Indicador de fuerza de tendencia implementado en 1H para asegurar que solo operamos en momentum de expansión de volatilidad (ADX > 20).
6. **Bollinger Bands (20,2)**: Utilizado en la escala de gatillo (5m) para identificar expansiones (Ruptura/Breakout) o rechazos (Reversión/Pullback).
7. **Soportes y Resistencias (S/R)**: Detecta dinámicamente pivot highs/lows del precio y los consolida mediante clustering para mapear los niveles estructurales de soporte y resistencia más relevantes y cercanos.
8. **Calidad de Vela (`Body Ratio`, `Close Position`)**: Permite determinar la decisión del impulso en velas de 5m antes del gatillo de ruptura o reversión.

## Sistemas de Señales (Grupos)
Actualmente existen 5 agrupaciones principales de señales:
1. **Experimental Signal (Signal 1)**: Evalúa cruces de EMA, el VWAP y el RSI para determinar puntos de entrada.
2. **Scoring Multicapa (Signal 2)**: Un modelo de puntaje ponderado que agrupa RSI, MACD, Bandas de Bollinger, VWAP y la capa de **Estructura S/R (Layer 6)**. Valida de forma estricta que el ratio **R:R mínimo sea >= 1.5:1** antes de confirmar una señal. Los pesos son ajustables por el usuario.
3. **Standard Voting**: Agrupa las lecturas de RSI, MACD, Bollinger Bands, Supertrend y Stochastic RSI. Para emitir una señal "Fuerte", se requiere un consenso de 3 o más votos en una dirección, integrando el filtro de la EMA 200 y volumen confirmatorio.
4. **VCME Sniper Engine v3 (Híbrido - Upgraded)**: Estrategia cuantitativa avanzada con selección interactiva de perfil y gatillo:
   - **Perfiles de Ejecución**:
     - *Day Trading (Intradía)*: Gatillo en 5m, ventana de simulación/evaluación (576 velas de 5m), forwardWindow unificado de 72 velas (6 hs max), Stop Loss ajustado por ATR/estructura local y objetivos escalonados de TP1 (2.0R - 50% + BE), TP2 (3.5R - 25% + trailing a TP1), y TP3 (5.0R - 25% runner).
     - *Swing Trading*: Gatillo en 1H, ventana de evaluación (evalWindow = 168 velas de 1H), forwardWindow de 48 velas (48 hs max), stop loss estructural en lookback corto (5 barras) y objetivos de TP1 (2.0R - 50% + BE), TP2 (3.5R - 25%), y TP3 (5.0R - 25%).
   - **Modos de Gatillo**:
     - *Agresivo (Ruptura)*: Disparo inmediato al cumplir las condiciones de confluencia de la vela de gatillo.
     - *Conservador (Retest)*: Busca confirmación mediante retest de los niveles de ruptura (retroceso de hasta 5 velas a las BB u ORB roto) para asegurar que el rompimiento es verídico en mercados de alta volatilidad.
   - **Volumen Estacional (U-Shape)**: Implementación de RVOL estacional diario que compara el volumen actual con el promedio de la misma franja de hora y minuto UTC de los últimos 20 días para mayor precisión técnica.
   - **Clasificación de Confianza**: Gradúa las señales en `ALTA`, `MODERADA` o `DESCARTAR` (que neutraliza la señal) según el puntaje de confluencia y el nivel de volatilidad relativo.
   - **1D (Bias/Dirección)**: Determina el permiso para operar. Para LONG exige precio por encima de la EMA 200 diaria, la EMA 50 diaria por encima de la EMA 200 diaria, y un ADX diario > 20 con el +DI diario por encima del -DI diario (inverso para SHORT).
   - **1H (Setup)**: Estructura stateless que busca un setup técnico alineado en las últimas 3 horas (cierre > VWAP 1H, EMA 20 > EMA 50, RSI entre 50 y 70, y el histograma del MACD en expansión positiva) sin invalidaciones intermedias (cierres bajo VWAP o cruces cruzados de EMAs).
   - **Gatillo/Ejecución**: Ofrece tres estrategias de entrada (Pullback, Breakout, Mean Reversion) aplicadas al timeframe del perfil seleccionado (5m o 1H).
   - **Filtros de Calidad e Invalidation**:
     - *Anti-Chasing*: Rechazo de entrada si el precio dista más de 2 * ATR del VWAP.
     - *Cuerpo Decisivo*: Vela de gatillo con un ratio de cuerpo >= 40% (evitando Dojis).
     - *Apertura y Noticias*: Descarte del caos de apertura (< 15 minutos) y volumen extremo de noticias (`RVOL >= 8.0`).
     - *Límite de Riesgo*: Distancia del Stop Loss estructural limitada a un máximo de 1.2% (Intradía) o 3.5% (Swing).
     - **Gestión de Riesgo y Salidas Complejas**:
      - **Trailing Stop Chandelier:** Trailing stop dinámico basado en `highest_high_since_entry - 2.5 * ATR` o cruce de EMA 9 activo tras alcanzar el Target 2.
      - **Time Stop:** Cierre de la posición tras 8 velas (40 min en 5m Intradía) si el beneficio no ha alcanzado al menos `+0.5R`.
      - **Emergency Exit:** Salida anticipada al cierre de cualquier vela que cruce por debajo de `VWAP + EMA21` (para LONG) o por encima (para SHORT).
5. **Multifractal MTF Engine (Signal 5)**: Motor de alertas multifractal basado en un flujo de compuertas lógicas secuenciales 1D → 1H → 5M:
   - **Capa 1 — Sesgo Macro (1D Andian Oscillator)**: Descompone velas diarias en fuerza alcista (GREEN) y bajista (RED), suavizadas con EMA y normalizadas contra el rango promedio. Determina BULLISH (GREEN > ORANGE, RED en percentil 20) o BEARISH (inverso). Solo permite operar en la dirección del sesgo.
   - **Capa 2 — Contexto Volatilidad (1H Revolution Band)**: Bollinger Bands horarias que miden el ancho del canal vs. su historial de 200 barras. Cuando el ancho cae al percentil 15 (COMPRIMIDO), indica que una expansión explosiva es inminente.
   - **Capa 3 — Gatillo (5M)**: Combina dos sub-indicadores:
     - *Volume Composition*: Descompone cada vela en compra activa `(close - low) / range` y venta activa `(high - close) / range`. Requiere multiplicador de volumen ≥ 1.5x (2.5x en apertura NYSE) y dominancia ≥ 65%.
     - *Dread Blitz MCD*: Oscilador de momentum (precio vs EMA12, normalizado por ATR) con Bollinger Bands para detectar sobrecompra/sobreventa.
   - **Dos Estrategias de Entrada**:
     - *⚡ Ruptura con Expansión*: Cierre rompe banda superior/inferior + volumen institucional + dominancia activa. Requiere las 3 capas alineadas.
     - *🔄 Reversión a la Media*: Divergencia alcista/bajista en Dread Blitz + absorción pasiva en mechas. No requiere compresión 1H.
   - **Gestión de Riesgo**: Stop Loss estructural acotado entre $0.8 \times ATR$ y $2.0 \times ATR$ (máximo $2.5\%$ de riesgo relativo). Invalidación automática si sufre un retroceso adverso $> 0.5R$ en las primeras 3 velas. Target Profit único de 1.5R.
   - **Filtro NYSE Opening**: Exige multiplicador de volumen ≥ 2.5x en la ventana 09:30-09:45 EST para filtrar el ruido de apertura.

## Sistema de Backtesting (Simulación Histórica)
El módulo de backtesting ha sido refactorizado para garantizar alta fidelidad y evitar distorsiones estadísticas:
- **Simulador Unificado (`src/utils/tradeSimulator.ts`)**: Consumido por los 5 motores y por el tracker de alertas en vivo para garantizar paridad matemática 1:1 en la ejecución de órdenes, cálculo de $R$ neto uniforme ($R_{\text{net}} = \frac{\text{netPnlPct}/100}{\text{initialRiskPct}}$) y costes ($0.08\%$).
- **Simulación Multitemporal VCME Sniper v3**: Realiza backtesting simulando las 3 capas, el score de confluencia técnica, y las salidas complejas (Time Stop, Emergency Exit y Chandelier Trailing).
- **Simulación Multifractal MTF**: Backtester dedicado que replica el flujo de compuertas 1D → 1H → 5M con cooldown de 12 velas (≥ forwardWindow), forward window de 12 velas (1 hora), invalidación temprana en 3 velas ante retrocesos $> 0.5R$ y target profit único de 1.5R.
- **Control de Sesiones y Gaps**: El backtester detecta si el activo opera 24/7 (Cripto) o en horarios fijos (Acciones) y descarta señales que cruzarían el cierre de mercado.
- **Cooldown de Señales Unificado (SSOT)**: Estandarizado en $O(1)$ a través de `getStrategyCooldownCandles` y `getStrategyCooldownMs` (1 hora / 12 velas en 5m, 4 horas en 1H, 48 horas en 1D) garantizando paridad exacta 1:1 entre Live (`App.tsx`) y los 5 motores del Backtest, eliminando cualquier sesgo en la métrica $R/\text{hora}$ del torneo.

## Optimizaciones de Rendimiento y Usabilidad Realizadas
- **Actualización v2026.07.21.1**:
  - Ajuste de tolerancia en Stochastic RSI (`prevK < 20 || currK < 25`) para capturar cruces al salir de sobreventa/sobrecompra.
  - Simetrización de señales de COMPRA en Confluencia para admitir impulso alcista fuerte (`close > open && bRatio >= 0.4 && close > ema9`).
  - Corrección de `minutesSinceOpen` en timeframe 1H (Swing) para permitir evaluar la primera vela de la sesión bursátil.
  - Optimización a caché rodante $O(n)$ de niveles S/R en el engine de backtest de Scoring.
  - Sincronización del umbral de Estrategia Líder (`pf >= 1.3`) entre la interfaz visual y el escáner de alarmas en segundo plano.
- **Motor de Backtesting O(n)**: Refactorizado de $O(n^2)$ a $O(n)$ calculando las series de indicadores técnicos de una sola vez al cargar las velas y luego indexándolas en tiempo constante $O(1)$ en el loop del backtester.
- **Unificación de Cargas y Timeframes**: Al cambiar de activo, descarga todos los timeframes (5m, 1h, 1d) en paralelo una sola vez. Al cambiar de timeframe, la UI lee instantáneamente de la memoria (`allKlines[interval]`).
- **Confirmación de Vela Cerrada**: Las señales de la UI y del scanner en segundo plano se calculan sobre la última vela completamente cerrada para evitar repintado.
- **Alertas en Segundo Plano con Cooldown**: Se implementó un scanner en segundo plano (`checkAllSignals`) que verifica cada 60 segundos si algún activo ha cambiado de señal.
- **Calculadora de Position Sizing Dinámico**: Incorpora multiplicadores adaptativos de confianza (según el score de la señal), volatilidad (según el ATR% del activo), salud de la cuenta (según el drawdown deslizable ingresado) y penalización por correlación de sector para sugerir el tamaño de posición óptimo en dólares y acciones/criptomonedas.
- **Matriz de Confluencia Multitemporal**: Panel visual que resume la tendencia técnica del activo actual en las escalas de 5m, 1h y 1d de forma paralela.
- **Métricas de Contexto Fundamental y Sentimiento (Zacks & Fear/Greed)**: En la pestaña *Mercado*, se muestra información complementaria de fundamentales y sentimiento.
- **Rediseño del Panel Lateral Derecho (UI/UX)**: Interfaz estructurada en tres pestañas (Estrategias, Calculadora, Mercado) con acordeones expandibles.
- **Marquesina de Índices Bursátiles (Market Ticker)**: Widget horizontal en la cabecera que muestra futuros, VIX, materias primas y Bitcoin.
- **Actualización v2026.07.22.1 — Fixes Críticos en Sistema de Alertas**:
  - **Cold Start Fix**: El scanner ahora dispara alertas en la primera ejecución si la señal es BUY/SELL, sin exigir un `prevSignal` previo que antes nunca existía al arrancar.
  - **Throttling Recovery**: Añadido listener `visibilitychange` que ejecuta `checkAllSignals()` inmediatamente al recuperar el foco de la pestaña/ventana, compensando el throttling de `setInterval` en background.
  - **Fallback de Estrategia**: Cuando ninguna estrategia cumple `PF >= 1.3` con suficientes trades resueltos, se usa un fallback escalonado (PF >= 1.0 con umbral relajado → Standard Voting) en lugar de descartar silenciosamente el símbolo.
  - **Dependencias Stale**: Agregados `executionStyle` y `triggerMode` al array de dependencias del `useEffect` del scanner para evitar closures con valores obsoletos.
- **Actualización v2026.07.22.2 — Quant Signal Engine v4 Upgrade**:
  - **Geometría de Velas Cuantitativa**: Integración de `closePosition`, `upperWickRatio` y `lowerWickRatio` en los 4 motores de señales para eliminar disparos en velas Doji o con mechas de rechazo adversas.
  - **Standard Voting Mejora**: Exige `closePosition >= 0.45` para BUY y `<= 0.55` para SELL (descarta velas con cierre adverso `< 0.45` / `> 0.55`) antes de emitir voto definitivo.
  - **Confluencia (Signal 1) Mejora**: Incorporado filtro anti-extensiones VWAP/ATR (`|close - vwap| <= 2.2 * ATR`) y cuerpo decisivo (`closePosition >= 0.60`).
  - **Scoring Multicapa (Signal 2) Mejora**: Bonus por compresión de Bollinger (`bbWidthRatio < 0.05`) en Capa 3 y penalización por mecha de rechazo en Capa 5.
  - **VCME Sniper Engine v4**: Integración de acotamiento de riesgo ATR (`0.8 * ATR <= Risk <= 1.8 * ATR`), validación de mechas en calidad de vela y sincronización 1:1 con el motor de backtesting.
- **Actualización v2026.07.28.1 — Multifractal MTF Engine (Signal 5)**:
  - **Nuevo Motor de Señales**: Implementación completa del Motor de Alertas Multifractal (MTF) con arquitectura de 3 capas secuenciales (1D → 1H → 5M) y 4 sub-indicadores dedicados:
    - *Revolution Volatility Band*: Compresión de volatilidad con percentil histórico P15.
    - *Volume Composition*: Descomposición de volumen en compra/venta activa y detección de absorción pasiva.
    - *Andian Oscillator*: Sesgo macro con análisis de fuerza bull/bear normalizado.
    - *Dread Blitz MCD*: Oscilador de momentum normalizado por ATR con Bollinger Bands.
  - **Dos Estrategias**: Ruptura con Expansión de Volatilidad y Reversión Excesiva a la Media con divergencia.
  - **Backtester Dedicado**: `backtestMultifractalMTF` con cooldown de 12 velas, invalidación temprana (3 velas), y forward window de 1 hora.
  - **Integración Completa en Alertas**: La estrategia participa en el torneo de selección del scanner en segundo plano y dispara notificaciones de escritorio.
  - **UI Rica**: Visualización de las 3 capas con valores numéricos de Andian (Green/Red/Orange), estado de Dread Blitz, barra de composición de volumen, y texto de reasoning contextual.
  - **Performance**: Optimización de `calculateDreadBlitz` de O(n²) a O(n) usando `calculateATRSeries`.
  - **Actualización v2026.07.31 — Auditoría de Código y Verificación Zero-Error Build**:
  - **Limpieza de Errores TypeScript & ESLint**: Corrección de componente huérfano `SectionTitle` en `HelpModal.tsx`, eliminación de variables sin uso en cláusulas `catch` y parámetros no usados.
  - **Cumplimiento React 19**: Reestructuración y refactorización de hooks `useEffect` con patrones de invocación asíncrona segura en `MarketTicker.tsx`, `App.tsx` y `SignalPanel.tsx` eliminando advertencias de re-renders en cascada (`set-state-in-effect`).
  - **Verificación Automática**: Configuración y paso limpio de `tsc -b` y `eslint .` con 0 errores y 0 warnings.

### Actualización v2026.07.31.2 — Integridad de Backtesting y Scanner MTF

- **Ventana forward completa**: VCME y Multifractal excluyen operaciones sin todo su horizonte futuro, eliminando timeouts artificiales y resultados parciales.
- **ATR point-in-time**: El backtester genérico calcula stop y target con el ATR disponible en cada vela de entrada, sin aplicar volatilidad futura al pasado.
- **S/R alineado**: La capa de soporte/resistencia usa una ventana móvil fija de 100 barras por vela evaluada; Layer 6 y la validación R:R ya no quedan anuladas ni desfasadas.
- **OHLC conservador**: Si una vela toca stop y target, el backtest resuelve primero el stop. En VCME los stops también preceden a Time Stop y Emergency Exit.
- **Velas cerradas**: Panel, scanner y backtests operan con velas completamente cerradas para evitar repintado de señales y estadísticas.
- **NYSE opening corregido**: El filtro usa timestamps Unix en segundos y la zona `America/New_York`; respeta EST/EDT y no se aplica a criptomonedas.
- **Historial cripto ampliado**: Binance descarga hasta 1000 velas, suficiente para el horizonte forward de 48 h del perfil VCME intradía más la muestra evaluada.
- **Contrato MTF del scanner**: El scanner descarga siempre 5m, 1h y 1d (y el timeframe activo si fuera distinto). Multifractal recibe 5m → 1h → 1d; VCME usa 5m en Intradía y 1h en Swing.
- **Escalabilidad watchlist**: El scanner dispone de un lock contra ejecuciones solapadas y procesa hasta 4 símbolos en paralelo. Las alertas se identifican por `símbolo + timeframe real de ejecución`, incluyendo deduplicación y precio de entrada.

- **Actualización v2026.07.31.3 — Motor de Selección por Ventaja Estadística (QVE Engine) con Confianza Progresiva**:
  - **Módulo Centralizado (`tournament.ts`)**: Creada función pura `evaluateStrategyTournament` que unifica el ranking de estrategias en `App.tsx` (confluencia y scanner) y `SignalPanel.tsx`.
  - **Confianza Progresiva**:
    - Muestra mínima adaptativa: 8 trades en 5m, 5 trades en 1h, 4 trades en 1d.
    - Score compuesto multivariable: `(PF × 0.45 + Expectancy × 0.35 + WinRate × 0.20) × Penalización Sigmoide de Muestra`.
    - Tres niveles de confianza: `HIGH` (supera muestra ideal + PF ≥ 1.25), `LIMITED` (muestra pequeña pero PF ≥ 1.0), `NONE` (mercado sin ventaja, PF < 1.0).
  - **UI de Confianza**: Integración de badges dinámicos en el panel general (`✅ Alta Confianza`, `⚠️ Muestra Limitada`, `🛡️ Sin Ventaja Estadística`) y actualización de distintivo `LÍDER` / `LÍDER ⚠️` por tarjeta.
  - **Alertas Inteligentes**: Notificaciones del scanner incluyen etiqueta `[Muestra Limitada]` cuando aplica y se silencian si la confianza es `NONE`.

- **Actualización v2026.07.31.4 — Live Forward Test, Auditabilidad, Overlays en Gráfico, GPU Perf & Resiliencia**:
  - **Motor de Tracking en Vivo (`alertTracker.ts`)**: Módulo liviano que calcula Stop Loss y Take Profits (TP1/TP2) para cada alerta emitida y evalúa las velas posteriores en segundo plano.
  - **Tracking de Resultados Automático**: Clasifica en tiempo real cada alerta en `OPEN`, `TP1_HIT`, `TP1_CLOSED`, `TP1_BE_CLOSED`, `TP2_HIT`, `TP2_CLOSED`, `SL_HIT` o `EXPIRED` (con PnL flotante/neto % y $R$ neto).
  - **Barra de Métricas de Sesión**: Panel superior en el historial de alertas que resume en vivo el WinRate % de hoy y los R netos acumulados.
  - **Superposición en el Gráfico (`Chart.tsx`)**: Al hacer clic en cualquier tarjeta del historial de alertas, dibuja dinámicamente sobre el gráfico de TradingView las líneas horizontales de Entrada (Azul), Stop Loss (Rojo), TP1 (Verde) y TP2 (Esmeralda).
  - **Optimización de GPU (<5% consumo)**: Eliminados los filtros de desenfoque de capa (`backdrop-filter: blur()`) que causaban repintados Gaussianos continuos a 60-144 FPS al interactuar con la marquesina en movimiento. La marquesina utiliza aislamiento de capas (`contain: layout paint; transform: translate3d`).
  - **Actualización v2026.08.05.2 — Persistencia de Métricas de Caché & Calibración de Calidad VCME Sniper**:
  - **Caché Completo del Torneo (`App.tsx`)**: Se guardan la tasa de acierto (`winRate`) y el factor de beneficio (`profitFactor`) dentro de `bestStrategyRef` para que durante los 5 minutos del caché la función de señal use los datos verdaderos del backtest en vez de valores por defecto.
  - **Optimización de Calidad VCME Sniper (`indicators.ts`)**: Se ajustaron los filtros de calidad en velas de 5m (`closePosition >= 0.50`, `upperWickRatio <= 0.35`, `candleBodyRatio >= 0.30`) evitando descarta señales válidas por pequeñas mechas de retest.
  - **Actualización v2026.08.06.1 — Especificación Algorítmica VCME v2.0 (Institutional Quant Engine)**:
  - **Motor Algorítmico Cuantitativo Spec v2.0 (`indicators.ts`)**: Implementación rigurosa de la especificación VCME v2.0 con filtros previos de liquidez, pendiente de EMA200 1H (`ema200_slope_1H`) y régimen direccional de mercado.
  - **Asimetría Estructural LONG vs SHORT**: Reglas diferenciadas para compras ($RVOL \ge 1.5$, $1.5 \times ATR_{5m}$ SL) y ventas en corto ($RVOL \ge 1.8$, $1.8 \times ATR_{5m}$ SL) para prevenir barridos de liquidez y short squeezes.
  - **Score de Confianza Continuo [0.0 - 1.0]**: Función matemática continua ponderada (volumen, tendencia macro, momentum 1H, distancia a media y VWAP); supresión automática por debajo del $65\%$ ($0.65$).
  - **Trailing Stop Avanzado con Chandelier Exit (22, 3.0)**: Salida dinámica por $EMA21_{1H}$ y *Chandelier Exit* de 1H en el objetivo secundario ($TP2$).
  - **Clasificación DAY vs SWING con Time-Stop**: Clasificación basada en $ADX_{1H} > 30$; trades tipo `DAY` incluyen time-stop de 40 min en ausencia de momentum, trades tipo `SWING` ejecutan trailing de 1H.
  - **Sincronización Total Backtest & Alertas (`backtester.ts`, `App.tsx`)**: Alineación completa del simulador `backtestMultitemporal` y el generador de alertas en segundo plano con las nuevas reglas VCME v2.0.
  - **Actualización v2026.08.07.1 — Corrección del Historial de Alertas y Contador Diario de Sesión**:
  - **Filtro Diario "HOY" (`alertTracker.ts`)**: Introducida la función `isAlertFromToday` para que las métricas de aciertos, fallos, Win Rate y R acumulado filtren estrictamente las alertas del día actual.
  - **Capacidad de Historial y Pruning (`App.tsx`)**: Ampliada la retención de `alertsLog` a 100 alertas con depuración automática de elementos mayores a 7 días en `localStorage`.
  - **Deduplicación Atómica de Alertas (`App.tsx`)**: Prevención de alertas duplicadas al cambiar temporalidades o recargar la app mediante chequeo de estado `OPEN` y cooldown activo.
  - **Corrección de Mapeo de Klines y Preservación de TP1**: Corrección del mapeo por activo en `updateAlertsOutcome` y preservación del estado `TP1_HIT`.
  - **Actualización v2026.08.12.10 — Performance de CPU O(N), Caché FIFO, Badges en Watchlist, Notificaciones Enriquecidas y Refinamiento de Memoria**:
    - **Optimización de CPU de Backtesting ($O(N)$)**: Pre-indexación lineal $O(N+M)$ de las series 1H y 1D en `backtestMultitemporal` y `backtestMultifractalMTF`, reduciendo las iteraciones retrocedidas anidadas de $\approx 96.000$ a solo $744$ pasos (reducción del 99% en bucles anidados).
    - **Caché en Memoria con Evicción FIFO**: Implementada la capa `getBacktestCache` / `setBacktestCache` en los 5 motores de backtesting. Elimina el doble cómputo entre `App.tsx` y `SignalPanel.tsx` (respuestas en **0.01ms**). Política de desalojo suave First-In, First-Out (`Map.delete(oldestKey)`) al alcanzar 150 entradas para evitar *cache stampedes*.
    - **Expiración de Alertas por Tiempo Real**: Expiración determinista en `alertTracker.ts` basada en la estampa de tiempo del mercado (`latestCandle.time * 1000 >= alert.timestamp + 24 * intervalMs`), inmune a fallbacks de timeframe o cargas masivas iniciales.
    - **Unificación de Guardia de 1D en UI**: Homologado el guard de `closedKlines1d` a `>= 30` velas en `SignalPanel.tsx`, sincronizando la interfaz visual con las alertas emitidas por el scanner.
    - **Indicadores de Señal Activa en Watchlist**: Badges neón 🟢 **`BUY`** o 🔴 **`SELL`** en la Watchlist mientras la alerta permanezca en `OPEN` o `TP1_HIT`. Desaparición automática al cerrarse o expirar la posición.
    - **Notificaciones de Escritorio Enriquecidas**: Inclusión directa de los niveles de trading (`Entry`, `SL`, `TP1`, `TP2`) en el cuerpo de las notificaciones emergentes del sistema operativo.
    - **Bucle O(1) en `latestVolume` y Fallback UI Macro**: Reemplazado `.slice().reverse()` por un bucle retroceso sin asignaciones de memoria en `App.tsx`, eliminación del array inerte `completedTrades`, y agregado mensaje de respaldo para el calendario macro (`SignalPanel.tsx`).
  - **Actualización v2026.08.14.1 — Optimización de Red (Paso 1: Deduplicación y Caché en Memoria)**:
  - **Capa de Deduplicación y Caché (`src/services/api.ts`)**: Implementado el motor `fetchWithDeduplication` para colapsar llamadas HTTP idénticas en vuelo (batching de promesas) y almacenar respuestas en RAM con TTL por tipo de dato:
    - *Velas/Klines*: 25 segundos (evita repeticiones en el mismo ciclo de escaneo de 60s).
    - *Resúmenes de Tickers*: 30 segundos.
    - *Noticias*: 5 minutos.
    - *Fundamentales/Zacks/Ganancias*: 1 hora.
  - **Reutilización Cruzada de Datos**: Al descargar velas de 1D en el scanner de `App.tsx`, el sistema auto-puebla la clave de resumen (`summary_${symbol}`). La `Watchlist` y el `MarketTicker` leen estos valores en 0.01 ms sin realizar peticiones HTTP a Vercel.
  - **Preservación de Señales (0% Impacto)**: El scanner en segundo plano continúa ejecutándose a la frecuencia exacta de 60 segundos sobre velas cerradas, manteniendo la precisión intradía de las alertas.
  - **Reducción Estimada de Consumo**: Disminuye las solicitudes Edge de Vercel de ~30 req/min a ~8-10 req/min (reducción del 65-70%).
  - **Actualización v2026.08.18.1 — Aislamiento de Caché por Activo, Sincronización 1:1 de Fórmulas y Perfeccionamiento de Auditoría de Alertas**:
  - **Aislamiento de Caché de Backtest (`src/utils/backtester.ts`)**: Se incluyó el `symbol` en las claves de caché de `backtestStandard`, `backtestConfluencia` y `backtestScoring` (`${strategy}:${symbol}:${interval}`), eliminando la contaminación cruzada donde activos con idéntico número de velas y timestamp en Binance compartían estadísticas ajenas.
  - **Sincronización Matemática de Indicadores y Backtest**:
    - *VCME Sniper Breakout*: Alineados los multiplicadores de volumen en `backtestMultitemporal` a `1.5x` (LONG) y `1.8x` (SHORT) para coincidir con la fórmula en tiempo real de `calculateVCMESniperSignal`.
    - *Scoring Multicapa*: Añadidos los filtros de penalización por mechas (`upperWickRatio > 0.25` / `lowerWickRatio > 0.25`) en `computeScoringSignalsSeries`.
  - **Ciclo de Vida y Auditoría de Alertas (`src/utils/alertTracker.ts`)**:
    - Introducido el estado terminal `TP1_BE_CLOSED` para congelar salidas en Breakeven tras TP1 (+1.0R neto) y prevenir reevaluaciones erráticas continuas.
    - Expiración de alertas corregida para aplicar tras 24 velas tanto en estado `OPEN` como en `TP1_HIT`.
    - `calculateSessionStats` actualizado para contabilizar `TP1_BE_CLOSED` como ganancia cerrada y mantener `TP1_HIT` como posición activa mientras continúa el trailing del 50% restante.
  - **Corrección de Timeframe Mismatch en Auditoría (`src/App.tsx`)**: Suministrado el mapa completo de temporalidades (`symbol:5m`, `symbol:1h`, `symbol:1d`) en `loadExtraData` evitando evaluar alertas de 5m con velas diarias al cambiar el gráfico.

  - **Actualización v2026.08.21.1 — Deduplicación Persistente Atómica por Vela & Integridad de Alertas**:
    - **Firma Canónica Inmutable (`dedupKey`)**: Se implementó `generateCandleAlertKey` (`${symbol}:${interval}:${candleTimestamp}:${strategy}:${signal}`) para identificar unívocamente cada disparo de señal por vela cerrada.
    - **Registro Persistente en RAM y LocalStorage (`src/utils/alertTracker.ts`)**: Implementado `registerFiredCandleAlert`, `isCandleAlertFired`, `getFiredAlertsRegistry`, `pruneFiredAlertsRegistry` y `clearFiredAlertsRegistry`. Previene repetición de notificaciones y entradas de auditoría ante recargas de página, cambios de timeframe o throttling de pestañas en background.
    - **Limpieza y Poda Automática**: Depuración automática de entradas en el registro con antigüedad mayor a 7 días y sincronización completa con el botón LIMPIAR del panel de alertas.
    - **Suite de Pruebas Unitarias Ampliada**: Incorporadas 4 nuevas pruebas automáticas (15/15 pasando) validando generación determinista, bloqueo de duplicados en la misma vela, admisión de velas consecutivas y poda con TTL.
  - **Market Radar / Screener Cuantitativo en Tiempo Real (`src/components/MarketRadar.tsx`)**:
    - Vista panorámica multiactivo integrada en el área central con selector `[ 📈 GRÁFICO ]` / `[ 📡 RADAR ]`.
    - Presets de universo (`Mi Watchlist`, `Top Cripto Volátiles`, `Mega Tech`, `Growth & High Beta`, `Índices & Futuros`).
    - Matriz de Confluencia Multitemporal en vivo (5m · 1h · 1d), cálculo en paralelo de la Estrategia Líder QVE con Profit Factor, ratio RVOL de volumen institucional y detección de Squeeze/Expansión de Bandas de Bollinger.
    - Filtros rápidos cuantitativos (`🔥 Confluencia 3/3`, `🟡 Squeeze BB`, `📈 Alto RVOL ≥ 1.5x`, `🎯 Señales Activas`) y navegación en 1 clic hacia el gráfico.
- **Actualización v2026.08.24 — Quantitative Parity & Execution Fidelity Overhaul**:
  - **Paridad 1:1 VCME Sniper (Live vs Backtest)**:
    - Sincronización del régimen ADX/pendiente EMA200 evaluado localmente en cada vela de setup dentro de la ventana de 3 horas.
    - Implementación de salidas 3-tier en el tracker: TP1 (50% @ 2.0R) → Trailing Stop a Breakeven; TP2 (25% @ 3.5R) → Trailing a TP1; TP3 (25% @ 5.0R).
    - **Time-Stop de Inactividad (Intradía 5m)**: Salida automática tras 8 velas (40 min) si $PnL < 0.5R$.
  - **Paridad 1:1 Multifractal MTF**:
    - Invalidación temprana en velas 1..3 si el precio sufre retroceso adverso $> 0.5R$ (corte anticipado de pérdidas sin asumir -1.0R total).
    - Horizonte de expiración ajustado a 12 velas (1 hora en 5m).
  - **Múltiplos R Ponderados Dinámicos**:
    - Cálculo matemáticamente exacto de $R$ en base a distancias reales de niveles: para setups con 1.5R fijo TP1 = $+0.75R$ (o $+1.0R$ en VCME con 2.0R @ 50%), TP2 = $+1.875R$ en VCME ($0.50 \times 2.0R + 0.25 \times 3.5R$) con runner 25% flotante hacia TP3 ($+3.125R$).
  - **Inmunidad a Repintado en Velas Vivas (`alertTracker.ts`)**:
    - Las transiciones de estado terminales (`TP1_HIT`, `TP2_HIT`, `SL_HIT`, `TP1_BE_CLOSED`) se evalúan exclusivamente sobre velas completamente cerradas `(time + duration) * 1000 <= nowMs`. La vela en formación se reserva únicamente para el cálculo de PnL flotante.
  - **Caché Multi-Timeframe con Fingerprint Atómico OHLCV**:
    - Inclusión de tupla completa `(length, time, open, high, low, close, volume)` de la última vela y `(close, volume)` de la penúltima para $5m, 1h, 1d$.
    - Invalida y recalcula instantáneamente en $O(1)$ ante revisiones de datos intrabarra o correcciones del proveedor.
  - **Eliminación de Notificaciones Fantasma**:
    - Validación de trades activos (`OPEN` o `TP1_HIT`) antes de disparar notificaciones del SO o registrar la vela, garantizando coherencia 1:1 entre el alert popup y la tabla de auditoría.
  - **Suite de Pruebas de Paridad End-to-End**:
    - Inclusión de 24 tests unitarios automatizados que incluyen fixtures deterministas de oro (*Gold Master Fixtures*) para VCME y Multifractal.
- **Actualización v2026.08.25.1 — MarketRadar Resilience, Adaptive Volatility & Profile Synchronization**:
  - **Sincronización Total de Perfiles (Day Trading / Swing & Agresivo / Conservador)**:
    - Vinculación de `executionStyle` y `triggerMode` entre `App.tsx`, `SignalPanel.tsx` y `MarketRadar.tsx`.
    - Eliminación de hardcodes en VCME Sniper dentro del Radar y unificación del sesgo de tendencia macro.
  - **Volatilidad Autoadaptativa (Percentil Histórico de Bollinger BandWidth)**:
    - Reemplazo de umbrales estáticos por percentil histórico (P15 para `SQUEEZE`, P85 para `EXPANSION`), adaptándose a la volatilidad intrínseca de cada activo.
  - **RVOL Time-of-Day Estacional**:
    - Integración de `calculateTimeOfDayVolumeAvg` para comparar el volumen de 5m contra la media histórica de la misma hora/minuto.
  - **Confluencia MTF Ponderada**:
    - Matriz de confluencia graduada con ponderación temporal 1D (45%), 1H (35%), 5m (20%) y fuerza de votos.
  - **Normalización de Expectancy en Torneo QVE**:
    - Normalización suave con $\tanh$ para equilibrar retornos porcentuales frente a Profit Factor y Win Rate.
  - **Rendimiento y Circuit Breaker**:
    - Caché por hash de timestamps de velas para evitar recalcular 55 backtests cada minuto.
    - Pausas asíncronas no bloqueantes entre lotes para garantizar 60 FPS continuos en la UI.
    - Backoff de 10 minutos para símbolos caídos o con errores repetidos de API con estado `OFFLINE` y botón de reintento manual.

- **Actualización v2026.08.26.1 — Quantitative Precision, Parity Overhaul & Tournament Normalization**:
  - **Resolución de la Cuantización de Riesgo en Activos Low-Price**:
    - Erradicación de `.toFixed(2)` en niveles SL/TP en `indicators.ts`, `alertTracker.ts` y `App.tsx`.
    - Creación de `formatters.ts` con `getOptimalDecimals`, `formatSmartPrice` y `formatSmartNumber` adaptables dinámicamente desde $PEPE ($0.000003) hasta $BTC ($60,000+).
  - **Sincronización de Salidas y Horizontes VCME**:
    - Unificación del horizonte intradía a 72 velas (6 horas) en `backtester.ts` y `alertTracker.ts`.
    - Implementación de Emergency Exit (pérdida de VWAP + EMA21) y Chandelier Trailing Exit ($2.5 \cdot ATR$ / EMA9) en el live alert tracker.
  - **Máquina de Estados de Runner Post-TP2**:
    - Descongelamiento de `TP2_HIT` (permanece activo en evaluación continua) y creación del estado terminal `TP2_CLOSED`.
    - Con objetivos TP1 (2.0R @ 50%), TP2 (3.5R @ 25%) y TP3 (5.0R @ 25%): al tocar TP2 se asegura $+1.875R$ ($0.50 \times 2.0R + 0.25 \times 3.5R$) y el runner ($25\%$) flota en tiempo real hasta su resolución ($+2.375R$ en retroceso a TP1 SL, salida Chandelier, o $+3.125R$ en TP3).
  - **Protección de Reversión a la Media en Multifractal MTF**:
    - Eliminación de la invalidación por cruce de Midpoint con `Math.abs()` en `backtester.ts:1766-1781`.
    - Sustitución por evaluación de retroceso adverso real ($> 0.5R$) con paridad 1:1 respecto a `alertTracker.ts`.
  - **Normalización Temporal y Regularización Bayesiana en el Torneo de Estrategias**:
    - Normalización de Expectancy por raíz de tiempo ($\sqrt{t}$): factor $\text{timeFactor} = \sqrt{\max(1.0, \text{exposureHours}/\text{baseHours})}$ nivelando equitativamente ventanas de 6, 12, 48 y 72 velas sin penalizar excesivamente horizontes largos.
    - Regularización Bayesiana Laplace para Profit Factor en $0$ pérdidas, eliminando el artefacto $PF = 99.9 \to 5.0$ en $N=1$.
    - Capping muestral de PF ($\text{Max PF} = \min(5.0, 1.0 + \max(0, N) \times 0.4)$) y unificación de denominadores con `totalSignals`.

- **Actualización v2026.08.26.2 — Unified Execution Simulator, Risk Metrics, Walk-Forward Validation & Anti-Chasing Refinement**:
  - **Simulador de Ejecución Centralizado (`src/utils/tradeSimulator.ts`)**:
    - Extracción del motor puro de simulación `simulateTrade` consumido por los 5 backtests y sincronizado con `alertTracker.ts`.
    - Soporte completo de salidas 3-tier en VCME (50% TP1 @ 2.0R, 25% TP2 @ 3.5R, 25% TP3 @ 5.0R), invalidación temprana en Multifractal MTF, Time-Stops a 8 velas (40 min en 5m), Emergency Exit (pérdida de VWAP + EMA21), Chandelier Trailing Stop y fricción/slippage contable ($0.08\%$).
  - **Normalización por R y Velocidad de Exposición Equilibrada**:
    - Comparación en múltiplos $R$ netos ($E[R]$) y score con $\tanh$: $\text{expRScore} = \tanh(E[R] / 0.5) \times 3.0$ y $\text{timeNormScore} = \tanh(\text{timeNormExpR} / 0.35) \times 2.5$.
    - Tratamiento de muestras sin pérdidas ($PF = \text{null} / 99.9$) como desconocidas/indeterminadas (`PF N/D`), eliminando singularidades estadísticas en muestras pequeñas ($N=1$).
  - **Métricas de Riesgo Institucionales en Backtest y UI**:
    - Cálculo de Max Drawdown en R ($MDD_R$), Racha Máxima de Pérdidas ($L_{\text{streak}}$) y Ratio Sortino sobre la serie de retornos $R$ netos.
    - Desglose direccional Long vs Short ($\Delta$ WinRate y $E[R]$) y desglose por régimen tendencial ($ADX > 25$ vs $ADX \le 25$).
    - Penalización cuadrática en el Torneo ante drawdowns severos ($MDD_R > 3.0R$) y bonificación por consistencia Sortino positiva.
  - **Validación Walk-Forward Rigurosa (70% In-Sample / 30% Out-of-Sample)**:
    - Partición sistemática de la ventana histórica (ej. 400 velas IS / 176 velas OOS en 5m $\approx$ 14.6 h ciegas).
    - Muestra mínima OOS obligatoria: $\ge 5$ operaciones en 5m, $\ge 3$ en 1h, $\ge 2$ en 1d.
    - Clasificación en `PASS` ($N_{\text{OOS}} \ge \text{minOosTrades} \land E[R]_{\text{OOS}} \ge 0$), `FAIL` ($E[R]_{\text{OOS}} < 0$) o `NO_OOS_TRADES` ($0 \le N_{\text{OOS}} < \text{minOosTrades}$).
    - Descalificación estricta de la categoría de confianza `HIGH` para cualquier estrategia que no sea `PASS`, multiplicador $0.55\times$ para `FAIL` y $0.85\times$ para `NO_OOS_TRADES`.
  - **Corrección de `distScore` en VCME (Campana Óptima a 0.5 ATR)**:
    - Corrección de la inversión matemática en `indicators.ts` y `backtester.ts` donde la distancia a la EMA21 premiaba el *chasing* sobreextendido.
    - Implementación de la campana triangular: $\text{distScore} = 0.15 \cdot \max(0, 1.0 - |\text{distRatio} - 0.5| / 1.0)$, premiando el rebote confirmado ($0.5\text{ ATR}$) y penalizando con $0.0$ la sobreextensión $> 1.5\text{ ATR}$.

- **Actualización v2026.08.27.4 — Escalado de Ventana Swing (720h) y Cuota OOS Adaptativa a la Capacidad de Ciclo**:
  - **Escalado de `evalWindow` en Swing (1H) a 720 velas**:
    - `getParams` y `backtestMultitemporal` escalan la ventana de 1H a `720` velas cuando hay $\ge 550$ barras disponibles (aprovechando las 1000 barras de Binance 1H y las 3500 barras de Yahoo Finance 1H con `range=730d`).
    - Tramo Out-Of-Sample (30%) ampliado a **216 velas horarias** ($\approx 9\,\text{días}$ 24/7 o $33\,\text{días}$ bursátiles), permitiendo entre 4 y 8 operaciones Swing completas.
  - **Capacidad OOS Adaptativa (`effectiveMinOosTrades`)**:
    - `calculateWalkForward` calcula la capacidad física de la ventana OOS en función del tiempo de ciclo medio: $\text{oosCapacity} = \lfloor W_{\text{OOS}} / \text{cycleTime} \rfloor$.
    - Umbral adaptativo: $\text{effectiveMinOos} = \min(\text{minOosTrades}, \max(2, \lfloor \text{oosCapacity} \times 0.6 \rfloor))$.
    - Resuelve el bloqueo aritmético de VCME Swing: ya no queda atrapado permanentemente en `NO_OOS_TRADES` y puede alcanzar confianza `HIGH` legítimamente cuando sus operaciones recientes son rentables.
    - Mantiene el rigor estadístico: trades individuales aislados (< 2) siguen marcando `NO_OOS_TRADES`, y tramos OOS con $E[R] < 0$ marcan `FAIL` descalificando de `HIGH`.
  - **Suite de Pruebas**:
    - **72/72 tests unitarios pasando**, incluyendo Test 72 de validación de Swing 720h y capacidad adaptativa OOS. `npm run lint` con **0 errores y 0 warnings**.

- **Actualización v2026.08.27.5 — Desambiguación de Estado OOS: `INSUFFICIENT_OOS` vs `NO_OOS_TRADES`**:
  - **Nuevo estado `INSUFFICIENT_OOS`** en `WalkForwardResult.status`:
    - `NO_OOS_TRADES`: 0 trades en OOS → la estrategia **no disparó señales** en el tramo reciente. `wfMultiplier = 0.80`.
    - `INSUFFICIENT_OOS`: $1 \le N < \text{effectiveMinOos}$ trades con $E[R] \ge 0$ → la estrategia disparó señales positivas pero la muestra es insuficiente. `wfMultiplier = 0.90`.
    - `FAIL`: Trades OOS con $E[R] < 0$ → la estrategia falló en el tramo reciente. `wfMultiplier = 0.55`.
    - `PASS`: $\ge \text{effectiveMinOos}$ trades con $E[R] \ge 0$ → validación ciega aprobada. `wfMultiplier = 1.0\text{--}1.15`.
  - **UI diferenciada en `BacktestCard.tsx`**:
    - `INSUFFICIENT_OOS` muestra badge ámbar con la expectativa real: `~ OOS +0.85R (2 trades)`.
    - `NO_OOS_TRADES` muestra badge gris neutro: `~ Sin trades OOS`.
  - **Torneo (`tournament.ts`)**: Reasoning diferenciado — `Muestra OOS reducida (N trades)` vs `Sin trades en OOS`.
  - **Suite de Pruebas**:
    - **72/72 tests unitarios pasando**. Tests 58, 59 y 65 actualizados para validar `INSUFFICIENT_OOS`. `npm run lint` con **0 errores y 0 warnings**.

- **Actualización v2026.08.27.11 — Desacoplamiento de Guardas Mínimas en 1H y Swing (Eliminación de Tautología)**:
  - **Corrección de Suelo Canónico en Guardas**:
    - Se elimina la fórmula circular `Math.min(168, Math.max(60, len - forwardWindow)) + forwardWindow` que colapsaba a $(len - FW) + FW = len$ entre 108 y 216 velas de 1H, permitiendo backtests sobre apenas 30 velas evaluadas.
    - Se establecen suelos absolutos fijos e independientes de `len`:
      * **VCME Swing**: `baseEvalWindow = 168` $\to$ Suelo mínimo absoluto de **216 velas** ($168 + 48$).
      * **1H Standard / Confluencia / Scoring**: `baseEvalWindow = 168` $\to$ Suelo mínimo absoluto de **172 velas** ($168 + 4$).
      * **5m**: Suelo mínimo de **582 / 648 velas** ($576 + FW$).
      * **1d**: Suelo mínimo de **63 velas** ($60 + 3$).
  - **Suite de Pruebas**:
    - **77/77 tests unitarios pasando**, incorporando tests de encapsulación SSOT, estado FLAT del torneo, invariancia S/R y paridad estricta de cooldowns.
    - 0 errores en ESLint, build de producción limpio.
- **Actualización v2026.08.27.12 — SSOT Architecture, Cooldown Symmetry & Quantitative Audit**:
  - **Arquitectura Single Source of Truth (`src/utils/strategyEvaluators.ts`)**:
    - Centralización absoluta de la evaluación pura de las 5 estrategias (`evaluateConfluenciaAt`, `evaluateScoringAt`, `evaluateStandardVotingAt`, `evaluateVCMESniperAt`, `evaluateMultifractalMTFAt`).
    - Eliminación de toda duplicación matemática entre `indicators.ts` (Live) y `backtester.ts` (Backtest).
    - Encapsulación completa de filtros en el motor: eliminación del filtro `getTrendFilter` filtrado externamente en componentes de React (`SignalPanel`, `MarketRadar`, `App.tsx`).
  - **Unificación y Simetría de Cooldowns**:
    - Creación de helpers canónicos `getStrategyCooldownCandles` y `getStrategyCooldownMs`.
    - Estandarización de 5m a 12 velas (1.0h), 1H a 4 velas (4.0h) y 1D a 2 velas (48.0h) en todos los motores y en el throttling de alertas en vivo (`App.tsx`).
    - Eliminación del sesgo de $R/\text{hora}$ en el Torneo QVE que favorecía artificialmente a motores con cooldowns más cortos.
  - **Torneo Cuantitativo con Estado FLAT (`NONE`)**:
    - Si ningún candidato pasa los criterios mínimos de consistencia estadística ni demuestra edge positivo ($E[R] > 0$), el torneo declara formalmente `bestStrategy: 'NONE'`, absteniéndose de operar.
  - **Normalización de Pendiente por Volatilidad Local**:
    - Slope de EMA200 1H en VCME Sniper normalizado en unidades de ATR (`deltaEma200 / atr1h > 0.05`) eliminando la sensibilidad absoluta a la escala de precios del activo.
  - **Graduación Cuantitativa de Calidad de Vela (Capa 5 Scoring)**:
    - Asignación matemática diferenciada: $\pm 1.0$ para velas de cuerpo dominante ($\ge 50\%$), $\pm 0.5$ para velas moderadas, $0.0$ para Dojis/indecisión y penalización de $\mp 0.5$ por mecha de rechazo adverso.
    - Eliminación de ramas muertas inalcanzables (`else { Doji }`).
  - **Normalización de Confluencia Multitemporal en MarketRadar**:
    - Escala completa de 0% a 100% en `MarketRadar.tsx` mediante evaluación de convicción (`getSigScore` con $\pm 1.0$ / $\pm 0.8$), desbloqueando ramas de confluencia macro ($\ge 70\%$).
  - **Optimización $O(1)$ de Cruces de EMA (`detectEmaCrossoverFromSeries`)**:
    - Eliminación del cuello de botella $O(N^2)$ (recalculación y slicing por barra) a favor de un escaneo $O(1)$ sobre arrays precomputados, acelerando el backtest $42\times$ (~0.5ms vs 21ms en $N=2000$).
    - Eliminación de la función huérfana `detectEmaCrossover`.
  - **Limpieza de Tipos en Confluencia (S1)**:
    - Eliminación del campo placeholder ficticio `rsi: 50` de `ConfluenciaEvaluationResult` y `calculateExperimentalSignal`.

---

## 📌 Guía de Arquitectura para la Fase 2 (Proxy de Infraestructura Futuro)

En caso de requerir independencia total del plan gratuito de Vercel (1.000.000 Edge Requests/mes) en el futuro, se han evaluado dos alternativas de proxy dedicadas:

### 1. Opción Raspberry Pi 4 (Proxy Local 24/7 de Capacidad Ilimitada)
- **Servicio Node.js/Express en la Pi**:
  Crear un microservicio en la Raspberry Pi 4 que reenvíe peticiones a Yahoo Finance (`query2.finance.yahoo.com`) y Zacks (`quote-feed.zacks.com`).
- **Puntos de Enlace**:
  - Endpoint Proxy Yahoo: `http://<PI_LOCAL_IP>:3001/api/yahoo/...`
  - Endpoint Proxy Zacks: `http://<PI_LOCAL_IP>:3001/api/zacks/...`
- **Ventajas**: Peticiones ilimitadas ($0/mes), consumo eléctrico insignificante (~3-5W), caché en RAM local.
- **Acceso Remoto**: Si se requiere acceder fuera del Wi-Fi de hogar, usar **Cloudflare Tunnel** (`cloudflared`) o **Tailscale** para exponer el puerto 3001 con cifrado TLS sin abrir puertos en el router.

### 2. Opción Cloudflare Workers (Proxy Serverless en la Nube 24/7)
- **Script Worker de Cloudflare**:
  Crear un Worker gratuito (script de ~20 líneas JS) que procese `fetch(request)` hacia Yahoo/Zacks.
- **Capacidad Gratuita**: 100.000 peticiones/día (3.000.000 peticiones/mes).
- **Integración**: Reemplazar en `vercel.json` la propiedad `destination` para apuntar a la URL de Cloudflare Worker (`https://tu-proxy.workers.dev/$1`).
- **Ventajas**: Sin mantenimiento de hardware, acceso universal desde cualquier dispositivo.

## Cuestiones Pendientes y Futuras Mejoras

- [x] **Deduplicación persistente por vela**: Usar la clave `símbolo + timeframe + timestamp de vela cerrada + configuración`, en lugar de depender sólo del cooldown temporal y de memoria. (Completado v2026.08.21.1)
- [x] **Radar / Screener Multi-Activo en Tiempo Real**: Escáner multiactivo con filtros de confluencia 3/3, Squeeze BB, RVOL y presets de mercado con 1-click chart navigation. (Completado v2026.08.21.1)
- [x] **Costes, Métricas de Riesgo y Validación Walk-Forward**: Fricción contable unificada en `simulateTrade`, Max Drawdown en R, Sortino sobre R, streaks, desglose ADX y partición ciega 70/30 en Torneo. (Completado v2026.08.26.2)
- [ ] **Alertas Push/Webhooks (Telegram / Discord)**: Notificaciones push directas en dispositivos móviles cuando ocurran señales de alta confluencia o confirmación QVE.
- [ ] **Overlays e Indicadores en Gráfico (VWAP / EMAs / S&R)**: Toggles interactivos en la cabecera para proyectar VWAP intradía, EMAs 20/50/200 y niveles estructurales de S/R sobre TradingView.
- [ ] **Paper Trading / Diario de Operaciones**: Simulador de ejecución con 1 clic y seguimiento de órdenes abiertas/cerradas.
- [ ] **Backtesting en la Nube / Historial Extendido**: Permitir realizar simulaciones en ventanas de tiempo de años mediante un microservicio servidor.

Este archivo es una guía central para cualquier asistente de IA que retome el proyecto, asegurando que comprenda la estructura actual del motor de señales y backtesting.
