import { Schema, model, models, type Model, Types } from "mongoose";

export type MainUnit = "box" | "bottle" | "tube" | "piece";

export interface IProduct {
  name: string; company: string; generic: string;
  batchNo: string; expiryDate?: Date; barcode?: string; rack?: string;

  mainUnit: MainUnit; // STOCK unit only - Box / Bottle / Tube / Piece
  pattaPerBox: number; // 1 box = 10 patta
  mlPerBottle: number; // 1 bottle = 120ml

  buyPrice: number; // per BOX / BOTTLE / TUBE / PIECE
  sellPrice: number; // per PATTA if main=box, else per Bottle/Tube/Piece
  stock: number; // e.g. 40 means 40 Box / 40 Bottle

  stockDisplay?: string;
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
  batchNo: { type: String, default: "", trim: true },
  expiryDate: { type: Date },
  barcode: { type: String, sparse: true, trim: true },
  rack: { type: String, default: "", trim: true },

  mainUnit: { type: String, enum: ["box","bottle","tube","piece"], required: true, default: "box" },
  pattaPerBox: { type: Number, default: 10, min: 1 },
  mlPerBottle: { type: Number, default: 120, min: 1 },

  buyPrice: { type: Number, required: true, default: 0 },
  sellPrice: { type: Number, required: true, default: 0 },
  stock: { type: Number, required: true, default: 0, min: 0 },

  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  localId: { type: String, sparse: true, index: true },
  synced: { type: Boolean, default: true },
  lastSyncedAt: { type: Date, default: Date.now },
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

ProductSchema.virtual("profit").get(function(){
  if(this.mainUnit === "box"){
    const buyPerPatta = this.buyPrice / (this.pattaPerBox || 10);
    return Math.round((this.sellPrice - buyPerPatta) * 100) / 100;
  }
  return Math.round((this.sellPrice - this.buyPrice) * 100) / 100;
});

ProductSchema.virtual("sellPricePatta").get(function(){
  return this.mainUnit === "box" ? this.sellPrice : 0;
});
ProductSchema.virtual("sellPriceHalfPatta").get(function(){
  return this.mainUnit === "box" ? Math.round((this.sellPrice / 2) * 100) / 100 : 0;
});
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
  if(this.mainUnit === "tube") return `${this.stock} Tube`;
  return `${this.stock} Piece`;
});

ProductSchema.pre("save", function(){
  if(!this.pattaPerBox) this.pattaPerBox = 10;
  if(!this.mlPerBottle) this.mlPerBottle = 120;
});

ProductSchema.index({ userId: 1, name: 1 });

const Product = (models.Product as Model<IProduct>) || model<IProduct>("Product", ProductSchema);
export default Product;