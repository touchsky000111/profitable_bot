import mongoose, { Schema, Document } from 'mongoose';
import config from '../config';
import { ITokenRecord } from '../types/types';

const TokenRecordSchema: Schema = new Schema(
  {
    pubKey: { type: String, required: true },
    mint: { type: String, required: true, unique: true, index: true },
    wallet: { type: String, required: true },
    fundsWallet: { type: String, required: true },
    depositeAmount: { type: Number, required: true },
    buyPrice: { type: Number, required: true },
    sellPrice: { type: Number, required: true },
    duration: { type: Number, required: true },
    date: { type: String, required: true },
    rate: { type: Number, required: false },
    highestProfitPercent: { type: Number, required: false }, // Highest profit percent reached during monitoring
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
);

// Create index on mint for faster lookups
TokenRecordSchema.index({ mint: 1 });

TokenRecordSchema.index({ createdAt: 1 }, { expireAfterSeconds: config.DATABASE_DURATION * 24 * 60 * 60 })

export default mongoose.model<ITokenRecord>('TokenRecord', TokenRecordSchema);

