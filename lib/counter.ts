/**
 * Simple in-memory counter for tracking bot buy/sell operations
 * +1 when bot buys a token
 * -1 when bot sells a token
 * Bot can only buy if counter < 7
 */
import config from "../config/index";
import { removeAllBoughtTokens } from "../master/context";
import { sellAllTokens } from "./lib.web3";
let counter = 0;

let isSold = false;

export const getCounter = (): number => {
    return counter;
};

export const incrementCounter = (): number => {
    counter += 1;
    console.log(`📊 Counter incremented: ${counter}`);
    return counter;
};

export const decrementCounter = (): number => {
    counter = Math.max(0, counter - 1); // Prevent negative values
    console.log(`📊 Counter decremented: ${counter}`);
    return counter;
};

export const formatCounter = (): string => {
    counter = 0
    return `📊 Counter: ${counter}`;
};

export const canBuy = (): boolean => {
    // Check counter limit first
    if (counter >= config.canBuy) {
        return false;
    }

    return true;
};



