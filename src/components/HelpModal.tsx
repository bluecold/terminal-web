import { useEffect } from 'react';
import { X } from 'lucide-react';

interface HelpModalProps {
  onClose: () => void;
}

interface SignalCardProps {
  number: string;
  name: string;
  color: string;
  badge: string;
  badgeColor: string;
  description: string;
  howItWorks: string[];
  strengths: string[];
  weaknesses: string[];
  bestFor: string;
  considerations: string;
}

function SignalCard({ number, name, color, badge, badgeColor, description, howItWorks, strengths, weaknesses, bestFor, considerations }: SignalCardProps) {
  return (
    <div style={{
      background: 'rgba(13, 17, 28, 0.6)',
      border: `1px solid ${color}30`,
      borderRadius: 'var(--border-radius-md)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 18px',
        background: `linear-gradient(135deg, ${color}10 0%, transparent 100%)`,
        borderBottom: `1px solid ${color}20`,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
      }}>
        <div style={{
          width: '32px', height: '32px',
          borderRadius: '8px',
          background: `${color}20`,
          border: `1px solid ${color}40`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '0.8rem', fontWeight: '800', color, fontFamily: 'var(--font-mono)',
          flexShrink: 0,
        }}>{number}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '0.95rem', fontWeight: '700', color: 'var(--text-primary)' }}>{name}</div>
          <span style={{
            fontSize: '0.6rem', fontWeight: '700', letterSpacing: '0.8px',
            padding: '2px 7px', borderRadius: '10px',
            background: `${badgeColor}15`, border: `1px solid ${badgeColor}30`,
            color: badgeColor,
          }}>{badge}</span>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: '1.6' }}>{description}</p>

        {/* How it works */}
        <div>
          <div style={{ fontSize: '0.68rem', fontWeight: '700', color, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '8px' }}>
            ⚙ Cómo funciona
          </div>
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {howItWorks.map((item, i) => (
              <li key={i} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: '1.5', display: 'flex', gap: '8px' }}>
                <span style={{ color, flexShrink: 0 }}>›</span>{item}
              </li>
            ))}
          </ul>
        </div>

        {/* Strengths & Weaknesses */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div style={{ background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.12)', borderRadius: '6px', padding: '10px' }}>
            <div style={{ fontSize: '0.65rem', fontWeight: '700', color: 'var(--accent-green)', marginBottom: '7px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>✓ Fortalezas</div>
            {strengths.map((s, i) => (
              <div key={i} style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '3px' }}>· {s}</div>
            ))}
          </div>
          <div style={{ background: 'rgba(244,63,94,0.04)', border: '1px solid rgba(244,63,94,0.12)', borderRadius: '6px', padding: '10px' }}>
            <div style={{ fontSize: '0.65rem', fontWeight: '700', color: 'var(--accent-red)', marginBottom: '7px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>✗ Limitaciones</div>
            {weaknesses.map((w, i) => (
              <div key={i} style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '3px' }}>· {w}</div>
            ))}
          </div>
        </div>

        {/* Best for & Considerations */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
            <span style={{ color: 'var(--accent-blue)', fontWeight: '600' }}>Ideal para: </span>{bestFor}
          </div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: '1.5', padding: '8px 10px', background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.12)', borderRadius: '5px' }}>
            <span style={{ color: 'var(--accent-yellow)' }}>⚠ </span>{considerations}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '0.7rem', fontWeight: '700', textTransform: 'uppercase',
      letterSpacing: '1.5px', color: 'var(--accent-blue)',
      borderBottom: '1px solid rgba(59,130,246,0.15)',
      paddingBottom: '8px', marginBottom: '14px',
    }}>
      {children}
    </div>
  );
}

export default function HelpModal({ onClose }: HelpModalProps) {
  // Close on Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(5, 7, 12, 0.88)',
        backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
        animation: 'fadeIn 0.2s ease-out',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '820px',
          maxHeight: '90vh',
          background: 'var(--bg-panel-solid)',
          border: '1px solid rgba(59,130,246,0.2)',
          borderRadius: 'var(--border-radius-lg)',
          boxShadow: '0 25px 60px rgba(0,0,0,0.6), 0 0 40px rgba(59,130,246,0.05)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* ── Modal Header ─────────────────────────────── */}
        <div style={{
          padding: '18px 24px',
          borderBottom: '1px solid var(--border-color)',
          background: 'rgba(0,0,0,0.2)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          flexShrink: 0,
        }}>
          <div>
            <div style={{
              fontSize: '1.1rem', fontWeight: '800', letterSpacing: '1px',
              background: 'linear-gradient(135deg, #fff 0%, var(--accent-blue) 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              TERMINAL LITE — Guía de Usuario
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '3px' }}>
              Motor de señales técnicas multiestrategia · v2026.08.06.1
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: '32px', height: '32px', borderRadius: '8px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--border-color)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-secondary)', cursor: 'pointer',
              transition: 'var(--transition-smooth)',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(244,63,94,0.1)'; e.currentTarget.style.color = 'var(--accent-red)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <X size={15} />
          </button>
        </div>

        {/* ── Scrollable Body ───────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '28px' }}>

          {/* ── Intro ──────────────────────────────────── */}
          <section>
            <SectionTitle>¿Qué es FinceptTerminal?</SectionTitle>
            <p style={{ fontSize: '0.83rem', color: 'var(--text-secondary)', lineHeight: '1.7', marginBottom: '14px' }}>
              FinceptTerminal es una aplicación de análisis técnico en tiempo real enfocada en operaciones de <strong style={{ color: 'var(--text-primary)' }}>corto plazo</strong> — intradía y swing de hasta una semana. Analiza activos de alta volatilidad (criptomonedas y acciones de EEUU) mediante cinco motores de señales independientes, cada uno con su propio backtesting histórico, y selecciona automáticamente el que mejor ha rendido en las últimas velas del activo en pantalla.
            </p>

            {/* Key concepts grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
              {[
                { icon: '🏆', title: 'Torneo de Estrategias', text: 'Cada vez que cambiás de activo, los 5 motores compiten por Profit Factor. El ganador lidera la señal general.' },
                { icon: '📊', title: 'Backtesting O(n)', text: 'Simulación histórica instantánea sobre las últimas 60–150 velas, con gestión de riesgo realista (SL/TP adaptativos).' },
                { icon: '🔔', title: 'Alertas en Background', text: 'El scanner revisa toda la watchlist cada 60 segundos incluso con la pestaña en segundo plano.' },
              ].map((c, i) => (
                <div key={i} style={{ background: 'rgba(59,130,246,0.04)', border: '1px solid rgba(59,130,246,0.12)', borderRadius: '8px', padding: '12px' }}>
                  <div style={{ fontSize: '1.2rem', marginBottom: '6px' }}>{c.icon}</div>
                  <div style={{ fontSize: '0.75rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '5px' }}>{c.title}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>{c.text}</div>
                </div>
              ))}
            </div>
          </section>

          {/* ── Important Considerations ───────────────── */}
          <section>
            <SectionTitle>Consideraciones Esenciales Antes de Operar</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {[
                { icon: '⚡', color: 'var(--accent-yellow)', text: 'Las señales se calculan sobre la ÚLTIMA VELA CERRADA, no sobre la vela en formación, para evitar repintado.' },
                { icon: '🔍', color: 'var(--accent-blue)', text: 'Un Profit Factor ≥ 1.3 en backtesting es el umbral mínimo para que una estrategia sea elegida como líder. Por debajo de ese valor, el sistema cae a un fallback escalonado.' },
                { icon: '📉', color: 'var(--accent-red)', text: 'El backtesting histórico NO garantiza rendimiento futuro. Las condiciones de mercado cambian. Usá siempre stop loss.' },
                { icon: '⏱', color: 'var(--accent-green)', text: 'Las señales VCME Sniper y Multifractal MTF son las más exigentes en confluencia. Es normal que pasen horas o días sin disparar — eso es parte del diseño, no un error.' },
                { icon: '📰', color: 'var(--accent-blue)', text: 'Revisá siempre el Calendario de Catalizadores antes de entrar. Una señal técnica perfecta puede fallar si hay un reporte de ganancias o decisión de la Fed en las próximas 48 horas.' },
                { icon: '💰', color: 'var(--accent-yellow)', text: 'Usá la Calculadora de Position Sizing. El sistema limita el riesgo máximo al 25% del capital, pero vos decidís el drawdown aceptable con el slider de salud de la cuenta.' },
              ].map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: '10px', padding: '10px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: '6px', alignItems: 'flex-start' }}>
                  <span style={{ fontSize: '0.9rem', flexShrink: 0, marginTop: '1px' }}>{item.icon}</span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: '1.55' }}>{item.text}</span>
                </div>
              ))}
            </div>
          </section>

          {/* ── Signals Section Title ─────────────────── */}
          <section>
            <SectionTitle>Los 5 Motores de Señales</SectionTitle>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.6', marginBottom: '18px' }}>
              Cada motor tiene una filosofía distinta. El sistema elige el mejor en tiempo real según el Profit Factor del backtest reciente del activo. La señal final mostrada en la UI es siempre la del motor ganador del torneo.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

              <SignalCard
                number="S1"
                name="Confluencia (Experimental Signal)"
                color="#3b82f6"
                badge="MOMENTUM + ESTRUCTURA"
                badgeColor="#3b82f6"
                description="Motor de entrada por confluencia de múltiples condiciones en el timeframe activo. Evalúa que el precio esté bien posicionado (sobre VWAP, sobre EMAs cruzadas) con volumen real y una vela de calidad antes de disparar."
                howItWorks={[
                  'EMA 9 > EMA 20 para BUY (tendencia de corto plazo alcista)',
                  'Precio sobre VWAP de sesión (compradores dominan)',
                  'Volumen de la vela > promedio de 20 velas (confirmación)',
                  'Patrón de vela válido: martillo, envolvente alcista, o cierre fuerte (cuerpo ≥ 40%)',
                  'closePosition ≥ 0.60: el cierre está en el tercio superior de la vela',
                  'Filtro anti-chasing: precio no más de 2.2 × ATR del VWAP',
                ]}
                strengths={['Muy intuitivo — basado en principios clásicos de price action', 'Bajo ruido cuando el mercado tiene dirección clara', 'Rápido de calcular — sin dependencias multitemporal']}
                weaknesses={['No tiene filtro de tendencia macro (1D) propio — depende del torneo', 'Puede fallar en mercados laterales o con gaps de volumen', 'Simétrico: la señal SELL es menos confiable que el BUY']}
                bestFor="Activos con tendencia intradiaria clara, alto volumen y sin noticias próximas"
                considerations="Si el VWAP y las EMAs están muy juntos, las señales pueden ser frecuentes pero de baja calidad. Priorizá setups donde el precio haya corregido al VWAP antes de continuar."
              />

              <SignalCard
                number="S2"
                name="Scoring Multicapa"
                color="#10b981"
                badge="PONDERADO · 6 CAPAS"
                badgeColor="#10b981"
                description="Motor cuantitativo de puntajes ponderados. Cada indicador suma o resta puntos según su lectura. La señal solo se emite si el score supera el 50% del máximo teórico Y existe suficiente espacio de riesgo/recompensa hacia el próximo nivel S/R."
                howItWorks={[
                  'Capa 1 — Tendencia EMA: cruce EMA rápida/lenta + precio vs EMA mayor (ajustable por TF)',
                  'Capa 2 — RSI con pendiente: sobreventa/sobrecompra + dirección del momentum',
                  'Capa 3 — Bollinger %B: posición del precio dentro de las bandas + squeeze',
                  'Capa 4 — Volumen: VWAP (intradía) u OBV (diario) según el timeframe',
                  'Capa 5 — Calidad de vela: ratio de cuerpo, mechas de rechazo adversas',
                  'Capa 6 — Estructura S/R: proximidad a soportes y resistencias pivot',
                  'Validación R:R: si el reward hasta la próxima resistencia es < 1.5 × SL, la señal se cancela',
                ]}
                strengths={['El más completo y configurable (pesos ajustables por el usuario)', 'La validación R:R previene entradas con poco espacio', 'Funciona bien en cualquier timeframe (5m, 1h, 1d) con configuraciones distintas']}
                weaknesses={['Puede ser conservador: muchas condiciones = menos señales', 'Los niveles S/R dinámicos son menos precisos en activos poco líquidos', 'Si el mercado está lateral, el RSI y las EMAs se contradicen constantemente']}
                bestFor="Análisis riguroso antes de entrar. Ideal como confirmación de señales de otros motores"
                considerations="Los pesos por defecto son: Tendencia 1.5, Volumen 1.5, resto 1.0. Podés ajustarlos en la pestaña Estrategias. Si ajustás el peso de la Capa 1 al máximo, el sistema se convierte casi en un seguidor de tendencia puro."
              />

              <SignalCard
                number="S3"
                name="Standard Voting"
                color="#8b5cf6"
                badge="VOTACIÓN · 6 INDICADORES"
                badgeColor="#8b5cf6"
                description="Sistema de votación democrática entre 6 indicadores clásicos. Cada uno vota BUY, SELL o NEUTRAL de forma independiente. La señal se emite cuando hay mayoría clara, confirmada por volumen relativo y la posición del cierre en la vela."
                howItWorks={[
                  'RSI (14): sobreventa < 30 → BUY, sobrecompra > 70 → SELL',
                  'MACD (12,26,9): cruce del histograma con filtro de aceleración',
                  'Bollinger Bands: precio fuera de las bandas',
                  'Supertrend (10,3): flip de dirección reciente (última vela o hasta 3 atrás)',
                  'Stochastic RSI: cruce de %K/%D en zona extrema (< 20 o > 80)',
                  'Volumen: spike ≥ 1.5× el promedio de 20 velas',
                  'Filtro final: EMA 200 como tendencia macro + closePosition de la vela',
                ]}
                strengths={['Robusto: requiere consenso, no depende de un solo indicador', 'El filtro EMA 200 evita operar contra la tendencia mayor', 'Transparente — podés ver exactamente qué vota cada indicador en la UI']}
                weaknesses={['Los indicadores clásicos son laggeados: señalan movimientos que ya empezaron', 'En tendencias fuertes, RSI y Bollinger están permanentemente en zona extrema → muchos NEUTRALes', 'RVOL asimétrico: BUY necesita 1.2×, SELL solo 0.8×; leve bias alcista']}
                bestFor="Mercados con impulso claro y volumen confirmatorio. Bueno en timeframes 1h y 1d"
                considerations="El indicador de pendiente RSI (▲/▼) en la UI es puramente informativo. El voto del RSI no cambia por la pendiente, pero te ayuda a leer si el momentum está acelerando o frenando antes de entrar."
              />

              <SignalCard
                number="S4"
                name="VCME Sniper Engine v4"
                color="#f59e0b"
                badge="MULTITEMPORAL · 3 CAPAS · CUANTITATIVO"
                badgeColor="#f59e0b"
                description="El motor más sofisticado. Usa tres capas secuenciales (1D → 1H → 5m/1H) como compuertas lógicas: si cualquier capa falla, la señal no se emite. Combina bias macro, setup de momentum y gatillo de ejecución con gestión de riesgo integrada."
                howItWorks={[
                  'CAPA 1 (1D Bias): precio > EMA 200, EMA 50 > EMA 200, ADX > 20 con +DI > -DI',
                  'CAPA 2 (1H Setup): cierre > VWAP 1H, EMA 20 > EMA 50, RSI entre 50-70, histograma MACD en expansión positiva — evaluado en las últimas 3 velas 1H',
                  'CAPA 3 (Gatillo): Pullback con ruptura de micro-máximo O Breakout ORB + Bollinger Squeeze, con RVOL estacional ≥ 1.5×',
                  'Filtros de calidad: cuerpo ≥ 40%, closePosition ≥ 0.60, no chasing (< 2 ATR del VWAP), sin caos de apertura (< 15 min), sin spike de noticias (RVOL < 8×)',
                  'Score de confluencia 0-9 puntos: bias 1D, ADX fuerte, RVOL ≥ 2×, VWAP 1H, MACD 1H, squeeze BB, S/R cercano',
                  'Confianza ALTA (≥ 70%), MODERADA (≥ umbral dinámico) o DESCARTAR',
                  'SL estructural ajustado por ATR (0.8–1.8×), TP1/TP2/TP3 escalonados',
                ]}
                strengths={['Máxima calidad de señal: pocas pero muy filtradas', 'Gestión de riesgo integrada: SL/TP calculados con ATR real', 'Score de confianza permite graduar el position sizing', 'Modo Conservador (retest) para mercados de alta volatilidad']}
                weaknesses={['Exige 200+ velas diarias: no funciona con activos muy nuevos', 'Las 5 condiciones de la capa 1H raramente coinciden todas → pocas señales', 'No opera bien en activos sin sesión definida (24/7 crypto en swing)', 'En mercados laterales la capa 1D rara vez cumple ADX > 20']}
                bestFor="Acciones de EEUU y crypto líquida (BTC, ETH) en Day Trading 5m o Swing 1H con tendencia diaria clara"
                considerations="Si el motor muestra 'DESCARTAR', no es un error — el score de confluencia no alcanzó el umbral mínimo. El modo Agresivo dispara más seguido; el Conservador busca retests y es más adecuado para cripto de alta volatilidad."
              />

              <SignalCard
                number="S5"
                name="Multifractal MTF Engine"
                color="#f43f5e"
                badge="FRACTAL · EXPANSIÓN DE VOLATILIDAD"
                badgeColor="#f43f5e"
                description="Motor basado en expansiones y contracciones de volatilidad con 4 sub-indicadores propios. Opera exclusivamente cuando los tres timeframes (1D, 1H, 5M) están alineados y detecta dos tipos de oportunidades: rupturas de compresión o reversiones extremas con divergencia."
                howItWorks={[
                  'CAPA 1 — Andian Oscillator (1D): descompone velas diarias en fuerza bull/bear normalizada. Bias BULLISH cuando green > orange y red está en percentil 20',
                  'CAPA 2 — Revolution Volatility Band (1H): Bollinger Bands horarias con historial de 200 barras. COMPRIMIDO cuando el ancho cae al percentil 15',
                  'CAPA 3A — Volume Composition (5M): ratio compra/venta activa por vela. Ruptura requiere vol multiplier ≥ 1.5× y dominancia ≥ 65%',
                  'CAPA 3B — Dread Blitz MCD (5M): oscilador de momentum (precio vs EMA12 / ATR) con Bollinger Bands para detectar sobrecompra/sobreventa',
                  'Estrategia Ruptura: las 3 capas alineadas + cierre fuera de banda + volumen institucional',
                  'Estrategia Reversión: Dread Blitz en zona extrema + divergencia + absorción pasiva en mechas (no requiere compresión 1H)',
                  'Invalidación temprana: si en las primeras 3 velas el precio cruza el midpoint de la banda, el trade se invalida automáticamente',
                ]}
                strengths={['Captura movimientos explosivos de alta volatilidad', 'La estrategia de Reversión no necesita la compresión 1H → más oportunidades', 'El Andian Oscillator es un sesgo macro no convencional, menos "seguido por todos"', 'Invalidación temprana limita las pérdidas en falsas rupturas']}
                weaknesses={['Altamente dependiente de datos 1D y 1H: sin ellos opera degradado', 'En mercados muy tendenciales el Dread Blitz está siempre en overbought sin reversar', 'El Andian Oscillator necesita ≥ 14 velas diarias para ser válido', 'Las señales de Ruptura en NYSE opening (9:30-9:45 EST) requieren RVOL 2.5× en lugar de 1.5×']}
                bestFor="Crypto en 5M durante expansiones de volatilidad, y acciones con compresión previa clara (squeeze en Bollinger 1H)"
                considerations="Este motor es el que más depende de las condiciones de mercado. En rangos laterales prolongados puede no disparar nada durante horas. Eso es correcto — está esperando que la compresión libere energía. Si el ancho de las bandas 1H lleva días comprimido, la próxima señal tiene alta probabilidad de capturar un movimiento amplio."
              />

            </div>
          </section>

          {/* ── Tournament & Workflow ──────────────────── */}
          <section>
            <SectionTitle>Flujo de trabajo recomendado</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {[
                { step: '01', text: 'Activá las notificaciones con el botón 🔔. Agregá los activos que seguís a la watchlist.' },
                { step: '02', text: 'Cuando llegue una alerta, hacé click en la tarjeta del historial. El gráfico salta automáticamente al símbolo y timeframe de la señal.' },
                { step: '03', text: 'Revisá la Matriz de Confluencia (5m/1h/1d) en el panel derecho. Si las 3 temporalidades están alineadas, la señal tiene mayor validez.' },
                { step: '04', text: 'Verificá el Calendario de Catalizadores. Si hay earnings o FOMC en menos de 48hs, reducí el tamaño o evitá la operación.' },
                { step: '05', text: 'Usá la Calculadora de Position Sizing con el drawdown actual de tu cuenta. El sistema sugerirá el tamaño de posición óptimo.' },
                { step: '06', text: 'Ejecutá la operación usando el Stop Loss sugerido por el motor de señal activo (visible en el panel Estrategias).' },
              ].map((item) => (
                <div key={item.step} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                  <div style={{
                    width: '26px', height: '26px', borderRadius: '6px', flexShrink: 0,
                    background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.65rem', fontWeight: '800', color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)',
                  }}>{item.step}</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: '1.55', paddingTop: '4px' }}>{item.text}</div>
                </div>
              ))}
            </div>
          </section>

          {/* ── Disclaimer ────────────────────────────── */}
          <section>
            <div style={{
              padding: '14px 16px',
              background: 'rgba(244,63,94,0.04)',
              border: '1px solid rgba(244,63,94,0.15)',
              borderRadius: '8px',
              fontSize: '0.74rem',
              color: 'var(--text-muted)',
              lineHeight: '1.6',
            }}>
              <span style={{ color: 'var(--accent-red)', fontWeight: '700' }}>⚠ Descargo de responsabilidad: </span>
              Esta aplicación es una herramienta de análisis técnico de uso personal. Las señales generadas son el resultado de algoritmos matemáticos sobre datos históricos y NO constituyen asesoramiento financiero, recomendaciones de inversión ni garantías de rendimiento. Toda operación en mercados financieros conlleva riesgo de pérdida del capital. Operá siempre con dinero que podés permitirte perder.
            </div>
          </section>

        </div>
        {/* Footer hint */}
        <div style={{
          padding: '10px 24px',
          borderTop: '1px solid var(--border-color)',
          background: 'rgba(0,0,0,0.15)',
          fontSize: '0.68rem',
          color: 'var(--text-muted)',
          textAlign: 'center',
          flexShrink: 0,
        }}>
          Presioná <kbd style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid var(--border-color)', borderRadius: '3px', padding: '1px 5px', fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>Esc</kbd> o hacé click fuera para cerrar · Scroll para ver más
        </div>
      </div>
    </div>
  );
}
