import mongoose from "mongoose";

const PurchaseItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  name: { type: String, required: true, trim: true },
  company: { type: String, trim: true },
  
  quantity: { type: Number, required: true, min: 1 }, // in mainUnit
  mainUnit: { type: String, enum: ["box", "bottle", "tube", "piece"], default: "box" },
  
  // --- BATCH INFO (NEW - This fixes your 3-month alert) ---
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
}, { timestamps: true });

PurchaseSchema.index({ userId: 1, createdAt: -1 });

// Auto-calc totals
PurchaseSchema.pre("save", function() {
  if (this.items && this.items.length > 0) {
    this.items.forEach((item) => {
      item.totalBuy = item.quantity * item.buyPricePerUnit;
    });
    this.totalBuyAmount = this.items.reduce((sum, it) => sum + (it.totalBuy || 0), 0);
    this.totalItems = this.items.length;
  }
});

// --- AFTER PURCHASE: AUTO CREATE BATCH + UPDATE PRODUCT STOCK ---
PurchaseSchema.post("save", async function(doc) {
  const Batch = mongoose.models.Batch;
  const Product = mongoose.models.Product;
  if (!Batch || !Product) return;

  for (const item of doc.items) {
    // 1. Create Batch record
    await Batch.create({
      productId: item.productId,
      batchNo: item.batchNo,
      expiryDate: item.expiryDate,
      buyPrice: item.buyPricePerUnit,
      quantity: item.quantity,
      userId: doc.userId,
    });

    // 2. Increase total stock in Product + update avg buy price
    const product = await Product.findById(item.productId);
    if (product) {
      const oldStock = product.stock || 0;
      const oldAvg = product.buyPriceAvg || item.buyPricePerUnit;
      const newStock = oldStock + item.quantity;
      
      // Weighted average buy price
      const newAvg = newStock > 0 
        ? ((oldAvg * oldStock) + (item.buyPricePerUnit * item.quantity)) / newStock
        : item.buyPricePerUnit;

      product.stock = newStock;
      product.buyPriceAvg = Math.round(newAvg * 100) / 100;
      if (item.sellPricePerUnit) product.sellPrice = item.sellPricePerUnit;
      await product.save();
    }
  }
});

export default mongoose.models.Purchase || mongoose.model("Purchase", PurchaseSchema);