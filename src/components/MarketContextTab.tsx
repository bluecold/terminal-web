import { useState, useEffect, useMemo, memo } from 'react';
import {
  fetchNews,
  fetchStockExtraInfo,
  fetchCryptoFearAndGreed,
  type StockExtraInfo,
  type CryptoExtraInfo,
  type NewsItem,
} from '../services/api';
import { APP_VERSION } from '../version';
import { EARNINGS_NOTICE_WINDOW_DAYS, getDaysUntil, getNextMacroEvent, type EarningsEvent } from '../utils/marketEvents';

const TIMING_TEXT = { BMO: 'antes de la apertura', AMC: 'tras el cierre', UNKNOWN: 'horario sin informar' } as const;

interface MarketContextTabProps {
  symbol: string;
  isCrypto: boolean;
  earningsEvent: EarningsEvent | null;
  entryPrice?: number;
}

function MarketContextTab({
  symbol,
  isCrypto,
  earningsEvent,
  entryPrice = 0,
}: MarketContextTabProps) {
  const [stockInfo, setStockInfo] = useState<StockExtraInfo | null>(null);
  const [cryptoInfo, setCryptoInfo] = useState<CryptoExtraInfo | null>(null);
  const [loadingExtra, setLoadingExtra] = useState(false);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loadingNews, setLoadingNews] = useState(false);

  // ── Extra Info (Zacks / Fear & Greed) with 24h Cache ───────────────────────
  /* eslint-disable react-hooks/set-state-in-effect -- sync cache read on symbol change */
  useEffect(() => {
    const cachedVersion = localStorage.getItem('terminal_app_version');
    if (cachedVersion !== APP_VERSION) {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith('terminal_extra_info_')) {
          localStorage.removeItem(key);
        }
      }
      localStorage.setItem('terminal_app_version', APP_VERSION);
    }

    let isMounted = true;
    const cacheKey = `terminal_extra_info_${symbol}`;
    const cachedData = localStorage.getItem(cacheKey);

    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData);
        if (parsed && typeof parsed.timestamp === 'number' && Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) {
          if (isCrypto) {
            setCryptoInfo(parsed.data);
            setStockInfo(null);
          } else {
            setStockInfo(parsed.data);
            setCryptoInfo(null);
          }
          setLoadingExtra(false);
          return;
        }
      } catch (e) {
        console.error('Error parsing cached extra info', e);
      }
    }

    const loadExtraInfo = async () => {
      setLoadingExtra(true);
      try {
        if (isCrypto) {
          const data = await fetchCryptoFearAndGreed();
          if (isMounted) {
            if (data) {
              setCryptoInfo(data);
              setStockInfo(null);
              localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
            } else {
              setCryptoInfo(null);
            }
          }
        } else {
          const data = await fetchStockExtraInfo(symbol);
          if (isMounted) {
            if (data) {
              setStockInfo(data);
              setCryptoInfo(null);
              localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
            } else {
              setStockInfo(null);
            }
          }
        }
      } catch (err) {
        console.error('Error loading extra info in MarketContextTab', err);
      } finally {
        if (isMounted) {
          setLoadingExtra(false);
        }
      }
    };

    loadExtraInfo();

    return () => {
      isMounted = false;
    };
  }, [symbol, isCrypto]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── News Feed ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;
    const loadNews = async () => {
      setLoadingNews(true);
      try {
        const data = await fetchNews(symbol);
        if (isMounted) setNews(data);
      } catch (err) {
        console.error('Error loading news in MarketContextTab', err);
      } finally {
        if (isMounted) setLoadingNews(false);
      }
    };
    loadNews();

    return () => {
      isMounted = false;
    };
  }, [symbol]);

  const nextMacro = useMemo(() => getNextMacroEvent(), []);

  const earningsInfo = useMemo(() => {
    if (!earningsEvent) return null;
    const reactionNote = earningsEvent.lastSessionAfterClose ? 'Presentó tras el último cierre: esta sesión opera la reacción' : null;
    if (!earningsEvent.dateKey) return { date: reactionNote ?? '', daysLeft: 0, pill: 'Reacción', reactionNote: null };
    const daysLeft = getDaysUntil(earningsEvent.dateKey);
    const details = [
      new Date(earningsEvent.dateKey + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
      earningsEvent.isConfirmed ? 'confirmada' : 'estimada',
      // Session timing is only published for the coming days
      ...(daysLeft <= EARNINGS_NOTICE_WINDOW_DAYS ? [TIMING_TEXT[earningsEvent.timing]] : []),
    ];
    return {
      date: details.join(' · '),
      daysLeft: reactionNote ? 0 : daysLeft,
      pill: daysLeft <= 0 ? 'Hoy' : daysLeft === 1 ? 'Mañana' : `en ${daysLeft} días`,
      reactionNote
    };
  }, [earningsEvent]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Métricas de Contexto (Complementary Info) */}
      {(() => {
        if (loadingExtra) {
          return (
            <div style={{
              backgroundColor: 'var(--bg-panel)',
              border: '1px solid var(--border-color)',
              padding: '16px',
              borderRadius: 'var(--border-radius-md)',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
              animation: 'pulse 1.5s infinite'
            }}>
              Cargando métricas de contexto...
            </div>
          );
        }

        if (isCrypto && cryptoInfo) {
          const value = cryptoInfo.value;
          const classification = cryptoInfo.classification;
          
          let color = 'var(--text-secondary)';
          let bgGlow = 'none';
          if (value <= 25) {
            color = 'var(--accent-red)';
            bgGlow = '0 0 10px rgba(244, 63, 94, 0.1)';
          } else if (value < 45) {
            color = '#f59e0b';
          } else if (value <= 55) {
            color = 'var(--text-secondary)';
          } else if (value < 75) {
            color = 'var(--accent-green)';
          } else {
            color = '#059669';
            bgGlow = '0 0 10px rgba(16, 185, 129, 0.1)';
          }

          return (
            <div style={{
              backgroundColor: 'var(--bg-panel)',
              border: '1px solid var(--border-color)',
              padding: '16px 14px 14px 14px',
              borderRadius: 'var(--border-radius-md)',
              position: 'relative',
              boxShadow: bgGlow || 'var(--shadow-sm)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px'
            }}>
              <div style={{ position: 'absolute', top: '-10px', left: '14px', background: 'var(--bg-dark)', padding: '0 8px', borderRadius: '4px' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px' }}>
                  SENTIMIENTO DE MERCADO CRIPTO
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>F&G INDEX (GLOBAL)</span>
                  <span style={{ fontSize: '1.25rem', fontWeight: '800', color: '#fff' }}>
                    {value} <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 'normal' }}>/ 100</span>
                  </span>
                </div>
                <span style={{ 
                  fontSize: '0.75rem', 
                  fontWeight: '800', 
                  padding: '4px 10px', 
                  borderRadius: '6px',
                  color: color,
                  backgroundColor: `${color}15`,
                  border: `1px solid ${color}30`,
                  letterSpacing: '0.5px',
                  textTransform: 'uppercase'
                }}>
                  {classification === 'Greed' ? 'Codicia' : classification === 'Extreme Greed' ? 'Codicia Extrema' : classification === 'Fear' ? 'Miedo' : classification === 'Extreme Fear' ? 'Miedo Extremo' : 'Neutral'}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ height: '8px', borderRadius: '4px', background: 'linear-gradient(to right, var(--accent-red) 0%, #f59e0b 50%, var(--accent-green) 100%)', position: 'relative', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{
                    position: 'absolute',
                    top: '-3px',
                    left: `${value}%`,
                    width: '4px',
                    height: '14px',
                    backgroundColor: '#fff',
                    borderRadius: '2px',
                    border: '1px solid #000',
                    boxShadow: '0 0 4px rgba(0,0,0,0.5)',
                    transform: 'translateX(-50%)',
                    transition: 'left 0.8s cubic-bezier(0.25, 0.8, 0.25, 1)'
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  <span>MIEDO EXTREMO</span>
                  <span>NEUTRAL</span>
                  <span>CODICIA EXTREMA</span>
                </div>
              </div>
            </div>
          );
        }

        if (!isCrypto) {
          if (!stockInfo) {
            return (
              <div style={{
                backgroundColor: 'var(--bg-panel)',
                border: '1px solid var(--border-color)',
                padding: '20px 14px 18px 14px',
                borderRadius: 'var(--border-radius-md)',
                position: 'relative',
                boxShadow: 'var(--shadow-sm)',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px'
              }}>
                <div style={{ position: 'absolute', top: '-10px', left: '14px', background: 'var(--bg-dark)', padding: '0 8px', borderRadius: '4px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px' }}>
                    ZACKS RANK & FUNDAMENTALES
                  </span>
                </div>
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                  padding: '10px 10px 4px 10px'
                }}>
                  <span style={{ fontSize: '1.2rem' }}>⚠️</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: '500', lineHeight: '1.4', color: 'var(--text-secondary)' }}>
                    Datos de consenso y fundamentales no disponibles
                  </span>
                  <span style={{ fontSize: '0.65rem', lineHeight: '1.4' }}>
                    Los servicios de Zacks y Yahoo Finance han limitado las peticiones desde este servidor o no hay conexión a internet.
                  </span>
                </div>
              </div>
            );
          }

          const recMean = stockInfo.recommendationMean;
          const recColor = recMean !== null
            ? (recMean <= 2.0 ? 'var(--accent-green)' : recMean <= 3.5 ? 'var(--text-secondary)' : 'var(--accent-red)')
            : 'var(--text-secondary)';
          
          let recLabel = 'MANTENER';
          if (recMean !== null) {
            if (recMean <= 1.5) recLabel = 'FUERTE COMPRA';
            else if (recMean <= 2.5) recLabel = 'COMPRA';
            else if (recMean <= 3.5) recLabel = 'MANTENER';
            else if (recMean <= 4.5) recLabel = 'VENTA';
            else recLabel = 'FUERTE VENTA';
          }

          const target = stockInfo.targetMeanPrice;
          const beta = stockInfo.beta;

          let upsidePct = 0;
          if (target && entryPrice > 0) {
            upsidePct = ((target - entryPrice) / entryPrice) * 100;
          }

          return (
            <div style={{
              backgroundColor: 'var(--bg-panel)',
              border: '1px solid var(--border-color)',
              padding: '16px 14px 14px 14px',
              borderRadius: 'var(--border-radius-md)',
              position: 'relative',
              boxShadow: 'var(--shadow-sm)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px'
            }}>
              <div style={{ position: 'absolute', top: '-10px', left: '14px', background: 'var(--bg-dark)', padding: '0 8px', borderRadius: '4px' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px' }}>
                  ZACKS RANK & FUNDAMENTALES
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>ZACKS RANK</span>
                  {recMean !== null && (
                    <span style={{ 
                      fontSize: '0.7rem', 
                      fontWeight: '800', 
                      padding: '2px 8px', 
                      borderRadius: '4px',
                      color: recColor,
                      backgroundColor: `${recColor}12`,
                      border: `1px solid ${recColor}25`
                    }}>
                      {recLabel} ({recMean})
                    </span>
                  )}
                </div>

                {recMean !== null ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ height: '8px', borderRadius: '4px', background: 'linear-gradient(to right, var(--accent-green) 0%, #a7f3d0 25%, var(--text-muted) 50%, #fca5a5 75%, var(--accent-red) 100%)', position: 'relative', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div style={{
                        position: 'absolute',
                        top: '-3px',
                        left: `${((recMean - 1) / 4) * 100}%`,
                        width: '4px',
                        height: '14px',
                        backgroundColor: '#fff',
                        borderRadius: '2px',
                        border: '1px solid #000',
                        boxShadow: '0 0 4px rgba(0,0,0,0.5)',
                        transform: 'translateX(-50%)',
                        transition: 'left 0.8s cubic-bezier(0.25, 0.8, 0.25, 1)'
                      }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.55rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      <span>1.0 FUERTE COMPRA</span>
                      <span>3.0 MANTENER</span>
                      <span>5.0 FUERTE VENTA</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Sin Zacks Rank disponible</div>
                )}
              </div>

              <div style={{ height: '1px', backgroundColor: 'var(--border-color)', margin: '2px 0' }} />

              <div style={{ display: 'flex', gap: '12px' }}>
                {target ? (
                  <>
                    <div style={{ 
                      flex: 1.2, 
                      padding: '8px 10px', 
                      background: 'rgba(0, 0, 0, 0.12)', 
                      border: '1px solid var(--border-color)', 
                      borderRadius: '6px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px'
                    }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>PRECIO OBJETIVO (YAHOO)</span>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#fff', fontFamily: 'var(--font-mono)' }}>
                          ${target.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                        <span style={{ 
                          fontSize: '0.65rem', 
                          fontWeight: 'bold', 
                          color: upsidePct >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'
                        }}>
                          {upsidePct >= 0 ? '+' : ''}{upsidePct.toFixed(1)}% Upside
                        </span>
                      </div>
                    </div>

                    <div style={{ 
                      flex: 0.8, 
                      padding: '8px 10px', 
                      background: 'rgba(0, 0, 0, 0.12)', 
                      border: '1px solid var(--border-color)', 
                      borderRadius: '6px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px'
                    }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>BETA (VOLATILIDAD)</span>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#fff', fontFamily: 'var(--font-mono)' }}>
                          {beta !== null ? beta.toFixed(2) : 'N/A'}
                        </span>
                        {beta !== null && (
                          <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', lineHeight: '1.1' }} title={beta > 1 ? "Más volátil que el mercado" : "Menos volátil que el mercado"}>
                            {beta > 1 ? "📈 Alta" : beta < 1 ? "📉 Baja" : "Neutral"}
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{ 
                    flex: 1, 
                    padding: '8px 10px', 
                    background: 'rgba(0, 0, 0, 0.12)', 
                    border: '1px solid var(--border-color)', 
                    borderRadius: '6px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px'
                  }}>
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>BETA (VOLATILIDAD)</span>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#fff', fontFamily: 'var(--font-mono)' }}>
                        {beta !== null ? beta.toFixed(2) : 'N/A'}
                      </span>
                      {beta !== null && (
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: '1.1' }} title={beta > 1 ? "Más volátil que el mercado" : "Menos volátil que el mercado"}>
                          {beta > 1 ? "📈 Alta (más volátil que el mercado)" : beta < 1 ? "📉 Baja (menos volátil que el mercado)" : "Neutral"}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        }

        return null;
      })()}

      {/* Volatility Catalysts (Earnings & Macro events) */}
      {(() => {
        const hasEvents = nextMacro || earningsInfo;
        if (!hasEvents) return null;

        return (
          <div style={{
            backgroundColor: 'var(--bg-panel)',
            border: '1px solid var(--border-color)',
            padding: '16px 14px 14px 14px',
            borderRadius: 'var(--border-radius-md)',
            position: 'relative',
            boxShadow: 'var(--shadow-sm)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
          }}>
            <div style={{ position: 'absolute', top: '-10px', left: '14px', background: 'var(--bg-dark)', padding: '0 8px', borderRadius: '4px' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px' }}>
                CATALIZADORES DE VOLATILIDAD
              </span>
            </div>
            
            {earningsInfo && (
              <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                padding: '6px 10px',
                background: earningsInfo.daysLeft <= 2 ? 'rgba(244, 63, 94, 0.05)' : 'rgba(255, 255, 255, 0.01)',
                border: `1px solid ${earningsInfo.daysLeft <= 2 ? 'rgba(244, 63, 94, 0.2)' : 'var(--border-color)'}`,
                borderRadius: '6px'
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>Reporte de Ganancias (Stock)</span>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{earningsInfo.date}</span>
                  {earningsInfo.reactionNote && (
                    <span style={{ fontSize: '0.65rem', color: 'var(--accent-red)' }}>{earningsInfo.reactionNote}</span>
                  )}
                </div>
                <span style={{ 
                  fontSize: '0.65rem', 
                  fontWeight: '800', 
                  padding: '2px 8px', 
                  borderRadius: '4px',
                  color: earningsInfo.daysLeft <= 2 ? 'var(--accent-red)' : 'var(--accent-blue)',
                  backgroundColor: earningsInfo.daysLeft <= 2 ? 'rgba(244, 63, 94, 0.08)' : 'rgba(0, 229, 255, 0.08)'
                }}>
                  {earningsInfo.pill}
                </span>
              </div>
            )}
            
            {nextMacro && (
              <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                padding: '6px 10px',
                background: nextMacro.daysLeft <= 2 ? 'rgba(245, 158, 11, 0.05)' : 'rgba(255, 255, 255, 0.01)',
                border: `1px solid ${nextMacro.daysLeft <= 2 ? 'rgba(245, 158, 11, 0.2)' : 'var(--border-color)'}`,
                borderRadius: '6px'
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>{nextMacro.title} (Macro 2026)</span>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{new Date(nextMacro.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                </div>
                <span style={{ 
                  fontSize: '0.65rem', 
                  fontWeight: '800', 
                  padding: '2px 8px', 
                  borderRadius: '4px',
                  color: nextMacro.daysLeft <= 2 ? 'var(--accent-yellow)' : 'var(--text-secondary)',
                  backgroundColor: nextMacro.daysLeft <= 2 ? 'rgba(245, 158, 11, 0.08)' : 'rgba(255, 255, 255, 0.03)'
                }}>
                  {nextMacro.daysLeft === 0 ? 'Hoy' : nextMacro.daysLeft === 1 ? 'Mañana' : `en ${nextMacro.daysLeft} días`}
                </span>
              </div>
            )}
          </div>
        );
      })()}

      {/* News Feed */}
      <div style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-color)',
        padding: '16px',
        borderRadius: 'var(--border-radius-md)'
      }}>
        <div style={{ 
          color: 'var(--text-secondary)', 
          fontSize: '0.75rem', 
          fontWeight: '800', 
          letterSpacing: '1px', 
          marginBottom: '14px', 
          borderBottom: '1px solid var(--border-color)', 
          paddingBottom: '8px',
          textTransform: 'uppercase'
        }}>
          ÚLTIMAS NOTICIAS
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {loadingNews ? (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0', fontSize: '0.8rem' }}>Cargando noticias...</div>
          ) : news.length > 0 ? (
            news.map((item, index) => (
              <a 
                key={index} 
                href={item.url} 
                target="_blank" 
                rel="noopener noreferrer" 
                style={{ 
                  textDecoration: 'none', 
                  display: 'block',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  background: 'rgba(255, 255, 255, 0.01)',
                  border: '1px solid rgba(255, 255, 255, 0.03)',
                  transition: 'var(--transition-smooth)',
                }}
                className="news-card"
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(59, 130, 246, 0.03)';
                  e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.15)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.01)';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.03)';
                }}
              >
                <div style={{ 
                  color: 'var(--accent-blue)', 
                  marginBottom: '6px', 
                  lineHeight: '1.4', 
                  fontWeight: '600',
                  fontSize: '0.8rem'
                }}>
                  {item.title}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                  <span>{item.source}</span>
                  <span>{item.time}</span>
                </div>
              </a>
            ))
          ) : (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0', fontSize: '0.8rem' }}>Sin noticias recientes</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(MarketContextTab);
