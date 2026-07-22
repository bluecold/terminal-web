# FinceptTerminal - Web App Context

## Descripción General
FinceptTerminal es una aplicación web enfocada en proporcionar señales de trading en el corto plazo (intradía, operaciones que duran un día o como máximo una semana). Su objetivo principal es analizar activos altamente volátiles para capturar subidas (o bajadas) mediante umbrales y estrategias basadas en indicadores técnicos.

## Arquitectura y Estructura
La aplicación separa claramente las responsabilidades:
- **`src/services/api.ts`**: Encargado de la obtención de datos (klines/velas) y noticias. Las noticias de criptomonedas se obtienen mediante la API de CryptoCompare.
- **`src/utils/indicators.ts`**: Contiene toda la lógica matemática de los indicadores técnicos.
- **`src/utils/backtester.ts`**: Lógica de simulación histórica para evaluar el rendimiento ("éxito") de los indicadores en ventanas de tiempo pasadas.
- **`src/components/`**: Componentes de React para la UI (como `SignalPanel`, `Watchlist`, etc.).
- **`src/App.tsx`**: Contenedor principal que maneja el estado global## Indicadores Técnicos Implementados y Corregidos
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
Actualmente existen 4 agrupaciones principales de señales:
1. **Experimental Signal (Signal 1)**: Evalúa cruces de EMA, el VWAP y el RSI para determinar puntos de entrada.
2. **Scoring Multicapa (Signal 2)**: Un modelo de puntaje ponderado que agrupa RSI, MACD, Bandas de Bollinger, VWAP y la capa de **Estructura S/R (Layer 6)**. Valida de forma estricta que el ratio **R:R mínimo sea >= 1.5:1** antes de confirmar una señal. Los pesos son ajustables por el usuario.
3. **Standard Voting**: Agrupa las lecturas de RSI, MACD, Bollinger Bands, Supertrend y Stochastic RSI. Para emitir una señal "Fuerte", se requiere un consenso de 3 o más votos en una dirección, integrando el filtro de la EMA 200 y volumen confirmatorio.
4. **VCME Sniper Engine v3 (Híbrido - Upgraded)**: Estrategia cuantitativa avanzada con selección interactiva de perfil y gatillo:
   - **Perfiles de Ejecución**:
     - *Day Trading (Intradía)*: Gatillo en 5m, ventana de simulación/evaluación corta (576 velas de 5m), Stop Loss ajustado por ATR/estructura local y objetivos escalonados de TP1 (1.5R - 50% + BE), TP2 (2.5R - 25%), y TP3 (3.5R - 25%).
     - *Swing Trading*: Gatillo en 1H, ventana de evaluación extendida (48 velas de 1H), stop loss estructural en lookback corto (5 barras) y objetivos amplios de TP1 (2.0R - 50% + BE), TP2 (4.0R - 25%), y TP3 (5.0R - 25%).
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
     - **Time Stop:** Cierre de la posición si tras 12 velas del perfil el beneficio no ha alcanzado al menos `+0.5R`.
     - **Emergency Exit:** Salida anticipada al cierre de cualquier vela que cruce por debajo de `VWAP + EMA21` (para LONG) o por encima (para SHORT).

## Sistema de Backtesting (Simulación Histórica)
El módulo de backtesting ha sido refactorizado para garantizar alta fidelidad y evitar distorsiones estadísticas:
- **Simulación Multitemporal VCME Sniper v3**: Realiza backtesting simulando las 3 capas, el score de confluencia técnica, y las salidas complejas (Time Stop, Emergency Exit y Chandelier Trailing).
- **Control de Sesiones y Gaps**: El backtester detecta si el activo opera 24/7 (Cripto) o en horarios fijos (Acciones) y descarta señales que cruzarían el cierre de mercado.
- **Cooldown de Señales**: Previene contar el mismo movimiento de precio múltiples veces (salta 2 horas/24 velas en 5m).

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
  - **Standard Voting Mejora**: Exige `closePosition >= 0.55` para BUY y `<= 0.45` para SELL antes de emitir voto definitivo.
  - **Confluencia (Signal 1) Mejora**: Incorporado filtro anti-extensiones VWAP/ATR (`|close - vwap| <= 2.2 * ATR`) y cuerpo decisivo (`closePosition >= 0.60`).
  - **Scoring Multicapa (Signal 2) Mejora**: Bonus por compresión de Bollinger (`bbWidthRatio < 0.05`) en Capa 3 y penalización por mecha de rechazo en Capa 5.
  - **VCME Sniper Engine v4**: Integración de acotamiento de riesgo ATR (`0.8 * ATR <= Risk <= 1.8 * ATR`), validación de mechas en calidad de vela y sincronización 1:1 con el motor de backtesting.

## Cuestiones Pendientes y Futuras Mejoras
- **Alertas Push/Webhooks**: Notificaciones push directas en dispositivos móviles cuando ocurran señales de alta confluencia.
- **Backtesting en la Nube / Historial Extendido**: Permitir realizar simulaciones en ventanas de tiempo de años mediante un microservicio servidor.

Este archivo es una guía central para cualquier asistente de IA que retome el proyecto, asegurando que comprenda la estructura actual del motor de señales y backtesting.
