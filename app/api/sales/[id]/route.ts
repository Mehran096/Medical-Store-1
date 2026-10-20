import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import Batch from "@/models/Batch";
import Sale from "@/models/Sale";
import Customer from "@/models/Customer";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };
type SaleStatus = "paid" | "pending" | "partial";
type MainUnit = "box" | "bottle" | "tube" | "piece";
type SellUnit = "patta" | "half_patta" | "box" | "bottle" | "ml" | "tube" | "piece";

type SaleUpdateBody = {
  quantity?: number;
  sellUnit?: SellUnit;
  mainUnit?: MainUnit;
  sellPrice?: number;
  customerName?: string;
  paymentType?: string;
  status?: SaleStatus;
  isCredit?: boolean;
};

function isValidObjectId(id: string): boolean { 
  return Types.ObjectId.isValid(id); 
}

function normalizeName(name: string | undefined): string { 
  return (name || "Walk-in").trim() || "Walk-in"; 
}

function calcDeduction(mainUnit: MainUnit, sellUnit: SellUnit, qty: number, ppb: number, mlB: number) {
  let deductionMain = 0;
  if (mainUnit === "box") {
    if (sellUnit === "patta") deductionMain = qty / ppb;
    else if (sellUnit === "half_patta") deductionMain = (qty * 0.5) / ppb;
    else deductionMain = qty;
  } else {
    deductionMain = sellUnit === "ml" ? qty / mlB : qty;
  }
  return Math.round(deductionMain * 1000) / 1000;
}

async function upsertKhataGrouped(userId: Types.ObjectId, name: string, amount: number, saleId: Types.ObjectId) {
  const safeName = normalizeName(name);
  const normalized = safeName.toLowerCase();
  return Customer.findOneAndUpdate(
    { userId, normalizedName: normalized, isPaid: false },
    {
      $setOnInsert: { name: safeName, normalizedName: normalized, userId, isPaid: false, paidAmount: 0 },
      $inc: { totalUdhar: Math.round(amount), totalBusiness: Math.round(amount), billsCount: 1 },
      $set: { lastUdharDate: new Date() },
      $addToSet: { saleIds: saleId },
    },
    { upsert: true, new: true }
  );
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isValidObjectId(id)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const sale = await Sale.findOne({ _id: id, userId: new Types.ObjectId(session.user.id) }).lean();
    if (!sale) return NextResponse.json({ error: "Sale not found" }, { status: 404 });
    return NextResponse.json(sale);
  } catch {
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isValidObjectId(id)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const body = (await req.json()) as SaleUpdateBody;
    const userObjectId = new Types.ObjectId(session.user.id);
    const existingSale = await Sale.findOne({ _id: id, userId: userObjectId });
    if (!existingSale) return NextResponse.json({ error: "Sale not found" }, { status: 404 });

    const newQuantity = body.quantity ?? existingSale.quantity;
    const newSellUnit = (body.sellUnit ?? existingSale.sellUnit) as SellUnit;
    const newMainUnit = (body.mainUnit ?? existingSale.mainUnit) as MainUnit;
    const newSellPrice = body.sellPrice ?? existingSale.sellPrice;
    const oldTotal = Math.round(existingSale.total);
    const oldDeduct = existingSale.deductionMain ?? 0;
    const oldBatchId = existingSale.batchId;

    if (newQuantity < 0.001) return NextResponse.json({ error: "Valid quantity required" }, { status: 400 });

    const ppb = existingSale.pattaPerBox ?? 10;
    const mlB = existingSale.mlPerBottle ?? 120;
    const newDeduct = calcDeduction(newMainUnit, newSellUnit, newQuantity, ppb, mlB);
    const diff = Math.round((newDeduct - oldDeduct) * 1000) / 1000;

    // STEP 1: Restore old batch quantity first
    if (oldBatchId) {
      await Batch.updateOne({ _id: oldBatchId }, { $inc: { quantity: oldDeduct } });
    }

    // STEP 2: Check stock for diff
    if (diff > 0.0001) {
      const product = await Product.findOne({ _id: existingSale.productId, userId: userObjectId });
      if (!product) {
        // rollback restore
        if (oldBatchId) await Batch.updateOne({ _id: oldBatchId }, { $inc: { quantity: -oldDeduct } });
        return NextResponse.json({ error: "Product not found" }, { status: 404 });
      }
      if (product.stock < diff - 0.0001) {
        if (oldBatchId) await Batch.updateOne({ _id: oldBatchId }, { $inc: { quantity: -oldDeduct } });
        return NextResponse.json({ error: `Only ${product.stock} ${newMainUnit} left` }, { status: 400 });
      }
    }

    // STEP 3: FIFO deduct from batches for new quantity
    const allBatches = await Batch.find({ 
      productId: existingSale.productId, 
      quantity: { $gt: 0 } 
    }).sort({ expiryDate: 1 });

    let remaining = newDeduct;
    let firstBatchUsed: typeof allBatches[0] | null = null;
    
    for (const batch of allBatches) {
      if (remaining <= 0) break;
      const take = Math.min(batch.quantity, remaining);
      await Batch.updateOne({ _id: batch._id }, { $inc: { quantity: -take } });
      if (!firstBatchUsed) firstBatchUsed = batch;
      remaining = Math.round((remaining - take) * 1000) / 1000;
    }

    if (remaining > 0.0001) {
      // Not enough batch stock - rollback
      if (firstBatchUsed) {
        // restore what we deducted
        for (const b of allBatches) {
          const wasDeducted = Math.min(b.quantity, newDeduct - remaining);
          if (wasDeducted > 0) await Batch.updateOne({ _id: b._id }, { $inc: { quantity: wasDeducted } });
        }
      }
      if (oldBatchId) await Batch.updateOne({ _id: oldBatchId }, { $inc: { quantity: -oldDeduct } });
      return NextResponse.json({ error: "Not enough batch stock" }, { status: 400 });
    }

    // STEP 4: Update product stock
    if (Math.abs(diff) > 0.0001) {
      await Product.findOneAndUpdate(
        { _id: existingSale.productId, userId: userObjectId },
        { $inc: { stock: -diff }, $set: { lastSyncedAt: new Date() } }
      );
    }

    const oldCustomerName = normalizeName(existingSale.customerName);
    const oldNormalized = oldCustomerName.toLowerCase();
    const oldIsCredit = existingSale.isCredit || existingSale.status === "pending";

    // STEP 5: Update sale fields with new batch info
    existingSale.quantity = newQuantity;
    existingSale.sellUnit = newSellUnit;
    existingSale.mainUnit = newMainUnit;
    existingSale.sellPrice = Number(newSellPrice);
    existingSale.deductionMain = newDeduct;
    existingSale.deductionPatta = newMainUnit === "box" ? newDeduct * ppb : 0;
    
    if (firstBatchUsed) {
      existingSale.batchId = firstBatchUsed._id;
      existingSale.batchNo = firstBatchUsed.batchNo;
      existingSale.expiryDate = firstBatchUsed.expiryDate;
      existingSale.buyPriceMain = firstBatchUsed.buyPrice;
    }

    if (body.customerName) existingSale.customerName = body.customerName.trim();
    if (body.paymentType) {
      const raw = body.paymentType.toLowerCase();
      const isCreditNow = raw === "credit" || raw === "udhar" || body.isCredit === true;
      existingSale.paymentType = isCreditNow ? "credit" : raw;
      existingSale.isCredit = isCreditNow;
      existingSale.status = isCreditNow ? "pending" : "paid";
    } else if (body.status) {
      existingSale.status = body.status;
      existingSale.isCredit = body.status === "pending";
    }

    // Recalculate total/profit based on new batch buyPrice
    const buyPrice = existingSale.buyPriceMain ?? 0;
    let total = 0;
    let profit = 0;
    if (newMainUnit === "box") {
      const buyPerPatta = buyPrice / ppb;
      if (newSellUnit === "patta") {
        total = Number(newSellPrice) * newQuantity;
        profit = (Number(newSellPrice) - buyPerPatta) * newQuantity;
      } else if (newSellUnit === "half_patta") {
        total = Number(newSellPrice) * newQuantity;
        profit = (Number(newSellPrice) - buyPerPatta/2) * newQuantity;
      } else {
        total = Number(newSellPrice) * newQuantity;
        profit = (Number(newSellPrice) - buyPrice) * newQuantity;
      }
    } else {
      total = Number(newSellPrice) * newQuantity;
      profit = (Number(newSellPrice) - buyPrice) * newQuantity;
    }
    existingSale.total = Math.round(total);
    existingSale.profit = Math.round(profit);

    await existingSale.save();

    try {
      const newIsCredit = existingSale.isCredit || existingSale.status === "pending";
      const newCustomerName = normalizeName(existingSale.customerName);
      const newNormalized = newCustomerName.toLowerCase();
      const newTotal = Math.round(existingSale.total);
      const amountDiff = newTotal - oldTotal;

      if (oldIsCredit && !newIsCredit) {
        await Customer.findOneAndUpdate(
          { userId: userObjectId, saleIds: existingSale._id, isPaid: false },
          { $inc: { totalUdhar: -oldTotal, totalBusiness: -oldTotal, billsCount: -1 }, $pull: { saleIds: existingSale._id } }
        );
        await Customer.deleteOne({ userId: userObjectId, isPaid: false, billsCount: { $lte: 0 } });
      } else if (!oldIsCredit && newIsCredit) {
        await upsertKhataGrouped(userObjectId, newCustomerName, newTotal, existingSale._id as Types.ObjectId);
      } else if (oldIsCredit && newIsCredit) {
        if (oldNormalized !== newNormalized) {
          await Customer.findOneAndUpdate(
            { userId: userObjectId, normalizedName: oldNormalized, isPaid: false },
            { $inc: { totalUdhar: -oldTotal, totalBusiness: -oldTotal, billsCount: -1 }, $pull: { saleIds: existingSale._id } }
          );
          await Customer.deleteOne({ userId: userObjectId, normalizedName: oldNormalized, isPaid: false, billsCount: { $lte: 0 } });
          await upsertKhataGrouped(userObjectId, newCustomerName, newTotal, existingSale._id as Types.ObjectId);
        } else if (amountDiff !== 0) {
          await Customer.findOneAndUpdate(
            { userId: userObjectId, normalizedName: newNormalized, isPaid: false },
            { $inc: { totalUdhar: amountDiff, totalBusiness: amountDiff }, $set: { lastUdharDate: new Date() } }
          );
        }
      }
    } catch (e) {
      console.error("Khata PUT error", e);
    }

    return NextResponse.json(existingSale);
  } catch (error) {
    console.error("PUT /api/sales/[id] error", error);
    return NextResponse.json({ error: "Failed to update sale" }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const userObjectId = new Types.ObjectId(session.user.id);
    let saleDoc = null;
    if (isValidObjectId(id)) saleDoc = await Sale.findOne({ _id: id, userId: userObjectId });
    if (!saleDoc) saleDoc = await Sale.findOne({ localId: id, userId: userObjectId });
    if (!saleDoc) return NextResponse.json({ error: "Sale not found" }, { status: 404 });

    const restoreQty = saleDoc.deductionMain ?? saleDoc.quantity;
    
    // Restore product stock
    await Product.findOneAndUpdate(
      { _id: saleDoc.productId, userId: userObjectId },
      { $inc: { stock: restoreQty }, $set: { lastSyncedAt: new Date() } }
    );

    // Restore batch stock - THIS WAS MISSING
    if (saleDoc.batchId) {
      await Batch.updateOne(
        { _id: saleDoc.batchId },
        { $inc: { quantity: restoreQty } }
      );
    } else {
      // Legacy sale without batchId - restore to earliest batch
      const earliest = await Batch.findOne({ productId: saleDoc.productId }).sort({ expiryDate: 1 });
      if (earliest) {
        await Batch.updateOne({ _id: earliest._id }, { $inc: { quantity: restoreQty } });
      }
    }

    if (saleDoc.isCredit || saleDoc.status === "pending" || saleDoc.paymentType === "credit") {
      try {
        const saleAmount = Math.round(saleDoc.total);
        const updated = await Customer.findOneAndUpdate(
          { userId: userObjectId, saleIds: saleDoc._id, isPaid: false },
          { $inc: { totalUdhar: -saleAmount, totalBusiness: -saleAmount, billsCount: -1 }, $pull: { saleIds: saleDoc._id } },
          { new: true }
        );
        if (updated) {
          if ((updated.totalUdhar ?? 0) <= 0.5 || (updated.billsCount ?? 0) <= 0) {
            await Customer.deleteOne({ _id: updated._id });
          } else if ((updated.totalUdhar ?? 0) < 0) {
            await Customer.updateOne({ _id: updated._id }, { $set: { totalUdhar: 0 } });
          }
        } else {
          const custName = normalizeName(saleDoc.customerName);
          await Customer.updateOne(
            { userId: userObjectId, normalizedName: custName.toLowerCase(), isPaid: false },
            { $inc: { totalUdhar: -saleAmount, totalBusiness: -saleAmount, billsCount: -1 } }
          );
          await Customer.deleteOne({
            userId: userObjectId,
            normalizedName: custName.toLowerCase(),
            isPaid: false,
            $or: [{ billsCount: { $lte: 0 } }, { totalUdhar: { $lte: 0.5 } }],
          });
        }
      } catch (e) {
        console.error("Khata DELETE error", e);
      }
    }

    await Sale.deleteOne({ _id: saleDoc._id, userId: userObjectId });
    return NextResponse.json({ message: "Sale deleted, stock restored" });
  } catch (error) {
    console.error("DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete sale" }, { status: 500 });
  }
}