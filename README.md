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
4. **VCME Sniper Engine v3 (Híbrido - Upgraded):** Estrategia cuantitativa avanzada con selección interactiva de perfil y gatillo:
   - **Perfiles de Ejecución**:
     - *Day Trading (Intradía)*: Gatillo en 5m, ventana de evaluación corta (576 velas de 5m), Stop Loss ajustado por ATR/estructura local y objetivos escalonados de TP1 (1.5R - 50% + BE), TP2 (2.5R - 25%), y TP3 (3.5R - 25%).
     - *Swing Trading*: Gatillo en 1H, ventana de evaluación extendida (48 velas de 1H), stop loss estructural en lookback corto (5 barras) y objetivos amplios de TP1 (2.0R - 50% + BE), TP2 (4.0R - 25%), y TP3 (5.0R - 25%).
   - **Modos de Gatillo**:
     - *Agresivo (Ruptura)*: Disparo inmediato al cumplir las condiciones de confluencia de la vela de gatillo.
     - *Conservador (Retest)*: Busca confirmación mediante retest de los niveles de ruptura (retroceso de hasta 5 velas a las BB u ORB roto) para asegurar que el rompimiento es verídico en mercados de alta volatilidad.
   - **Volumen Estacional (U-Shape)**: Implementación de RVOL estacional diario que compara el volumen actual con el promedio de la misma franja de hora y minuto UTC de los últimos 20 días para mayor precisión técnica.
   - **Clasificación de Confianza**: Gradúa las señales en `ALTA`, `MODERADA` o `DESCARTAR` (que neutraliza la señal) según el puntaje de confluencia y el nivel de volatilidad relativo.
   - **1D (Bias/Dirección):** Exige precio por encima de la EMA 200 diaria, la EMA 50 diaria por encima de la EMA 200 diaria, y un ADX diario > 20 con el +DI diario por encima del -DI diario para LONG (o inversa para SHORT).
   - **1H (Setup):** Estructura stateless que busca un setup técnico alineado en las últimas 3 horas (cierre > VWAP 1H, EMA 20 > EMA 50, RSI entre 50 y 70, y el histograma del MACD en expansión positiva) sin invalidaciones intermedias.
   - **Gatillo/Ejecución**: Ofrece tres estrategias de entrada (Pullback, Breakout, Mean Reversion) aplicadas al timeframe del perfil seleccionado (5m o 1H).
   - **Filtros de Calidad e Invalidation:**
     - *Anti-Chasing*: Rechazo de entrada si el precio dista más de 2 * ATR del VWAP.
     - *Cuerpo Decisivo*: Vela de gatillo con un ratio de cuerpo >= 40% (evitando Dojis).
     - *Apertura y Noticias*: Descarte del caos de apertura (< 15 minutos) y volumen extremo de noticias (`RVOL >= 8.0`).
     - *Límite de Riesgo*: Distancia del Stop Loss estructural limitada a un máximo de 1.2% (Intradía) o 3.5% (Swing).
   - **Gestión de Riesgo y Salidas Complejas:**
     - **Trailing Stop Chandelier:** Trailing stop dinámico basado en `highest_high_since_entry - 2.5 * ATR` o cruce de EMA 9 activo tras alcanzar el Target 2.
     - **Time Stop:** Cierre de la posición si tras 12 velas del perfil el beneficio no ha alcanzado al menos `+0.5R`.
     - **Emergency Exit:** Salida anticipada al cierre de cualquier vela que cruce por debajo de `VWAP + EMA21` (para LONG) o por encima (para SHORT).

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
