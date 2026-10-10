/**
 * risk.ts — Position sizing and risk calculations (pure, unit-testable).
 * All values are estimates; never imply guaranteed max loss.
 */

export interface RiskInputs {
  balance: number;
  riskPct: number; // e.g. 1 = 1%
  entry: number;
  stopLoss: number;
  takeProfit: number;
  fees: number; // total estimated fees per round trip
  slippagePct: number; // e.g. 0.1 = 0.1% adverse slippage on entry+exit
  direction: "long" | "short";
  /** If set, uses this qty instead of calculating from risk budget (for open positions). */
  fixedQty?: number;
}

export interface RiskResult {
  valid: boolean;
  errors: string[];
  riskBudget: number;
  stopDistance: number;
  suggestedQty: number;
  maxLoss: number;
  grossProfit: number;
  riskReward: number;
  requiredBuyingPower: number;
  remainingBuyingPower: number;
}

export function calculateRisk(inp: RiskInputs): RiskResult {
  const errors: string[] = [];
  const empty: RiskResult = {
    valid: false,
    errors,
    riskBudget: 0,
    stopDistance: 0,
    suggestedQty: 0,
    maxLoss: 0,
    grossProfit: 0,
    riskReward: 0,
    requiredBuyingPower: 0,
    remainingBuyingPower: inp.balance,
  };

  // Validation
  if (!(inp.balance > 0)) errors.push("Balance must be positive.");
  if (!(inp.riskPct > 0) || inp.riskPct > 100) errors.push("Risk % must be between 0 and 100.");
  if (!(inp.entry > 0)) errors.push("Entry price must be positive.");
  if (!(inp.stopLoss > 0)) errors.push("Stop-loss must be positive.");
  if (!(inp.takeProfit > 0)) errors.push("Take-profit must be positive.");
  if (inp.direction === "long") {
    if (inp.stopLoss >= inp.entry) errors.push("Long stop-loss must be below entry.");
    if (inp.takeProfit <= inp.entry) errors.push("Long take-profit must be above entry.");
  } else {
    if (inp.stopLoss <= inp.entry) errors.push("Short stop-loss must be above entry.");
    if (inp.takeProfit >= inp.entry) errors.push("Short take-profit must be below entry.");
  }
  if (errors.length > 0) return empty;

  const riskBudget = (inp.balance * inp.riskPct) / 100;
  const stopDistance = Math.abs(inp.entry - inp.stopLoss);
  if (!(stopDistance > 0)) {
    errors.push("Stop distance is zero — cannot size position.");
    return { ...empty, errors, riskBudget };
  }

  // Suggested qty: risk budget / per-share risk, rounded down.
  // If fixedQty is set (open position), use actual qty instead.
  const suggestedQty = inp.fixedQty != null && inp.fixedQty > 0
    ? Math.floor(inp.fixedQty)
    : Math.floor(riskBudget / stopDistance);
  if (suggestedQty < 1) {
    errors.push(inp.fixedQty != null
      ? "Position quantity is zero."
      : "Risk budget too small for 1 share at this stop distance.");
    return { ...empty, errors, riskBudget, stopDistance };
  }

  // Slippage: adverse move on entry and exit.
  const slipPerShare = inp.entry * (inp.slippagePct / 100) * 2;
  const maxLoss = suggestedQty * stopDistance + inp.fees + suggestedQty * slipPerShare;

  const tpDistance = Math.abs(inp.takeProfit - inp.entry);
  const grossProfit = Math.max(0, suggestedQty * tpDistance - inp.fees - suggestedQty * slipPerShare);

  const riskReward = maxLoss > 0 ? grossProfit / maxLoss : 0;

  const requiredBuyingPower = suggestedQty * inp.entry;
  const remainingBuyingPower = inp.balance - requiredBuyingPower;

  return {
    valid: true,
    errors: [],
    riskBudget,
    stopDistance,
    suggestedQty,
    maxLoss,
    grossProfit,
    riskReward,
    requiredBuyingPower,
    remainingBuyingPower,
  };
}
