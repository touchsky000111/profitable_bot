import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import chalk from "chalk";
import readlineSync from "readline-sync";
import config from "../config/index";
import { getBlockhash } from "./getBlockhash";
import {startWebSocket} from "./websocket";
import * as web3Lib from "../lib/lib.web3";
import { getSharedConnection, setFastify, getSharedPumpSdk } from "./context";
import { startSubscribePumpfun } from "./subscribe.pumpfun";
import { startSubscribeTokenMonitoring } from "../controller/token.sell.pumpfun";
import { startPumpfunStatusUpdater } from "./getPumpfun.state";
import { getBuyStateSubscribe } from "./getBuyState";
import { createJitoTipTransaction } from "jito-bundle-solana";
declare module "fastify" {
  interface FastifyInstance {
    password?: string;
  }
}

export const initFastify = async (): Promise<FastifyInstance | false> => {
  const fastify: FastifyInstance = Fastify();

  setFastify(fastify);

  // Logging hook
  fastify.addHook(
    "onResponse",
    (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      const now = new Date();
      const isoString = now.toISOString();
      console.log(
        `${chalk.gray("[")}${isoString} ${chalk.green("INFO")}${chalk.gray("]")} ${request.ip} ${
          request.method
        } ${request.url} HTTP/${request.raw.httpVersion} ${reply.getHeader("content-length") || 0} - ${
          reply.statusCode === 200 ? chalk.green(reply.statusCode) : chalk.red(reply.statusCode)
        } ${request.headers["user-agent"]} ${chalk.cyan(
          (reply as any).elapsedTime?.toFixed(2) ?? 0
        )} ${chalk.green("ms")}`
      );
      done();
    }
  );

  // Ask for password

  try {
    // Load wallet
    const walletAddress = await web3Lib.wallet();
    console.log(chalk.green("💳") + " Wallet Address => \n", walletAddress.publicKey.toString());
    const connection = getSharedConnection()
    createJitoTipTransaction(connection, walletAddress)
    console.log("Back-Testing => ", config.backTest);
    console.log(chalk.green("✔") + " Bot Backend is Running");

    if(config.isSubscribeThroughWebsocket == true) {
      startWebSocket();
    } else {
      startPumpfunStatusUpdater()

      getSharedConnection()
      // getSharedPumpSdk()
      // getBlockhash();
      // startSubscribePumpfun()
      // getBuyStateSubscribe()
      // startSubscribeTokenMonitoring();
    }
  } catch (error) {
    console.error(">> ERROR: Bot Backend error >> ", error);
    return false;
  }

  return fastify;
};
