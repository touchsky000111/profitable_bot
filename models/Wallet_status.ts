import mongoose, { Schema } from 'mongoose';
import config from '../config';
import { IWalletState } from '../types/types';

const TxInterfaceSchema: Schema = new Schema(
  {
    signature: { type: String, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    amount: { type: Number, required: true },
    fromBalance: { type: Number, required: true },
    toBalance: { type: Number, required: true },
    timestamp: { type: Number, required: true },
  },
  { _id: false }
);

const WalletStateSchema: Schema = new Schema(
  {
    wallet: { type: String, required: true, unique: true, index: true },
    balance: { type: Number, required: true, default: 0 },
    last10Tx: { type: [TxInterfaceSchema], required: true, default: [] },
  },
  {
    timestamps: true, // adds createdAt and updatedAt automatically
  }
);

// TTL index: automatically deletes wallets that haven't been updated for 10 days
WalletStateSchema.index({ updatedAt: 1 }, { expireAfterSeconds: config.DATABASE_DURATION * 24 * 60 * 60 });

export default mongoose.model<IWalletState>('WalletState', WalletStateSchema);
