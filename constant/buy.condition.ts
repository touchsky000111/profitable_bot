import { RecordTokenDataInterface, TokenDataInterface } from "../types/types";
import config from "../config/index";
import WebSocket from "ws";
import { api } from "../service";
import { SellPlan } from "../types/types";
import axios from "axios";
/** --- Types --- */


export const getTokenBuyPrice = (
        tokenData: RecordTokenDataInterface
): Promise<number> => {
        return new Promise((resolve, reject) => {
                const ws = new WebSocket(config.JUPITER_WS_URL, {
                        headers: {
                                Origin: "https://jup.ag",
                        },
                });

                ws.on("open", () => {
                        ws.send(
                                JSON.stringify({
                                        type: "subscribe:prices",
                                        assets: [tokenData.mint],
                                })
                        );
                });

                ws.on("message", async (data) => {
                        try {
                                const message = JSON.parse(data.toString());
                                const solPrice = await axios.get('https://perps-api.jup.ag/v1/market-stats?mint=So11111111111111111111111111111111111111112')
                                const price = Number(message?.data?.[0]?.price) / Number(solPrice.data.price);
                                if (!price || price <= 0) return;

                                ws.close();
                                resolve(price); // ✅ THIS returns buy price
                        } catch (err) {
                                reject(err);
                        }
                });

                ws.on("error", reject);

                ws.on("close", () => {
                        // optional cleanup
                });
        });
};


/** --- tokenCheck: Validate token based on wallet analytics --- */
export const isProfitableToken = async (tokenData: TokenDataInterface): Promise<{
        msg: boolean,
        ratioAmount?: number,
        fundsWallet?: string,
        depositedAmount?: number,
        predict: number | null,
        clusterStats?: {
                probability: number;
                expected_roi_median: number;
                expected_roi_q25: number;
                expected_roi_q75: number;
        }
}> => {

        try {
                const poolAddress = tokenData.bondingCurveKey;
                const walletAddress = tokenData.traderPublicKey;
                if (!poolAddress || !walletAddress) {
                        return {
                                msg: false,
                                predict: null,
                                ratioAmount: 0,
                        };
                }
                // Run both async operations in parallel
                
                const resp = await api.post("/predict",
                        {
                                mint: tokenData.mint,
                                traderPublicKey: tokenData.traderPublicKey,
                                initialBuy: tokenData.initialBuy,
                                solAmount: tokenData.solAmount,
                                marketCapSol: tokenData.marketCapSol,
                                vSolInBondingCurve: tokenData.vSolInBondingCurve,
                                vTokensInBondingCurve: tokenData.vTokensInBondingCurve,
                                txInSameSlot: tokenData.txInSameSlot,
                        }
                );

                const data = resp.data;

                // New API: response is a single expected ROI multiplier (e.g. 1.0135, 1.0046)
                if (typeof data === "number" && !isNaN(data)) {
                        const minRoiMultiplier = 1.3;
                        const gatePass = data > minRoiMultiplier;
                        if (!gatePass) {
                                return { msg: false, predict: null };
                        }
                        const respectedMinRoi = data < 2 ? (data - 1) * 0.8 + 1: data * 0.95
                        // predict for DB/legacy: profit ratio (e.g. 1.0135 -> 0.0135)
                        const ratioAmount = data < 2 ? 0.5:1
                        const predict = data ;
                        const clusterStats = {
                                probability: 1,
                                expected_roi_median: respectedMinRoi,
                                expected_roi_q25: respectedMinRoi,
                                expected_roi_q75: respectedMinRoi,
                        };
                        return {
                                ratioAmount: ratioAmount,
                                predict,
                                fundsWallet: "fundsWallet",
                                depositedAmount: 0,
                                msg: true,
                                clusterStats,
                        };
                }
                return { msg: false, predict: null };

        } catch (error: any) {
                // console.error(
                //         chalk.red("❌") + `mint: ${tokenData.mint} ` + ` wallet ${tokenData.traderPublicKey} `
                // );
                const errorMsg = error.response?.data || error.message || error.toString()
                // console.dir(errorMsg);
                return {
                        msg: false,
                        predict: null,
                        ratioAmount: 0,
                }
        }
};

/**
 * Create a one-shot sell plan: target ROI is (q75 - 1) when q75 > 3, else expected_roi_q25.
 * @param buyPrice - The price at which the token was purchased
 * @param clusterStats - Cluster statistics from ML prediction
 * @returns SellPlan with single sell target
 */
export const createSellPlan = (
        buyPrice: number,
        clusterStats: {
                probability: number;
                expected_roi_median: number;
                expected_roi_q25: number;
                expected_roi_q75: number;
        }
): SellPlan => {
        const { probability, expected_roi_q25, expected_roi_q75 } = clusterStats;

        // Target ROI: q75 > 4 => 3; q75 in (3, 4) => 2; q75 < 3 => expected_roi_q25 (q25 > 1.3)
        const targetRoi = expected_roi_q25;
 

        const sellPrice = buyPrice * targetRoi;

        // Stop-loss logic (cluster-aware)
        const stopLossPrice = buyPrice * (1 - 0.3);

        // Time-based kill switch (default: 6 minutes)
        // TODO: Use clusterStats.median_peak_time_sec if available
        console.log("Buy Price => ", buyPrice, " Sell Price => ", sellPrice, "ROI => ", targetRoi);
        const maxHoldSeconds = config.maxHoldSeconds * 60;
        return {
                stopLossPrice,
                tiers: [
                        {
                                name: "q25_target",
                                price: sellPrice,
                                weight: 1.0  // Sell 100% at Q25 price
                        }
                ],
                killSwitch: {
                        maxHoldSeconds
                }
        };
};