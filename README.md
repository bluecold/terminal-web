# FinceptTerminal 📈

**FinceptTerminal** es una aplicación web de análisis técnico diseñada para proporcionar señales de trading a corto plazo (intradía, operaciones que duran un día o como máximo una semana). Su objetivo principal es analizar activos altamente volátiles para capturar subidas (o bajadas) mediante algoritmos y estrategias basadas en indicadores matemáticos.

[**Ver Demo en Producción**](https://terminal-web-orpin.vercel.app)

---

## 🚀 Características Principales

* **Gráficos Ultra Rápidos (Lightweight Charts):** Representación visual de velas japonesas y volumen con un rendimiento excepcional usando TradingView's lightweight-charts.
* **Leyenda Flotante Dinámica (OHLC & BB):** Panel interactivo que se mueve con el cursor (`crosshair`) para mostrar datos del precio exacto e información de expansión de las Bandas de Bollinger sin causar costosos re-renderizados en React (manipulación directa del DOM).
* **Watchlist Paralelizada:** Carga múltiple de tickers de manera concurrente para asegurar tiempos de espera mínimos.
* **Multi-Soporte de Mercados:**
  * **Criptomonedas:** Obtención de datos en tiempo real mediante la API pública de Binance (ej. `BTCUSDT`).
  * **Mercados Tradicionales/Stocks:** Integración con Yahoo Finance V8 API (ej. `TSLA`, `MSFT`).
* **Marquesina de Índices en Tiempo Real:** Barra superior interactiva (carrusel/marquee) al estilo Yahoo Finance que muestra cotizaciones en tiempo real y variaciones diarias de los principales mercados mundiales (S&P 500 Futures, Nasdaq, Dow Jones, Russell 2000, VIX, Gold, Crude Oil, Bitcoin). Utiliza animación fluida acelerada por GPU y pausa automática al pasar el cursor.
* **Feed de Noticias Relevantes:** Muestra hasta 3 noticias recientes curadas desde Yahoo Finance del activo seleccionado, permitiendo entender rápidamente los fundamentales que mueven el precio.
* **Alertas en Segundo Plano (Watchlist):** Notificaciones nativas del navegador (vía Notifications API) que escanean automáticamente toda tu Watchlist (y el activo en pantalla) cada 60 segundos. Cuenta con un filtro estricto de calidad (requiere que la mejor estrategia tenga un Profit Factor >= 1.3 y un volumen mínimo de operaciones según el timeframe) para evitar ruido y falsas señales.
* **Historial Interactivo de Alertas:** Registro visual persistente (guardado en `localStorage`) en la barra lateral izquierda que almacena las últimas 20 alertas. Al hacer clic en cualquier tarjeta, el gráfico cambia automáticamente al símbolo y la temporalidad de la señal para que la revises al instante.
* **Calculadora Dinámica de Gestión de Riesgo y Posición:** Herramienta para dimensionar tu operativa de forma profesional. Ingresando tu capital y el riesgo estipulado (ej: 1%), calcula el tamaño sugerido de la posición (unidades/USD) y margen necesario, cargando dinámicamente el Stop Loss y Take Profit adaptativos (ATR) de la estrategia activa.
* **Matriz de Confluencia Multitemporal:** Un widget que evalúa y expone en paralelo las señales técnicas del activo en 5m, 1h y 1d, permitiendo confirmar si la operación coincide con la tendencia de temporalidades superiores.
* **Calendario de Catalizadores de Volatilidad:** Sistema de prevención que advierte al usuario si hay un reporte de ganancias corporativas inminente (consultado online para acciones) o eventos macro clave de 2026 pre-agendados (IPC/CPI y decisiones de la FOMC/Fed), alertando si quedan menos de 48 horas para el evento.

---

## 🧠 Modelos de Señales Integrados

La aplicación cuenta con 4 agrupaciones principales que analizan los datos en tiempo real:

1. **Experimental Signal:** Evalúa cruces de medias móviles (EMA 9/20), niveles de VWAP diario y confirmaciones de volumen + acción del precio (patrones envolventes, martillos) para determinar entradas precisas.
2. **Scoring Multicapa:** Un modelo avanzado de puntajes ponderados que evalúa:
   - **Tendencia:** Posición frente a las EMA y confirmación de la tendencia macro.
   - **RSI:** Análisis de sobrecompra/sobreventa usando suavizado (RMA/Wilder's Smoothing).
   - **Bollinger (%B):** Análisis de la posición del precio dentro de las bandas.
   - **Volumen:** Presión compradora/vendedora usando VWAP en temporalidades cortas (5m, 1h) y OBV en gráficas diarias.
   - **Vela (Price Action):** Fuerza y confirmación del cuerpo de las velas japonesas.
3. **Standard Voting:** Agrupa diversas confirmaciones e integra la **EMA 200** como filtro principal para bloquear operaciones en contra de la tendencia dominante.
4. **Filtro Maestro (Multitemporal):** Estrategia institucional que alinea la tendencia macro (EMA 200 en 1H) con gatillos en la temporalidad de entrada (Supertrend en 5m, cruce de VWAP y RSI entre 40-70 para compra y 30-60 para venta). Todas las evaluaciones se realizan sobre vela cerrada para evitar parpadeos.

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
