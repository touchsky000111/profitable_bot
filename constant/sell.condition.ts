import { SellPlan, SellTier } from "../types/types";

export interface SellDecision {
        shouldSell: boolean;
        reason: string;
        tier?: SellTier;
        isStopLoss?: boolean;
        isKillSwitch?: boolean;
        profit?: number;
}

/**
 * Check if sell condition is met based on multi-tier sell plan
 * @param currentPrice - Current token price
 * @param buyPrice - Price at which token was purchased
 * @param sellPlan - Production-grade sell plan with tiers and stop-loss
 * @param holdTimeSeconds - How long the position has been held
 * @param executedTiers - Set of tier names that have already been executed
 * @returns SellDecision with sell recommendation
 */
export const isSellConditionMet = (
        currentPrice: number,
        buyPrice: number,
        sellPlan: SellPlan | null,
        holdTimeSeconds: number,
        executedTiers: Set<string>,
        highestProfitPercent: number
): SellDecision => {
        // Fallback to legacy predict-based logic if no sell plan
        if (!sellPlan) {
                return {
                        shouldSell: false,
                        reason: "No sell plan available"
                };
        }

        const { tiers, killSwitch, stopLossPrice } = sellPlan;

        // 1. Check stop-loss (highest priority)
        if (currentPrice <= stopLossPrice) {
                return {
                        shouldSell: true,
                        reason: `Stop-loss triggered: ${currentPrice} <= ${stopLossPrice}`,
                        isStopLoss: true
                };
        }

        // 2. Check time-based kill switch
        if (holdTimeSeconds >= killSwitch.maxHoldSeconds) {
                return {
                        shouldSell: true,
                        reason: `Kill switch: held for ${holdTimeSeconds}s >= ${killSwitch.maxHoldSeconds}s`,
                        isKillSwitch: true
                };
        }

        // 3. Check tier prices (in order: conservative -> median -> aggressive)
        for (const tier of tiers) {
                // Skip if this tier has already been executed
                if (executedTiers.has(tier.name)) {
                        continue;
                }

                // Check if current price has reached this tier
                if (currentPrice >= tier.price) {
                        return {
                                shouldSell: true,
                                reason: `${tier.name} tier reached: ${currentPrice} >= ${tier.price}`,
                                tier: tier
                        };
                }
        }

        // No sell condition met
        const profit = (currentPrice - buyPrice) / buyPrice;
        const nextTier = tiers.find(t => !executedTiers.has(t.name));

        const target =
                nextTier ? ((nextTier.price / buyPrice) - 1) * 100 : 0;
        return {
                shouldSell: false,
                reason: `Monitoring: ${currentPrice} | Profit: ${(profit * 100).toFixed(2)}% | Target: ${target.toFixed(2)}%  | Hold: ${holdTimeSeconds}s`,
                profit: profit
        };
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use isSellConditionMet with SellPlan instead
 */
export const isSellConditionMetLegacy = (counter: number, currentPrice: number, buyPrice: number, predict: number) => {
        if (predict === 0 || isNaN(predict)) return false;
        const profit = (currentPrice - buyPrice) / buyPrice;
        console.log(`Price Update #${counter}: ${currentPrice} USD | Profit: ${(profit * 100).toFixed(2)}%`);

        return profit >= predict;
}