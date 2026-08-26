/**
 * FinceptTerminal - Universal Smart Precision & Price Formatting Utility
 * 
 * Provides dynamic magnitude-aware formatting for financial assets ranging
 * from mega-caps ($BTC, $SPY >= $1,000) to sub-cent meme tokens ($DOGE, $SHIB, $PEPE < $0.01).
 * 
 * Prevents mathematical quantization errors by keeping calculations strictly in 64-bit IEEE-754 floats
 * and only adapting precision at the visual/presentation boundary.
 */

/**
 * Determines the optimal number of decimal places based on price magnitude.
 */
export function getOptimalDecimals(price: number): number {
  if (!price || isNaN(price) || price === 0) return 2;
  const abs = Math.abs(price);
  if (abs < 0.0001) return 8; // e.g. PEPE $0.00000854, SHIB $0.00002810
  if (abs < 0.01) return 6;   // e.g. GALA $0.021540
  if (abs < 1.0) return 4;    // e.g. XRP $0.5218, DOGE $0.1174, ADA $0.3455
  if (abs < 10.0) return 3;   // e.g. SUI $3.452, NEAR $4.812
  return 2;                   // e.g. SOL $152.40, NVDA $128.50, BTC $65,420.50
}

/**
 * Formats a financial asset price dynamically according to its scale with optional '$' prefix.
 * Preserves high precision for small-priced assets while avoiding cluttered zeros on large-priced assets.
 */
export function formatSmartPrice(
  value: number | undefined | null,
  includeDollarSign: boolean = true
): string {
  if (value === undefined || value === null || isNaN(value)) {
    return '-';
  }
  if (value === 0) {
    return includeDollarSign ? '$0.00' : '0.00';
  }

  const decimals = getOptimalDecimals(value);
  const formatted = value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return includeDollarSign ? `$${formatted}` : formatted;
}

/**
 * Formats a generic numerical value or distance with smart precision fallback.
 */
export function formatSmartNumber(
  value: number | undefined | null,
  defaultDecimals: number = 2
): string {
  if (value === undefined || value === null || isNaN(value)) {
    return '-';
  }
  const abs = Math.abs(value);
  if (abs === 0) return (0).toFixed(defaultDecimals);
  if (abs < 0.0001) return value.toFixed(8);
  if (abs < 0.01) return value.toFixed(6);
  if (abs < 1.0) return value.toFixed(4);
  return value.toFixed(defaultDecimals);
}
