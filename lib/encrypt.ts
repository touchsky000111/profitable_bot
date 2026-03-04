import crypto from "crypto";
import { getFastify } from '../master/context';


export const encryptAESGCM = (plainText: string) => {
    const fastify = getFastify()
    const password: string = (fastify as any)?.password || ""
    const salt = crypto.randomBytes(16); // store with ciphertext
    const iv = crypto.randomBytes(12);   // AES-GCM nonce
    const key = crypto.pbkdf2Sync(password, salt, 100_000, 32, "sha256");
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Pack into: [salt | iv | tag | ciphertext]
    const combined = Buffer.concat([salt, iv, tag, ct]);

    // Return as base64 string
    return combined.toString("base64");
}

export const decryptAESGCM = (encoded: string) => {
    const fastify = getFastify()
    const password: string = (fastify as any)?.password || ""

    const data = Buffer.from(encoded, "base64");

    const salt = data.subarray(0, 16);
    const iv = data.subarray(16, 28);
    const tag = data.subarray(28, 44);
    const ct = data.subarray(44);

    const key = crypto.pbkdf2Sync(password, salt, 100_000, 32, "sha256");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);

    return pt.toString("utf8");
}