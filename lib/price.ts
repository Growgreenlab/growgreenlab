/**
 * price.ts — Price normalization utilities.
 * Ensures consistent decimal precision across chart, inputs, and engine.
 */

/** US equity tick size: $0.01 for stocks priced >= $1. */
export const EQUITY_TICK_SIZE = 0.01;

/**
 * Normalize a price to the instrument's valid tick increment.
 * Uses toFixed to eliminate floating-point artifacts like 3.200000047683716.
 * Math.round(price / tickSize) * tickSize does NOT work because tickSize
 * (0.01) cannot be represented exactly in binary.
 */
export function normalizePrice(price: number, decimals: number = 2): number {
  if (!isFinite(price) || price <= 0) return price;
  return Number(price.toFixed(decimals));
}

/** Format a price for display (2 decimals for equities). */
export function formatPrice(price: number | null): string {
  if (price == null || !isFinite(price)) return "";
  return price.toFixed(2);
}
