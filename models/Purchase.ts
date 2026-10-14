import mongoose from "mongoose";

const PurchaseItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
  name: { type: String, required: true },
  company: String,
  quantity: { type: Number, required: true }, // how many box/bottle bought
  mainUnit: { type: String, enum: ["box","bottle","tube","piece"], default: "box" },
  buyPricePerUnit: { type: Number, required: true },
  sellPricePerUnit: Number,
  totalBuy: Number, // quantity * buyPrice
}, {_id:false});

const PurchaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  supplier: { type: String, default: "Local Market" },
  invoiceNo: String,
  totalBuyAmount: { type: Number, required: true }, // total kharidari
  totalItems: Number,
  items: [PurchaseItemSchema],
  paymentType: { type: String, enum: ["cash","credit"], default: "cash" },
  createdAt: { type: Date, default: Date.now, index: true }
});

export default mongoose.models.Purchase || mongoose.model("Purchase", PurchaseSchema);