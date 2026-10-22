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

type BatchDoc = {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  batchNo: string;
  expiryDate: Date;
  buyPrice: number;
  quantity: number;
};

function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id);
}
function normalizeName(name: string | undefined): string {
  return (name || "Walk-in").trim() || "Walk-in";
}
function calcDeduction(mainUnit: MainUnit, sellUnit: SellUnit, qty: number, ppb: number, mlB: number): number {
  let d = 0;
  if (mainUnit === "box") {
    if (sellUnit === "patta") d = qty / ppb;
    else if (sellUnit === "half_patta") d = (qty * 0.5) / ppb;
    else d = qty;
  } else {
    d = sellUnit === "ml" ? qty / mlB : qty;
  }
  return Math.round(d * 1000) / 1000;
}
function getNeedPatta(mainUnit: MainUnit, sellUnit: SellUnit, qty: number, ppb: number): number {
  if (mainUnit !== "box") return qty;
  if (sellUnit === "patta") return qty;
  if (sellUnit === "half_patta") return qty * 0.5;
  return qty * ppb;
}
async function recalcProductStock(productId: Types.ObjectId, userId: Types.ObjectId) {
  const batches = await Batch.find({ productId, userId, quantity: { $gt: 0.0001 } });
  const sum = batches.reduce((s, b) => s + b.quantity, 0);
  const earliest = [...batches].sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())[0];
  await Product.updateOne(
    { _id: productId, userId },
    {
      $set: {
        stock: Math.round(sum * 1000) / 1000,
        nearestExpiry: earliest?.expiryDate,
        expiryDate: earliest?.expiryDate,
        batchNo: earliest?.batchNo,
        lastSyncedAt: new Date(),
      },
    }
  );
  return { sum, earliest };
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
    const oldDeduct = Number(existingSale.deductionMain ?? 0);
    const oldBatchId = existingSale.batchId as Types.ObjectId | undefined;

    if (newQuantity < 0.001) return NextResponse.json({ error: "Valid quantity required" }, { status: 400 });

    const ppb = Number(existingSale.pattaPerBox ?? 10);
    const mlB = Number(existingSale.mlPerBottle ?? 120);
    const newDeduct = calcDeduction(newMainUnit, newSellUnit, newQuantity, ppb, mlB);

    if (oldBatchId && isValidObjectId(String(oldBatchId))) {
      await Batch.updateOne({ _id: oldBatchId, userId: userObjectId }, { $inc: { quantity: oldDeduct } });
    }

    const allBatchesForCheck = (await Batch.find({ productId: existingSale.productId, userId: userObjectId, quantity: { $gt: 0.0001 } }).sort({ expiryDate: 1 })) as BatchDoc[];
    const totalAvailable = allBatchesForCheck.reduce((s, b) => s + b.quantity, 0);

    // V20.9 FIX: patta based check
    const availPatta = getNeedPatta(newMainUnit, "box", totalAvailable, 1);
    const needPatta = getNeedPatta(newMainUnit, newSellUnit, newQuantity, ppb);
    if (availPatta + 0.001 < needPatta) {
      if (oldBatchId && isValidObjectId(String(oldBatchId))) {
        await Batch.updateOne({ _id: oldBatchId, userId: userObjectId }, { $inc: { quantity: -oldDeduct } });
      }
      return NextResponse.json({ error: `Only ${availPatta.toFixed(1)} patta (${totalAvailable.toFixed(3)} ${newMainUnit}) left, need ${needPatta.toFixed(1)} patta` }, { status: 400 });
    }

    let remaining = newDeduct;
    let firstBatchUsed: BatchDoc | null = null;
    for (const batch of allBatchesForCheck) {
      if (remaining <= 0) break;
      const take = Math.min(batch.quantity, remaining);
      await Batch.updateOne({ _id: batch._id, userId: userObjectId }, { $inc: { quantity: -take } });
      if (!firstBatchUsed) firstBatchUsed = batch;
      remaining = Math.round((remaining - take) * 1000) / 1000;
    }

    await recalcProductStock(existingSale.productId as Types.ObjectId, userObjectId);

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

    const buyPrice = Number(existingSale.buyPriceMain ?? 0);
    let total = 0;
    let profit = 0;
    if (newMainUnit === "box") {
      const buyPerPatta = buyPrice / ppb;
      if (newSellUnit === "patta") {
        total = Number(newSellPrice) * newQuantity;
        profit = (Number(newSellPrice) - buyPerPatta) * newQuantity;
      } else if (newSellUnit === "half_patta") {
        total = Number(newSellPrice) * newQuantity;
        profit = (Number(newSellPrice) - buyPerPatta / 2) * newQuantity;
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
      const newCustomerName = normalizeName(existingSale.customerName as string);
      const newNormalized = newCustomerName.toLowerCase();
      const newTotal = Math.round(existingSale.total);
      const amountDiff = newTotal - oldTotal;
      const oldCustomerName = normalizeName(existingSale.customerName as string);
      const oldNormalized = oldCustomerName.toLowerCase();
      const wasCredit = oldTotal !== 0 && (await Customer.exists({ userId: userObjectId, saleIds: existingSale._id, isPaid: false })) !== null;
      const isNowCredit = Boolean(existingSale.isCredit) || existingSale.status === "pending";
      if (wasCredit && !isNowCredit) {
        await Customer.findOneAndUpdate(
          { userId: userObjectId, saleIds: existingSale._id, isPaid: false },
          { $inc: { totalUdhar: -oldTotal, totalBusiness: -oldTotal, billsCount: -1 }, $pull: { saleIds: existingSale._id } }
        );
        await Customer.deleteOne({ userId: userObjectId, isPaid: false, billsCount: { $lte: 0 } });
      } else if (!wasCredit && isNowCredit) {
        await upsertKhataGrouped(userObjectId, newCustomerName, newTotal, existingSale._id as Types.ObjectId);
      } else if (wasCredit && isNowCredit) {
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
    const restoreQty = Number(saleDoc.deductionMain ?? saleDoc.quantity ?? 0);
    const productId = saleDoc.productId as Types.ObjectId;
    if (saleDoc.batchId && isValidObjectId(String(saleDoc.batchId))) {
      await Batch.updateOne({ _id: saleDoc.batchId, userId: userObjectId }, { $inc: { quantity: restoreQty } });
    } else if (saleDoc.batchNo) {
      await Batch.updateOne({ productId, batchNo: saleDoc.batchNo, userId: userObjectId }, { $inc: { quantity: restoreQty } });
    } else {
      const earliest = await Batch.findOne({ productId, userId: userObjectId }).sort({ expiryDate: 1 });
      if (earliest) await Batch.updateOne({ _id: earliest._id, userId: userObjectId }, { $inc: { quantity: restoreQty } });
    }
    await recalcProductStock(productId, userObjectId);
    if (saleDoc.isCredit || saleDoc.status === "pending" || saleDoc.paymentType === "credit") {
      try {
        const saleAmount = Math.round(saleDoc.total);
        const updated = await Customer.findOneAndUpdate(
          { userId: userObjectId, saleIds: saleDoc._id, isPaid: false },
          { $inc: { totalUdhar: -saleAmount, totalBusiness: -saleAmount, billsCount: -1 }, $pull: { saleIds: saleDoc._id } },
          { new: true }
        );
        if (updated && ((updated.totalUdhar ?? 0) <= 0.5 || (updated.billsCount ?? 0) <= 0)) {
          await Customer.deleteOne({ _id: updated._id });
        }
      } catch (e) {
        console.error("Khata DELETE error", e);
      }
    }
    await Sale.deleteOne({ _id: saleDoc._id, userId: userObjectId });
    return NextResponse.json({ message: "Sale deleted, stock restored", restored: restoreQty });
  } catch (error) {
    console.error("DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete sale" }, { status: 500 });
  }
}