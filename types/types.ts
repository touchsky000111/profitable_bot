import { Document } from 'mongoose';
import BN from "bn.js";


export interface RecordTokenDataInterface {
        pubKey: string,
        mint: string,
        wallet: string,
        fundsWallet: string,
        depositeAmount: number,
        buyPrice: number,
        sellPrice: number,
        duration: number,
        date: string,
        predict?: number | null
}


export interface SolanaTransfer {
        tx: string;
        source: string;
        destination: string;
        lamports: number;
}


export interface TxInterface {
        type: string,
        amount: number
}

/** Single tx in same slot: BUY or SELL with sol and token amounts */
export interface TxInSameSlotEntry {
        type: "BUY" | "SELL";
        solAmount: number;
        tokenAmount: number;
}

export interface TokenDataInterface {
        slot?: number;
        buyPrice?: number;
        mint: string;
        bondingCurveKey?: string;
        traderPublicKey?: string;
        signature?: string;
        solAmount: number;
        initialBuy: number;
        vSolInBondingCurve: number;
        vTokensInBondingCurve: number;
        marketCapSol: number;
        txInSameSlot?: TxInSameSlotEntry[];
        /** All-time high price (USD), stored as sellPrice; updated on buy/sell when current > sellPrice */
        sellPrice?: number;
        /** Timestamp when sellPrice (ATH) was last updated (ms); used for 30-min persist rule */
        sellPriceUpdatedAt?: number;
        /** Timestamp when token was added to in-memory array (ms); used for 1-day removal */
        mintedAt?: number;
        decimals?: number;
        tokenProgramId?: string;
}


// Type Definitions

export interface PricePoint {
        price: number;
        timestamp: number;
}

export interface TrendResult {
        trend: "rising" | "falling" | "stable" | "neutral";
        stabilized: boolean;
        percentChange?: number;
        volatility?: number;
        velocity?: number;
}

export interface TokenSellParams {
        tokenData: TokenDataInterface;
        amount: number;
        isTimeOut: boolean;
        sellPrice: number;
        buyPrice: number;
        counter: number;
        maxHistory: number;
        priceHistory: PricePoint[];
        ws: WebSocket;
        maxPrice: number;
        predictedAth?: number | null;
        liquidity?: number;
        finalWalletBalance?: number;
        txLength?: number;
        depth?: number;
}


export interface PriceEntry {
        price: number;
        timestamp: number;
}

export interface MessageData {
        data?: { price?: number }[];
}

export interface TokenParams {
        predict?: number | null;
        buyPrice?: number;
        sellPlan?: SellPlan;
}

export interface SellPlan {
        stopLossPrice: number;
        tiers: SellTier[];
        killSwitch: {
                maxHoldSeconds: number;
        };
}

export interface SellTier {
        name: string;
        price: number;
        weight: number;
}

export interface UpdateHistoryParams {
        pubKey?: string;
        mint: string;
        liquidity?: number;
        finalWalletBalance?: number;
        txLength?: number;
        depth?: number;
        pool?: string;
        buyPrice?: number;
        wallet?: string;
        sellPrice?: number;
        finalWallet?: string;
        tx?: string;
        maxPrice?: number;
        expectedAth?: number;
        reasonToSell: string;
        highestProfitPercent?: number; // Highest profit percent reached during monitoring
}


export interface ITokenRecord extends Document {
        timestamp?: number;
        signature?: string;
        from?: string;
        to?: string;
        amount?: number;
}

export interface IPumpToken extends Document {
        signature?: string;
        mint?: string;
        traderPublicKey?: string;
        txType?: string;
        initialBuy?: number;
        solAmount?: number;
        bondingCurveKey: string;
        vTokensInBondingCurve: number;
        vSolInBondingCurve: number;
        marketCapSol: number;
        name: string;
        symbol: string;
        uri: string;
        image?: string;
        metadata?: string;
        twitter?: string | null;
        telegram?: string | null;
        website?: string;
        is_mayhem_mode?: boolean;
        pool: string;
        buyPrice: number;
        sellPrice: number;
        traderPublicKeyTransactions: IWalletState;
        fundsWalletTransactions: IWalletState;
        txInSameSlot?: TxInSameSlotEntry[];
}

export interface ITxInterface {
        type: string;
        amount: number;
}

export interface ITokenRecord extends Document {
        pubKey: string,
        mint: string,
        wallet: string,
        fundsWallet: string,
        depositeAmount: number,
        buyPrice: number,
        sellPrice: number,
        duration: number,
        date: string,
        rate?: number;
        highestProfitPercent?: number; // Highest profit percent reached during monitoring
        createdAt?: Date;
        updatedAt?: Date;
}

export interface ITxInterface {
        signature: string;
        from: string;
        to: string;
        amount: number;
        timestamp: Date;
}

export interface IWalletState extends Document {
        wallet: string;                  // Wallet address (primary key)
        balance: number;                 // Latest balance
        last10Tx: ITxInterface[];        // Last 10 transactions
        createdAt?: Date;
        updatedAt?: Date;                // Updated on every transaction update (TTL target)
}

export interface WalletTx {
        signature: string;
        from: string;
        to: string;
        amount: number;
        fromBalance: number;
        toBalance: number;
        timestamp: number;
}

export interface WalletStateDoc {
        wallet: string;
        balance: number;
        last10Tx: WalletTx[];
        updatedAt: Date;
}

export interface BondingCurveInput {
        virtualTokenReserves: BN;  // token base units
        virtualSolReserves: BN;    // lamports
        solAmount: number;          // input as number in SOL
        totalFeeBps: number;        // e.g. 125 for 1.25%
}
export interface BondingCurveOutput {
        virtualTokenReserves: BN;  // token base units
        virtualSolReserves: BN;    // lamports
        tokenAmount: number;          // input as number in SOL
        totalFeeBps: number;
}
export interface FlatFees {
        lpFeeBps: BN;
        protocolFeeBps: BN;
        creatorFeeBps: BN;
}

export interface FeeConfig {
        flatFees: FlatFees;
}
