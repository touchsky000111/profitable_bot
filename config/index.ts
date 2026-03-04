import 'dotenv/config';
import { initializeShyftAPIKeyRotation } from '../lib/api.key.rotation';

const parseShyftApiKeys = (): string[] => {
  return [process.env.SHYFT_API_KEY as string];
};

const shyftApiKeys = parseShyftApiKeys();
if (shyftApiKeys.length > 0) {
  initializeShyftAPIKeyRotation(shyftApiKeys);
}

const config = {
  PORT: process.env.PORT as string,
  PRIVATEKEY: process.env.PRIVATE_KEY as string,
  TOKEN: process.env.TOKEN as string,
  GRPC_URL: process.env.GRPC_URL as string,
  RPC_URL: process.env.RPC_URL as string,
  RABBIT_URL: process.env.RABBIT_URL as string,
  GRPC_TOKEN: process.env.GRPC_TOKEN as string,
  SHYFT_API_KEY: process.env.SHYFT_API_KEY as string,
  DATABASE_URL: (process.env.DATABASE_URL || process.env.DB_URL) as string,
  JUPITER_WS_URL: 'wss://trench-stream.jup.ag/ws',
  WS_URL: "wss://pumpportal.fun/api/data",
  PUMPFUN_PROGRAMID: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  backTest: false,
  RAPID_DRAWDOWN_DROP_PERCENT: 30,
  slippage: 20, // default slippage for swap
  canBuy: 10,
  maxHoldSeconds: 30,
  delay: 10,
  buyAmount: 0.02,
  JITO_TIP_ADDRESS: '',
  JITO_TIP_URL: 'https://singapore.mainnet.block-engine.jito.wtf',
  WrapSol: "So11111111111111111111111111111111111111112" as String,
  DATABASE_DURATION: 7,
  DATABASE_LENGTH: 30,
  DATABASE_NAME: "sniper",
  BACK_END_URL: 'http://95.217.63.103:9000',
  REDIS_URL: "redis://localhost:6379",
  isSavedInDatabase: true,
  isSubscribeThroughWebsocket: false,
  redisBlockHashKey: "solana:blockhash",
  redisBlockHeightKey: "solana:blockHeight",
};

export default config;
