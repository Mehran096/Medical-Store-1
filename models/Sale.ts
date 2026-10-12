import { Schema, model, models, Types, type Model } from "mongoose";

export type SaleBaseUnit = "tablet" | "ml" | "gram" | "piece";

export interface ISale {
  productId: Types.ObjectId;
  productName: string;
  quantity: number;
  price: number;
  buyPrice: number;
  sellPrice: number;
  originalPrice: number;
  discount: number;
  profit: number;
  total: number;
  soldBy?: string;
  userId: Types.ObjectId;
  localId?: string;
  customerName?: string;
  paymentType?: string;
  synced?: boolean;
  offlineCreatedAt?: Date;
  
  unit?: string;
  baseUnit?: SaleBaseUnit;
  tabletsPerPatta?: number;
  pattaPerBox?: number;
  qtyPerUnit?: number;
  quantityInTablets: number;
  totalTablets: number;
  
  subUnit?: string;
  quantityInSub?: number;
  isPartialSale?: boolean;
  pricePerSub?: number;
  
  customerId?: Types.ObjectId;
  paidAmount?: number;
  pendingAmount?: number;
  status?: "paid" | "pending" | "partial";
  isCredit?: boolean;
  wusoolDate?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const SaleSchema = new Schema<ISale>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0.001 },
    price: { type: Number, required: true },
    buyPrice: { type: Number, required: true, default: 0 },
    sellPrice: { type: Number, required: true, default: 0 },
    originalPrice: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    profit: { type: Number, required: true, default: 0 },
    total: { type: Number, required: true },
    soldBy: { type: String, default: "shop" },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    unit: { 
      type: String, 
      default: "tablet",
      enum: ["tablet", "patta", "box", "half_patta", "syrup", "piece", "bottle", "capsule", "injection", "sachet", "tube", "ml", "liter", "gram", "kg"],
    },
    baseUnit: {
      type: String,
      enum: ["tablet", "ml", "gram", "piece"],
      default: "tablet",
    },
    tabletsPerPatta: { type: Number, default: 10 },
    pattaPerBox: { type: Number, default: 10 },
    qtyPerUnit: { type: Number, default: 1 },
    quantityInTablets: { type: Number, default: 0 },
    totalTablets: { type: Number, default: 0 },
    subUnit: { type: String, default: "" },
    quantityInSub: { type: Number, default: 0 },
    isPartialSale: { type: Boolean, default: false },
    pricePerSub: { type: Number, default: 0 },
    localId: { type: String, unique: true, sparse: true },
    customerName: { type: String, default: "Walk-in" },
    paymentType: { 
      type: String, 
      default: "cash", 
      enum: ["cash", "credit", "udhar", "jazzcash", "easypaisa", "card"],
    },
    synced: { type: Boolean, default: true },
    offlineCreatedAt: { type: Date },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    paidAmount: { type: Number, default: 0 },
    pendingAmount: { type: Number, default: 0 },
    status: { type: String, enum: ["paid", "pending", "partial"], default: "paid" },
    isCredit: { type: Boolean, default: false },
    wusoolDate: { type: Date },
  },
  { timestamps: true }
);

function detectBaseUnit(u: string): SaleBaseUnit {
  if (["ml","liter","bottle","syrup"].includes(u)) return "ml";
  if (["gram","kg","tube"].includes(u)) return "gram";
  if (["piece","injection","capsule","sachet"].includes(u)) return "piece";
  return "tablet";
}

SaleSchema.pre("validate", function () {
  if (this.paymentType === "credit" || this.paymentType === "udhar") {
    this.isCredit = true;
    if (this.status === "paid") this.status = "pending";
  } else {
    this.isCredit = false;
    this.status = "paid";
  }
  if (!this.originalPrice) this.originalPrice = this.sellPrice || this.price;

  if (!this.baseUnit) this.baseUnit = detectBaseUnit(this.unit || "tablet");
  const qty = this.quantity || 0;
  const tpp = this.tabletsPerPatta || 10;
  const ppb = this.pattaPerBox || 10;
  const qpu = this.qtyPerUnit || (this.baseUnit === "ml" ? 120 : this.baseUnit === "gram" ? 20 : 1);

  let totalBase = 0;
  let pricePerUnit = 0;
  const perBaseSell = this.sellPrice || 0;

  if (this.baseUnit === "tablet") {
    if (this.unit === 'tablet') totalBase = qty;
    else if (this.unit === 'patta') totalBase = qty * tpp;
    else if (this.unit === 'half_patta') totalBase = qty * (tpp/2);
    else if (this.unit === 'box') totalBase = qty * tpp * ppb;
    else totalBase = qty;
  } else if (this.baseUnit === "ml" || this.baseUnit === "gram") {
    if (["bottle","tube","box","liter","kg"].includes(this.unit || "")) totalBase = qty * qpu;
    else totalBase = qty;
  } else {
    totalBase = qty;
  }

  this.quantityInSub = Math.round(totalBase);
  if (this.baseUnit === "tablet") {
    this.quantityInTablets = Math.round(totalBase);
    this.totalTablets = Math.round(totalBase);
  } else {
    this.quantityInTablets = 0;
    this.totalTablets = 0;
  }

  if (!this.price || this.price === 0) {
    if (this.baseUnit === "tablet") {
      if (this.unit === 'tablet') pricePerUnit = perBaseSell;
      else if (this.unit === 'patta') pricePerUnit = perBaseSell * tpp;
      else if (this.unit === 'half_patta') pricePerUnit = perBaseSell * (tpp/2);
      else if (this.unit === 'box') pricePerUnit = perBaseSell * tpp * ppb;
      else pricePerUnit = perBaseSell;
    } else {
      if (["bottle","tube","box"].includes(this.unit || "")) pricePerUnit = perBaseSell * qpu;
      else pricePerUnit = perBaseSell;
    }
    this.price = pricePerUnit;
  }

  this.total = Math.round(this.price * this.quantity);
  this.profit = Math.round(((this.sellPrice || 0) - (this.buyPrice || 0)) * totalBase);
});

SaleSchema.index({ userId: 1, createdAt: -1 });
SaleSchema.index({ userId: 1, productName: 1 });
SaleSchema.index({ productId: 1, createdAt: -1 });
SaleSchema.index({ status: 1, customerName: 1 });
SaleSchema.index({ isCredit: 1, createdAt: -1 });

const Sale = (models.Sale as Model<ISale>) || model<ISale>("Sale", SaleSchema);
export default Sale;