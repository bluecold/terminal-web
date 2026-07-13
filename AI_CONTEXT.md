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
4. **VCME Sniper Engine (Multitemporal)**: Estrategia cuantitativa que alinea 3 temporalidades:
   - **1D (Bias)**: Exige que el precio esté por encima de EMA 200/50 y que la pendiente de la EMA 200 de 1D sea positiva para LONG (o inversa para SHORT).
   - **1H (Momentum)**: Exige precio sobre EMA 50, MACD cruzado al alza con histograma creciente, RSI entre 45 y 75 (zona de momentum sano), ADX > 20 (tendencia fuerte) y volumen superior a su media de 20 períodos.
   - **5m (Gatillo)**: Ofrece dos modos de disparo: **Modo A (Ruptura)** si cierra fuera de Bandas de Bollinger con cuerpo decidido y volumen > 1.5x, o **Modo B (Reversión)** si perfora la banda pero cierra dentro con vela de rechazo y volumen de absorción.
   - **Gestión de Riesgo**: Stop Loss estructural/ATR, salida TP1 a 1.5R (cierra 50% y mueve a breakeven) y TP2 (cierre por cruce inverso de EMA 9 en 5m).

## Sistema de Backtesting (Simulación Histórica)
El módulo de backtesting ha sido refactorizado para garantizar alta fidelidad y evitar distorsiones estadísticas:
- **Simulación Multitemporal VCME Sniper**: Realiza backtesting alineando las velas en formación con velas de mayor temporalidad (1H y 1D) cerradas en el pasado. Evalúa la performance intradiaria exacta simulando salidas parciales (TP1 a 1.5R + breakeven, y TP2 con trailing exit por EMA 9 o bandas).
- **Control de Sesiones y Gaps**: El backtester detecta si el activo opera 24/7 (Cripto) o en horarios fijos (Acciones) y descarta señales que cruzarían el cierre de mercado.
- **Cooldown de Señales**: Previene contar el mismo movimiento de precio múltiples veces (salta 2 horas/24 velas en 5m).

## Optimizaciones de Rendimiento y Usabilidad Realizadas
- **Motor de Backtesting O(n)**: Refactorizado de $O(n^2)$ a $O(n)$ calculando las series de indicadores técnicos de una sola vez al cargar las velas y luego indexándolas en tiempo constante $O(1)$ en el loop del backtester.
- **Unificación de Cargas y Timeframes**: Al cambiar de activo, descarga todos los timeframes (5m, 1h, 1d) en paralelo una sola vez. Al cambiar de timeframe, la UI lee instantáneamente de la memoria (`allKlines[interval]`).
- **Confirmación de Vela Cerrada**: Las señales de la UI y del scanner en segundo plano se calculan sobre la última vela completamente cerrada para evitar repintado.
- **Alertas en Segundo Plano con Cooldown**: Se implementó un scanner en segundo plano (`checkAllSignals`) que verifica cada 60 segundos si algún activo ha cambiado de señal.
- **Calculadora de Gestión de Riesgo y Posición**: Sincronizada con el Stop Loss y Take Profit dinámicos de VCME Sniper cuando la estrategia está activa.
- **Matriz de Confluencia Multitemporal**: Panel visual que resume la tendencia técnica del activo actual en las escalas de 5m, 1h y 1d de forma paralela.
- **Métricas de Contexto Fundamental y Sentimiento (Zacks & Fear/Greed)**: En la pestaña *Mercado*, se muestra información complementaria de fundamentales y sentimiento.
- **Rediseño del Panel Lateral Derecho (UI/UX)**: Interfaz estructurada en tres pestañas (Estrategias, Calculadora, Mercado) con acordeones expandibles.
- **Marquesina de Índices Bursátiles (Market Ticker)**: Widget horizontal en la cabecera que muestra futuros, VIX, materias primas y Bitcoin.

## Cuestiones Pendientes y Futuras Mejoras
- **Alertas Push/Webhooks**: Notificaciones push directas en dispositivos móviles cuando ocurran señales de alta confluencia.
- **Backtesting en la Nube / Historial Extendido**: Permitir realizar simulaciones en ventanas de tiempo de años mediante un microservicio servidor.

Este archivo es una guía central para cualquier asistente de IA que retome el proyecto, asegurando que comprenda la estructura actual del motor de señales y backtesting.
