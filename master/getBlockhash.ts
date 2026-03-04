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
import Redis from "ioredis";
import { SubscribeRequestPing } from "@triton-one/yellowstone-grpc/dist/types/grpc/geyser";
import { setLatestBlockHash, setValidBlockHeight } from "./context";
// Initialize Redis client

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
  ping?: SubscribeRequestPing;
}
const BLOCKS_TO_INCLUDE_ADDRESS = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
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
      console.warn("Blockhash stream idle for 1 min, closing to reconnect...");
      if (idleCheckInterval) clearInterval(idleCheckInterval);
      stream.end();
    }
  }, IDLE_CHECK_INTERVAL_MS);

  // Handle incoming transaction data
  stream.on("data", (data) => {
    lastDataReceivedAt = Date.now();
    const newBlockhash = data?.blockMeta?.blockhash;
    const newBlockHeight = Number(data?.blockMeta?.blockHeight?.blockHeight) + 150;

    if (!newBlockhash || !newBlockHeight) return;
    setLatestBlockHash(newBlockhash);
    setValidBlockHeight(newBlockHeight);
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
      console.log(chalk.green("💫") + ' Connecting to Blockhash Subscribe...');
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
  {
    "grpc.max_receive_message_length": 1024 * 1024 * 1024
  }
);


const req: SubscribeRequest = {
  slots: {},
  accounts: {},
  transactions: {},
  blocks: {},
  blocksMeta: {
    blockmetadata: {}
  },
  accountsDataSlice: [],
  commitment: CommitmentLevel.CONFIRMED, // Subscribe to processed blocks for the fastest updates
  entry: {},
  transactionsStatus: {},
};


export const getBlockhash = async () => {

  // Initialize MongoDB connection

  subscribeCommand(client, req);
}

