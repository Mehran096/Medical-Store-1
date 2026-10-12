import { Schema, model, models, type Model, Types } from "mongoose";

export interface IProduct {
  name: string;
  company: string;
  generic: string;
  batchNo: string;
  expiryDate?: Date;
  barcode?: string;
  rack?: string;

  price: number;
  buyPrice: number;
  sellPrice: number;

  // V9: now includes ml/liter/gram/kg
  unit: "tablet" | "patta" | "half_patta" | "box" | "syrup" | "bottle" | "ml" | "liter" | "gram" | "kg" | "piece" | "capsule" | "injection" | "sachet" | "tube";
  baseUnit: "tablet" | "ml" | "gram" | "piece"; // what stock is stored in

  stock: number; // 500 tablets OR 1000 ml OR 500 gram

  tabletsPerPatta: number;
  pattaPerBox: number;

  // for ml/gram: 1 bottle = 120 ml, 1 tube = 20 gram
  qtyPerUnit: number;
  subUnit: string;
  baseQtyInSub: number;

  // virtuals
  stockInPatta?: string;
  profit?: number;
  pricePerPatta?: number;
  pricePerBox?: number;
  isExpired?: boolean;
  isNearExpiry?: boolean;

  userId: Types.ObjectId;
  localId?: string;
  synced?: boolean;
  lastSyncedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const ProductSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, trim: true },
    company: { type: String, required: true, default: "Unknown", trim: true },
    generic: { type: String, default: "", trim: true },
    batchNo: { type: String, default: "", trim: true },
    expiryDate: { type: Date },
    barcode: { type: String, trim: true, sparse: true },
    rack: { type: String, trim: true, default: "" },

    buyPrice: { type: Number, required: true, default: 0, min: 0 },
    sellPrice: { type: Number, required: true, default: 0, min: 0 },
    price: { type: Number, required: true, min: 0, default: 0 },

    unit: {
      type: String,
      enum: ["tablet", "patta", "half_patta", "box", "syrup", "bottle", "ml", "liter", "gram", "kg", "piece", "capsule", "injection", "sachet", "tube"],
      default: "tablet",
      trim: true
    },
    baseUnit: {
      type: String,
      enum: ["tablet", "ml", "gram", "piece"],
      default: "tablet",
    },

    stock: { type: Number, required: true, default: 0, min: 0 },

    tabletsPerPatta: { type: Number, default: 10, min: 1 },
    pattaPerBox: { type: Number, default: 10, min: 1 },

    qtyPerUnit: { type: Number, default: 1 },
    subUnit: { type: String, default: "tablet" },
    baseQtyInSub: { type: Number, default: 0 },

    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    localId: { type: String, sparse: true, index: true },
    synced: { type: Boolean, default: true },
    lastSyncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

ProductSchema.virtual("profit").get(function () {
  return (this.sellPrice || this.price || 0) - (this.buyPrice || 0);
});

ProductSchema.virtual("pricePerPatta").get(function () {
  if (this.baseUnit !== "tablet") return this.sellPrice;
  return (this.sellPrice || 0) * (this.tabletsPerPatta || 10);
});

ProductSchema.virtual("pricePerBox").get(function () {
  if (this.baseUnit !== "tablet") return this.sellPrice * (this.qtyPerUnit || 1);
  return (this.sellPrice || 0) * (this.tabletsPerPatta || 10) * (this.pattaPerBox || 10);
});

ProductSchema.virtual("stockInPatta").get(function () {
  // for ml/gram show liter/gram display
  if (this.baseUnit === "ml") {
    const bottles = Math.floor((this.stock || 0) / (this.qtyPerUnit || 120));
    const rem = (this.stock || 0) % (this.qtyPerUnit || 120);
    return `${bottles} Bottle ${rem} ml`;
  }
  if (this.baseUnit === "gram") {
    const tubes = Math.floor((this.stock || 0) / (this.qtyPerUnit || 20));
    const rem = (this.stock || 0) % (this.qtyPerUnit || 20);
    return `${tubes} Tube ${rem} g`;
  }

  // tablet logic - your original perfect logic
  let t = this.stock || 0;
  const perBox = (this.tabletsPerPatta || 10) * (this.pattaPerBox || 10);
  const boxes = Math.floor(t / perBox);
  t %= perBox;
  const pattas = Math.floor(t / (this.tabletsPerPatta || 10));
  t %= (this.tabletsPerPatta || 10);
  if (boxes > 0) return `${boxes} Box ${pattas} Patta ${t} Tab`;
  if (pattas > 0) return `${pattas} Patta ${t} Tab`;
  return `${t} Tablet`;
});

ProductSchema.virtual("isExpired").get(function () {
  if (!this.expiryDate) return false;
  return new Date(this.expiryDate) < new Date();
});

ProductSchema.virtual("isNearExpiry").get(function () {
  if (!this.expiryDate) return false;
  const diff = new Date(this.expiryDate).getTime() - Date.now();
  const days = diff / (1000 * 60 * 60 * 24);
  return days <= 60 && days >= 0;
});

ProductSchema.pre("save", function () {
  if (this.sellPrice) this.price = this.sellPrice;
  else if (this.price) this.sellPrice = this.price;
  if (!this.tabletsPerPatta) this.tabletsPerPatta = 10;
  if (!this.pattaPerBox) this.pattaPerBox = 10;
  
  // auto-set baseUnit
  if (["ml","liter","bottle","syrup"].includes(this.unit)) this.baseUnit = "ml";
  else if (["gram","kg","tube"].includes(this.unit)) this.baseUnit = "gram";
  else if (["piece","injection","capsule","sachet"].includes(this.unit)) this.baseUnit = "piece";
  else this.baseUnit = "tablet";

  if (!this.baseQtyInSub) this.baseQtyInSub = this.stock;
  
});

ProductSchema.index({ userId: 1, name: 1 });
ProductSchema.index({ userId: 1, createdAt: -1 });

const Product = (models.Product as Model<IProduct>) || model<IProduct>("Product", ProductSchema);
export default Product;