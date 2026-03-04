import { FastifyInstance } from "fastify";
import { TokenDataInterface, SellPlan } from "../types/types";
import Redis from "ioredis";
import config from "../config/index";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import {
        PumpSdk,
} from "@pump-fun/pump-sdk";
import { createRotatedConnection } from "../lib/api.key.rotation";
import { wallet } from "../lib/lib.web3";

let fastifyInstance: FastifyInstance | null = null;

type BuyState = {
  bondingCurveAddress: string;
  bondingCurveAccountInfo: any;
  bondingCurve: any;
  creator: PublicKey | null;
  updatedAt: number;
};

export interface BoughtTokenEntry {
  tokenData: TokenDataInterface;
  isValidToken: {
    msg: boolean,
    fundsWallet?: string,
    depositedAmount?: number,
    predict: number | null,
    clusterStats?: {
      probability: number;
      expected_roi_median: number;
      expected_roi_q25: number;
      expected_roi_q75: number;
    }
  };
  buyPrice: number;
  mintValue: number;
  sellPlan: SellPlan | undefined;
}

const boughtTokens: BoughtTokenEntry[] = [];

let latestBlockHash = ""
let validBlockHeight = 0
let globalPumpfun: any = null;
let feeConfig: any = null
const buyStates: BuyState[] = [];
export const setFastify = (instance: FastifyInstance): void => {
  fastifyInstance = instance;
};

export const getFastify = (): FastifyInstance | null => {
  return fastifyInstance;
};

export const addBoughtToken = (entry: BoughtTokenEntry): void => {
  boughtTokens.push(entry);
};

export const getBoughtTokens = (): BoughtTokenEntry[] => {
  return boughtTokens;
};

export const tokensBeingSold = new Set<string>();
/**
 * Remove a token from the bought tokens list (e.g. after selling all tokens).
 */
export const removeBoughtToken = (mint: string): void => {
  const index = boughtTokens.findIndex((entry) => entry.tokenData.mint === mint);
  if (index !== -1) {
    boughtTokens.splice(index, 1);
  }
};


export const removeAllBoughtTokens = (): void => {
  boughtTokens.length = 0;
  tokensBeingSold.clear();
};

export const getLatestBlockHash = (): string => {
  return latestBlockHash;
}

export const getValidBlockHeight = (): number => {
  return validBlockHeight;
}

export const setLatestBlockHash = (hash: string): void => {
  latestBlockHash = hash;
}

export const setValidBlockHeight = (height: number): void => {
  validBlockHeight = height;
}

export const setGlobalPumpfun = (globalPumpfunInstance: any): void => {
  globalPumpfun = globalPumpfunInstance;
}

export const setFeeConfig = (config: any): void => {
  feeConfig = config;
}

export const getGlobalPumpfun = (): any => {
  return globalPumpfun;
}

export const getFeeConfig = (): any => {
  return feeConfig;
}

export const setBuyState = ({
  bondingCurveAddress,
  bondingCurveAccountInfo,
  bondingCurve,
  creator
}: Omit<BuyState, "updatedAt">): void => {

  const index = buyStates.findIndex(
    (item) => item.bondingCurveAddress === bondingCurveAddress
  );

  const updatedAt = Date.now();

  if (index !== -1) {
    // Update existing
    if (bondingCurveAccountInfo !== null && bondingCurveAccountInfo !== undefined) buyStates[index].bondingCurveAccountInfo = bondingCurveAccountInfo;
    if (bondingCurve !== null && bondingCurve !== undefined) buyStates[index].bondingCurve = bondingCurve;
    if (creator !== null && creator !== undefined) buyStates[index].creator = creator;
    buyStates[index].updatedAt = updatedAt;
  } else {
    // Insert new
    buyStates.push({
      bondingCurveAddress,
      bondingCurveAccountInfo,
      bondingCurve,
      creator,
      updatedAt,
    });
  }
};

const BUY_STATE_MAX_AGE_MS = 10 * 60 * 60 * 1000; // 10 hours

const pruneStaleBuyStates = (): void => {
  const cutoff = Date.now() - BUY_STATE_MAX_AGE_MS;
  for (let i = buyStates.length - 1; i >= 0; i--) {
    if (buyStates[i].updatedAt < cutoff) {
      buyStates.splice(i, 1);
    }
  }
};

export const getBuyState = (bondingCurveAddress: string): any => {
  pruneStaleBuyStates();
  const state = buyStates.find(
    (item) => item.bondingCurveAddress === bondingCurveAddress
  );
  return state || null;
}


let sharedConnection: Connection | null = null;
let sharedPumpSdk: PumpSdk | null = null;
let cachedKeypair: Keypair | null = null;

export const getSharedConnection = (): Connection => {
        if (!sharedConnection) sharedConnection = createRotatedConnection('confirmed');
        return sharedConnection;
};

export const getSharedPumpSdk = (): PumpSdk => {
        if (!sharedPumpSdk) sharedPumpSdk = new PumpSdk();
        return sharedPumpSdk;
};

export const getWalletKeypair = (): Keypair => {
        if (!cachedKeypair) cachedKeypair = wallet();
        return cachedKeypair;
};

export const redisClient = new Redis(config.REDIS_URL);