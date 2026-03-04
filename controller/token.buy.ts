import * as trade from '../lib/lib.web3';
import config from "../config/index";
import { getTokenBuyPrice, isProfitableToken, createSellPlan } from "../constant/buy.condition";
import { TokenDataInterface, RecordTokenDataInterface, SellPlan } from "../types/types";
import { recordCoinData } from "../lib/database";
import { canBuy, incrementCounter, getCounter } from "../lib/counter";
import { addBoughtToken } from "../master/context";

export const tokenVerify = async (tokenData: TokenDataInterface): Promise<void> => {
    try {
        const start = Date.now();
        const isValidToken = await isProfitableToken(tokenData);
        const end = Date.now();
        const duration = end - start;
        if(duration > 5000) {
            console.log(`⛔ Skipping token ${tokenData.mint} due to long verification time (${duration} ms)`);
            return;
        }

        if (isValidToken.msg == false) return;

        // Check if bot can buy (counter must be < 7)
        if (!canBuy()) {
            console.log(`⛔ Cannot buy token: Counter is ${getCounter()} (must be < 7)`);
            return;
        }
        console.log("mint =>", tokenData.mint)
        console.log("duration => ", duration, " ms")
        let buyPrice = 0
        let mintValue = 0
        const amount = config.buyAmount * (isValidToken?.ratioAmount || 0)
        const mintAddress = tokenData.mint;

        if (config.backTest == false) {
            const tokenPrice = await trade.buyFromBondingCurve({ mint: mintAddress, solAmount: amount, tokenProgramId: tokenData.tokenProgramId, decimals: tokenData.decimals })
            buyPrice = tokenPrice.tokenPrice
            mintValue = tokenPrice.tokenBalanceChange

            // Increment counter after successful buy


        } else if (config.backTest == true) {
            buyPrice = await getTokenBuyPrice({
                pubKey: "mypubKey",
                mint: tokenData.mint,
                wallet: tokenData.traderPublicKey,
                fundsWallet: isValidToken.fundsWallet,
                depositeAmount: isValidToken.depositedAmount,
                buyPrice: 0,
                sellPrice: 0,
                date: new Date().toISOString(),
            } as RecordTokenDataInterface)
            // Increment counter after successful buy (backtest mode)
        }

        if (buyPrice == 0 || buyPrice == undefined || isNaN(buyPrice)) {
            console.log("❌ Failed to get buy price", buyPrice);
            return;
        };

        const buyTime = Date.now()
        console.log((`✅ Bought token ${mintAddress} with ${buyPrice} price for ${buyTime - start} ms`));


        // Create one-shot sell plan: sell at Q25 price (expected_roi_q25 * buyPrice)
        let sellPlan: SellPlan | undefined = undefined;
        if (isValidToken.clusterStats) {
            sellPlan = createSellPlan(buyPrice, isValidToken.clusterStats);
        }

        addBoughtToken({
            tokenData,
            isValidToken: isValidToken,
            buyPrice,
            sellPlan,
            mintValue: mintValue,
        });
        incrementCounter();

        if (config.isSavedInDatabase == false) return;

        await recordCoinData({
            pubKey: "mypubKey",
            mint: tokenData.mint,
            wallet: tokenData.traderPublicKey,
            fundsWallet: isValidToken.fundsWallet,
            depositeAmount: isValidToken.depositedAmount,
            buyPrice: buyPrice,
            sellPrice: 0,
            predict: isValidToken.predict,
            duration: duration,
            date: new Date().toISOString(),
        } as RecordTokenDataInterface)

    } catch (error) {
        console.error("Error inside delayed fetch:", error);
    }
};