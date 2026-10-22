import { Schema, model, models, type Model, Types } from "mongoose";

export type MainUnit = "box" | "bottle" | "tube" | "piece";

export interface IProduct {
  name: string; company: string; generic: string;
  barcode?: string; rack?: string;
  mainUnit: MainUnit;
  pattaPerBox: number;
  mlPerBottle: number;
  sellPrice: number;
  buyPriceAvg: number;
  stock: number;
  stockDisplay?: string;
  nearestExpiry?: Date;
  expiryDate?: Date; // FIXED: add - used in recalc
  batchNo?: string; // FIXED: add - used in recalc
  buyPrice?: number; // FIXED: add - legacy field
  sellPriceBox?: number;
  sellPriceHalfPatta?: number;
  sellPricePatta?: number;
  profit?: number;
  userId: Types.ObjectId;
  localId?: string; synced?: boolean; lastSyncedAt?: Date;
}

const ProductSchema = new Schema<IProduct>({
  name: { type: String, required: true, trim: true },
  company: { type: String, default: "Unknown", trim: true },
  generic: { type: String, default: "", trim: true },
  barcode: { type: String, sparse: true, trim: true },
  rack: { type: String, default: "", trim: true },

  mainUnit: { type: String, enum: ["box","bottle","tube","piece"], required: true, default: "box" },
  pattaPerBox: { type: Number, default: 10, min: 1 },
  mlPerBottle: { type: Number, default: 120, min: 1 },

  sellPrice: { type: Number, required: true, default: 0 },
  buyPriceAvg: { type: Number, required: true, default: 0 },
  buyPrice: { type: Number, default: 0 }, // legacy
  stock: { type: Number, required: true, default: 0, min: 0 },
  nearestExpiry: { type: Date, index: true },
  expiryDate: { type: Date, index: true }, // NEW
  batchNo: { type: String, trim: true }, // NEW

  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  localId: { type: String, sparse: true, index: true },
  synced: { type: Boolean, default: true },
  lastSyncedAt: { type: Date, default: Date.now },
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true }, strict: false }); // allow extra

ProductSchema.index({ userId: 1, name: 1, company: 1 }, { unique: false });
ProductSchema.index({ name: "text", company: "text", generic: "text" });

ProductSchema.virtual("profit").get(function(){
  if(this.mainUnit === "box"){
    const buyPerPatta = (this.buyPriceAvg || 0) / (this.pattaPerBox || 10);
    return Math.round((this.sellPrice - buyPerPatta) * 100) / 100;
  }
  return Math.round((this.sellPrice - (this.buyPriceAvg || 0)) * 100) / 100;
});
ProductSchema.virtual("sellPricePatta").get(function(){ return this.mainUnit === "box" ? this.sellPrice : 0; });
ProductSchema.virtual("sellPriceHalfPatta").get(function(){ return this.mainUnit === "box" ? Math.round((this.sellPrice / 2) * 100) / 100 : 0; });
ProductSchema.virtual("sellPriceBox").get(function(){
  if(this.mainUnit !== "box") return this.sellPrice;
  return Math.round(this.sellPrice * (this.pattaPerBox || 10) * 100) / 100;
});
ProductSchema.virtual("stockDisplay").get(function(){
  if(this.mainUnit === "box"){
    const totalPatta = Math.floor((this.stock || 0) * (this.pattaPerBox || 10));
    return `${this.stock} Box (${totalPatta} Patta)`;
  }
  if(this.mainUnit === "bottle"){
    const totalMl = (this.stock || 0) * (this.mlPerBottle || 120);
    return `${this.stock} Bottle (${totalMl} ml)`;
  }
  return `${this.stock} ${this.mainUnit}`;
});

const Product = (models.Product as Model<IProduct>) || model<IProduct>("Product", ProductSchema);
export default Product;