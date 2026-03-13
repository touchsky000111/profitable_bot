import config from "./config/index";
import {initFastify} from "./master/fastify";
import chalk from "chalk";
import { FastifyInstance } from "fastify";

const start = async (): Promise<void> => {
  try {
    const app: FastifyInstance | false = await initFastify();

    if (!app) {
      console.log(chalk.red("✖ Private Key is not correct!"));
      process.exit(1);
    } else {
      await app.listen({ port: Number(config.PORT), host: "0.0.0.0" });
      console.log(
        chalk.green("✔") + chalk.white(` Server listening on http://localhost:${config.PORT}`)
      );
    }
  } catch (error) {
    console.error(">> ERROR: server >> ", error);
    process.exit(1);
  }
};

start();
