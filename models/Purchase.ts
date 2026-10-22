import mongoose from "mongoose";

const PurchaseItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  name: { type: String, required: true, trim: true },
  company: { type: String, trim: true },
  quantity: { type: Number, required: true, min: 1 },
  mainUnit: { type: String, enum: ["box", "bottle", "tube", "piece"], default: "box" },
  batchNo: { type: String, required: true, trim: true },
  expiryDate: { type: Date, required: true },
  buyPricePerUnit: { type: Number, required: true, min: 0 },
  sellPricePerUnit: { type: Number, min: 0 },
  totalBuy: { type: Number, min: 0 },
}, { _id: false });

const PurchaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  supplier: { type: String, default: "Local Market", trim: true },
  invoiceNo: { type: String, trim: true },
  totalBuyAmount: { type: Number, required: true, min: 0 },
  totalItems: { type: Number, min: 0 },
  items: { type: [PurchaseItemSchema], required: true },
  paymentType: { type: String, enum: ["cash", "credit"], default: "cash" },
  localId: { type: String, index: true }, // for idempotency
}, { timestamps: true });

PurchaseSchema.index({ userId: 1, createdAt: -1 });

// Auto-calc totals only — NO Batch / Product update here
PurchaseSchema.pre("save", function() {
  if (this.items && this.items.length > 0) {
    this.items.forEach((item) => {
      item.totalBuy = item.quantity * item.buyPricePerUnit;
    });
    this.totalBuyAmount = this.items.reduce((sum, it) => sum + (it.totalBuy || 0), 0);
    this.totalItems = this.items.length;
  }
});

// REMOVED post("save") hook — batches/stock are handled in /api/purchases route
// This was causing double Batch + double stock (5→10, 15→25)

export default mongoose.models.Purchase || mongoose.model("Purchase", PurchaseSchema);