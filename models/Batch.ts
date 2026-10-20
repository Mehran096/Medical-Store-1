import { Schema, model, models, type Model, Types } from "mongoose";

export interface IBatch {
  productId: Types.ObjectId;
  batchNo: string;
  expiryDate: Date;
  buyPrice: number;
  quantity: number;
  userId: Types.ObjectId;
  localId?: string;
  synced?: boolean;
}

const BatchSchema = new Schema<IBatch>({
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
  batchNo: { type: String, required: true, trim: true },
  expiryDate: { type: Date, required: true, index: true },
  buyPrice: { type: Number, required: true },
  quantity: { type: Number, required: true, min: 0 },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  localId: { type: String, sparse: true },
  synced: { type: Boolean, default: true },
}, { timestamps: true });

BatchSchema.index({ userId: 1, expiryDate: 1 });
BatchSchema.index({ userId: 1, productId: 1, expiryDate: 1 });
BatchSchema.index({ productId: 1, batchNo: 1 });
BatchSchema.index({ userId: 1, localId: 1 }, { unique: true, sparse: true });

const Batch = (models.Batch as Model<IBatch>) || model<IBatch>("Batch", BatchSchema);
export default Batch;