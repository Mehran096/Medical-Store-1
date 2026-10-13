import { Schema, model, models, Types, type Model } from "mongoose";

export type MainUnit = "box" | "bottle" | "tube" | "piece";
export type SellUnit = "patta" | "half_patta" | "box" | "bottle" | "ml" | "tube" | "piece";

export interface ISale {
  productId: Types.ObjectId;
  productName: string;
  mainUnit: MainUnit; // from Product - box/bottle/tube/piece
  sellUnit: SellUnit; // decided at counter - patta/half_patta/box/bottle/ml/tube/piece
  quantity: number; // in sellUnit - e.g., 1 patta, 0.5, 2 box
  
  pattaPerBox: number;
  mlPerBottle: number;

  buyPriceMain: number; // per Box/Bottle/Tube/Piece - from Product
  sellPrice: number; // per Patta/HalfPatta/Box/Bottle/ml - EDITABLE at counter
  total: number;
  profit: number;

  deductionMain: number; // deduct from stock - e.g., 0.1 Box for 1 Patta
  deductionPatta: number;

  userId: Types.ObjectId;
  customerName?: string; 
  paymentType?: string;
  status?: "paid"|"pending"|"partial"; 
  isCredit?: boolean;
  localId?: string;
}

const SaleSchema = new Schema<ISale>({
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  productName: { type: String, required: true },
  mainUnit: { type: String, enum: ["box","bottle","tube","piece"], required: true },
  sellUnit: { type: String, enum: ["patta","half_patta","box","bottle","ml","tube","piece"], required: true, default: "patta" },
  quantity: { type: Number, required: true, min: 0.001 },

  pattaPerBox: { type: Number, default: 10 },
  mlPerBottle: { type: Number, default: 120 },

  buyPriceMain: { type: Number, required: true },
  sellPrice: { type: Number, required: true }, // EDITABLE
  total: { type: Number, required: true },
  profit: { type: Number, required: true },
  deductionMain: { type: Number, default: 0 },
  deductionPatta: { type: Number, default: 0 },

  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  customerName: { type: String, default: "Walk-in" },
  paymentType: { type: String, default: "cash", enum: ["cash","credit","udhar","jazzcash","easypaisa","card"] },
  status: { type: String, enum: ["paid","pending","partial"], default: "paid" },
  isCredit: { type: Boolean, default: false },
  localId: { type: String, sparse: true },
}, { timestamps: true });

SaleSchema.pre("validate", function(){
  const qty = this.quantity || 0;
  const ppb = this.pattaPerBox || 10;
  const mlB = this.mlPerBottle || 120;

  let deductMain = 0;
  let profit = 0;
  let total = 0;
  let deductPatta = 0;

  if(this.mainUnit === "box"){
    const buyPerPatta = this.buyPriceMain / ppb;
    const buyPerHalf = buyPerPatta / 2;
    if(this.sellUnit === "patta"){
      deductMain = qty / ppb;
      total = this.sellPrice * qty;
      profit = (this.sellPrice - buyPerPatta) * qty;
      deductPatta = qty;
    } else if(this.sellUnit === "half_patta"){
      deductMain = (qty * 0.5) / ppb;
      total = this.sellPrice * qty;
      profit = (this.sellPrice - buyPerHalf) * qty;
      deductPatta = qty * 0.5;
    } else { // box
      deductMain = qty;
      total = this.sellPrice * qty;
      profit = (this.sellPrice - this.buyPriceMain) * qty;
      deductPatta = qty * ppb;
    }
  } else {
    if(this.sellUnit === "ml"){
      const buyPerMl = this.buyPriceMain / mlB;
      deductMain = qty / mlB;
      total = this.sellPrice * qty;
      profit = (this.sellPrice - buyPerMl) * qty;
    } else {
      deductMain = qty;
      total = this.sellPrice * qty;
      profit = (this.sellPrice - this.buyPriceMain) * qty;
    }
  }

  this.deductionMain = Math.round(deductMain * 1000) / 1000;
  this.deductionPatta = Math.round(deductPatta * 1000) / 1000;
  this.total = Math.round(total);
  this.profit = Math.round(profit);
});

SaleSchema.index({ userId: 1, createdAt: -1 });

const Sale = (models.Sale as Model<ISale>) || model<ISale>("Sale", SaleSchema);
export default Sale;