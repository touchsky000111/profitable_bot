import {
        Connection,
        PublicKey,
        Keypair,
        Transaction,
        TransactionInstruction,
        ComputeBudgetProgram,
        LAMPORTS_PER_SOL,
        VersionedTransaction,
        ParsedTransactionWithMeta,
        sendAndConfirmTransaction,
        AccountMeta,
        SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
        OnlinePumpSdk,
        PumpSdk,
        getBuyTokenAmountFromSolAmount,
        getSellSolAmountFromTokenAmount
} from "@pump-fun/pump-sdk";
import { getMint, TOKEN_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, transfer } from "@solana/spl-token";
import bs58 from "bs58";
import axios from "axios";

import config from "../config/index";
import * as encrypt from "./encrypt";
import { getNextRotatedShyftApiKey, createRotatedConnection } from "./api.key.rotation";
import { decrementCounter } from "./counter";
import { getGlobalPumpfun, removeBoughtToken, getFeeConfig, getBuyState, getSharedConnection, getSharedPumpSdk, getWalletKeypair } from "../master/context";
import { getLatestBlockHash, getValidBlockHeight } from "../master/context";
import { BondingCurveInput, FeeConfig, BondingCurveOutput } from "../types/types";

export const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Same key for buy AND sell fee_config on the bonding curve program
const FEE_CONFIG_KEY = Buffer.from([
        1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170,
        81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

export const NewConnection = () => {
        // Use RPC rotation to distribute load across multiple RPCs
        return createRotatedConnection('confirmed');
};

// Reused per process to avoid ~70ms setup cost per buy/sell request


export const getSolBalance = async (walletAddress: String): Promise<Number> => {
        try {
                const apiKey = getNextRotatedShyftApiKey()
                const url = `https://api.shyft.to/sol/v1/wallet/balance?network=mainnet-beta&wallet=${walletAddress}`
                const response = await axios.get(url,
                        {
                                headers: {
                                        // "x-api-key": "cDR643MgQ3qenoiX"
                                        'x-api-key': apiKey
                                }
                        }
                )
                return Number(response.data.result.balance)
        } catch (err) {
                return 0
        }
}

export const getTokenBalance = async (
        walletAddress: String,
        mintAddress: String
): Promise<Number> => {
        try {
                const apiKey = config.SHYFT_API_KEY

                const url = `https://api.shyft.to/sol/v1/wallet/token_balance?network=mainnet-beta&wallet=${walletAddress}&token=${mintAddress}`
                const response = await axios.get(url,
                        {
                                headers: {
                                        // "x-api-key": "cDR643MgQ3qenoiX"
                                        'x-api-key': apiKey
                                }
                        }
                )

                return Number(response.data.result.balance)

        } catch (err) {
                return 0
        }
}

// ----- Low-level helpers for upgraded Pump program -----

function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
        const [ata] = PublicKey.findProgramAddressSync(
                [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
                ATA_PROGRAM
        );
        return ata;
}

function deriveBondingCurve(mint: PublicKey): PublicKey {
        const [pda] = PublicKey.findProgramAddressSync(
                [Buffer.from("bonding-curve"), mint.toBuffer()],
                PUMP_FUN_PROGRAM
        );
        return pda;
}

function deriveBondingCurveV2(mint: PublicKey): PublicKey {
        const [pda] = PublicKey.findProgramAddressSync(
                [Buffer.from("bonding-curve-v2"), mint.toBuffer()],
                PUMP_FUN_PROGRAM
        );
        return pda;
}

function deriveFeeConfig(): PublicKey {
        const [pda] = PublicKey.findProgramAddressSync(
                [Buffer.from("fee_config"), FEE_CONFIG_KEY],
                FEE_PROGRAM
        );
        return pda;
}

// Detect cashback status from bonding curve account data.
// byte[82] == 1 means cashback is enabled.
const isCashbackEnabled = (bondingCurveData: Buffer): boolean => {
        return bondingCurveData.length > 82 && bondingCurveData[82] !== 0;
};

// Read the creator pubkey from bonding curve data (offset 49, 32 bytes).
function readCreator(bondingCurveData: Buffer): PublicKey {
        return new PublicKey(bondingCurveData.subarray(49, 81));
}

/**
 * Build a sell instruction.
 * Non-cashback: 15 accounts. Cashback: 16 accounts.
 */
function buildSellInstruction(
        mint: PublicKey,
        payer: PublicKey,
        tokenAmount: bigint,
        minSolOut: bigint,
        feeRecipient: PublicKey,
        creator: PublicKey,
        tokenProgram: PublicKey,
        cashbackEnabled: boolean, // from bonding curve byte[82]
): TransactionInstruction {
        const bondingCurve = deriveBondingCurve(mint);
        const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_FUN_PROGRAM);
        const [creatorVault] = PublicKey.findProgramAddressSync(
                [Buffer.from("creator-vault"), creator.toBuffer()],
                PUMP_FUN_PROGRAM
        );
        const [eventAuth] = PublicKey.findProgramAddressSync(
                [Buffer.from("__event_authority")],
                PUMP_FUN_PROGRAM
        );

        // sell discriminator: sha256("global:sell")[..8]
        const disc = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
        const data = Buffer.alloc(24);
        disc.copy(data, 0);
        data.writeBigUInt64LE(tokenAmount, 8);
        data.writeBigUInt64LE(minSolOut, 16);

        const keys: AccountMeta[] = [
                { pubkey: global, isSigner: false, isWritable: false },                       // 0
                { pubkey: feeRecipient, isSigner: false, isWritable: true },                  // 1
                { pubkey: mint, isSigner: false, isWritable: false },                         // 2
                { pubkey: bondingCurve, isSigner: false, isWritable: true },                  // 3
                { pubkey: deriveAta(bondingCurve, mint, tokenProgram), isSigner: false, isWritable: true },  // 4
                { pubkey: deriveAta(payer, mint, tokenProgram), isSigner: false, isWritable: true },         // 5
                { pubkey: payer, isSigner: true, isWritable: true },                          // 6
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },      // 7
                { pubkey: creatorVault, isSigner: false, isWritable: true },                  // 8
                { pubkey: tokenProgram, isSigner: false, isWritable: false },                 // 9
                { pubkey: eventAuth, isSigner: false, isWritable: false },                    // 10
                { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },             // 11
                { pubkey: deriveFeeConfig(), isSigner: false, isWritable: false },            // 12
                { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },                  // 13
        ];

        // Cashback tokens need user_volume_accumulator BEFORE bonding_curve_v2
        if (cashbackEnabled) {
                const [userVol] = PublicKey.findProgramAddressSync(
                        [Buffer.from("user_volume_accumulator"), payer.toBuffer()],
                        PUMP_FUN_PROGRAM
                );
                keys.push({ pubkey: userVol, isSigner: false, isWritable: true });            // 14
        }

        // bonding_curve_v2 is ALWAYS the last account
        keys.push({
                pubkey: deriveBondingCurveV2(mint),
                isSigner: false,
                isWritable: false,
        }); // 14 or 15

        return new TransactionInstruction({ programId: PUMP_FUN_PROGRAM, keys, data });
}

export const wallet = () => { 
        const privateKey = process.env.PRIVATE_KEY || ""; 
        const signerKeyPair = Keypair.fromSecretKey(bs58.decode(privateKey)); 
        return signerKeyPair
} // Add the keypair to the wallet instance return signerKeyPair; };


export const createTransaction = () => {
        const transaction = new Transaction();
        transaction.add(
                ComputeBudgetProgram.setComputeUnitLimit({
                        units: 200000
                })
        );
        return transaction;
}

export const getJupiterTransaction = async (
        tokenA: String,
        tokenB: String,
        amount: Number,
        slippageBps: Number,
        anchorWallet: any
): Promise<any> => {
        const response = await axios.get(
                `https://lite-api.jup.ag/swap/v1/quote?inputMint=${tokenA}&outputMint=${tokenB}&amount=${amount}&slippageBps=${slippageBps}`
        );

        const quoteResponse = response.data;
        const swapResponse = await axios.post(`https://lite-api.jup.ag/swap/v1/swap`, {
                quoteResponse,
                userPublicKey: anchorWallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true, // allow dynamic compute limit instead of max 1,400,000
                prioritizationFeeLamports: 200000, // or custom lamports: 1000
        });
        return swapResponse.data;
};

export const executeTransaction = async (
        connection: any,
        swapTransaction: any,
        anchorWallet: Keypair,
): Promise<{ confirm: Boolean, signature: String }> => {
        try {

                const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
                const latestBlockHash = await connection.getLatestBlockhash();
                const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

                transaction.sign([anchorWallet]);

                // Execute the transaction
                const rawTransaction = transaction.serialize();
                const txid = await connection.sendRawTransaction(rawTransaction, {
                        skipPreflight: false,
                        maxRetries: 5,
                });

                const signature = await connection.confirmTransaction({
                        blockhash: latestBlockHash.blockhash,
                        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
                        signature: txid,
                });

                return {
                        confirm: true,
                        signature: txid,
                };
        } catch (error) {
                console.log("Transaction error:", error);
                console.log("Transaction reconfirm after 10s!");
                await new Promise((resolve) => setTimeout(resolve, 10000));
                return {
                        confirm: false,
                        signature: "",
                };
        }
}

export const getDecimal = async (tokenAddress: String): Promise<Number> => {
        const connection = NewConnection();
        const mintAddress = new PublicKey(tokenAddress);
        try {
                const mintInfo = await getMint(connection, mintAddress);
                return Number(mintInfo.decimals);
        } catch (error) {
                console.error("Error fetching token decimals:", error);
                return 0; // Return 0 or handle the error as needed
        }
}


export const swapTokenWithJupiter = async (
        signer: Keypair,
        tokenA: String,
        tokenB: String,
        fixamount: number
): Promise<any> => {
        const anchorWallet = signer;
        const connection = NewConnection();
        const decimal = 9;
        let slippageBps = 50;
        const amount = Math.floor(fixamount * Math.pow(10, Number(decimal)));
        let success: Boolean = false;
        console.log(`Swapping ${amount} of ${tokenA} for ${tokenB}...`);
        // Get Route for swap
        try {
                let confirm: Boolean = false;
                let txid;
                const { swapTransaction } = await getJupiterTransaction(
                        tokenA,
                        tokenB,
                        amount,
                        slippageBps,
                        anchorWallet
                );
                // deserialize the transaction
                const result = await executeTransaction(
                        connection,
                        swapTransaction,
                        anchorWallet
                );
                // console.log("result", result);
                console.log("🔴 Sold Transaction Confirming .......... ")
                confirm = result.confirm;
                txid = result.signature;
                success == true;
                console.log(`🔴 Sold Transaction https://solscan.io/tx/${txid}`);
                return true

        } catch (error) {
                console.log("error", error);
                console.log("Retry");
                return false
        }
}




export const checkSwapAmounts = async (
        txSignature: string,
        token: string,
): Promise<any> => {
        try {
                const connection = getSharedConnection();
                const tx = await connection.getParsedTransaction(txSignature, { maxSupportedTransactionVersion: 0 });
                if (!tx || !tx.meta) {
                        console.log("Transaction not found or not parsed.");
                        return;
                }

                const preTokenBalances = tx.meta.preTokenBalances || [];
                const postTokenBalances = tx.meta.postTokenBalances || [];
                const preBalances = tx.meta.preBalances
                const postBalances = tx.meta.postBalances
                let token_Value = 0
                for (let i = 0; i < preTokenBalances.length; i++) {
                        for (let j = 0; j < postTokenBalances.length; j++) {
                                const pre = preTokenBalances[i];
                                const post = postTokenBalances[j];

                                if (pre.accountIndex === post.accountIndex) {
                                        const preAmount = pre.uiTokenAmount?.uiAmount ?? 0; // default to 0 if null
                                        const postAmount = post.uiTokenAmount?.uiAmount ?? 0;

                                        const mint = pre.mint;
                                        const value = preAmount - postAmount;

                                        token_Value = Math.abs(value);
                                }
                        }
                }

                const changes = [];

                for (let i = 0; i < preBalances.length; i++) {
                        const diff = BigInt(postBalances[i]) - BigInt(preBalances[i]);

                        if (diff !== 0n) {
                                changes.push(diff);
                        }
                }


                const solBalanceChange = changes.reduce(
                        (max, val) => (val > max ? val : max),
                        0n
                );

                let tokenPrice = 0
                tokenPrice = Number(solBalanceChange) / (token_Value * Math.pow(10, 9))
                console.log("token_Value", token_Value)

                return {
                        tokenPrice: tokenPrice,
                        tokenBalanceChange: token_Value,
                        solBalanceChange: Number(solBalanceChange),
                }

        } catch (err) {
                console.log(">>Error: checkSwapAmounts >> ", err);
        }
        // For most swaps, index 0 is the sender, 1 is the receiver.
}


export const checkSwapAmountsWithShyftApi = async (
        txSignature: string,
        walletAddress: string,
        token: string,
): Promise<any> => {
        const SOL_MINT = "So11111111111111111111111111111111111111112"

        try {

                // ===== Fetch Transaction =====
                const url = `https://api.shyft.to/sol/v1/transaction/parsed?network=mainnet-beta&txn_signature=${txSignature}&commitment=confirmed`

                const response = await axios.get(url, {
                        headers: { "x-api-key": config.SHYFT_API_KEY }
                })

                const actions = response.data.result.actions || []

                let tokenDelta = 0
                let solDelta = 0
                let swapFound = false

                // ===== Try SWAPS =====
                for (const action of actions) {

                        if (!action.info?.swaps) continue

                        swapFound = true

                        for (const swap of action.info.swaps) {

                                if (swap.in.token_address === token)
                                        tokenDelta -= swap.in.amount

                                if (swap.out.token_address === token)
                                        tokenDelta += swap.out.amount

                                if (swap.in.token_address === SOL_MINT)
                                        solDelta -= swap.in.amount

                                if (swap.out.token_address === SOL_MINT)
                                        solDelta += swap.out.amount
                        }
                }

                // ===== Fallback to TRANSFERS =====
                if (!swapFound) {

                        for (const action of actions) {

                                if (action.type === "TOKEN_TRANSFER") {

                                        const info = action.info
                                        if (info.token_address !== token) continue

                                        if (info.receiver === walletAddress)
                                                tokenDelta += info.amount

                                        if (info.sender === walletAddress)
                                                tokenDelta -= info.amount
                                }

                                if (action.type === "SOL_TRANSFER") {

                                        const info = action.info

                                        if (info.receiver === walletAddress)
                                                solDelta += info.amount

                                        if (info.sender === walletAddress)
                                                solDelta -= info.amount
                                }
                        }
                }

                const tokenPrice =
                        tokenDelta !== 0 ? Math.abs(solDelta / tokenDelta) : 0

                return {
                        tokenBalanceChange: tokenDelta > 0 ? tokenDelta : -tokenDelta,
                        solBalanceChange: solDelta > 0 ? solDelta : -solDelta,
                        tokenPrice
                }

        } catch (err: any) {

                console.error("Parse error:", err?.response?.data || err.message)

                return {
                        tokenBalanceChange: 0,
                        solBalanceChange: 0,
                        tokenPrice: 0
                }
        }
        // For most swaps, index 0 is the sender, 1 is the receiver.
}


export const buyToken = async (
        {
                mint,
                solAmount
        }: {
                mint: string,
                solAmount: Number
        }): Promise<any> => {
        try {
                const signerKeyPair = wallet();
                const pubKey = signerKeyPair.publicKey.toString();

                // Use RPC rotation instead of fixed endpoint
                const web3Connection = getSharedConnection();

                const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
                        method: "POST",
                        headers: {
                                "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                                "publicKey": pubKey,  // Your wallet public key
                                "action": "buy",                 // "buy" or "sell"
                                "mint": mint,         // contract address of the token you want to trade
                                "denominatedInSol": "true",     // "true" if amount is amount of SOL, "false" if amount is number of tokens
                                "amount": solAmount,                  // amount of SOL or tokens
                                "slippage": config.slippage,                   // percent slippage allowed
                                "priorityFee": 0.00001,          // priority fee
                                "pool": "pump"                   // exchange to trade on. "pump" or "raydium"
                        })
                });

                if (response.status === 200) { // successfully generated transaction
                        const data = await response.arrayBuffer();
                        const tx = VersionedTransaction.deserialize(new Uint8Array(data));
                        tx.sign([signerKeyPair]);
                        const signature = await web3Connection.sendTransaction(tx)

                        // try {
                        //         await web3Connection.confirmTransaction(signature);
                        //         confirmed = true;
                        // } catch (confirmErr: any) {
                        //         const isTimeout = confirmErr?.name === 'TransactionExpiredTimeoutError' ||
                        //                 confirmErr?.message?.includes('not confirmed') ||
                        //                 confirmErr?.message?.includes('30.00 seconds');
                        //         if (isTimeout) {
                        //                 const statuses = await web3Connection.getSignatureStatuses([signature]);
                        //                 const status = statuses?.value?.[0];
                        //                 if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
                        //                         confirmed = true;
                        //                 }
                        //         }
                        //         if (!confirmed) {
                        //                 console.log(">> buyToken: confirmation failed or timeout; check signature:", signature);
                        //                 return 0;
                        //         }
                        // }


                        console.log("✅ Buy Transaction: https://solscan.io/tx/" + signature);
                        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
                        // Fetch parsed transaction to read logs
                        // const tokenPriceWithShyftApi = await checkSwapAmountsWithShyftApi(signature, pubKey, mint)
                        // console.log("tokenPriceWithShyftApi", tokenPriceWithShyftApi)
                        let tokenPrice;
                        let retryCount = 0;
                        const maxRetries = 5;
                        while (retryCount <= maxRetries) {
                                try {
                                        tokenPrice = await checkSwapAmounts(signature, mint);
                                        if (tokenPrice && tokenPrice.tokenPrice !== undefined) {
                                                break; // Success, exit retry loop
                                        }
                                        // If tokenPrice is undefined, treat as error and retry
                                        retryCount++;
                                        if (retryCount > maxRetries) {
                                                throw new Error("checkSwapAmounts returned undefined after all retries");
                                        }
                                        console.log(`>> checkSwapAmounts returned undefined (attempt ${retryCount}/${maxRetries}), retrying after 5 seconds...`);
                                        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
                                } catch (error) {
                                        retryCount++;
                                        if (retryCount > maxRetries) {
                                                throw error; // Re-throw if max retries exceeded
                                        }
                                        console.log(`>> Error in checkSwapAmounts (attempt ${retryCount}/${maxRetries}), retrying after 5 seconds...`, error);
                                        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
                                }
                        }

                        if (!tokenPrice || tokenPrice.tokenPrice === undefined) {
                                throw new Error("Failed to get token price after all retries");
                        }

                        const tokenBalance = await getTokenBalance(pubKey, mint)
                        return {
                                tokenPrice: tokenPrice.tokenPrice,
                                tokenBalanceChange: tokenBalance,
                                solBalanceChange: tokenPrice.solBalanceChange
                        }
                } else {

                        if (response.statusText.includes("TooMuchSolRequired")) {
                                console.log("❌ Sol balance is not enough.");
                        } else {
                                console.log(response.statusText);
                        }

                        return {
                                tokenPrice: 0,
                                tokenBalanceChange: 0,
                                solBalanceChange: 0
                        }
                }
        } catch (error: any) {
                console.log(">> ERROR: buyToken >> ");
                if (error.toString().includes("TooMuchSolRequired")) {
                        console.log("❌ Sol balance or slippage is not enough.");
                } else {
                        console.log("⚠️ Unexpected error:", error.message || error);
                }
                return 0
        }
}

export function numberToBN(amount: number, decimals: number = 10): any {
        // Convert number to fixed string with enough precision
        const amountStr = amount.toFixed(decimals);

        const [whole, fraction = ""] = amountStr.split(".");
        const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
        const combined = whole + paddedFraction;
        return new BN(combined);
}

export function getTotalFeeBps(feeConfig: FeeConfig): number {
        const { lpFeeBps, protocolFeeBps, creatorFeeBps } = feeConfig.flatFees;
        return lpFeeBps.add(protocolFeeBps).add(creatorFeeBps).toNumber();
}

export function getExpectedTokenAmount({
        virtualTokenReserves,
        virtualSolReserves,
        solAmount,
        totalFeeBps
}: BondingCurveInput): BN {
        const BPS_DENOM = new BN(10_000);

        // Convert SOL number to lamports
        const solAmountLamports = new BN(Math.floor(solAmount * 1e9));

        // Apply fee
        const feeBpsBN = new BN(totalFeeBps);
        const solAfterFee = solAmountLamports.mul(BPS_DENOM.sub(feeBpsBN)).div(BPS_DENOM);

        if (solAfterFee.isZero()) return new BN(0);

        // k = x * y
        const k = virtualSolReserves.mul(virtualTokenReserves);

        // newSolReserve = x + Δx
        const newSolReserve = virtualSolReserves.add(solAfterFee);

        // newTokenReserve = k / newSolReserve
        const newTokenReserve = k.div(newSolReserve);

        // tokensOut = y - newY
        return virtualTokenReserves.sub(newTokenReserve);
}


export function getExpectedSolAmount({
        virtualTokenReserves,
        virtualSolReserves,
        tokenAmount, // e.g., 174830.42375
        totalFeeBps
}: BondingCurveOutput): BN {
        const BPS_DENOM = new BN(10_000);

        // Convert tokenAmount to smallest units (e.g., 6 decimals for token)
        const DECIMALS = 6;
        const tokenAmountParts = tokenAmount.toString().split(".");
        const integerPart = tokenAmountParts[0];
        const decimalPart = tokenAmountParts[1] || "0";

        // Build BN safely
        const tokenAmountBN = new BN(integerPart).mul(new BN(10).pow(new BN(DECIMALS)))
                .add(new BN(decimalPart.padEnd(DECIMALS, "0").slice(0, DECIMALS)));

        console.log("Token Amount (raw):", tokenAmount);
        console.log("Token Amount (BN, smallest units):", tokenAmountBN.toString());

        // === Example: simple proportional swap calculation ===
        // Expected SOL = (tokenAmountBN * virtualSolReserves) / virtualTokenReserves
        const expectedSol = tokenAmountBN
                .mul(new BN(virtualSolReserves))
                .div(new BN(virtualTokenReserves));

        // Apply fee if needed
        const feeBN = expectedSol.mul(new BN(totalFeeBps)).div(BPS_DENOM);
        const expectedSolAfterFee = expectedSol.sub(feeBN);

        return expectedSolAfterFee; // BN in lamports
}


export const buyFromBondingCurve = async ({
        mint,
        solAmount,
        decimals,
        tokenProgramId
}: {
        mint: string,
        solAmount: number,
        decimals?: number,
        tokenProgramId?: string
}): Promise<any> => {
        const startTime = Date.now();
        const web3Connection = getSharedConnection();
        const signerKeyPair = getWalletKeypair();
        const pumpSdk = getSharedPumpSdk();
        try {
                const middleTime = Date.now()
                const bondingCurveAddress = getBondingCurveAddress(mint)
                let buyState = getBuyState(bondingCurveAddress);

                const onlinePumpSdk = new OnlinePumpSdk(web3Connection)
                let onLinebuyState = await onlinePumpSdk.fetchBuyState(new PublicKey(mint), signerKeyPair.publicKey)
                console.log("Offline BUYSTATE: ", buyState)
                console.log("Online BUYSTATE: ", onLinebuyState)

                const global = getGlobalPumpfun();
                const feeConfig = getFeeConfig();
                const { bondingCurve, bondingCurveAccountInfo } = buyState;

                if (bondingCurve.complete) {
                        throw new Error("Bonding curve is complete. Token has graduated to Raydium. Use pump-swap-sdk instead.");
                }

                const solAmountLamports = new BN(solAmount)
                        .mul(new BN(1_000_000_000));

                const totalFeeBps = getTotalFeeBps(feeConfig); // 125
                const tokenAmount = getExpectedTokenAmount(
                        {
                                virtualTokenReserves: bondingCurve.virtualTokenReserves,
                                virtualSolReserves: bondingCurve.virtualSolReserves,
                                solAmount: solAmount,
                                totalFeeBps: totalFeeBps
                        }
                );


                // Minimum tokens out with 1% slippage
                const slippageMultiplier = new BN(Math.floor((100 - config.slippage))); // Use 10000 for precision (1% = 9900)
                const minTokensOut = tokenAmount.mul(slippageMultiplier).div(new BN(100));
                const middle_2 = Date.now();
                const buyInstructions = await pumpSdk.buyInstructions({
                        global,
                        bondingCurveAccountInfo,
                        bondingCurve: {
                                ...bondingCurve,
                                creator: buyState.creator
                        },
                        associatedUserAccountInfo: null,
                        mint: new PublicKey(mint),
                        user: signerKeyPair.publicKey,
                        amount: minTokensOut, // minimum tokens we expect
                        solAmount: solAmountLamports,
                        slippage: config.slippage,
                        tokenProgram: tokenProgramId ? new PublicKey(tokenProgramId) : TOKEN_PROGRAM_ID, // handle both SPL v1 and v2 tokens
                })


                const transaction = new Transaction();
                transaction.add(ComputeBudgetProgram.setComputeUnitLimit({
                        units: 300000
                }))

                transaction.add(ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: 150000
                }))

                const [bondingCurveV2] = PublicKey.findProgramAddressSync(
                        [
                                Buffer.from("bonding-curve-v2"),
                                (new PublicKey(mint)).toBuffer()
                        ],
                        PUMP_FUN_PROGRAM
                );

                buyInstructions.forEach(ix => {
                        if (ix.programId.equals(PUMP_FUN_PROGRAM)) {
                                ix.keys.push({
                                        pubkey: bondingCurveV2,
                                        isSigner: false,
                                        isWritable: false
                                });
                        }
                        transaction.add(ix);
                });

                transaction.recentBlockhash = getLatestBlockHash();
                transaction.lastValidBlockHeight = Number(getValidBlockHeight());
                transaction.feePayer = signerKeyPair.publicKey;

                // Sign transaction
                transaction.sign(signerKeyPair);

                const endTime = Date.now();
                const duration = endTime - startTime;
                console.log(`>> Total buyFromBondingCurve duration: ${duration}ms`);
                console.log(`>> Time to fetch state and calculate amounts: ${middleTime - startTime}ms`);
                console.log(`>> Time to simulate instructions: ${middle_2 - middleTime}ms`);
                console.log(`>> Time to build instruction ${endTime - middle_2}ms`);
                console.log(`>> Sending transaction... ${solAmount * config.slippage}`)

                let signature: string;
                try {
                        signature = "test_signaturee"
                        // signature = await sendAndConfirmTransaction(
                        //         web3Connection,
                        //         transaction,
                        //         [signerKeyPair],
                        //         { commitment: "confirmed" }
                        // );
                        // signature = await web3Connection.sendRawTransaction(
                        //         transaction.serialize(),
                        //         {
                        //                 skipPreflight: true,
                        //                 maxRetries: 0
                        //         }
                        // )
                } catch (err: any) {
                        // Tx can be confirmed on-chain while client throws "block height exceeded". Verify before failing.
                        const sig = err?.signature ?? (err?.message?.match(/Signature\s+(\S+)\s+has\s+expired/)?.[1]);
                        if (sig && /block height exceeded|BlockheightExceeded/i.test(String(err?.message ?? ""))) {
                                const statuses = await web3Connection.getSignatureStatuses([sig]);
                                const status = statuses?.value?.[0];
                                if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
                                        signature = sig;
                                        console.log("✅ Buy tx confirmed on-chain despite blockheight-exceeded: https://solscan.io/tx/" + signature);
                                } else {
                                        throw err;
                                }
                        } else {
                                throw err;
                        }
                }
                // return signature;

                let tokenPrice;
                let retryCount = 0;
                const maxRetries = 5;
                while (retryCount <= maxRetries) {
                        try {
                                tokenPrice = await checkSwapAmounts(signature, mint);
                                if (tokenPrice && tokenPrice.tokenPrice !== undefined) {
                                        break; // Success, exit retry loop
                                }
                                // If tokenPrice is undefined, treat as error and retry
                                retryCount++;
                                if (retryCount > maxRetries) {
                                        throw new Error("checkSwapAmounts returned undefined after all retries");
                                }
                                console.log(`>> checkSwapAmounts returned undefined (attempt ${retryCount}/${maxRetries}), retrying after 5 seconds...`);
                                await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
                        } catch (error) {
                                retryCount++;
                                if (retryCount > maxRetries) {
                                        throw error; // Re-throw if max retries exceeded
                                }
                                console.log(`>> Error in checkSwapAmounts (attempt ${retryCount}/${maxRetries}), retrying after 5 seconds...`, error);
                                await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
                        }
                }

                if (!tokenPrice || tokenPrice.tokenPrice === undefined) {
                        throw new Error("Failed to get token price after all retries");
                }

                const tokenBalance = await getTokenBalance(signerKeyPair.publicKey.toString(), mint)
                return {
                        tokenPrice: tokenPrice.tokenPrice,
                        tokenBalanceChange: tokenBalance,
                        solBalanceChange: tokenPrice.solBalanceChange
                }

        } catch (error: any) {

                console.error("Error buying from bonding curve:", error);
                // const middleTime = Date.now()
                // const onlinePumpSdk = new OnlinePumpSdk(web3Connection)
                // // let buyState = getBuyState(bondingCurveAddress);
                // let buyState = await onlinePumpSdk.fetchBuyState(new PublicKey(mint), signerKeyPair.publicKey)
                // // console.log("Offline BUYSTATE: ", buyState)
                // // console.log("Online BUYSTATE: ", onLinebuyState)
                // const global = getGlobalPumpfun();
                // const feeConfig = getFeeConfig();
                // const { bondingCurve, bondingCurveAccountInfo } = buyState;

                // if (bondingCurve.complete) {
                //         throw new Error("Bonding curve is complete. Token has graduated to Raydium. Use pump-swap-sdk instead.");
                // }

                // const solAmountLamports = new BN(solAmount * 1e9);

                // const totalFeeBps = getTotalFeeBps(feeConfig); // 125
                // const tokenAmount = getExpectedTokenAmount(
                //         {
                //                 virtualTokenReserves: bondingCurve.virtualTokenReserves,
                //                 virtualSolReserves: bondingCurve.virtualSolReserves,
                //                 solAmount: solAmount,
                //                 totalFeeBps: totalFeeBps
                //         }
                // );


                // // Minimum tokens out with 1% slippage
                // const slippageMultiplier = new BN(Math.floor((100 - config.slippage))); // Use 10000 for precision (1% = 9900)
                // const minTokensOut = tokenAmount.mul(slippageMultiplier).div(new BN(100));
                // const middle_2 = Date.now();
                // const buyInstructions = await pumpSdk.buyInstructions({
                //         global,
                //         bondingCurveAccountInfo,
                //         bondingCurve,
                //         associatedUserAccountInfo: null,
                //         mint: new PublicKey(mint),
                //         user: signerKeyPair.publicKey,
                //         amount: minTokensOut, // minimum tokens we expect
                //         solAmount: solAmountLamports,
                //         slippage: config.slippage,
                //         tokenProgram: tokenProgramId ? new PublicKey(tokenProgramId) : TOKEN_PROGRAM_ID, // handle both SPL v1 and v2 tokens
                // })


                // const transaction = new Transaction();

                // buyInstructions.forEach(instruction => transaction.add(instruction));

                // transaction.recentBlockhash = getLatestBlockHash();
                // transaction.lastValidBlockHeight = Number(getValidBlockHeight());
                // transaction.feePayer = signerKeyPair.publicKey;

                // // Sign transaction
                // transaction.sign(signerKeyPair);

                // const endTime = Date.now();
                // const duration = endTime - startTime;
                // console.log(`>> Total buyFromBondingCurve duration: ${duration}ms`);
                // console.log(`>> Time to fetch state and calculate amounts: ${middleTime - startTime}ms`);
                // console.log(`>> Time to simulate instructions: ${middle_2 - middleTime}ms`);
                // console.log(`>> Time to build instruction ${endTime - middle_2}ms`);
                // console.log(`>> Sending transaction... ${solAmount * config.slippage}`)

                // let signature: string;
                // try {
                //         // signature = "test_signaturee"
                //         signature = await sendAndConfirmTransaction(
                //                 web3Connection,
                //                 transaction,
                //                 [signerKeyPair],
                //                 { commitment: "confirmed" }
                //         );
                // } catch (err: any) {
                //         // Tx can be confirmed on-chain while client throws "block height exceeded". Verify before failing.
                //         const sig = err?.signature ?? (err?.message?.match(/Signature\s+(\S+)\s+has\s+expired/)?.[1]);
                //         if (sig && /block height exceeded|BlockheightExceeded/i.test(String(err?.message ?? ""))) {
                //                 const statuses = await web3Connection.getSignatureStatuses([sig]);
                //                 const status = statuses?.value?.[0];
                //                 if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
                //                         signature = sig;
                //                         console.log("✅ Buy tx confirmed on-chain despite blockheight-exceeded: https://solscan.io/tx/" + signature);
                //                 } else {
                //                         throw err;
                //                 }
                //         } else {
                //                 throw err;
                //         }
                // }
                // // return signature;

                // let tokenPrice;
                // let retryCount = 0;
                // const maxRetries = 5;
                // while (retryCount <= maxRetries) {
                //         try {
                //                 tokenPrice = await checkSwapAmounts(signature, mint);
                //                 if (tokenPrice && tokenPrice.tokenPrice !== undefined) {
                //                         break; // Success, exit retry loop
                //                 }
                //                 // If tokenPrice is undefined, treat as error and retry
                //                 retryCount++;
                //                 if (retryCount > maxRetries) {
                //                         throw new Error("checkSwapAmounts returned undefined after all retries");
                //                 }
                //                 console.log(`>> checkSwapAmounts returned undefined (attempt ${retryCount}/${maxRetries}), retrying after 5 seconds...`);
                //                 await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
                //         } catch (error) {
                //                 retryCount++;
                //                 if (retryCount > maxRetries) {
                //                         throw error; // Re-throw if max retries exceeded
                //                 }
                //                 console.log(`>> Error in checkSwapAmounts (attempt ${retryCount}/${maxRetries}), retrying after 5 seconds...`, error);
                //                 await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
                //         }
                // }

                // if (!tokenPrice || tokenPrice.tokenPrice === undefined) {
                //         throw new Error("Failed to get token price after all retries");
                // }

                // const tokenBalance = await getTokenBalance(signerKeyPair.publicKey.toString(), mint)
                // return {
                //         tokenPrice: tokenPrice.tokenPrice,
                //         tokenBalanceChange: tokenBalance,
                //         solBalanceChange: tokenPrice.solBalanceChange
                // }
        }
}

export const sellFromBondingCurve = async ({ mint, rate, amount, decimals, tokenProgramId }: { mint: string, rate: number, amount: number, decimals: number, tokenProgramId: String }) => {
        const startTime = Date.now();
        const web3Connection = getSharedConnection();
        const pumpSdk = getSharedPumpSdk();
        const signerKeyPair = getWalletKeypair();
        const userPubkey = signerKeyPair.publicKey;

        try {
                const middleTime = Date.now()
                const global = getGlobalPumpfun();
                const feeConfig = getFeeConfig();

                // 2️⃣ Fetch bonding curve state
                // const sellState = await onlinePumpSdk.fetchBuyState(new PublicKey(mint), userPubkey);
                const bondingCurveAddress = getBondingCurveAddress(mint)
                let sellState = getBuyState(bondingCurveAddress);
                const {
                        bondingCurve,
                        bondingCurveAccountInfo,
                } = sellState;


                // if (sellState.bondingCurve == null || sellState.bondingCurve == undefined || sellState.bondingCurveAccountInfo == null || sellState.bondingCurveAccountInfo == undefined) {
                //         console.log("fetching PUMP BUY STATE")
                //         sellState = await onlinePumpSdk.fetchBuyState(new PublicKey(mint), signerKeyPair.publicKey)
                // }
                const isCashback = !!bondingCurve.cashbackConfig;

                const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
                        [
                                Buffer.from("user-volume-accumulator"),
                                userPubkey.toBuffer(),
                                new PublicKey(mint).toBuffer(),
                        ],
                        PUMP_FUN_PROGRAM
                );


                // Convert UI amount -> raw amount ONCE
                const tokenAmountBN = new BN(amount)
                        .mul(new BN(rate))
                        .mul(new BN(10).pow(new BN(decimals)));


                if (bondingCurve.complete) {
                        throw new Error("Token graduated to Raydium. Cannot sell via curve.");
                }

                // 3️⃣ Calculate expected SOL out
                // const expectedSolOut = getExpectedSolAmount({
                //         virtualTokenReserves: bondingCurve.virtualTokenReserves,
                //         virtualSolReserves: bondingCurve.virtualSolReserves,
                //         tokenAmount: Number(amount * rate),
                //         totalFeeBps: getTotalFeeBps(feeConfig)
                // })

                const expectedSolOut = getSellSolAmountFromTokenAmount({
                        global,
                        feeConfig,
                        mintSupply: bondingCurve.tokenTotalSupply,
                        bondingCurve: {
                                ...bondingCurve,
                                creator: sellState.creator
                        },
                        amount: tokenAmountBN
                });

                const middle_2 = Date.now()

                const slippageMultiplier = new BN(Math.floor((100 - config.slippage)));
                const minSolOut = expectedSolOut.mul(slippageMultiplier).div(new BN(100));
                // 5️⃣ Build SELL instructions
                const sellInstructions = await pumpSdk.sellInstructions({
                        global,
                        bondingCurveAccountInfo: {
                                ...bondingCurveAccountInfo,
                                data: Buffer.from(bondingCurveAccountInfo.data),
                        },
                        bondingCurve: {
                                ...bondingCurve,
                                creator: sellState.creator
                        },
                        mint: new PublicKey(mint),
                        user: userPubkey,
                        amount: tokenAmountBN,
                        solAmount: minSolOut,
                        slippage: config.slippage, // 5%
                        tokenProgram: new PublicKey(tokenProgramId), // handle both SPL v1 and v2 tokens
                        mayhemMode: bondingCurve.isMayhemMode,
                })

                // 6️⃣ Build transaction
                const tx = new Transaction();

                tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                        units: 300000
                }))

                tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: 150000
                }))

                const [bondingCurveV2] = PublicKey.findProgramAddressSync(
                        [
                                Buffer.from("bonding-curve-v2"),
                                (new PublicKey(mint)).toBuffer()
                        ],
                        PUMP_FUN_PROGRAM
                );

                sellInstructions.forEach(ix => {
                        if (ix.programId.equals(PUMP_FUN_PROGRAM)) {

                                if (isCashback) {
                                        ix.keys.push({
                                                pubkey: userVolumeAccumulator,
                                                isSigner: false,
                                                isWritable: true,   // MUST be writable
                                        });
                                }
                                ix.keys.push({
                                        pubkey: bondingCurveV2,
                                        isSigner: false,
                                        isWritable: false
                                })
                        }
                        tx.add(ix)
                });

                tx.recentBlockhash = String(getLatestBlockHash());
                tx.lastValidBlockHeight = Number(getValidBlockHeight());
                tx.feePayer = userPubkey;

                tx.sign(signerKeyPair);

                const endTime = Date.now();
                const duration = endTime - startTime;
                console.log(`>> Total Sell FromBondingCurve duration: ${duration}ms`);
                console.log(`>> Time to fetch state and calculate amounts: ${middleTime - startTime}ms`);
                console.log(`>> Time to simulate instructions: ${middle_2 - middleTime}ms`);
                console.log(`>> Time to build instruction ${endTime - middle_2}ms`);
                let signature: string;
                try {
                        // signature = await sendAndConfirmTransaction(
                        //         web3Connection,
                        //         tx,
                        //         [signerKeyPair],
                        //         { commitment: "confirmed" }
                        // );
                        signature = await web3Connection.sendRawTransaction(
                                tx.serialize(),
                                {
                                        skipPreflight: true,
                                        maxRetries: 0
                                }
                        )
                } catch (err: any) {
                        // What: TransactionExpiredBlockheightExceededError = "block height exceeded".
                        // Why: sendAndConfirmTransaction stops waiting once lastValidBlockHeight is passed;
                        // the tx can still be included in a block before that and show as confirmed on Solscan.
                        // So we re-check on-chain and, if confirmed, treat as success.
                        const sig = err?.signature ?? (err?.message?.match(/Signature\s+(\S+)\s+has\s+expired/)?.[1]);
                        if (sig && (err?.name === "TransactionExpiredBlockheightExceededError" || /block height exceeded|BlockheightExceeded/i.test(String(err?.message)))) {
                                const statuses = await web3Connection.getSignatureStatuses([sig]);
                                const status = statuses?.value?.[0];
                                if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
                                        signature = sig;
                                        console.log("🔴 Tx confirmed on-chain despite blockheight-exceeded from waiter: https://solscan.io/tx/" + signature);
                                } else {
                                        throw err;
                                }
                        } else {
                                throw err;
                        }
                }

                console.log("🔴 Sold Transaction: https://solscan.io/tx/" + signature);

                // const tokenPriceWithShyftApi = await checkSwapAmountsWithShyftApi(signature, pubKey, mint as string)
                // console.log("tokenPriceWithShyftApi", tokenPriceWithShyftApi)

                let sellStatus;
                let retryCount = 0;
                const maxRetries = 5;
                while (retryCount <= maxRetries) {
                        try {
                                sellStatus = await checkSwapAmounts(signature, mint as string);
                                if (sellStatus && sellStatus.tokenPrice !== undefined) {
                                        break; // Success, exit retry loop
                                }
                                // If sellStatus is undefined, treat as error and retry
                                retryCount++;
                                if (retryCount > maxRetries) {
                                        throw new Error("checkSwapAmounts returned undefined after all retries");
                                }
                                console.log(`>> checkSwapAmounts returned undefined (attempt ${retryCount}/${maxRetries}), retrying after 5 seconds...`);
                                await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
                        } catch (error) {
                                retryCount++;
                                if (retryCount > maxRetries) {
                                        throw error; // Re-throw if max retries exceeded
                                }
                                console.log(`>> Error in checkSwapAmounts (attempt ${retryCount}/${maxRetries}), retrying after 5 seconds...`, error);
                                await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
                        }
                }

                if (!sellStatus || sellStatus.tokenPrice === undefined) {
                        throw new Error("Failed to get sell status after all retries");
                }

                const sellPrice = sellStatus.tokenPrice
                console.log("sellPrice => ", sellPrice);

                decrementCounter();
                removeBoughtToken(mint as string)
                await closeTokenAccount(mint as string)
                return true; // success, exit the retry loop

        } catch (err: any) {
                console.error("SELL ERROR:", err);
                decrementCounter();
                removeBoughtToken(mint as string)
                sellToken({ mint, rate, amount })
                return false;
        }
}


export const sellFromBondingCurveWithSigner = async ({
        mint,
        signer,
}: {
        mint: string;
        signer: Keypair;
}) => {
        const connection = createRotatedConnection("confirmed");
        const onlinePumpSdk = new OnlinePumpSdk(connection);
        const userPubkey = signer.publicKey;

        try {
                // 1️⃣ Fetch balances + mint info
                const [uiBalanceRaw, mintAccountInfo] = await Promise.all([
                        getTokenBalance(userPubkey.toString(), mint),
                        connection.getAccountInfo(new PublicKey(mint)),
                ]);

                const [global, feeConfig, sellState, mintInfo] = await Promise.all([
                        onlinePumpSdk.fetchGlobal(),
                        onlinePumpSdk.fetchFeeConfig(),
                        onlinePumpSdk.fetchBuyState(new PublicKey(mint), userPubkey),
                        getMint(
                                connection,
                                new PublicKey(mint),
                                undefined,
                                mintAccountInfo?.owner || TOKEN_PROGRAM_ID
                        ),
                ]);

                const decimals = mintInfo.decimals;

                // 2️⃣ Safe UI → BN conversion (no floats)
                const [whole, frac = ""] = uiBalanceRaw.toString().split(".");
                const paddedFrac = (frac + "0".repeat(decimals)).slice(0, decimals);
                const tokenAmountBN = new BN(whole + paddedFrac);

                if (tokenAmountBN.isZero()) {
                        throw new Error("No token balance to sell");
                }

                const { bondingCurve, bondingCurveAccountInfo } = sellState;

                if (bondingCurve.complete) {
                        throw new Error("Token graduated. Cannot sell via curve.");
                }

                console.log("BondingCurve => ", bondingCurve);

                // 3️⃣ Compute expected SOL out and minSolOut with slippage
                const expectedSolOut = getSellSolAmountFromTokenAmount({
                        global,
                        feeConfig,
                        mintSupply: bondingCurve.tokenTotalSupply,
                        bondingCurve,
                        amount: tokenAmountBN,
                });

                const slippageMultiplier = new BN(Math.floor(100 - config.slippage));
                const minSolOutBN = expectedSolOut.mul(slippageMultiplier).div(new BN(100));

                // Detect cashback from raw bonding curve account data (byte[82])
                const bondingCurveData = Buffer.from(bondingCurveAccountInfo.data);
                const cashbackEnabled = isCashbackEnabled(bondingCurveData);

                // Read creator from bonding curve data
                const creator = readCreator(bondingCurveData);

                // Resolve protocol fee recipient from global account
                const rawFeeRecipient =
                        (global as any).feeRecipient ??
                        (global as any).fee_recipient ??
                        (global as any).protocolFeeRecipient ??
                        (global as any).protocol_fee_recipient;

                if (!rawFeeRecipient) {
                        throw new Error("Pumpfun global account missing fee recipient field");
                }

                const feeRecipientPk =
                        rawFeeRecipient instanceof PublicKey
                                ? rawFeeRecipient
                                : new PublicKey(rawFeeRecipient);

                // Detect token program (Token-2022 vs SPL Token)
                const tokenProgram = mintAccountInfo?.owner || TOKEN_PROGRAM_ID;

                // 4️⃣ Build low-level sell instruction (no PumpSdk.sellInstructions)
                const sellIx = buildSellInstruction(
                        new PublicKey(mint),
                        userPubkey,
                        BigInt(tokenAmountBN.toString()),
                        BigInt(minSolOutBN.toString()),
                        feeRecipientPk,
                        creator,
                        tokenProgram,
                        cashbackEnabled
                );

                // 5️⃣ Build and send transaction
                const { blockhash, lastValidBlockHeight } =
                        await connection.getLatestBlockhash();

                const tx = new Transaction();
                tx.add(sellIx);

                tx.recentBlockhash = blockhash;
                tx.lastValidBlockHeight = lastValidBlockHeight;
                tx.feePayer = userPubkey;

                tx.sign(signer);

                const signature = await sendAndConfirmTransaction(
                        connection,
                        tx,
                        [signer],
                        { commitment: "confirmed" }
                );

                console.log(
                        "🔴 Sold Transaction: https://solscan.io/tx/" + signature
                );

                return true;
        } catch (err) {
                console.error("SELL ERROR:", err);
                return false;
        }
};





export const sellToken = async (
        { mint, rate, amount }: { mint: String, rate: number, amount: number }
): Promise<boolean> => {

        const signerKeyPair = wallet()
        const pubKey = signerKeyPair.publicKey.toString();
        // Use RPC rotation instead of fixed endpoint
        const web3Connection = getSharedConnection();
        console.log(">> Sold with pumpportal")
        try {
                const tokenAmount = amount * rate;

                if (tokenAmount === 0) {
                        return false
                }

                const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                                publicKey: pubKey,
                                action: "sell",
                                mint,
                                denominatedInSol: "false",
                                amount: tokenAmount,
                                slippage: config.slippage,
                                priorityFee: 0.00001,
                                pool: "pump"
                        })
                });

                if (response.status === 200) {
                        const data = await response.arrayBuffer();
                        const tx = VersionedTransaction.deserialize(new Uint8Array(data));
                        tx.sign([signerKeyPair]);
                        const signature = await web3Connection.sendTransaction(tx);




                        console.log("🔴 Sold Transaction: https://solscan.io/tx/" + signature);

                        // const tokenPriceWithShyftApi = await checkSwapAmountsWithShyftApi(signature, pubKey, mint as string)
                        // console.log("tokenPriceWithShyftApi", tokenPriceWithShyftApi)

                        let sellStatus;
                        let retryCount = 0;
                        const maxRetries = 5;
                        while (retryCount <= maxRetries) {
                                try {
                                        sellStatus = await checkSwapAmounts(signature, mint as string);
                                        if (sellStatus && sellStatus.tokenPrice !== undefined) {
                                                break; // Success, exit retry loop
                                        }
                                        // If sellStatus is undefined, treat as error and retry
                                        retryCount++;
                                        if (retryCount > maxRetries) {
                                                throw new Error("checkSwapAmounts returned undefined after all retries");
                                        }
                                        console.log(`>> checkSwapAmounts returned undefined (attempt ${retryCount}/${maxRetries}), retrying after 5 seconds...`);
                                        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
                                } catch (error) {
                                        retryCount++;
                                        if (retryCount > maxRetries) {
                                                throw error; // Re-throw if max retries exceeded
                                        }
                                        console.log(`>> Error in checkSwapAmounts (attempt ${retryCount}/${maxRetries}), retrying after 5 seconds...`, error);
                                        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
                                }
                        }

                        if (!sellStatus || sellStatus.tokenPrice === undefined) {
                                throw new Error("Failed to get sell status after all retries");
                        }

                        const sellPrice = sellStatus.tokenPrice
                        console.log("sellPrice => ", sellPrice);

                        await closeTokenAccount(String(mint))
                        return true; // success, exit the retry loop
                } else {
                        console.log("❌ Error from trade-local API:", response.statusText);
                        return false;
                }

        } catch (error: any) {
                console.log(">> ERROR: sellToken >> ", error.response?.data || error.message || error.toString());
                // const amount = Number(await getTokenBalance(pubKey, mint));

                // console.log("Swapping with Jupiter")
                // await swapTokenWithJupiter(
                //         signerKeyPair,
                //         mint,
                //         config.WrapSol,
                //         amount * rate
                // );
                // decrementCounter();
                // removeBoughtToken(mint as string)
                return false;
        }
};

export const sellTokenWithSigner = async (
        { mint, signer }: { mint: String, signer: Keypair }
): Promise<any> => {
        const MAX_RETRIES = 4;       // how many times to retry
        const RETRY_INTERVAL = 1000;  // wait time between retries (ms)

        const signerKeyPair = signer
        const pubKey = signerKeyPair.publicKey.toString();
        // Use RPC rotation instead of fixed endpoint
        const web3Connection = createRotatedConnection('confirmed');

        try {
                const amount = Number(await getTokenBalance(pubKey, mint));
                const tokenAmount = amount;

                if (tokenAmount === 0) {
                        return
                }

                const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                                publicKey: pubKey,
                                action: "sell",
                                mint,
                                denominatedInSol: "false",
                                amount: tokenAmount,
                                slippage: config.slippage,
                                priorityFee: 0.00001,
                                pool: "pump"
                        })
                });

                if (response.status === 200) {
                        const data = await response.arrayBuffer();
                        const tx = VersionedTransaction.deserialize(new Uint8Array(data));
                        tx.sign([signerKeyPair]);
                        const signature = await web3Connection.sendTransaction(tx);
                        const confirmation = await web3Connection.confirmTransaction(signature);

                        // Fetch parsed transaction to read logs
                        const parsedTx = await web3Connection.getParsedTransaction(signature, {
                                maxSupportedTransactionVersion: 0
                        });

                        const errLogs = parsedTx?.meta?.logMessages ?? [];

                        if (errLogs.some((log) => log.includes("BondingCurveComplete"))) {
                                console.log("❌ Bonding curve completed. Liquidity moved to Raydium.");
                                return;
                        }

                        console.log("🔴 Sold Transaction: https://solscan.io/tx/" + signature);
                        // closeTokenAccount(String(mint))
                        return signature; // success, exit the retry loop
                } else {
                        console.log("❌ Error from trade-local API:", response.statusText);
                        return
                }

        } catch (error: any) {
                const errorMsg = error.response?.data || error.message || error.toString();
                console.log(">> ERROR: sellToken >> ", errorMsg);
                return;
        }
};

export const IsExistAta = async (connection: Connection, walletPubKey: PublicKey, mintPubKey: PublicKey) => {
        // Derive the ATA
        const associatedTokenAccount = getAssociatedTokenAddressSync(
                mintPubKey,
                walletPubKey,
                false,
                TOKEN_2022_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
        );


        // Get account info
        const accountInfo = await connection.getAccountInfo(associatedTokenAccount);

        if (accountInfo === null) {
                return false;
        } else {
                return true;
        }
}



export const closeTokenAccount = async (mint: string): Promise<void> => {

        try {

                const feePayer = wallet()
                const mintAddress = new PublicKey(mint)
                const associatedTokenAccount = getAssociatedTokenAddressSync(
                        mintAddress,
                        feePayer.publicKey,
                        false, // allowOwnerOffCurve
                        TOKEN_2022_PROGRAM_ID,
                        ASSOCIATED_TOKEN_PROGRAM_ID
                );

                const web3Connection = createRotatedConnection('confirmed');
                const isExist = await IsExistAta(
                        web3Connection,
                        feePayer.publicKey,
                        new PublicKey(mint)
                )

                const tokenAmount = await getTokenBalance(feePayer.publicKey.toString(), mint)

                if (tokenAmount !== 0) return
                if (isExist == false) {
                        console.log("🧨 Ata is not existed")
                        return
                }

                // Create close account instruction
                const closeAccountInstruction = createCloseAccountInstruction(
                        associatedTokenAccount, // token account to close
                        feePayer.publicKey, // destination to receive SOL
                        feePayer.publicKey, // owner of token account
                        [], // multiSigners
                        TOKEN_2022_PROGRAM_ID // programId
                );

                const latestBlockhash2 = await web3Connection.getLatestBlockhash();
                // Create and sign transaction for closing token account
                const closeTransaction = new Transaction({
                        feePayer: feePayer.publicKey,
                        blockhash: latestBlockhash2.blockhash,
                        lastValidBlockHeight: latestBlockhash2.lastValidBlockHeight
                }).add(closeAccountInstruction);

                // Sign and send close transaction
                const transactionSignature2 = await sendAndConfirmTransaction(
                        web3Connection,
                        closeTransaction,
                        [feePayer]
                );

                console.log("\n🧨 Successfully closed the token account");
        } catch (error) {
                console.log("closeTokenAccount already closed")
        }
}

export const getSolBalanceChange = async (txSignature: string): Promise<number[]> => {
        const connection = NewConnection();
        const tx: ParsedTransactionWithMeta | null = await connection.getParsedTransaction(txSignature, {
                maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
                console.log("Transaction not found");
                return [];
        }

        if (!tx.meta) {
                console.log("Transaction metadata not available");
                return [];
        }

        const balanceChanges = tx.meta.preBalances.map((pre: number, idx: number) => {
                const post = tx.meta!.postBalances[idx];
                return (post - pre) / 1e9; // Convert lamports to SOL
        });

        return balanceChanges;
}

export const getTransaciontListWithAccountForTokenHistory = async (account: String, txMintSignature: String, bondingCurve: String): Promise<{
        type: string,
        amount: number,
        status: string,
}[]> => {

        const apiKey = getNextRotatedShyftApiKey()
        const number = 10

        const url = `https://api.shyft.to/sol/v1/wallet/transaction_history?network=mainnet-beta&wallet=${account}&tx_num=${number}`
        const response = await axios.get(url,
                {
                        headers: {
                                "x-api-key": apiKey
                                // 'x-api-key': "L9VkIPhsoO3ewK5k"
                        }
                }
        )

        const res = response.data.result



        const initialTxHistory = res
                // .filter(item => item.type === "SWAP" && item.status === "Success")
                .map((item: any, index: any) => {

                        const actions = item.actions;

                        // All token transfers of this mint
                        const tokenTransfers = actions.filter(
                                (a: any) =>
                                        a.type === "TOKEN_TRANSFER" &&
                                        (a.info?.token_address === account || a.info?.mint === account)
                        );

                        if (tokenTransfers.length === 0) return null;

                        const solTransfers = actions.filter(
                                (a: any) =>
                                        a.type === "SOL_TRANSFER"
                        );


                        const swaps = [];

                        for (const tokenTransfer of tokenTransfers) {
                                const ix = tokenTransfer.ix_index;

                                // Determine BUY or SELL
                                const sender = tokenTransfer.info.sender;
                                const swapType = sender === bondingCurve ? "BUY" : "SELL";

                                // Find the SOL transfer that matches this token transfer
                                let maxTransfer = 0
                                const amounts = solTransfers.filter((itx: any) => itx.info.sender === tokenTransfer.info.receiver);
                                if (amounts.length === 0) {
                                        continue
                                } else {
                                        maxTransfer = (amounts.reduce((prev: any, curr: any) => {
                                                return curr.info.amount > prev.info.amount ? curr : prev;
                                        })).info.amount;
                                }

                                swaps.push({
                                        amount: maxTransfer,
                                        type: swapType,
                                        status: item.status
                                });
                        }


                        swaps.reverse();

                        if (swaps.length == 0) {
                                const type = item.actions[0].info.tokens_swapped.in.token_address == "So11111111111111111111111111111111111111112" ? "BUY" : "SELL"
                                const data = {
                                        amount: type === "BUY"
                                                ? item.actions[0].info.tokens_swapped.in.amount
                                                : -Number(item.actions[0].info.tokens_swapped.out.amount),
                                        type,
                                        status: item.status
                                }
                                return [data]
                        } else {
                                return swaps.length > 0 ? swaps : null
                        }
                })

        const swaps = (initialTxHistory.filter((item: any) => item !== null)).flat();
        const filteredSwaps = swaps.filter((swap: any) => swap.amount !== 0 && swap.status !== "Fail");

        return filteredSwaps
}


export const getTransaciontListWithAccountForWallet = async (account: String, number: number): Promise<any[]> => {

        const apiKey = getNextRotatedShyftApiKey()

        const url = `https://api.shyft.to/sol/v1/wallet/transaction_history?network=mainnet-beta&wallet=${account}&tx_num=${number}`
        const response = await axios.get(url,
                {
                        headers: {
                                "x-api-key": apiKey
                                // 'x-api-key': "L9VkIPhsoO3ewK5k"
                        }
                }
        )

        const res = response.data.result
        return res
}

export const getDepositeWallet = async (txList: any[], account: String): Promise<any> => {
        console.log("Calculating deposit amount...")
        const res = txList
        const filters = res.filter((item) => {
                return item.type === "SOL_TRANSFER";
        });

        // Find the transaction with maximum SOL transfer amount
        let maxTransfer: any = null;
        let maxAmount = 0;

        filters.forEach(item => {
                // Extract amount from actions array
                // Amount is typically in actions[0].info.amount for SOL transfers
                const amount = item.actions?.[0]?.info?.amount || 0;
                const receiver = item.actions?.[0]?.info?.receiver || '';
                if (amount > maxAmount && item.status === "Success" && receiver === account) {
                        maxAmount = amount;
                        maxTransfer = item;
                }
        });

        return {
                from: maxTransfer?.actions?.[0]?.info?.sender || '',
                to: maxTransfer?.actions?.[0]?.info?.receiver || '',
                amount: maxAmount,
                signers: maxTransfer?.signers.length || 0
        }

}



export const getDepositeWalletStatus = async (txList: any[], account: String): Promise<any> => {
        const res = txList


        const filters = res.filter((item) => item.type === "SOL_TRANSFER");

        const finalData = filters.flatMap((item) => {
                return item.actions.map((action: any) => ({
                        amount: action.info.sender === account ? -action.info.amount : action.info.amount,
                        feePayer: item.signers.length,
                        fee: item.fee,
                }));
        });

        const filteredData = finalData.filter((tx) => Math.abs(tx.amount) > 0.0001);

        return filteredData
}


export const getBondingCurveAddress = (mintAddress: string) => {
        try {
                const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
                const mint = new PublicKey(mintAddress);

                // Derive the bonding curve PDA
                const [bondingCurveAddress] = PublicKey.findProgramAddressSync(
                        [
                                Buffer.from("bonding-curve"),
                                mint.toBuffer(),
                        ],
                        PUMP_FUN_PROGRAM
                );

                return bondingCurveAddress.toBase58();
        } catch (error: any) {
                throw new Error(`Failed to derive bonding curve address: ${error.message}`);
        }
}

export const detectSolTransfersFromLog = (pre: any[], post: any[], accKeys: any[]) => {
        const changes = [];

        for (let i = 0; i < pre.length; i++) {
                const diff = BigInt(post[i]) - BigInt(pre[i]);

                if (diff !== 0n) {
                        changes.push({
                                index: i,
                                pubkey: accKeys[i],
                                change: diff, // positive = receive, negative = send
                        });
                }
        }

        const senders = changes.filter(c => c.change < 0n);
        const receivers = changes.filter(c => c.change > 0n);

        senders.sort((a, b) => Number(a.change - b.change));
        receivers.sort((a, b) => Number(b.change - a.change));

        const transfers = [];

        let si = 0, ri = 0;

        while (si < senders.length && ri < receivers.length) {
                const sent = -senders[si].change;
                const received = receivers[ri].change;

                const amount = sent < received ? sent : received;

                const fromIndex = senders[si].index;
                const toIndex = receivers[ri].index;

                transfers.push({
                        from: senders[si].pubkey,
                        to: receivers[ri].pubkey,
                        lamports: amount.toString(),
                        sol: Number(amount) / 1e9,

                        // 🔥 NEW: post balances of each account
                        fromBalance: Number(post[fromIndex]) / 1e9,
                        toBalance: Number(post[toIndex]) / 1e9,
                });

                senders[si].change += BigInt(amount);
                receivers[ri].change -= BigInt(amount);

                if (senders[si].change === 0n) si++;
                if (receivers[ri].change === 0n) ri++;
        }
        return transfers;
}

export const decodeSignature = (signatureBuffer: any) => {
        let signature: string;

        // Decode Buffer to base58 string
        if (Buffer.isBuffer(signatureBuffer)) {
                signature = bs58.encode(signatureBuffer);
        } else if (signatureBuffer instanceof Uint8Array) {
                signature = bs58.encode(Buffer.from(signatureBuffer));
        } else {
                signature = signatureBuffer as string;
        }
        return signature;
}

export const getTokenAccounts = (sender: PublicKey, receiverPublicKey: PublicKey, mintAddress: PublicKey) => {
        // Sender's token account
        const senderTokenAccount = getAssociatedTokenAddressSync(
                mintAddress,
                sender,
                false,
                TOKEN_2022_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
        );

        // Receiver's token account (auto-creates if not exist)
        const receiverTokenAccount = getAssociatedTokenAddressSync(
                mintAddress,
                receiverPublicKey,
                true,
                TOKEN_2022_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
        );

        return { senderTokenAccount, receiverTokenAccount };
}

export const sellAllTokens = async (): Promise<void> => {
        const signerKeyPair = wallet();
        const web3Connection = createRotatedConnection('confirmed');
        const pubKey = signerKeyPair.publicKey.toString()
        console.log(pubKey)


        const url = `https://api.shyft.to/sol/v1/wallet/all_tokens?network=mainnet-beta&wallet=${pubKey}`

        const response = await axios.get(url,
                {
                        headers: {
                                "x-api-key": config.SHYFT_API_KEY
                                // 'x-api-key': "L9VkIPhsoO3ewK5k"
                        }
                }
        )

        const res = response.data.result

        const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

        for (const token of res) {
                try {
                        const mint = token.address;
                        const SOL = 'So11111111111111111111111111111111111111112';

                        // Get ATA
                        const mintAddress = new PublicKey(mint);
                        const associatedTokenAccount = getAssociatedTokenAddressSync(
                                mintAddress,
                                signerKeyPair.publicKey,
                                false,
                                TOKEN_2022_PROGRAM_ID,
                                ASSOCIATED_TOKEN_PROGRAM_ID
                        );


                        const amount = await getTokenBalance(pubKey, mint);
                        const solBalanceOfAta = await web3Connection.getBalance(associatedTokenAccount);
                        const isExist = await IsExistAta(web3Connection, signerKeyPair.publicKey, new PublicKey(mint));
                        console.log("===========================")
                        console.log("Mint :", mint)
                        console.log("Ata :", associatedTokenAccount.toString())
                        console.log("amount => ", amount);
                        console.log("Exist", isExist)
                        console.log("SolBalanceOfAta => ", solBalanceOfAta / LAMPORTS_PER_SOL);

                        if (amount === 0 && isExist) {
                                // Close ATA
                                const latestBlockhash2 = await web3Connection.getLatestBlockhash();
                                const closeAccountInstruction = createCloseAccountInstruction(
                                        associatedTokenAccount, // token account to close
                                        signerKeyPair.publicKey, // destination to receive SOL
                                        signerKeyPair.publicKey, // owner of token account
                                        [],
                                        TOKEN_2022_PROGRAM_ID
                                );

                                const closeTransaction = new Transaction({
                                        feePayer: signerKeyPair.publicKey,
                                        blockhash: latestBlockhash2.blockhash,
                                        lastValidBlockHeight: latestBlockhash2.lastValidBlockHeight
                                }).add(closeAccountInstruction);

                                const transactionSignature2 = await sendAndConfirmTransaction(
                                        web3Connection,
                                        closeTransaction,
                                        [signerKeyPair]
                                );

                                console.log(`Successfully closed ATA for ${mint}`);
                        }

                        if (amount !== 0) {
                                // Sell token
                                const result = await sellTokenWithSigner({ mint, signer: signerKeyPair });

                                if (result == undefined) {
                                        const bondingCurve = getBondingCurveAddress(mint);
                                        console.log(`No direct market found for ${mint}. Trying to sell via bonding curve ${bondingCurve.toString()}`);
                                        const { senderTokenAccount, receiverTokenAccount } = await getTokenAccounts(signerKeyPair.publicKey, new PublicKey(bondingCurve), mintAddress)

                                        console.log("Sender Token Account :", senderTokenAccount.toString())
                                        console.log("Receiver Token Account :", receiverTokenAccount.toString())
                                        const mintInfo = await getMint(
                                                web3Connection,
                                                mintAddress,
                                                "confirmed",
                                                TOKEN_2022_PROGRAM_ID
                                        );

                                        const amountInBaseUnits =
                                                Number(amount) * Math.pow(10, mintInfo.decimals);

                                        const signature = await transfer(
                                                web3Connection,
                                                signerKeyPair,                // payer
                                                senderTokenAccount,           // source ATA
                                                receiverTokenAccount,         // destination ATA
                                                signerKeyPair.publicKey,      // owner
                                                amountInBaseUnits,
                                                [],
                                                undefined,
                                                TOKEN_2022_PROGRAM_ID
                                        );

                                        const updatedAmount = await getTokenBalance(pubKey, mint);

                                        if (updatedAmount === 0 && isExist) {
                                                const latestBlockhash2 = await web3Connection.getLatestBlockhash();
                                                const closeAccountInstruction = createCloseAccountInstruction(
                                                        associatedTokenAccount, // token account to close
                                                        signerKeyPair.publicKey, // destination to receive SOL
                                                        signerKeyPair.publicKey, // owner of token account
                                                        [],
                                                        TOKEN_2022_PROGRAM_ID
                                                );

                                                const closeTransaction = new Transaction({
                                                        feePayer: signerKeyPair.publicKey,
                                                        blockhash: latestBlockhash2.blockhash,
                                                        lastValidBlockHeight: latestBlockhash2.lastValidBlockHeight
                                                }).add(closeAccountInstruction);

                                                const transactionSignature2 = await sendAndConfirmTransaction(
                                                        web3Connection,
                                                        closeTransaction,
                                                        [signerKeyPair]
                                                );

                                                console.log(`Successfully closed ATA for ${mint}`);
                                        }
                                }
                        }




                        // Wait 1 second before processing next token
                        await sleep(1000);

                } catch (err) {
                        console.log(err);
                        // Wait 1 second even if error occurs to avoid spamming RPC
                        await sleep(1000);
                }
        }
}