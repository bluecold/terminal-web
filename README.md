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
* **Feed de Noticias Relevantes:** Muestra hasta 3 noticias recientes curadas desde Yahoo Finance del activo seleccionado, permitiendo entender rápidamente los fundamentales que mueven el precio.

---

## 🧠 Modelos de Señales Integrados

La aplicación cuenta con 3 agrupaciones principales que analizan los datos en tiempo real:

1. **Experimental Signal:** Evalúa cruces de medias móviles (EMA 9/20), niveles de VWAP diario y confirmaciones de volumen + acción del precio (patrones envolventes, martillos) para determinar entradas precisas.
2. **Scoring Multicapa:** Un modelo avanzado de puntajes ponderados que evalúa:
   - **Tendencia:** Posición frente a las EMA y confirmación de la tendencia macro.
   - **RSI:** Análisis de sobrecompra/sobreventa usando suavizado (RMA/Wilder's Smoothing).
   - **Bollinger (%B):** Análisis de la posición del precio dentro de las bandas (posibles rebotes o rupturas).
   - **Volumen:** Presión compradora/vendedora usando VWAP en temporalidades cortas (5m, 1h) y OBV en gráficas diarias.
   - **Vela (Price Action):** Fuerza y confirmación del cuerpo de las velas japonesas.
3. **Standard Voting:** Agrupa diversas confirmaciones e integra fuertemente la **EMA 200** como filtro principal para bloquear operaciones en contra de la tendencia dominante.

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

FinceptTerminal cuenta con un motor de backtesting O(n²) integrado directamente en el frontend que permite evaluar la rentabilidad histórica de las estrategias sin necesidad de un backend pesado:

- **Umbrales Adaptativos (ATR):** El `Stop Loss` y `Take Profit` se calculan dinámicamente según la volatilidad real del activo (ATR), permitiendo comparar de forma justa criptomonedas (alta volatilidad) con acciones (baja volatilidad).
- **Manejo de Sesiones (Gaps):** Detección automática de huecos de mercado para acciones de EEUU. Las señales intradiarias que cruzarían un gap overnight son descartadas para simular una operativa realista.
- **Métricas Avanzadas:** Calcula y expone métricas institucionales como **Profit Factor**, **Expectancy (Esperanza Matemática)**, y **Resolution Rate**, además del tradicional WinRate (basado estrictamente en operaciones resueltas).
- **Control de Cooldown:** Previene la distorsión estadística al ignorar señales duplicadas dentro de la ventana de vida de una operación activa.

---

## 📈 Tareas Pendientes / Mejoras Futuras

- [ ] **Performance O(n) en Backtesting:** Refactorizar el motor de simulación para pre-calcular series completas en lugar de re-evaluar iterativamente, reduciendo el lag al cambiar de activo en dispositivos móviles.
- [ ] **Alertas Push/Webhooks:** Notificaciones proactivas cuando el *Scoring Multicapa* detecte oportunidades con alta probabilidad (90%+).

---

*Desarrollado con ❤️ para los mercados volátiles.*
