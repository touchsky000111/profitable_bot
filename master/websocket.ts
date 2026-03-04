import WebSocket from "ws";
import { tokenVerify } from "../controller/token.buy";
import chalk from "chalk";
import config from "../config/index";

type TokenData = any; // Replace 'any' with actual type of your token data if known

export const startWebSocket = (): void => {
  let ws: WebSocket | null = null;
  const reconnectDelay = 3000; // 3s before reconnect

  const connect = (): void => {
    ws = new WebSocket(config.WS_URL);

    ws.on("open", () => {
      console.log(chalk.green("✔") + " Connected to Pump.fun WebSocket");
      ws?.send(JSON.stringify({ method: "subscribeNewToken" }));
    });

ws.on("message", (data: string | Buffer) => {
  try {
    const message = typeof data === "string" ? data : data.toString();
    const tokenData = JSON.parse(message); // type as needed
    tokenVerify(tokenData);
  } catch (error) {
    console.error(">> ERROR: websocket message >> ", error);
  }
});

    ws.on("close", () => {
      console.log("❌ WebSocket closed. Reconnecting...");
      setTimeout(connect, reconnectDelay);
    });

    ws.on("error", (err: Error) => {
      console.error("⚠️ WebSocket error:", err.message);
      ws?.close(); // trigger reconnect
    });
  };

  connect();
};
