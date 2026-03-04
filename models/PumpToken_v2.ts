import mongoose, { Schema } from 'mongoose';
import config from '../config';
import { IPumpToken } from '../types/types';


const PumpTokenSchema: Schema = new Schema(
    {
        signature: { type: String, required: false},
        mint: { type: String, required: false, unique: true },
        traderPublicKey: { type: String, required: false },
        txType: { type: String, required: false },
        initialBuy: { type: Number, required: false },
        solAmount: { type: Number, required: false },
        bondingCurveKey: { type: String, required: false },
        vTokensInBondingCurve: { type: Number, required: false },
        vSolInBondingCurve: { type: Number, required: false },
        marketCapSol: { type: Number, required: false },
        name: { type: String, required: false },
        symbol: { type: String, required: false },
        uri: { type: String, required: false },
        image: { type: String, required: false },
        metadata: { type: String, required: false },
        twitter: { type: String, required: false },
        telegram: { type: String, required: false },
        website: { type: String, required: false },
        is_mayhem_mode: { type: Boolean, required: false },
        pool: { type: String, required: false },
        buyPrice: { type: Number, required: false },
        sellPrice: { type: Number, required: false },
        traderPublicKeyTransactions: { type: Schema.Types.Mixed, required: false },
        fundsWalletTransactions: { type: Schema.Types.Mixed, required: false },
        prediction: {
            type: Schema.Types.Mixed, required: false
        },
        txInSameSlot: [{
            _id: false,
            type: { type: String, enum: ["BUY", "SELL"], required: true },
            solAmount: { type: Number, required: true },
            tokenAmount: { type: Number, required: true },
        }],
    },
    {
        timestamps: true, // Adds createdAt and updatedAt automatically
    }
);

// TTL index: automatically deletes documents 10 days after creation
PumpTokenSchema.index({ createdAt: 1 }, { expireAfterSeconds: config.DATABASE_DURATION * 24 * 60 * 60 }); // 10 days

export default mongoose.model<IPumpToken>('PumpTokens_v2', PumpTokenSchema);
