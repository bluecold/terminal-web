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
1. **RSI (Relative Strength Index)**: Utiliza suavizado RMA (Welles Wilder's Smoothing) en lugar de un simple promedio (SMA) para preservar el contexto histórico de la volatilidad.
2. **VWAP (Volume Weighted Average Price)**: Implementado para un entorno intradiario. Se reinicia en cada sesión diaria a las 00:00 UTC para criptomonedas, y a las 9:30 AM EST (apertura de NYSE) para acciones estadounidenses.
3. **MACD**: Modificado para actuar como un trigger direccional. Se buscan cruces de la línea MACD y la línea de señal en las últimas 3 velas.
4. **EMA 200 (Filtro de Tendencia Macro)**: Integrado como filtro para evitar operar contra la tendencia principal. Si el precio está por debajo de la EMA 200, se bloquean las señales de compra; si está por encima, se bloquean las señales de venta.
5. **Supertrend (10,3)**: Indicador de seguimiento de tendencia basado en ATR y bandas dinámicas, utilizado para determinar la dirección predominante del precio y confirmar cambios de tendencia.
6. **Stochastic RSI (StochRSI)**: Oscilador estocástico aplicado a los valores del RSI, con líneas `%K` y `%D` suavizadas para detectar zonas extremas de sobrecompra o sobreventa antes que el RSI tradicional.

## Sistemas de Señales (Grupos)
Actualmente existen 4 agrupaciones principales de señales:
1. **Experimental Signal (Signal 1)**: Evalúa cruces de EMA, el VWAP y el RSI para determinar puntos de entrada.
2. **Scoring Multicapa (Signal 2)**: Un modelo de puntaje ponderado que agrupa RSI, MACD, Bandas de Bollinger y VWAP. Los pesos son ajustables por el usuario. Posee un umbral adaptativo (1% para 5m, 1.2% para 1h, y 1.5% para 1d).
3. **Standard Voting**: Agrupa las lecturas de RSI, MACD, Bollinger Bands, Supertrend y Stochastic RSI. Para emitir una señal "Fuerte", se requiere ahora un consenso de 3 o más votos en una dirección, integrando además el filtro de la EMA 200 y volumen confirmatorio.
4. **Filtro Maestro (Multitemporal)**: Estrategia institucional que alinea dos temporalidades (opera en 5m/1h y filtra según la tendencia macro de la EMA 200 en 1H/1D). Requiere un cambio de color del Supertrend (5m) + cruce de VWAP + RSI en zona de impulso sin sobrecompra (40-70 para compra, 30-60 para venta).

## Sistema de Backtesting (Simulación Histórica)
El módulo de backtesting ha sido refactorizado para garantizar alta fidelidad y evitar distorsiones estadísticas:
- **Simulación Multitemporal**: La estrategia "Filtro Maestro" realiza backtesting alineando las velas en formación con velas de mayor temporalidad cerradas en el pasado.
- **Salidas Tácticas (Filtro Maestro)**: Utiliza salidas basadas en el Supertrend y VWAP para fijar el Stop Loss al entrar, y cierra por cambio de color del Supertrend o sobrecompra/sobreventa extrema de RSI.
- **Umbrales Adaptativos (ATR)**: El take-profit y stop-loss en las otras estrategias se adaptan a la volatilidad real del activo midiendo su ATR (Average True Range).
- **Control de Sesiones y Gaps**: El backtester detecta si el activo opera 24/7 (Cripto) o en horarios fijos (Acciones) y descarta señales que cruzarían el cierre de mercado.
- **Cooldown de Señales**: Previene contar el mismo movimiento de precio múltiples veces (salta 2 horas en 5m).

## Optimizaciones de Rendimiento y Usabilidad Realizadas
- **Motor de Backtesting O(n)**: Refactorizado de $O(n^2)$ a $O(n)$ calculando las series de indicadores técnicos (RSI, MACD, Bollinger Bands, ATR, VWAP, Stochastic RSI, Volumen) de una sola vez al cargar las velas y luego indexándolas en tiempo constante $O(1)$ en el loop del backtester.
- **Unificación de Cargas y Timeframes**: Optimización del ciclo de vida en React (`App.tsx`). Al cambiar de activo, descarga todos los timeframes (5m, 1h, 1d) en paralelo una sola vez. Al cambiar de timeframe, la UI lee instantáneamente de la memoria (`allKlines[interval]`) con un coste de **0 ms**, eliminando llamadas redundantes al servidor y recálculos innecesarios. El scanner/polling en tiempo real solo actualiza el timeframe activo.
- **Buscador de Ticker con Confirmación**: Cambiamos el input de búsqueda para que use un estado local y solo ejecute la cascada de fetches y análisis al presionar **Enter** o disparar el evento **onBlur**, evitando recargar la UI letra por letra.
- **Confirmación de Vela Cerrada**: Las señales de la UI y del scanner en segundo plano se calculan sobre la última vela completamente cerrada (`length - 2`) para evitar el parpadeo y repintado de indicadores.
- **Watchlist Paralelizada**: La carga de tickers en la Watchlist se realiza concurrentemente usando `Promise.all`.
- **Leyenda Flotante Dinámica y Bandas de Bollinger**: Se añadió una leyenda interactiva en el gráfico que muestra OHLC y métricas de Bandas de Bollinger manipulando directamente el DOM mediante referencias (`useRef`), evitando re-renderizados lentos de React.
- **Alertas en Segundo Plano con Cooldown**: Se implementó un scanner en segundo plano (`checkAllSignals`) que verifica cada 60 segundos si algún activo de la Watchlist ha cambiado de señal. Posee un cooldown de **2 horas** por activo para prevenir la fatiga de alertas.
- **Historial Interactivo de Alertas (Watchlist)**: Registro visual persistente (vía `localStorage`) en la barra lateral izquierda que almacena las últimas 20 notificaciones.
- **Calculadora de Gestión de Riesgo y Posición**: Sincronizada con el Stop Loss y Take Profit dinámicos del Filtro Maestro (Supertrend/VWAP) cuando la estrategia está activa.
- **Matriz de Confluencia Multitemporal**: Panel visual que resume la tendencia técnica del activo actual en las escalas de 5m, 1h y 1d de forma paralela.
- **Catalizadores de Volatilidad (Calendario)**: Sistema de alerta que consulta online reportes de ganancias y eventos macro clave (IPC, FOMC) de 2026, advirtiendo del peligro en ventanas menores a 48 horas.

## Cuestiones Pendientes y Futuras Mejoras
- **Alertas Push/Webhooks**: Notificaciones push directas en dispositivos móviles cuando ocurran señales de alta confluencia.
- **Backtesting en la Nube / Historial Extendido**: Permitir realizar simulaciones en ventanas de tiempo de años mediante un microservicio servidor.


Este archivo es una guía central para cualquier asistente de IA que retome el proyecto, asegurando que comprenda la estructura actual del motor de señales y backtesting.
