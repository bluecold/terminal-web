import { useEffect } from 'react';
import { X } from 'lucide-react';
import { APP_VERSION } from '../version';

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
              Motor de señales técnicas multiestrategia y paridad cuantitativa · {APP_VERSION}
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
              FinceptTerminal es una estación cuantitativa de análisis técnico en tiempo real para operaciones de <strong style={{ color: 'var(--text-primary)' }}>corto plazo</strong> (Intradía 5m y Swing 1H). Analiza criptomonedas y acciones de Wall Street mediante cinco motores matemáticos independientes, simulador de ejecución unificado (`simulateTrade`) con slippage adverso en órdenes a mercado y deadband simétrico en R, métricas de riesgo institucional (Drawdown en R, Sortino, racha de pérdidas), factor de beneficio homogéneo (PF en R), scoring de contracción bayesiana (Bayesian Shrinkage), selección condicionada por régimen de volatilidad con histéresis ([22, 26]), compuerta activa de multiplicidad (White's Reality Check), validación Walk-Forward con 3 folds disjuntos (`foldsPassed ≥ 2`) y scoring continuo $C^0$ sin escalones binarios.
            </p>

            {/* Key concepts grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
              {[
                { icon: '📡', title: 'Radar Multi-Activo', text: 'Escáner en vivo de la watchlist y presets con confluencias 3/3, compresión BB y RVOL estacional.' },
                { icon: '🏆', title: 'Torneo Bayesiano & QVE', text: 'Ranking puro In-Sample, compuerta de multiplicidad Bonferroni (+0.04R hurdle), margen sobre 2º y Walk-Forward disjunto.' },
                { icon: '⚡', title: 'VCME & MTF Parity', text: 'Simulador unificado con salidas 3-tier, Time-Stop a 8 velas, Emergency Exit, slippage de mercado y fricción contable (0.08%).' },
                { icon: '🎯', title: 'Audit Tracker & Chart', text: 'Seguimiento causal sin repintado en velas vivas, líneas visuales en TradingView y cero alertas fantasma.' },
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
                { icon: '⚡', color: 'var(--accent-yellow)', text: 'Las señales se calculan sobre la ÚLTIMA VELA CERRADA, no sobre la vela en formación, para evitar repintado temporal.' },
                { icon: '🔍', color: 'var(--accent-blue)', text: 'El Torneo exige E[R] > 0, ratio Sortino consistente, control de Drawdown (MDD ≤ 2.5R), al menos 3 trades para LIMITED, ranking libre de data leakage, validación Walk-Forward con 3 particiones disjuntas (foldsPassed ≥ 2 para HIGH), y superación del hurdle deflactado (+0.04R) y margen sobre el 2º clasificado.' },
                { icon: '🌊', color: 'var(--accent-green)', text: 'Condicionamiento Dinámico por Régimen (Histéresis [22, 26]): En mercados de alta tendencia (ADX ≥ 26) el torneo prioriza motores de ruptura y descarta reversiones tóxicas; en rango (ADX ≤ 22) prioriza osciladores y reversión a la media. Entre 22 y 26 conserva inercia para evitar parpadeos.' },
                { icon: '📉', color: 'var(--accent-red)', text: 'El Profit Factor se calcula homogéneamente en múltiplos R (PF_R = Σ Gains_R / Σ |Losses_R|), garantizando perfecta comparabilidad entre scalps de 5m con stop estrecho y swings de 1H con stop amplio.' },
                { icon: '⏱', color: 'var(--accent-yellow)', text: 'VCME Sniper exige un Confidence Score ≥ 65% con campana óptima a 0.5 ATR para disparar. Es normal que transcurran horas sin señal — esto es protección algorítmica por diseño.' },
                { icon: '💰', color: 'var(--accent-blue)', text: 'Usá la Calculadora de Position Sizing (VCME v2.0). El sistema calcula las unidades exactas sugiriendo un riesgo del 1% de capital y límite de concentración del 20%.' },
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
                  'Precio sobre VWAP de sesión (compradores dominan, con neutralización de apertura)',
                  'Volumen de la vela ≥ 80% del promedio de 20 velas (confirmación)',
                  'Patrón de vela válido: martillo, envolvente alcista, o cierre fuerte (cuerpo ≥ 40%)',
                  'closePosition: ≥ 0.50 para BUY (mitad superior) / ≤ 0.50 para SELL (mitad inferior)',
                  'Filtro anti-chasing: precio no más de 2.2 × ATR del VWAP',
                  'Stop Loss a 2.0 × ATR con TP a 3.0 × ATR (1.5R) y horizonte escalado (10 velas 5m / 7 velas 1h)',
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
                badge="PONDERADO · 6 CAPAS CONTINUAS"
                badgeColor="#10b981"
                description="Motor cuantitativo de puntajes continuos ponderados. Utiliza mapeos suaves mediante tangentes hiperbólicas (tanh) en EMA mayor, VWAP y OBV, eliminando discontinuidades binarias. Se activa al superar el 40% del máximo alcanzable con espacio R:R hacia S/R."
                howItWorks={[
                  'Capa 1 — Tendencia EMA: cruce EMA rápida/lenta + aporte continuo tanh((close - EMA_major)/ATR)',
                  'Capa 2 — RSI con pendiente: sobreventa/sobrecompra + dirección del momentum',
                  'Capa 3 — Bollinger %B: posición del precio dentro de las bandas + squeeze',
                  'Capa 4 — Volumen: VWAP continuo con rampa suave a 1.8-2.2 ATR (intradía) u OBV continuo tanh normalizado por volumen medio (diario)',
                  'Capa 5 — Calidad de vela: ratio de cuerpo, mechas de rechazo adversas',
                  'Capa 6 — Estructura S/R: proximidad a soportes y resistencias pivot',
                  'Validación R:R: si el reward hasta la próxima resistencia es < 1.5 × SL, la señal se cancela',
                  'Geometría calibrada: SL a 1.5 × ATR y horizonte escalado a 8 velas (5m) / 5 velas (1h)',
                ]}
                strengths={['Mapeo continuo C0 que erradica el churn y saltos abruptos por ruido', 'La validación R:R previene entradas con poco espacio', 'Funciona bien en cualquier timeframe (5m, 1h, 1d) con configuraciones calibradas']}
                weaknesses={['Puede ser conservador: muchas condiciones = menos señales', 'Los niveles S/R dinámicos son menos precisos en activos poco líquidos', 'Si el mercado está lateral, el RSI y las EMAs se contradicen constantemente']}
                bestFor="Análisis riguroso antes de entrar. Ideal como confirmación de señales de otros motores"
                considerations="Los pesos por defecto son: Tendencia 1.5, Volumen 1.5, resto 1.0. El umbral se calibra automáticamente al 40% de la capacidad continua alcanzable (2.50 en 5m, 2.80 en 1h/1d)."
              />

              <SignalCard
                number="S3"
                name="Standard Voting"
                color="#8b5cf6"
                badge="VOTACIÓN · MAYORÍA NETA ≥ 2"
                badgeColor="#8b5cf6"
                description="Sistema de votación democrática entre 6 indicadores clásicos. Exige una mayoría neta calificada (voteMargin ≥ 2) confirmada por volumen relativo simétrico y la posición del cierre en la vela."
                howItWorks={[
                  'RSI (14): sobreventa < 30 → BUY, sobrecompra > 70 → SELL',
                  'MACD (12,26,9): cruce del histograma con filtro de aceleración',
                  'Bollinger Bands: precio fuera de las bandas',
                  'Supertrend (10,3): flip de dirección reciente (última vela o hasta 3 atrás)',
                  'Stochastic RSI: cruce de %K/%D en zona extrema (< 20 o > 80)',
                  'Volumen: spike ≥ 1.5× el promedio de 20 velas',
                  'Mayoría neta: exige margen de votos ≥ 2 y RVOL simétrico de 0.9x para BUY y SELL',
                  'Filtro final: EMA 200 como tendencia macro + closePosition de la vela',
                ]}
                strengths={['Robusto: requiere consenso real (margen ≥ 2), evitando señales con un solo voto', 'Filtro RVOL simétrico de 0.9x evita operar ventas sin liquidez', 'Transparente — podés ver exactamente qué vota cada indicador en la UI']}
                weaknesses={['Los indicadores clásicos son laggeados: señalan movimientos que ya empezaron', 'En tendencias fuertes, RSI y Bollinger están permanentemente en zona extrema → muchos NEUTRALes']}
                bestFor="Mercados con impulso claro y volumen confirmatorio. Bueno en timeframes 1h y 1d"
                considerations="El indicador de pendiente RSI (▲/▼) en la UI es puramente informativo. El voto del RSI no cambia por la pendiente, pero te ayuda a leer si el momentum está acelerando o frenando antes de entrar."
              />

              <SignalCard
                number="S4"
                name="VCME v2.0 Quant Engine"
                color="#f59e0b"
                badge="INSTITUCIONAL · MULTITEMPORAL · 3 CAPAS"
                badgeColor="#f59e0b"
                description="Motor algorítmico cuantitativo de grado institucional. Utiliza 3 capas secuenciales (1D Juez → 1H Contexto/Régimen → 5m Gatillo) con asimetría LONG/SHORT, score de confianza matemático continuo (0.0–1.0), clasificación dinámica DAY/SWING y salidas complejas por Chandelier Exit."
                howItWorks={[
                  'CAPA 1 (1D Bias): Cierre > EMA 200, EMA 50 > EMA 200, ADX > 20 y +DI > -DI (para LONG)',
                  'CAPA 2 (1H Contexto & Régimen): Cierre > VWAP 1H, EMA 20 > EMA 50, RSI entre 50-70, MACD Hist en expansión positiva + filtro de pendiente de la EMA 200 1H adaptado a volatilidad (> 0.05 × ATR 1H)',
                  'CAPA 3 (Gatillo 5m): Asimétrico. LONG exige RVOL ≥ 1.5x y cierre en el 40% superior. SHORT exige RVOL ≥ 1.8x y cierre en el 40% inferior (evita short squeezes)',
                  'Score de Confianza Continuo [0.0–1.0]: Pondera RVOL (30%), Bias 1D (25%), MACD 1H (20%), Distancia a EMA21 con campana óptima a 0.5 ATR (15%) y VWAP (10%). Umbral mínimo de activación: 65% (0.65)',
                  'Clasificación DAY vs SWING: Clasifica según ADX 1H > 30. Trades DAY incluyen time-stop de 40 min; trades SWING ejecutan trailing stop continuo en 1H',
                  'Gestión de Riesgo Asimétrica: SL de 1.5 ATR (LONG) y 1.8 ATR (SHORT). Trailing TP2 guiado por el Chandelier Exit (22, 3.0) en 1H',
                  'Position Sizing Automático: Calcula las unidades exactas a operar basándose en el 1% de riesgo de capital y 20% máximo de concentración',
                ]}
                strengths={['Grado institucional: máxima solidez cuantitativa y cero repintado', 'Asimetría LONG/SHORT previene trampas de mercado y squeeze bajistas', 'Score continuo 0.0–1.0 sin saltos discretos', 'Trailing por Chandelier Exit 1H maximiza ganancias en tendencias extendidas']}
                weaknesses={['Exige 200+ velas diarias y 60+ velas de 1H para converger indicadores', 'Muy exigente en confluencia: la supresión al 65% descarta trades de baja probabilidad', 'En mercados completamente laterales sin tendencia 1D/1H genera neutrales']}
                bestFor="Acciones de EEUU y criptomonedas líquidas (BTC, ETH, SOL) en Day Trading 5m o Swing 1-3 días con sesgo cuantitativo claro"
                considerations="Si la señal indica 'Confidence Score insuficiente (<65%)', la operación se cancela automáticamente por prudencia algorítmica. Revisá si el trade es DAY o SWING en el panel para conocer la estrategia de trailing aplicada."
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
                  'CAPA 3A — Volume Composition (5M): ratio compra/venta activa sin auto-inclusión. Ruptura requiere vol multiplier ≥ 1.5× y dominancia ≥ 65%',
                  'CAPA 3B — Dread Blitz MCD (5M): oscilador de momentum (precio vs EMA12 / ATR) con Bollinger Bands para detectar sobrecompra/sobreventa',
                  'Estrategia Ruptura: las 3 capas alineadas + cierre fuera de banda + volumen institucional',
                  'Estrategia Reversión: Dread Blitz en zona extrema + divergencia + absorción en mechas + compatibilidad estricta con sesgo 1D (prohíbe compras con bias diario bajista)',
                  'Corte adverso temprano: si en las primeras 3 velas el precio retrocede ≥ 0.5R en contra de la entrada, se cierra la posición con pérdida reducida (-0.5R en lugar de -1.0R de SL completo)',
                ]}
                strengths={['Captura movimientos explosivos de alta volatilidad', 'La estrategia de Reversión no necesita la compresión 1H → más oportunidades', 'El Andian Oscillator es un sesgo macro no convencional, menos "seguido por todos"', 'Corte temprano a -0.5R reduce drásticamente el impacto de pérdidas en falsas rupturas']}
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
