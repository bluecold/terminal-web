# FinceptTerminal - Web App Context

## Descripción General
FinceptTerminal es una aplicación web enfocada en proporcionar señales de trading en el corto plazo (intradía, operaciones que duran un día o como máximo una semana). Su objetivo principal es analizar activos altamente volátiles para capturar subidas (o bajadas) mediante umbrales y estrategias basadas en indicadores técnicos.

## Arquitectura y Estructura
La aplicación separa claramente las responsabilidades:
- **`src/services/api.ts`**: Encargado de la obtención de datos (klines/velas) y noticias. Las noticias de criptomonedas se obtienen mediante la API de CryptoCompare.
- **`src/utils/indicators.ts`**: Contiene toda la lógica matemática de los indicadores técnicos.
- **`src/utils/backtester.ts`**: Lógica de simulación histórica para evaluar el rendimiento ("éxito") de los indicadores en ventanas de tiempo pasadas.
- **`src/components/`**: Componentes de React para la UI (como `SignalPanel`, `Watchlist`, etc.).
- **`src/App.tsx`**: Contenedor principal que maneja el estado global de la sesión.

## Indicadores Técnicos Implementados y Corregidos
Recientemente se han realizado optimizaciones críticas en la matemática y lógica de los indicadores para operar de manera realista:
1. **RSI (Relative Strength Index)**: Utiliza suavizado RMA (Welles Wilder's Smoothing) en lugar de un simple promedio (SMA) para preservar el contexto histórico de la volatilidad.
2. **VWAP (Volume Weighted Average Price)**: Implementado para un entorno intradiario. Se reinicia en cada sesión diaria para temporalidades de 5m y 1h, y semanalmente para temporalidad de 1d.
3. **MACD**: Modificado para actuar como un trigger direccional. Se buscan cruces de la línea MACD y la línea de señal en las últimas 3 velas.
4. **EMA 200 (Filtro de Tendencia Macro)**: Integrado como filtro para evitar operar contra la tendencia principal. Si el precio está por debajo de la EMA 200, se bloquean las señales de compra; si está por encima, se bloquean las señales de venta.
5. **Supertrend (10,3)**: Indicador de seguimiento de tendencia basado en ATR y bandas dinámicas, utilizado para determinar la dirección predominante del precio y confirmar cambios de tendencia.
6. **Stochastic RSI (StochRSI)**: Oscilador estocástico aplicado a los valores del RSI, con líneas `%K` y `%D` suavizadas para detectar zonas extremas de sobrecompra o sobreventa antes que el RSI tradicional.

## Sistemas de Señales (Grupos)
Actualmente existen 3 agrupaciones principales de señales:
1. **Experimental Signal (Signal 1)**: Evalúa cruces de EMA, el VWAP y el RSI para determinar puntos de entrada.
2. **Scoring Multicapa (Signal 2)**: Un modelo de puntaje ponderado que agrupa RSI, MACD, Bandas de Bollinger y VWAP. Los pesos son ajustables por el usuario. Posee un umbral adaptativo (1% para 5m, 1.2% para 1h, y 1.5% para 1d).
3. **Standard Voting**: Agrupa las lecturas de RSI, MACD, Bollinger Bands, Supertrend y Stochastic RSI. Para emitir una señal "Fuerte", se requiere ahora un consenso de 3 o más votos en una dirección, integrando además el filtro macroscópico de la EMA 200 y una señal de Volumen confirmatoria basada en picos inusuales vs su promedio móvil.

## Sistema de Backtesting (Simulación Histórica)
El módulo de backtesting ha sido refactorizado para garantizar alta fidelidad y evitar distorsiones estadísticas:
- **Umbrales Adaptativos (ATR)**: El take-profit y stop-loss ya no son porcentajes fijos, sino que se adaptan a la volatilidad real del activo midiendo su ATR (Average True Range).
- **Control de Sesiones y Gaps**: El backtester detecta si el activo opera 24/7 (Cripto) o en horarios fijos (Acciones). En el caso de acciones, descarta automáticamente señales intradiarias que cruzarían el cierre de mercado para evitar gaps overnight perjudiciales.
- **Cooldown de Señales**: Previene contar el mismo movimiento de precio múltiples veces saltando el período de *forward window* después de cada señal activa.
- **Métricas Avanzadas**: El sistema calcula y expone el WinRate (sobre operaciones resueltas), Resolution Rate, Profit Factor y la Esperanza Matemática (Expectancy).

## Optimizaciones de Rendimiento y Usabilidad Realizadas
- **Watchlist Paralelizada**: La carga de tickers en la Watchlist se realiza concurrentemente usando `Promise.all`.
- **Leyenda Flotante Dinámica y Bandas de Bollinger**: Se añadió una leyenda interactiva en el gráfico que muestra OHLC y métricas de Bandas de Bollinger manipulando directamente el DOM mediante referencias (`useRef`), evitando re-renderizados lentos de React.
- **Alertas en Segundo Plano (Watchlist)**: Se implementó un scanner en segundo plano (`checkAllSignals`) que verifica cada 60 segundos si algún activo de la Watchlist (o el activo actual) ha cambiado de señal en el timeframe activo. Envía notificaciones nativas del navegador únicamente si la estrategia ganadora para ese activo pasa un control de calidad estricto (Profit Factor >= 1.3, calificado como "Bueno" o "Excelente", y un número mínimo de operaciones resueltas dependiente del timeframe: 5m: 5, 1h: 4, 1d: 3) para evitar spam de señales de baja confianza.
- **Rediseño Visual Premium (Glassmorphism)**: Diseño inmersivo y futurista usando fuentes de Google (Outfit y Fira Code), paneles translúcidos, y UI reactiva (Profit Factor dynamically styles rating labels).
- **Despliegue y Control de Versiones**: Pipeline CI/CD activo conectado a **Vercel** para despliegues a producción.

## Cuestiones Pendientes y Futuras Mejoras
- **Performance O(n) en Backtesting**: Actualmente el backtester es O(n²) debido a recálculos completos de indicadores en cada iteración del ciclo. Para reducir lag en dispositivos móviles al cambiar tickers, se debe refactorizar para pre-calcular series completas.
- **Manejo Dinámico del Tamaño de Posición**: Posibilidad de sugerir apalancamiento basado en la fuerza del *Scoring Multicapa*.

Este archivo es una guía central para cualquier asistente de IA que retome el proyecto, asegurando que comprenda la estructura actual del motor de señales y backtesting.
