import chalk from "chalk";
import config from "../config/index";
import Client, {
    CommitmentLevel,
    SubscribeRequestAccountsDataSlice,
    SubscribeRequestFilterAccounts,
    SubscribeRequestFilterBlocks,
    SubscribeRequestFilterBlocksMeta,
    SubscribeRequestFilterEntry,
    SubscribeRequestFilterSlots,
    SubscribeRequestFilterTransactions,
} from "@triton-one/yellowstone-grpc";
import { getBondingCurveAddress, decodeSignature, sellFromBondingCurve } from "../lib/lib.web3";
import { getBoughtTokens, removeBoughtToken, tokensBeingSold } from "../master/context";
import { updateHistory } from "../lib/database";
import { decrementCounter } from "../lib/counter";
import { isSellConditionMet } from "../constant/sell.condition";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
// Interface for the subscription request structure
interface SubscribeRequest {
    accounts: { [key: string]: SubscribeRequestFilterAccounts };
    slots: { [key: string]: SubscribeRequestFilterSlots };
    transactions: { [key: string]: SubscribeRequestFilterTransactions };
    transactionsStatus: { [key: string]: SubscribeRequestFilterTransactions };
    blocks: { [key: string]: SubscribeRequestFilterBlocks };
    blocksMeta: { [key: string]: SubscribeRequestFilterBlocksMeta };
    entry: { [key: string]: SubscribeRequestFilterEntry };
    commitment?: CommitmentLevel;
    accountsDataSlice: SubscribeRequestAccountsDataSlice[];
    ping?: any;
}

/**
 * Subscribes to the gRPC stream and handles incoming data.
 *
 * @param client - Yellowstone gRPC client
 * @param args - The Subscription request which specifies what data to stream
 */

type TokenBalance = {
    accountIndex: number;
    mint: string;
    uiTokenAmount: {
        uiAmount: number;
        decimals: number;
        amount: string;
        uiAmountString: string;
    };
    owner: string;
    programId: string;
};

type TransactionType = "BUY" | "SELL";

type FindWalletPoolParams = {
    signature: string;
    type: TransactionType;
    preBalances: string[];
    postBalances: string[];
    preTokenBalances: TokenBalance[];
    postTokenBalances: TokenBalance[];
    accountsKeys: string[];
};

type SwapResult = {
    signature: string;
    type: TransactionType;
    mint: string;
    wallet: string;
    pool: string;
    tokenAmount: number;
    solAmount: number;
    poolPostBalances: number;
    poolPostTokenBalances: number;
};

function normalizeTokenBalances(pre: any, post: any) {
    // Build maps by accountIndex
    const preMap = new Map(pre.map((x: any) => [x.accountIndex, x]));
    const postMap = new Map(post.map((x: any) => [x.accountIndex, x]));

    // Collect all accountIndexes seen
    const allIndexes = new Set([
        ...pre.map((x: any) => x.accountIndex),
        ...post.map((x: any) => x.accountIndex),
    ]);

    const fixedPre: any[] = [];
    const fixedPost: any[] = [];

    for (const index of allIndexes) {
        let preItem = preMap.get(index);
        let postItem = postMap.get(index);

        // If missing in pre → create zero entry based on post
        if (!preItem && postItem) {
            preItem = {
                ...postItem,
                uiTokenAmount: {
                    ...(postItem as any)?.uiTokenAmount,
                    uiAmount: 0,
                    amount: "0",
                    uiAmountString: "0"
                }
            };
        }

        // If missing in post → create zero entry based on pre
        if (!postItem && preItem) {
            postItem = {
                ...preItem,
                uiTokenAmount: {
                    ...(preItem as any)?.uiTokenAmount,
                    uiAmount: 0,
                    amount: "0",
                    uiAmountString: "0"
                }
            };
        }

        fixedPre.push(preItem as any);
        fixedPost.push(postItem as any);
    }

    return { preTokenBalances: fixedPre, postTokenBalances: fixedPost };
}



function getSwapDetails(params: FindWalletPoolParams): SwapResult {
    try {
        const { type, preBalances, postBalances, preTokenBalances, postTokenBalances, accountsKeys, signature } = params;

        const { preTokenBalances: _preTokenBalances, postTokenBalances: _postTokenBalances } = normalizeTokenBalances(preTokenBalances, postTokenBalances);
        // Map token balance changes
        const _tokenDeltas = _postTokenBalances.map(post => {
            const pre = _preTokenBalances.find(p => p.accountIndex === post.accountIndex && p.mint === post.mint);
            if (!pre) return null;
            return {
                account: accountsKeys[post.accountIndex], // Token account address
                owner: post.owner, // Actual wallet owner address
                delta: post.uiTokenAmount.uiAmount - pre.uiTokenAmount.uiAmount,
                postAmount: post.uiTokenAmount.uiAmount,
                mint: post.mint,
            };
        }).filter(Boolean) as { account: string; owner: string; delta: number; postAmount: number; mint: string }[];

        const tokenDeltas = _tokenDeltas.filter(t => t.delta !== 0 && t.mint !== config.WrapSol);

        if (tokenDeltas.length < 2 || tokenDeltas.length > 3) {
            return {
                signature,
                type,
                mint: "",
                wallet: "", // Return the actual wallet owner address
                pool: "",
                tokenAmount: 0,
                solAmount: 0,
                poolPostBalances: 0,
                poolPostTokenBalances: 0,
            }
        };

        // Identify wallet and pool based on type
        let wallet: string, pool: string;
        let walletOwner: string; // The actual wallet owner address
        let tokenDelta: number;
        let poolPostToken: number;
        const mint = tokenDeltas.find(t => t.mint !== config.WrapSol)?.mint;

        if (mint == undefined) {
            return {
                signature,
                type,
                mint: "",
                wallet: "", // Return the actual wallet owner address
                pool: "",
                tokenAmount: 0,
                solAmount: 0,
                poolPostBalances: 0,
                poolPostTokenBalances: 0,
            }
        }

        const bondingCurveAddress = getBondingCurveAddress(mint)

        let walletDelta: any
        let poolDelta: any


        walletDelta = tokenDeltas.find(t => t.owner !== bondingCurveAddress && t.mint === mint)!;
        poolDelta = tokenDeltas.find(t => t.owner === bondingCurveAddress && t.mint === mint)!;
        wallet = walletDelta.account; // Token account
        walletOwner = walletDelta.owner; // Actual wallet owner
        pool = poolDelta.owner;
        tokenDelta = Math.abs(poolDelta.delta);
        poolPostToken = poolDelta.postAmount;

        // The signer (index 0) is the wallet that signed the transaction, so use that for SOL change
        // Alternatively, try to find the walletOwner in accountsKeys
        let walletSolChange = 0;
        const walletOwnerIndex = accountsKeys.findIndex(acc => acc === walletOwner);

        if (walletOwnerIndex !== -1 && walletOwnerIndex < preBalances.length && walletOwnerIndex < postBalances.length) {
            // Found wallet owner in accounts, use its SOL change
            walletSolChange = Number(BigInt(String(postBalances[walletOwnerIndex])) - BigInt(String(preBalances[walletOwnerIndex]))) / 1e9;
        } else {
            // Fallback: use signer (index 0) as the wallet
            walletSolChange = Number(BigInt(String(postBalances[0])) - BigInt(String(preBalances[0]))) / 1e9;
        }

        const solAmount = Math.abs(walletSolChange);


        // Calculate pool SOL balance
        const poolIndex = accountsKeys.findIndex(acc => acc === pool);
        const poolPostBalances = poolIndex !== -1 && poolIndex < postBalances.length
            ? Number(postBalances[poolIndex])
            : 0;

        return {
            signature,
            type,
            mint,
            wallet: walletOwner, // Return the actual wallet owner address
            pool,
            tokenAmount: tokenDelta,
            solAmount,
            poolPostBalances: poolPostBalances / 1e9,
            poolPostTokenBalances: poolPostToken,
        };
    } catch (error: any) {
        // console.error("Error getting swap details:", error.message || error);
        return {
            signature: "",
            type: "BUY",
            mint: "",
            wallet: "", // Return the actual wallet owner address
            pool: "",
            tokenAmount: 0,
            solAmount: 0,
            poolPostBalances: 0,
            poolPostTokenBalances: 0,
        }
    }
}

// Rapid drawdown: sell if current profit is 20% or more below the highest profit seen (no time check)
   // e.g. highest was +30%, now +8% → 22% below → sell

// Track sell execution state per token mint
interface TokenSellState {
    executedTiers: Set<string>;
    positionStartTime: number;
    totalSoldWeight: number;
    highestProfitPercent: number; // Track the highest profit percent reached during monitoring
}

const tokenSellStates = new Map<string, TokenSellState>();
/** Mints currently being sold — skip processing to avoid double trigger */


/**
 * Get or create sell state for a token
 */
function getTokenSellState(mint: string): TokenSellState {
    if (!tokenSellStates.has(mint)) {
        tokenSellStates.set(mint, {
            executedTiers: new Set<string>(),
            positionStartTime: Date.now(),
            totalSoldWeight: 0,
            highestProfitPercent: 0,
        });
    }
    return tokenSellStates.get(mint)!;
}

/**
 * Execute sell for a specific tier
 */
async function executeTierSell(tokenData: any, tierName: string, tierWeight: number, reason: string, amount: number): Promise<void> {
    const mint = tokenData.mint;
    // Verify token is still being monitored before executing
    const boughtTokens = getBoughtTokens();
    const isTokenStillBought = boughtTokens.some(bt => bt.tokenData.mint === mint);
    if (!isTokenStillBought) {
        console.log(`⚠️ Token ${mint} no longer in boughtTokens, skipping tier ${tierName} execution`);
        return;
    }

    const state = getTokenSellState(mint);

    if (state.executedTiers.has(tierName)) {
        console.log(`⚠️ Tier ${tierName} already executed for ${mint}, skipping`);
        return;
    }

    state.executedTiers.add(tierName);
    state.totalSoldWeight += tierWeight;

    console.log(`🔴 Executing ${tierName} tier sell (weight: ${(tierWeight * 100).toFixed(1)}%) for ${mint} - ${reason}`);

    if (config.backTest) {
        await new Promise(resolve => setTimeout(resolve, 400));
        console.log(`[BACKTEST] Would sell ${(tierWeight * 100).toFixed(1)}% of ${mint}`);
    } else {
        // Sell the tier's weight portion of the position
        sellFromBondingCurve({ 
            mint, 
            rate: tierWeight, 
            amount: amount,
            decimals: tokenData.decimals || 6,
            tokenProgramId: tokenData.tokenProgramId || TOKEN_2022_PROGRAM_ID.toString()
        });
    }
}

const STREAM_IDLE_TIMEOUT_MS = 60 * 1000;  // 1 min without data → close and reconnect
const IDLE_CHECK_INTERVAL_MS = 15 * 1000;  // check every 15s

async function handleStream(client: Client, args: SubscribeRequest) {
    const stream = await client.subscribe();
    let lastDataReceivedAt = Date.now();
    let idleCheckInterval: ReturnType<typeof setInterval> | null = null;

    // Promise that resolves when the stream ends or errors out
    const streamClosed = new Promise<void>((resolve, reject) => {
        stream.on("error", (error) => {
            if (idleCheckInterval) clearInterval(idleCheckInterval);
            console.error("Stream error:", error);
            reject(error);
            stream.end();
        });

        stream.on("end", () => {
            if (idleCheckInterval) clearInterval(idleCheckInterval);
            resolve();
        });
        stream.on("close", () => {
            if (idleCheckInterval) clearInterval(idleCheckInterval);
            resolve();
        });
    });

    // If no data for 1 min, close stream so subscribeCommand reconnects
    idleCheckInterval = setInterval(() => {
        if (Date.now() - lastDataReceivedAt >= STREAM_IDLE_TIMEOUT_MS) {
            console.warn("Sell stream idle for 1 min, closing to reconnect...");
            if (idleCheckInterval) clearInterval(idleCheckInterval);
            stream.end();
        }
    }, IDLE_CHECK_INTERVAL_MS);

    // Handle incoming transaction data
    stream.on("data", async (data) => {
        lastDataReceivedAt = Date.now();
        if (!data?.transaction?.transaction) return
        const tx = data.transaction.transaction
        const logMsg = tx.meta.logMessages
        const isBuying = logMsg.some((line: string) => line.includes("Buy"));
        const isSelling = logMsg.some((line: string) => line.includes("Sell"));

        const signature = decodeSignature(tx.signature)
        const accounts = tx.transaction.message.accountKeys;
        const meta = tx.meta;
        const preBalances = meta?.preBalances;
        const postBalances = meta?.postBalances;
        const preTokenBalances = meta?.preTokenBalances;
        const postTokenBalances = meta?.postTokenBalances;
        const loadedWritableAddresses = meta?.loadedWritableAddresses.map((addr: any) => decodeSignature(addr));
        const loadedReadonlyAddresses = meta?.loadedReadonlyAddresses.map((addr: any) => decodeSignature(addr));
        const decodedAccounts = accounts.map((addr: any) => decodeSignature(addr))

        const accountKeys = [
            ...decodedAccounts,
            ...loadedWritableAddresses,
            ...loadedReadonlyAddresses
        ]
        // const signer = accountKeys[0]
        let tokenMonitoring: any

        // Process both BUY and SELL transactions to monitor price and check sell conditions
        if (isBuying) {
            tokenMonitoring = getSwapDetails({
                signature,
                type: "BUY",
                preBalances: preBalances || [],
                postBalances: postBalances || [],
                preTokenBalances: preTokenBalances || [],
                postTokenBalances: postTokenBalances || [],
                accountsKeys: accountKeys
            })
        } else if (isSelling) {
            tokenMonitoring = getSwapDetails({
                signature: signature,
                type: "SELL",
                preBalances: preBalances || [],
                postBalances: postBalances || [],
                preTokenBalances: preTokenBalances || [],
                postTokenBalances: postTokenBalances || [],
                accountsKeys: accountKeys
            })
        }

        const boughtTokens = getBoughtTokens();

        // Kill switch: check ALL bought tokens for hold-time limit on every transaction.
        // Sell any token whose hold time is reached, even if this tx is for a different mint.
        for (const boughtToken of [...boughtTokens]) {
            const mint = boughtToken.tokenData.mint;
            const amount = boughtToken.mintValue;
            const sellPlan = boughtToken.sellPlan;
            if (!sellPlan) continue;

            const sellState = getTokenSellState(mint);
            const holdTimeSeconds = Math.floor((Date.now() - sellState.positionStartTime) / 1000);
            if (holdTimeSeconds < sellPlan.killSwitch.maxHoldSeconds) continue;

            if (tokensBeingSold.has(mint)) continue; // already selling this token
            console.log(`⏰ KILL SWITCH for ${mint}: held ${holdTimeSeconds}s >= ${sellPlan.killSwitch.maxHoldSeconds}s (checked on unrelated tx)`);
            try {
                tokensBeingSold.add(mint);
                const highestProfitPercent = sellState.highestProfitPercent; // Capture before deleting
                if (!config.backTest) {
                    sellFromBondingCurve({ 
                        mint,
                        rate: 1.0, 
                        amount: amount , 
                        decimals: boughtToken.tokenData.decimals || 6, 
                        tokenProgramId: boughtToken.tokenData.tokenProgramId || TOKEN_2022_PROGRAM_ID.toString()
                    });
                } else {
                    await new Promise((resolve) => setTimeout(resolve, 400));
                }
                tokenSellStates.delete(mint);
                removeBoughtToken(mint); // Remove from monitoring to prevent duplicate sells
                if (config.isSavedInDatabase) {
                    await updateHistory({
                        mint,
                        sellPrice: boughtToken.buyPrice,
                        buyPrice: boughtToken.buyPrice,
                        reasonToSell: `Kill switch: held ${holdTimeSeconds}s >= ${sellPlan.killSwitch.maxHoldSeconds}s`,
                        highestProfitPercent
                    });
                }
            } catch (err: any) {
                console.error(`❌ Kill switch sell failed for ${mint}:`, err?.message || err);
                const highestProfitPercent = sellState.highestProfitPercent; // Capture before deleting
                tokenSellStates.delete(mint);
                removeBoughtToken(mint); // Remove from monitoring even on error to prevent duplicate sells
                if (config.isSavedInDatabase) {
                    try {
                        await updateHistory({
                            mint,
                            sellPrice: boughtToken.buyPrice,
                            buyPrice: boughtToken.buyPrice,
                            reasonToSell: `Kill switch (sell failed): held ${holdTimeSeconds}s`,
                            highestProfitPercent
                        });
                    } catch (_) { }
                }
            } finally {
                tokensBeingSold.delete(mint);
            }
        }

        // Only process price/matching logic if we have valid token monitoring data
        if (!tokenMonitoring || !tokenMonitoring.mint) {
            return;
        }

        for (const boughtToken of boughtTokens) {
            if (boughtToken.tokenData.mint === tokenMonitoring.mint) {
                const mint = boughtToken.tokenData.mint;
                const buyPrice = boughtToken.buyPrice;
                const sellPlan = boughtToken.sellPlan;
                const amount = boughtToken.mintValue;
                // Calculate current price from swap transaction
                // Price = SOL amount / Token amount (both are absolute values from the swap)
                // This works for both BUY and SELL transactions as they represent the effective price
                // const currentPrice = tokenMonitoring.tokenAmount > 0
                //     ? tokenMonitoring.solAmount / tokenMonitoring.tokenAmount
                //     : 0;

                const vTokenBalance = 73000000 + tokenMonitoring.poolPostTokenBalances;
                const vSolBalance = 30 + tokenMonitoring.poolPostBalances;
                const currentPrice = (vSolBalance) / vTokenBalance;

                if (currentPrice <= 0) {
                    console.log(`⚠️ Invalid price calculated for ${mint} (solAmount: ${tokenMonitoring.solAmount}, tokenAmount: ${tokenMonitoring.tokenAmount}), skipping sell logic`);
                    return;
                }

                // Verify token is still in boughtTokens before processing
                // This prevents processing tokens that should have been removed
                const isTokenStillBought = boughtTokens.some(bt => bt.tokenData.mint === mint);
                if (!isTokenStillBought) {
                    // Token was removed but we're still processing it - skip
                    return;
                }

                // Get or initialize sell state for this token
                const sellState = getTokenSellState(mint);

                // Calculate hold time (used by isSellConditionMet for kill switch)
                const holdTimeSeconds = Math.floor((Date.now() - sellState.positionStartTime) / 1000);

                // Profit for rapid drawdown and legacy path
                const profit = (currentPrice - buyPrice) / buyPrice;
                const profitPercent = profit * 100;

                // Update peak profit, then check drawdown: sell if current is 20%+ below highest (no time check)
                if (profitPercent > sellState.highestProfitPercent) {
                    sellState.highestProfitPercent = profitPercent;
                }
                const dropFromHigh = sellState.highestProfitPercent - profitPercent;
                let sellDecision: { shouldSell: boolean; reason: string; profit?: number; tier?: any; isKillSwitch?: boolean } | undefined;
                if (dropFromHigh >= config.RAPID_DRAWDOWN_DROP_PERCENT) {
                    sellDecision = {
                        shouldSell: true,
                        reason: `Drawdown: current ${profitPercent.toFixed(1)}% is ${dropFromHigh.toFixed(1)}% below peak ${sellState.highestProfitPercent.toFixed(1)}%`,
                        profit,
                    };
                }

                if (!sellDecision) {
                    // Use sell plan logic if available, otherwise fall back to legacy
                    if (sellPlan) {
                        sellDecision = isSellConditionMet(
                            currentPrice,
                            buyPrice,
                            sellPlan,
                            holdTimeSeconds,
                            sellState.executedTiers,
                            sellState.highestProfitPercent
                        );

                        // Log monitoring status and track highest profit
                        if (!sellDecision.shouldSell) {
                            if (sellDecision.profit !== undefined && !isNaN(sellDecision.profit)) {
                                // Update highest profit percent if current profit is higher
                                const profitPercent = sellDecision.profit * 100;
                                if (profitPercent > sellState.highestProfitPercent) {
                                    sellState.highestProfitPercent = profitPercent;
                                }
                                console.log(`📊 ${mint} ${sellDecision.reason}`);
                            }
                        } else {
                            // Even if selling, track the profit if available
                            if (sellDecision.profit !== undefined && !isNaN(sellDecision.profit)) {
                                const profitPercent = sellDecision.profit * 100;
                                if (profitPercent > sellState.highestProfitPercent) {
                                    sellState.highestProfitPercent = profitPercent;
                                }
                            }
                        }
                    } else {
                        // Legacy fallback - use predict or clusterStats target ROI (profit/profitPercent from above)
                        const currentROI = currentPrice / buyPrice;
                        const predictROI =
                            boughtToken.isValidToken.clusterStats?.expected_roi_q25 ??
                            (boughtToken.isValidToken.predict != null ? 1 + boughtToken.isValidToken.predict : 0);
                        const shouldSell = predictROI > 0 && currentROI >= predictROI;

                        // Track highest profit in legacy mode
                        if (profitPercent > sellState.highestProfitPercent) {
                            sellState.highestProfitPercent = profitPercent;
                        }

                        sellDecision = {
                            shouldSell,
                            reason: shouldSell
                                ? `Legacy predict threshold reached: ${(profit * 100).toFixed(2)}% }%`
                                : `Monitoring (legacy mode): ${(currentROI * 100).toFixed(2)}% profit`,
                            profit: profit
                        };
                    }
                }

                if (!sellDecision.shouldSell) {
                    return; // Continue monitoring
                }

                // Handle sell decision
                let sellPrice = currentPrice;
                let reasonToSell = sellDecision.reason;
                let shouldClosePosition = false;

                if (tokensBeingSold.has(mint)) {
                    return; // already selling this token, skip to avoid double trigger
                }

                try {
                    tokensBeingSold.add(mint);
                    if (sellDecision.isKillSwitch) {
                        // Kill switch: sell everything due to time limit
                        console.log(`⏰ KILL SWITCH for ${mint}: ${reasonToSell}`);
                        if (!config.backTest) {
                            sellFromBondingCurve({ 
                                mint, 
                                rate: 1.0, 
                                amount, 
                                decimals: boughtToken.tokenData.decimals || 6, 
                                tokenProgramId: boughtToken.tokenData.tokenProgramId || TOKEN_2022_PROGRAM_ID.toString()
                            });                            
                        } else {
                            await new Promise(resolve => setTimeout(resolve, 400));
                        }
                        shouldClosePosition = true;
                    } else if (sellDecision.tier) {
                        // Tier reached: execute tier sell


                        await executeTierSell(
                            boughtToken.tokenData,
                            sellDecision.tier.name,
                            sellDecision.tier.weight,
                            reasonToSell,
                            amount
                        );

                        // Check if all tiers executed or if we should continue monitoring
                        if (sellPlan && sellState.executedTiers.size >= sellPlan.tiers.length) {
                            // All tiers executed - sell any remaining position
                            const remainingWeight = 1.0 - sellState.totalSoldWeight;
                            if (remainingWeight > 0.01) { // Only sell if > 1% remaining
                                console.log(`💰 Selling remaining position (${(remainingWeight * 100).toFixed(1)}%) for ${mint}`);
                                if (!config.backTest) {
                                    sellFromBondingCurve({ 
                                        mint, 
                                        rate: remainingWeight, 
                                        amount: amount,
                                        decimals: boughtToken.tokenData.decimals || 6,
                                        tokenProgramId: boughtToken.tokenData.tokenProgramId || TOKEN_2022_PROGRAM_ID.toString()
                                    });
                                }
                            }
                            console.log(`✅ All sell tiers executed for ${mint}. Total sold: ${(sellState.totalSoldWeight * 100).toFixed(1)}%`);
                            shouldClosePosition = true;
                        } else if (sellState.totalSoldWeight >= 0.95) {
                            // Position almost fully sold
                            console.log(`✅ Position fully sold for ${mint} (${(sellState.totalSoldWeight * 100).toFixed(1)}%)`);
                            shouldClosePosition = true;
                        } else {
                            console.log(`📊 Continuing to monitor ${mint} for remaining tiers... (Sold: ${(sellState.totalSoldWeight * 100).toFixed(1)}%)`);
                            // Continue monitoring for other tiers - update history but don't close
                            if (config.isSavedInDatabase) {
                                await updateHistory({
                                    mint,
                                    sellPrice,
                                    buyPrice,
                                    reasonToSell: `${reasonToSell} (Partial: ${(sellDecision.tier.weight * 100).toFixed(1)}%)`,
                                    highestProfitPercent: sellState.highestProfitPercent
                                });
                            }
                            return; // Continue monitoring
                        }
                    } else {
                        // Legacy mode or fallback
                        console.log(`🔴 Selling ${mint} (legacy mode): ${reasonToSell}`);
                        if (!config.backTest) {
                            sellFromBondingCurve({ 
                                mint, 
                                rate: 1.0, 
                                amount: amount,
                                decimals: boughtToken.tokenData.decimals || 6,
                                tokenProgramId: boughtToken.tokenData.tokenProgramId || TOKEN_2022_PROGRAM_ID.toString()
                            });
                        }
                        shouldClosePosition = true;
                    }

                    // Clean up state and remove from bought list if position is fully closed
                    const highestProfitPercent = sellState.highestProfitPercent;
                    if (shouldClosePosition) {
                        // Remove from boughtTokens FIRST to prevent race conditions
                        removeBoughtToken(mint); // Remove from monitoring to prevent duplicate sells
                        // Then delete state after removal is confirmed
                        tokenSellStates.delete(mint);
                    }

                    // Update history if database saving is enabled
                    if (config.isSavedInDatabase) {
                        await updateHistory({
                            mint,
                            sellPrice,
                            buyPrice,
                            reasonToSell,
                            highestProfitPercent
                        });
                    }

                } catch (error: any) {
                    console.error(`❌ Error executing sell for ${mint}:`, error.message || error);
                    // Still decrement counter even if sell fails (to prevent stuck state)
                    decrementCounter();
                    tokenSellStates.delete(mint);
                    removeBoughtToken(mint);

                    // Update history with error
                    if (config.isSavedInDatabase) {
                        try {
                            const highestProfitPercent = sellState.highestProfitPercent;
                            await updateHistory({
                                mint,
                                sellPrice,
                                buyPrice,
                                reasonToSell: `${reasonToSell} (Error: ${error.message || 'Unknown error'})`,
                                highestProfitPercent
                            });
                        } catch (historyError: any) {
                            console.error(`❌ Error updating history for ${mint}:`, historyError.message || historyError);
                        }
                    }
                } finally {
                    tokensBeingSold.delete(mint);
                }

                // Break after processing first matching token (assuming one token per mint)
                break;
            }
        }
    });

    // Send the subscription request
    await new Promise<void>((resolve, reject) => {
        stream.write(args, (err: any) => {
            err ? reject(err) : resolve();
        });
    }).catch((err) => {
        console.error("Failed to send subscription request:", err);
        throw err;
    });

    // Wait for the stream to close
    await streamClosed;
}

/**
 * Entry point to start the subscription stream.
 *
 */
async function subscribeCommand(client: Client, args: SubscribeRequest) {
    while (true) {
        try {
            await handleStream(client, args);
        } catch (error) {
            console.error("Stream error, retrying in 1 second...", error);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}

// Instantiate Yellowstone gRPC client with env credentials
const client = new Client(
    config.GRPC_URL, //Your Region specific gRPC URL
    config.GRPC_TOKEN, // your Access Token
    undefined,
);

/**
 * Subscribe Request: The `blocks` filter will stream blocks which include those
 * that involve the specified address in `accountInclude`.
 */




export const startSubscribeTokenMonitoring = () => {
    console.log(chalk.green("💫") + " Connecting to PumpFun Subscribe for Price Monitoring");

    const req: SubscribeRequest = {
        accounts: {},
        slots: {},
        transactions: {
            pumpFun: {
                vote: false,
                failed: false,
                signature: undefined,
                accountInclude: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"],
                //for our usecase we only need to listen to transaction belonging to one program, so we have added one address
                accountExclude: [],
                accountRequired: [],
            },
        },
        transactionsStatus: {},
        entry: {},
        blocks: {},
        blocksMeta: {},
        accountsDataSlice: [],
        ping: undefined,
        commitment: CommitmentLevel.CONFIRMED,
    };
    subscribeCommand(client, req);
}
