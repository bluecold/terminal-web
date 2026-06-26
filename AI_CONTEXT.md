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

## Sistemas de Señales (Grupos)
Actualmente existen 3 agrupaciones principales de señales:
1. **Experimental Signal (Signal 1)**: Evalúa cruces de EMA, el VWAP y el RSI para determinar puntos de entrada.
2. **Scoring Multicapa (Signal 2)**: Un modelo de puntaje ponderado que agrupa RSI, MACD, Bandas de Bollinger y VWAP. Los pesos son ajustables por el usuario. Posee un umbral adaptativo (1% para 5m, 1.2% para 1h, y 1.5% para 1d).
3. **Standard Voting**: Agrupa varias señales de confirmación e integra fuertemente el filtro de tendencia EMA 200.

## Optimizaciones de Rendimiento y Usabilidad Realizadas
- **Watchlist Paralelizada**: La carga de tickers en la Watchlist se realiza concurrentemente usando `Promise.all` en lugar de llamadas secuenciales con delay, lo cual disminuyó drásticamente los tiempos de carga.
- **Persistencia de Sesión**: El ticker seleccionado y la temporalidad (timeframe) se guardan y restauran desde el `localStorage` del navegador para una mejor experiencia de usuario al recargar la página.
- **Noticias Relevantes**: Se ha integrado la API de CryptoCompare para obtener un feed de noticias fiable y relacionado con los activos que se visualizan.
- **Leyenda Flotante Dinámica y Bandas de Bollinger**: Se añadió una leyenda interactiva en el gráfico que muestra OHLC y métricas de Bandas de Bollinger en tiempo real. Para evitar re-renderizados lentos de React durante los movimientos del cursor (crosshair), la actualización se realiza manipulando directamente el DOM mediante referencias (`useRef`). Además, se alerta visualmente (color naranja y símbolo de advertencia) cuando el ancho de las bandas supera el umbral de alta volatilidad adaptativo (1.5% para 5m, 8% para 1h y 10% para 1d).

## Cuestiones Pendientes y Futuras Mejoras
- **Evaluación Constante de Éxito**: Seguir puliendo la funcionalidad que analiza ventanas temporales de las últimas velas (ej. últimas 200 velas) para informar el porcentaje de acierto de una señal, adaptándose al timeframe seleccionado (5m, 1h, 1d).
- **Gestión del Riesgo**: Las señales de trading emiten sugerencias de Stop Loss, pero en el futuro podrían refinarse usando parámetros como el ATR (Average True Range).
- **Cobertura de Activos**: Si se requiere operar con acciones (stocks) ademas de criptomonedas, será necesario añadir fallbacks a las APIs que devuelvan noticias y cotizaciones específicas del mercado tradicional.

Este archivo es una guía central para cualquier asistente de IA que retome el proyecto, asegurando que comprenda el enfoque a corto plazo, la corrección intradiaria de los indicadores, y la estructura de los componentes principales.
