import mongoose from "mongoose";
import { RecordTokenDataInterface, UpdateHistoryParams } from "../types/types";
import TokenRecord from "../models/TokenRecord";
import WalletStateModel from "../models/Wallet_status";
import config from "../config";



/**
 * Wait for mongoose connection to be ready
 */
const waitForConnection = async (): Promise<boolean> => {
        // Connection states: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
        const readyState = mongoose.connection.readyState;

        if (readyState === 1) {
                return true; // Already connected
        }

        if (readyState === 0) {
                // Not connected, wait a bit and check again
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (mongoose.connection.readyState === 1) {
                        return true;
                }
        }

        // Wait for connection with timeout
        return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                        resolve(false);
                }, 5000); // 5 second timeout

                if (mongoose.connection.readyState === 1) {
                        clearTimeout(timeout);
                        resolve(true);
                } else {
                        mongoose.connection.once('connected', () => {
                                clearTimeout(timeout);
                                resolve(true);
                        });
                }
        });
};

/**
 * Update trading history in TokenRecord collection
 * Updates only the fields provided (partial update)
 * If record doesn't exist, it will be created with the provided fields
 */
export const updateHistory = async ({
        pubKey,
        mint,
        wallet,
        sellPrice,
        buyPrice,
        reasonToSell,
        highestProfitPercent
}: UpdateHistoryParams): Promise<void> => {
        try {
                // Wait for mongoose connection
                const isConnected = await waitForConnection();
                if (!isConnected) {
                        console.error("MongoDB connection not ready, skipping updateHistory");
                        return;
                }

                const time = new Date().toISOString();

                // Get existing record to calculate rate properly
                const existingRecord = await TokenRecord.findOne({ mint });

                const updateFields: any = {
                        date: time, // Always update the date when updating
                };

                // Only include fields that are explicitly provided (not undefined)
                if (sellPrice !== undefined) updateFields.sellPrice = sellPrice;
                // Compute rate only when buyPrice is provided and non-zero to avoid undefined / divide-by-zero
                if (existingRecord?.buyPrice !== undefined && existingRecord?.buyPrice !== 0) {
                        updateFields.rate = ((sellPrice ?? 0) / existingRecord?.buyPrice) - 1;
                }
                // Save highest profit percent if provided
                if (highestProfitPercent !== undefined) {
                        updateFields.highestProfitPercent = highestProfitPercent;
                }
                // Use findOneAndUpdate with upsert to create or update
                await TokenRecord.findOneAndUpdate(
                        { mint },
                        {
                                $set: updateFields,
                        },
                        {
                                upsert: true,
                                new: true,
                                setDefaultsOnInsert: true,
                        }
                );

                if (!existingRecord) {
                        console.log("No matching record found. Added new data!");
                } else {
                        console.log("History updated successfully!");
                }
        } catch (error: any) {
                console.error("Error updating history in MongoDB:", error.message || error);
        }
};

/**
 * Record new token data in MongoDB
 * Creates a new record if mint doesn't exist, otherwise updates existing record
 */
export const recordCoinData = async ({
        pubKey,
        mint,
        wallet,
        fundsWallet,
        depositeAmount,
        buyPrice,
        sellPrice,
        duration,
        date,
        predict
}: RecordTokenDataInterface): Promise<void> => {
        try {
                // Wait for mongoose connection
                const isConnected = await waitForConnection();
                if (!isConnected) {
                        console.error("MongoDB connection not ready, skipping recordCoinData");
                        return;
                }

                const time = new Date().toISOString();

                // Check if document exists before updating
                const existingRecord = await TokenRecord.findOne({ mint });

                // Use findOneAndUpdate with upsert to create or update
                await TokenRecord.findOneAndUpdate(
                        { mint },
                        {
                                $set: {
                                        pubKey,
                                        mint,
                                        wallet,
                                        fundsWallet,
                                        depositeAmount,
                                        buyPrice,
                                        sellPrice,
                                        duration,
                                        date: time,
                                        predict: buyPrice * (1 + (predict || 0)) || null
                                },
                        },
                        {
                                upsert: true,
                                new: true,
                                setDefaultsOnInsert: true,
                        }
                );

                if (!existingRecord) {
                        console.log("No matching record found. Added new data!");
                } else {
                        console.log("History updated successfully!");
                }
        } catch (error: any) {
                console.error("Error recording coin data in MongoDB:", error.message || error);
        }
};



export const logSolTransfer = (from: string, to: string, amount: number, fromBalance: number, toBalance: number, signature: string, timestamp: number): void => {
        const start = Date.now();
        // const _legerModel = new LedgerModel({
        //   from,
        //   to,
        //   amount,
        //   fromBalance,
        //   toBalance,
        //   timestamp,
        //   signature
        // })

        // _legerModel.save().then(() => {
        //   const end = Date.now();
        //   const duration = end - start;
        //   console.log(`Logged SOL transfer to LedgerModel ${duration} ms`);
        // }).catch((error) => {
        //   console.error("Error logging SOL transfer to LedgerModel:", error);
        // });

        const Duration = Date.now() - config.DATABASE_DURATION * 24 * 60 * 60 * 1000;

        const newTx = {
                signature,
                from,
                to,
                amount,
                fromBalance,
                toBalance,
                timestamp,
        };

        WalletStateModel.updateOne(
                { wallet: from },  // update 'to' wallet
                [
                        {
                                $set: {
                                        balance: fromBalance,
                                        last10Tx: {
                                                $slice: [
                                                        {
                                                                $sortArray: {
                                                                        input: {
                                                                                $concatArrays: [
                                                                                        { $ifNull: ["$last10Tx", []] },
                                                                                        [newTx],
                                                                                ],
                                                                        },
                                                                        // IMPORTANT: when timestamps tie, ordering is undefined unless we add a tie-breaker.
                                                                        // Use signature as a deterministic secondary key so last10Tx order is stable.
                                                                        sortBy: { timestamp: -1, signature: -1 },
                                                                },
                                                        },
                                                        config.DATABASE_LENGTH, // keep only last N txs if you want, optional
                                                ],
                                        },
                                },
                        },
                        {
                                $set: {
                                        last10Tx: {
                                                $filter: {
                                                        input: "$last10Tx",
                                                        as: "tx",
                                                        cond: { $gte: ["$$tx.timestamp", Duration] },
                                                },
                                        },
                                },
                        },
                ],
                { upsert: true }
        ).then(() => {
                const end = Date.now();
                const duration = end - start;
                console.log(`Logged SOL transfer to WalletStateModel ${duration} ms`);
        }).catch((error) => {
                console.error("Error logging SOL transfer to WalletStateModel:", error);
        });


        WalletStateModel.updateOne(
                { wallet: to },  // update 'to' wallet
                [
                        {
                                $set: {
                                        balance: toBalance,
                                        last10Tx: {
                                                $slice: [
                                                        {
                                                                $sortArray: {
                                                                        input: {
                                                                                $concatArrays: [
                                                                                        { $ifNull: ["$last10Tx", []] },
                                                                                        [newTx],
                                                                                ],
                                                                        },
                                                                        // IMPORTANT: when timestamps tie, ordering is undefined unless we add a tie-breaker.
                                                                        // Use signature as a deterministic secondary key so last10Tx order is stable.
                                                                        sortBy: { timestamp: -1, signature: -1 },
                                                                },
                                                        },
                                                        config.DATABASE_LENGTH, // keep only last N txs if you want, optional
                                                ],
                                        },
                                },
                        },
                        {
                                $set: {
                                        last10Tx: {
                                                $filter: {
                                                        input: "$last10Tx",
                                                        as: "tx",
                                                        cond: { $gte: ["$$tx.timestamp", Duration] },
                                                },
                                        },
                                },
                        },
                ],
                { upsert: true }
        ).then(() => {
                const end = Date.now();
                const duration = end - start;
                console.log(`Logged SOL transfer to WalletStateModel ${duration} ms`);
        }).catch((error) => {
                console.error("Error logging SOL transfer to WalletStateModel:", error);
        });

}