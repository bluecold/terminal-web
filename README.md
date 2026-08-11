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
* **Motor QVE de Ventaja Estadística (QVE Engine):** Torneo cuantitativo centralizado (`tournament.ts`) que evalúa dinámicamente el rendimiento histórico de las 5 estrategias y selecciona automáticamente la estrategia líder con mayor ventaja matemática (`Profit Factor`, `Expectancy` y `WinRate`).
* **Niveles de Confianza Progresiva:** Clasificación transparente de señales en `Alta Confianza` (supera muestra estadística mínima), `Muestra Limitada ⚠️` (muestra reducida con penalización sigmoide) y `Sin Ventaja Estadística 🛡️` (descarte automático de alertas cuando no hay ventaja histórica).
* **Live Forward Test & Tracking en Vivo de Alertas:** Motor de seguimiento automático que registra y audita el resultado de cada alerta emitida (`TP1 +1.5R`, `TP2 +2.5R`, `SL -1.0R`, `Abierta ⏳` con PnL flotante en tiempo real) en función de las velas posteriores.
* **Barra Ejecutiva de Rendimiento de Sesión:** Resumen en vivo en el historial de alertas que calcula el WinRate % del día y el retorno neto acumulado en unidades de riesgo ($+R$).
* **Líneas de Precio y Overlays en Gráfico (Entry / SL / TP):** Al hacer clic en cualquier tarjeta del historial de alertas, el gráfico dibuja instantáneamente sobre TradingView las líneas de Entrada (Azul), Stop Loss (Rojo), TP1 (Verde) y TP2 (Esmeralda).
* **Rendimiento Ultra-Optimizado (Cero Sobrecarga GPU):** Arquitectura CSS y renderizado sin cuellos de botella de desenfoque GPU (`backdrop-filter`), garantizando un consumo de GPU de <5% a 60-144 FPS.
* **Resiliencia & ErrorBoundary:** Manejador global de errores en React para prevenir pantallas en blanco ante incompatibilidades de datos o caché local.
* **Marquesina de Índices en Tiempo Real:** Barra superior interactiva (carrusel/marquee) que muestra cotizaciones de los principales mercados mundiales (S&P 500, Nasdaq, Dow Jones, Russell 2000, VIX, Oro, Petróleo, BTC) con aislamiento de capa GPU (`contain: layout paint`).
* **Calculadora de Position Sizing Dinámico y Gestión de Capital:** Herramienta cuantitativa profesional con multiplicadores por score, ATR%, Drawdown de cuenta y penalización por correlación de sector.
* **Matriz de Confluencia Multitemporal:** Widget que evalúa y expone en tiempo real las señales del activo en 5m, 1h y 1d.
* **Calendario de Catalizadores y Métricas de Sentimiento:** Advertencias de ganancias corporativas (Earnings), macro 2026 (IPC/FOMC), Zacks Rank y Crypto Fear & Greed.

---

## 🧠 Modelos de Señales Integrados

La aplicación cuenta con **5 estrategias principales** que analizan los datos en tiempo real:

1. **Experimental Signal:** Evalúa cruces de medias móviles (EMA 9/20), niveles de VWAP diario y confirmaciones de volumen + acción del precio (patrones envolventes, martillos) para determinar entradas precisas.
2. **Scoring Multicapa:** Un modelo avanzado de puntajes ponderados que evalúa tendencia, RSI, Bollinger (%B), volumen, vela y estructura S/R.
3. **Standard Voting:** Agrupa diversas confirmaciones e integra la **EMA 200** como filtro principal. Cuenta con indicadores visuales de pendiente en RSI, y un filtro de desaceleración en el histograma del MACD para evitar falsas señales en momentum decreciente.
4. **VCME v2.0 Quant Engine (Volatility-Contraction Momentum Expansion):** Estrategia cuantitativa institucional de 3 capas (1D/1H/5m) con asimetría LONG/SHORT, score de confianza continuo [0.0 - 1.0], trailing stop por Chandelier Exit de 1H y gestión de riesgo integrada:
    - **Perfiles de Ejecución**:
      - *Day Trading (Intradía)*: Gatillo en 5m, ventana de evaluación corta (576 velas de 5m), Stop Loss ajustado por ATR/estructura local (0.8 ATR a 1.8 ATR) y objetivos escalonados de TP1 (1.5R - 50% + BE), TP2 (2.5R - 25%), y TP3 (3.5R - 25%).
      - *Swing Trading*: Gatillo en 1H, ventana de evaluación extendida (48 velas de 1H), stop loss estructural en lookback corto (5 barras) y objetivos amplios de TP1 (2.0R - 50% + BE), TP2 (4.0R - 25%), y TP3 (5.0R - 25%).
    - **Modos de Gatillo**:
      - *Agresivo (Ruptura)*: Disparo inmediato al cumplir las condiciones de confluencia y geometría de la vela de gatillo (`closePosition >= 0.60`, mecha superior `<= 0.25`).
      - *Conservador (Retest)*: Busca confirmación mediante retest de los niveles de ruptura (retroceso de hasta 6 velas con expiración) para asegurar que el rompimiento es verídico en mercados de alta volatilidad.
    - **Volumen Estacional (U-Shape)**: Implementación de RVOL estacional diario que compara el volumen actual con el promedio de la misma franja de hora y minuto UTC de los últimos 20 días para mayor precisión técnica.
    - **Clasificación de Confianza**: Gradúa las señales en `ALTA`, `MODERADA` o `DESCARTAR` (que neutraliza la señal) según el puntaje de confluencia y el nivel de volatilidad relativo.
    - **1D (Bias/Dirección):** Exige precio por encima de la EMA 200 diaria, la EMA 50 diaria por encima de la EMA 200 diaria, ADX diario > 20 con el +DI diario por encima del -DI diario, y distancia a la EMA 200 `> 0.3 * ATR 1D` para LONG.
    - **1H (Setup):** Estructura stateless que busca un setup técnico alineado en las últimas 3 horas (cierre > VWAP 1H, EMA 20 > EMA 50, RSI entre 50 y 70, y el histograma del MACD en expansión positiva) sin invalidaciones intermedias.
    - **Gatillo/Ejecución**: Ofrece tres estrategias de entrada (Pullback, Breakout, Mean Reversion) aplicadas al timeframe del perfil seleccionado (5m o 1H).
    - **Geometría de Vela e Invalidation:**
      - *Anti-Chasing*: Rechazo de entrada si el precio dista más de 2.2 * ATR del VWAP.
      - *Geometría Cuantitativa*: Cierre en el 40% superior de la vela (`closePosition >= 0.60`) y mecha adversa `<= 0.25` (evitando martillos invertidos / dojis).
      - *Apertura y Noticias*: Descarte del caos de apertura (< 15 minutos) y volumen extremo de noticias (`RVOL >= 8.0`).
      - *Límite de Riesgo ATR*: Stop Loss acotado dinámicamente entre `0.8 * ATR` y `1.8 * ATR` (máx. 1.2% Intradía o 3.5% Swing).
    - **Gestión de Riesgo y Salidas Complejas:**
      - **Trailing Stop Chandelier:** Trailing stop dinámico basado en `highest_high_since_entry - 2.5 * ATR` o cruce de EMA 9 activo tras alcanzar el Target 2.
      - **Time Stop:** Cierre de la posición si tras 12 velas del perfil el beneficio no ha alcanzado al menos `+0.5R`.
      - **Emergency Exit:** Salida anticipada al cierre de cualquier vela que cruce por debajo de `VWAP + EMA21` (para LONG) o por encima (para SHORT).
5. **Multifractal MTF Engine (Signal 5):** Motor de alertas multifractal con arquitectura de compuertas lógicas secuenciales 1D → 1H → 5M y 4 sub-indicadores dedicados:
    - **Capa 1 — Sesgo Macro (1D Andian Oscillator):** Descompone velas diarias en fuerza alcista (GREEN) y bajista (RED), suavizadas con EMA y normalizadas contra el rango promedio. Determina BULLISH o BEARISH. Solo permite operar en la dirección del sesgo.
    - **Capa 2 — Contexto Volatilidad (1H Revolution Band):** Bollinger Bands horarias que miden el ancho del canal vs. su historial de 200 barras. Cuando cae al percentil 15 (COMPRIMIDO), indica que una expansión explosiva es inminente.
    - **Capa 3 — Gatillo (5M):** Combina *Volume Composition* (compra/venta activa con multiplicador ≥ 1.5x) y *Dread Blitz MCD* (oscilador de momentum normalizado por ATR con Bollinger Bands).
    - **Estrategias de Entrada:**
      - *⚡ Ruptura con Expansión:* Cierre rompe banda + volumen institucional + dominancia activa ≥ 65%. Requiere las 3 capas alineadas.
      - *🔄 Reversión a la Media:* Divergencia en Dread Blitz + absorción pasiva en mechas.
    - **Gestión de Riesgo:** Stop Loss dinámico en midpoint de banda (Ruptura) o bajo mecha de absorción (Reversión). Invalidación automática en 3 velas. Filtro de apertura NYSE (09:30-09:45 EST).

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

5. Corre la suite de pruebas unitarias automatizadas:
   ```bash
   npm test
   ```

6. Abre [http://localhost:5173](http://localhost:5173) en tu navegador para ver la aplicación.

---

## 📊 Motor de Backtesting (Simulación Histórica)

FinceptTerminal cuenta con un motor de backtesting optimizado a $O(n)$ integrado directamente en el frontend, lo que permite evaluar la rentabilidad histórica de las estrategias casi instantáneamente sin necesidad de un backend pesado:

- **Umbrales Adaptativos (ATR):** El `Stop Loss` y `Take Profit` se calculan dinámicamente según la volatilidad real del activo (ATR), permitiendo comparar de forma justa criptomonedas (alta volatilidad) con acciones (baja volatilidad).
- **Simulación Multifractal MTF:** Backtester dedicado que replica el flujo de compuertas 1D → 1H → 5M sobre las últimas 150 velas de 5m con cooldown de 12 velas para prevenir look-ahead bias, forward window de 1 hora, e invalidación temprana en 3 velas.
- **Manejo de Sesiones (Gaps):** Detección automática de huecos de mercado para acciones de EEUU. Las señales intradiarias que cruzarían un gap overnight son descartadas.
- **Métricas Avanzadas:** Calcula y expone métricas institucionales como **Profit Factor**, **Expectancy (Esperanza Matemática)**, y **Resolution Rate**, además del tradicional WinRate.
- **Control de Cooldown:** Previene la distorsión estadística al ignorar señales duplicadas dentro de la ventana de vida de una operación activa.

---

## 📈 Tareas Pendientes / Mejoras Futuras

- [ ] **Alertas Push/Webhooks:** Notificaciones proactivas cuando el *Scoring Multicapa* detecte oportunidades con alta probabilidad (90%+).
- [ ] **Backtesting en la Nube / Historial Extendido:** Permitir realizar simulaciones en ventanas de tiempo de años mediante un microservicio servidor.

---

*Desarrollado con ❤️ para los mercados volátiles.*
