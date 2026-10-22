import { Schema, model, models, Types, type Model } from "mongoose";

export type MainUnit = "box" | "bottle" | "tube" | "piece";
export type SellUnit = "patta" | "half_patta" | "box" | "bottle" | "ml" | "tube" | "piece";

export interface ISale {
  productId: Types.ObjectId;
  productName: string;
  batchId?: Types.ObjectId;
  batchNo?: string;
  expiryDate?: Date;
  mainUnit: MainUnit;
  sellUnit: SellUnit;
  quantity: number;
  pattaPerBox: number;
  mlPerBottle: number;
  buyPriceMain: number;
  sellPrice: number;
  total: number;
  profit: number;
  deductionMain: number;
  deductionPatta: number;
  userId: Types.ObjectId;
  customerName?: string;
  customerId?: Types.ObjectId;
  paymentType?: string;
  status?: "paid" | "pending" | "partial";
  isCredit?: boolean;
  localId?: string;
}

const SaleSchema = new Schema<ISale>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch" },
    batchNo: { type: String, default: "" },
    expiryDate: { type: Date },
    mainUnit: { type: String, enum: ["box", "bottle", "tube", "piece"], required: true },
    sellUnit: { type: String, enum: ["patta", "half_patta", "box", "bottle", "ml", "tube", "piece"], required: true, default: "patta" },
    quantity: { type: Number, required: true, min: 0.001 },
    pattaPerBox: { type: Number, default: 10 },
    mlPerBottle: { type: Number, default: 120 },
    buyPriceMain: { type: Number, required: true },
    sellPrice: { type: Number, required: true },
    total: { type: Number, required: true },
    profit: { type: Number, required: true },
    deductionMain: { type: Number, default: 0 },
    deductionPatta: { type: Number, default: 0 },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    customerName: { type: String, default: "Walk-in" },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    paymentType: { type: String, default: "cash" },
    status: { type: String, enum: ["paid", "pending", "partial"], default: "paid" },
    isCredit: { type: Boolean, default: false },
    localId: { type: String, sparse: true, index: true },
  },
  { timestamps: true }
);

// No `any`, no `next` - sync hook
SaleSchema.pre("validate", function () {
  const qty = this.quantity || 0;
  const ppb = this.pattaPerBox && this.pattaPerBox > 0 ? this.pattaPerBox : 10;
  const mlB = this.mlPerBottle && this.mlPerBottle > 0 ? this.mlPerBottle : 120;

  // If client already provided deductionMain for batchId flow, keep it
  const hasClientDeduction = this.deductionMain > 0.0001 && Boolean(this.batchId);

  if (!hasClientDeduction) {
    let deductMain = 0;
    let deductPatta = 0;

    if (this.mainUnit === "box") {
      if (this.sellUnit === "patta") {
        deductMain = qty / ppb;
        deductPatta = qty;
      } else if (this.sellUnit === "half_patta") {
        deductMain = (qty * 0.5) / ppb;
        deductPatta = qty * 0.5;
      } else {
        deductMain = qty;
        deductPatta = qty * ppb;
      }
    } else if (this.mainUnit === "bottle") {
      if (this.sellUnit === "ml") {
        deductMain = qty / mlB;
      } else {
        deductMain = qty;
      }
    } else {
      deductMain = qty;
    }

    this.deductionMain = Math.round(deductMain * 1000) / 1000;
    this.deductionPatta = Math.round(deductPatta * 1000) / 1000;
  }

  // Always recalc total/profit from buyPriceMain to prevent drift
  let total = 0;
  let profit = 0;

  if (this.mainUnit === "box") {
    const buyPerPatta = this.buyPriceMain / ppb;
    const buyPerHalf = buyPerPatta / 2;
    if (this.sellUnit === "patta") {
      total = this.sellPrice * qty;
      profit = (this.sellPrice - buyPerPatta) * qty;
    } else if (this.sellUnit === "half_patta") {
      total = this.sellPrice * qty;
      profit = (this.sellPrice - buyPerHalf) * qty;
    } else {
      total = this.sellPrice * qty;
      profit = (this.sellPrice - this.buyPriceMain) * qty;
    }
  } else if (this.mainUnit === "bottle") {
    if (this.sellUnit === "ml") {
      const buyPerMl = this.buyPriceMain / mlB;
      total = this.sellPrice * qty;
      profit = (this.sellPrice - buyPerMl) * qty;
    } else {
      total = this.sellPrice * qty;
      profit = (this.sellPrice - this.buyPriceMain) * qty;
    }
  } else {
    total = this.sellPrice * qty;
    profit = (this.sellPrice - this.buyPriceMain) * qty;
  }

  this.total = Math.round(total * 10) / 10;
  this.profit = Math.round(profit * 10) / 10;
});

SaleSchema.index({ userId: 1, createdAt: -1 });
SaleSchema.index({ userId: 1, productName: 1 });
SaleSchema.index({ userId: 1, batchId: 1 });

const Sale = (models.Sale as Model<ISale>) || model<ISale>("Sale", SaleSchema);
export default Sale;