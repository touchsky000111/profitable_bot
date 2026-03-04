import chalk from "chalk";
import config from "../config/index";
import WalletState from "../models/Wallet_status"
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
import { getBondingCurveAddress, detectSolTransfersFromLog, decodeSignature } from "../lib/lib.web3";
import { TokenDataInterface, TxInSameSlotEntry } from "../types/types";
import axios from "axios";
import { tokenVerify } from "../controller/token.buy";
import { getBuyState, redisClient } from "./context";
import { PublicKey } from "@solana/web3.js";
import { mintTo } from "@solana/spl-token";
import { setBuyState } from "./context";
import bs58 from "bs58";
import { BN } from "bn.js";
import { numberToBN } from "../lib/lib.web3";
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



// Function to fetch Solana price from Jupiter API
async function fetchSolanaPrice(): Promise<number> {
    try {
        const response = await axios.get('https://perps-api.jup.ag/v1/market-stats?mint=So11111111111111111111111111111111111111112');
        const price = Number(response.data.price);
        if (isNaN(price) || price <= 0) {
            throw new Error(`Invalid price received: ${response.data.price}`);
        }
        return price;
    } catch (error: any) {
        console.error(chalk.red("✖") + ` Error fetching Solana price:`, error.message || error.toString());
        throw error;
    }
}

// Function to update Solana price in Redis
async function updateSolanaPriceInRedis(): Promise<void> {
    try {
        const price = await fetchSolanaPrice();
        await redisClient.set("SOLANA_PRICE", price.toString());
        console.log(chalk.green("✓") + ` Solana price updated in Redis: $${price.toFixed(2)}`);
    } catch (error: any) {
        console.error(chalk.red("✖") + ` Failed to update Solana price in Redis:`, error.message || error.toString());
    }
}

// // Start timer to fetch Solana price every 1 minute
// function startSolanaPriceTimer(): void {
//     // Fetch immediately on startup
//     updateSolanaPriceInRedis();

//     // Then fetch every 1 minute (60000 ms)
//     setInterval(() => {
//         updateSolanaPriceInRedis();
//     }, 60000);

//     console.log(chalk.yellow("⏰") + " Solana price timer started (updates every 1 minute)");
// }

export async function getWalletDeposits(
    walletAddress: string,
): Promise<any> {
    try {
        const traderPublicKeyTransactions = await WalletState.findOne({ wallet: walletAddress });

        if (!traderPublicKeyTransactions || !traderPublicKeyTransactions.last10Tx) return [];

        const fundsWallet = traderPublicKeyTransactions.last10Tx.reverse()
            .filter((tx: any) => tx.to === walletAddress)
            .map(tx => ({
                from: tx.from,
                amount: tx.amount,
                timestamp: tx.timestamp,
                signature: tx.signature
            }))[0].from;

        const fundsWalletTransactions = await WalletState.findOne({ wallet: fundsWallet });
        return {
            traderPublicKeyTransactions: {
                wallet: traderPublicKeyTransactions.wallet,
                balance: traderPublicKeyTransactions.balance,
                last10Tx: traderPublicKeyTransactions.last10Tx
            },
            fundsWalletTransactions: {
                wallet: fundsWalletTransactions?.wallet,
                balance: fundsWalletTransactions?.balance,
                last10Tx: fundsWalletTransactions?.last10Tx
            }
        }
    } catch (error) {
        return {
            traderPublicKeyTransactions: {
                wallet: null,
                balance: 0,
                last10Tx: null
            },
            fundsWalletTransactions: {
                wallet: null,
                balance: 0,
                last10Tx: null
            }
        }
    }
}


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

type Transfer = {
    from: string;
    to: string;
    lamports: string;
    sol: number;
    fromBalance: number;
    toBalance: number;
};

/** Array of newly detected token info (mint / slot / signature / bonding curve data, etc.) */
const detectedTokens: TokenDataInterface[] = [];

/**
 * Subscribes to the gRPC stream and handles incoming data.
 *
 * @param client - Yellowstone gRPC client
 * @param args - The Subscription request which specifies what data to stream
 */

const TOKEN_PROGRAM_LEGACY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_PROGRAM_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";


function detectTokenProgramFromAccounts(accounts: string[]) {
    if (accounts.includes(TOKEN_PROGRAM_2022)) {
        return TOKEN_PROGRAM_2022;
    }

    if (accounts.includes(TOKEN_PROGRAM_LEGACY)) {
        return TOKEN_PROGRAM_LEGACY;
    }

    return null;
}





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



async function getMintTransaction(data: any) {
    const tx = data.transaction.transaction
    const slot = data.transaction.slot

    const signature = decodeSignature(tx.signature)
    const accounts = tx.transaction.message.accountKeys;
    const instructions = tx.transaction.message.instructions;
    const meta = tx.meta;
    const innerInstructions = meta?.innerInstructions;
    const preBalances = meta?.preBalances;
    const postBalances = meta?.postBalances;
    const loadedWritableAddresses = meta?.loadedWritableAddresses.map((addr: any) => decodeSignature(addr));
    const loadedReadonlyAddresses = meta?.loadedReadonlyAddresses.map((addr: any) => decodeSignature(addr));
    const decodedAccounts = accounts.map((addr: any) => decodeSignature(addr))

    const accountKeys = [
        ...decodedAccounts,
        ...loadedWritableAddresses,
        ...loadedReadonlyAddresses
    ]
    const signer = accountKeys[0]
    const mint = accountKeys[1]
    const bondingCurveAddress = getBondingCurveAddress(mint)

    const transferLog: any = detectSolTransfersFromLog(preBalances || [], postBalances || [], accountKeys);

    const transfers: Transfer[] = transferLog;

    const bondingCurveTx = transfers.find(tx => tx.to === bondingCurveAddress);

    const solAmount = bondingCurveTx?.sol ?? 0;

    const vSolInBondingCurve = 30 + solAmount
    const vTokensInBondingCurve = 32_190_000_000 / vSolInBondingCurve;
    const initialBuy = meta?.postTokenBalances?.[1]?.uiTokenAmount?.uiAmount || 0
    const totalSupply = 1000000000
    const marketCapSol = vSolInBondingCurve * totalSupply / vTokensInBondingCurve
    const buyPrice = vSolInBondingCurve / vTokensInBondingCurve


    const tokenProgramId = detectTokenProgramFromAccounts(accountKeys);
    const decimals = meta?.postTokenBalances
        ?.find((tb: any) => tb.mint === mint)
        ?.uiTokenAmount?.decimals ?? 6;


    setBuyState({
        bondingCurveAddress,
        bondingCurveAccountInfo: null,
        bondingCurve: null,
        creator: new PublicKey(signer)
    })


    const tokenData: TokenDataInterface = {
        slot: Number(slot),
        signature: signature,
        mint: mint,
        buyPrice: buyPrice,
        traderPublicKey: signer,
        bondingCurveKey: bondingCurveAddress,
        solAmount: solAmount,
        initialBuy: initialBuy,
        vSolInBondingCurve: vSolInBondingCurve,
        vTokensInBondingCurve: vTokensInBondingCurve,
        marketCapSol: marketCapSol,
        txInSameSlot: [],
        tokenProgramId: tokenProgramId || TOKEN_PROGRAM_2022,
        decimals: decimals
    }

    detectedTokens.push(tokenData);
    // getTokenBuyPrice(tokenData);
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

async function getBuyTransactionInSameSlot(data: any) {
    if (!data?.transaction?.transaction) return
    const tx = data.transaction.transaction
    const slot = data.transaction.slot

    const logMsg = tx.meta.logMessages
    const isBuying = logMsg.some((line: string) => line.includes("Buy"));
    const isSelling = logMsg.some((line: string) => line.includes("Sell"));

    const signature = decodeSignature(tx.signature)
    const accounts = tx.transaction.message.accountKeys;
    const instructions = tx.transaction.message.instructions;
    const meta = tx.meta;
    const innerInstructions = meta?.innerInstructions;
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
    const signer = accountKeys[0]
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

    const vTokenBalance = 73000000 + tokenMonitoring.poolPostTokenBalances;
    const vSolBalance = 30 + tokenMonitoring.poolPostBalances;
    const currentPrice = vSolBalance / vTokenBalance;

    const virtualTokenReserves = vTokenBalance / 1e4
    const virtualSolReserves = vSolBalance / 10
    const realTokenReserves = virtualTokenReserves - 28000
    const realSolReserves = virtualSolReserves - 3
    const tokenTotalSupply = 100000.0000000

    const bondingCurve = {
        virtualTokenReserves: numberToBN(virtualTokenReserves),
        virtualSolReserves: numberToBN(virtualSolReserves),
        realTokenReserves: numberToBN(realTokenReserves),
        realSolReserves: numberToBN(realSolReserves),
        tokenTotalSupply: numberToBN(tokenTotalSupply),
        complete: false,
        isMayhemMode: false,
        isCashbackCoin: false
    }

    if (tokenMonitoring.mint !== '') {
        const bondingCurveAddress = getBondingCurveAddress(tokenMonitoring.mint)
        setBuyState({
            bondingCurveAddress: bondingCurveAddress,
            bondingCurveAccountInfo: null,
            bondingCurve: bondingCurve,
            creator: null
        })

    }

    const solAmount = tokenMonitoring.solAmount;
    const tokenAmount = tokenMonitoring.tokenAmount
    const txInSameSlot: TxInSameSlotEntry = {
        type: tokenMonitoring.type,
        solAmount: solAmount,
        tokenAmount: tokenAmount
    }

    detectedTokens.forEach(token => {

        if (token.slot && token.slot === Number(slot)) {
            if (token.mint === tokenMonitoring.mint) {
                if (!token.txInSameSlot) token.txInSameSlot = []

                if (token.txInSameSlot.length === 0) {
                    token.txInSameSlot.push({
                        type: tokenMonitoring.type,
                        solAmount: solAmount,
                        tokenAmount: token.initialBuy
                    })
                    token.buyPrice = currentPrice
                } else {
                    token.txInSameSlot.push(txInSameSlot)
                    token.buyPrice = currentPrice
                }
            }
        }
    })

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
            console.warn("PumpFun stream idle for 1 min, closing to reconnect...");
            if (idleCheckInterval) clearInterval(idleCheckInterval);
            stream.end();
        }
    }, IDLE_CHECK_INTERVAL_MS);

    // Handle incoming transaction data
    stream.on("data", (data) => {
        lastDataReceivedAt = Date.now();

        if (!data?.transaction?.transaction) return
        const tx = data.transaction.transaction

        const logMsg = tx.meta.logMessages
        const hasMintTo = logMsg.some((line: string) => line.includes("MintTo"));
        const isBuying = logMsg.some((line: string) => line.includes("Buy"));
        const isSelling = logMsg.some((line: string) => line.includes("Sell"));

        const slot = data.transaction.slot

        detectedTokens.forEach(token => {
            if (token.slot && token.slot < Number(slot)) {
                detectedTokens.splice(detectedTokens.indexOf(token), 1)
                tokenVerify(token);
            }
        })

        if (hasMintTo) {
            getMintTransaction(data);
        }
        if (isBuying || isSelling) {
            getBuyTransactionInSameSlot(data)
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
            console.log(chalk.green("💫") + ' Connecting to PumpFun Subscribe for Dex...');
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
    commitment: CommitmentLevel.PROCESSED,
};


export const startSubscribePumpfunForDex = () => {
    subscribeCommand(client, req);
}