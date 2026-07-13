# FinceptTerminal 📈

**FinceptTerminal** es una aplicación web de análisis técnico diseñada para proporcionar señales de trading a corto plazo (intradía, operaciones que duran un día o como máximo una semana). Su objetivo principal es analizar activos altamente volátiles para capturar subidas (o bajadas) mediante algoritmos y estrategias basadas en indicadores matemáticos.

[**Ver Demo en Producción**](https://terminal-web-orpin.vercel.app)

---

## 🚀 Características Principales

* **Gráficos Ultra Rápidos (Lightweight Charts):** Representación visual de velas japonesas y volumen con un rendimiento excepcional usando TradingView's lightweight-charts.
* **Leyenda Flotante Dinámica (OHLC & BB):** Panel interactivo que se mueve con el cursor (`crosshair`) para mostrar datos del precio exacto e información de expansión de las Bandas de Bollinger sin causar costosos re-renderizados en React (manipulación directa del DOM).
* **Watchlist Paralelizada:** Carga múltiple de tickers de manera concurrente para asegurar tiempos de espera mínimos.
* **Multi-Soporte de Mercados:**
  * **Criptomonedas:** Obtención de datos mediante WebSockets en tiempo real (Binance) y agregadores de datos históricos.
  * **Mercados Tradicionales/Stocks:** Integración con Data Feeds de baja latencia para stocks, ETFs y futuros.
* **Marquesina de Índices en Tiempo Real:** Barra superior interactiva (carrusel/marquee) al estilo Yahoo Finance que muestra cotizaciones en tiempo real y variaciones diarias de los principales mercados mundiales (S&P 500 Futures, Nasdaq, Dow Jones, Russell 2000, VIX, Gold, Crude Oil, Bitcoin). Utiliza animación fluida acelerada por GPU y pausa automática al pasar el cursor.
* **Feed de Noticias Relevantes:** Muestra hasta 3 noticias recientes curadas desde Yahoo Finance del activo seleccionado, permitiendo entender rápidamente los fundamentales que mueven el precio.
* **Alertas en Segundo Plano (Watchlist):** Notificaciones nativas del navegador (vía Notifications API) que escanean automáticamente toda tu Watchlist (y el activo en pantalla) cada 60 segundos. Cuenta con un filtro estricto de calidad (requiere que la mejor estrategia tenga un Profit Factor >= 1.3 y un volumen mínimo de operaciones según el timeframe) para evitar ruido y falsas señales.
* **Historial Interactivo de Alertas:** Registro visual persistente (guardado en `localStorage`) en la barra lateral izquierda que almacena las últimas 20 alertas. Al hacer clic en cualquier tarjeta, el gráfico cambia automáticamente al símbolo y la temporalidad de la señal para que la revises al instante.
* **Calculadora de Position Sizing Dinámico y Gestión de Capital:** Herramienta cuantitativa profesional. Calcula el tamaño sugerido de la posición (unidades/USD) y margen necesario aplicando multiplicadores en tiempo real: Factor Confianza (según el score de la señal), Factor Volatilidad (ATR% del activo), Factor Salud de la Cuenta (Drawdown deslizable de 0% a 30%) y Penalización por Correlación de Sector. Integra un límite de riesgo máximo del 25% del capital total.
* **Matriz de Confluencia Multitemporal:** Un widget que evalúa y expone en paralelo las señales técnicas del activo en 5m, 1h y 1d, permitiendo confirmar si la operación coincide con la tendencia de temporalidades superiores.
* **Calendario de Catalizadores de Volatilidad:** Sistema de prevención que advierte al usuario si hay un reporte de ganancias corporativas inminente (consultado online para acciones) o eventos macro clave de 2026 pre-agendados (IPC/CPI y decisiones de la FOMC/Fed), alertando si quedan menos de 48 horas para el evento.
* **Métricas de Contexto de Sentimiento y Fundamentales:**
  * **Stocks (Acciones):** Integración con el feed oficial de **Zacks Rank** (escala 1-5 de Strong Buy a Strong Sell) y Beta de volatilidad para proveer contexto macroeconómico verídico sin depender de datos ficticios.
  * **Criptomonedas:** Consulta directa al índice de sentimiento **Fear & Greed (Miedo y Codicia)** mediante la API de `alternative.me` para detectar extremos de euforia o pánico en el mercado cripto.
  * **Caché Eficiente:** Almacenamiento local persistente (`localStorage`) por activo válido por 24 horas para reducir la latencia a 0 ms y optimizar el consumo de red.

---

## 🧠 Modelos de Señales Integrados

La aplicación cuenta con 4 agrupaciones principales que analizan los datos en tiempo real:

1. **Experimental Signal:** Evalúa cruces de medias móviles (EMA 9/20), niveles de VWAP diario y confirmaciones de volumen + acción del precio (patrones envolventes, martillos) para determinar entradas precisas.
2. **Scoring Multicapa:** Un modelo avanzado de puntajes ponderados que evalúa tendencia, RSI, Bollinger (%B), volumen, vela y estructura S/R.
3. **Standard Voting:** Agrupa diversas confirmaciones e integra la **EMA 200** como filtro principal. Cuenta con indicadores visuales de pendiente en RSI, y un filtro de desaceleración en el histograma del MACD para evitar falsas señales en momentum decreciente.
4. **VCME Sniper Engine v2 (Adaptive Scoring):** Estrategia cuantitativa avanzada que alinea 3 temporalidades en cascada:
   - **1D (Bias):** Exige tendencia alcista/bajista macro (`Precio > EMA 200` y `EMA 20 > EMA 50` para LONG).
   - **1H (Setup):** Requiere un pullback dinámico a la EMA 20 (`Low <= EMA 20`) y que el precio de cierre esté por encima del VWAP.
   - **5m (Gatillo):** Entrada precisa por Breakout (ruptura con Squeeze en Bollinger + volumen >1.8x) o Reversal (absorción/toque de banda inferior con volumen >1.5x).
   - **Scoring Adaptativo (0-100):** Calcula una confianza dinámica multiplicando por factores de régimen de volatilidad de mercado (ATR percentile), perfil del activo (rango diario %) y meta-learning de winrate histórico.
   - **Gestión de Riesgo (3 Targets):** Stop Loss por ATR/Swing. Salidas parciales en TP1 (1.5R, cierra 40% y mueve a breakeven + 0.1 ATR), TP2 (1.0 ATR 1H, cierra 35%) y TP3 (2.5R, cierra 25% con trailing EMA 9).

---

## 🛠 Tecnologías Utilizadas

- **[React 19](https://react.dev/):** Biblioteca principal para la UI, usando Hooks (`useState`, `useEffect`, `useRef`, `useCallback`) con un enfoque en rendimiento puro sin estados intermedios lentos.
- **[TypeScript](https://www.typescriptlang.org/):** Tipado estricto (cero `any` implícitos) que garantiza seguridad al mapear datos de los proveedores financieros.
- **[Vite](https://vitejs.dev/):** Entorno de desarrollo ultrarápido.
- **[TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/):** Lienzo en HTML5 de alto rendimiento.
- **[Lucide React](https://lucide.dev/):** Iconografía minimalista y limpia.

---

## 🏗 Instalación y Desarrollo Local

1. Clona este repositorio:
   ```bash
   git clone https://github.com/bluecold/terminal-web.git
   ```

2. Navega al directorio del proyecto:
   ```bash
   cd terminal-web
   ```

3. Instala las dependencias necesarias:
   ```bash
   npm install
   ```

4. Ejecuta el servidor de desarrollo:
   ```bash
   npm run dev
   ```

5. Abre [http://localhost:5173](http://localhost:5173) en tu navegador para ver la aplicación.

---

## 📊 Motor de Backtesting (Simulación Histórica)

FinceptTerminal cuenta con un motor de backtesting optimizado a $O(n)$ integrado directamente en el frontend, lo que permite evaluar la rentabilidad histórica de las estrategias casi instantáneamente sin necesidad de un backend pesado:

- **Umbrales Adaptativos (ATR):** El `Stop Loss` y `Take Profit` se calculan dinámicamente según la volatilidad real del activo (ATR), permitiendo comparar de forma justa criptomonedas (alta volatilidad) con acciones (baja volatilidad).
- **Manejo de Sesiones (Gaps):** Detección automática de huecos de mercado para acciones de EEUU. Las señales intradiarias que cruzarían un gap overnight son descartadas para simular una operativa realista.
- **Métricas Avanzadas:** Calcula y expone métricas institucionales como **Profit Factor**, **Expectancy (Esperanza Matemática)**, y **Resolution Rate**, además del tradicional WinRate (basado estrictamente en operaciones resueltas).
- **Control de Cooldown:** Previene la distorsión estadística al ignorar señales duplicadas dentro de la ventana de vida de una operación activa.

---

## 📈 Tareas Pendientes / Mejoras Futuras

- [ ] **Alertas Push/Webhooks:** Notificaciones proactivas cuando el *Scoring Multicapa* detecte oportunidades con alta probabilidad (90%+).
- [ ] **Backtesting en la Nube / Historial Extendido:** Permitir realizar simulaciones en ventanas de tiempo de años mediante un microservicio servidor.

---

*Desarrollado con ❤️ para los mercados volátiles.*
