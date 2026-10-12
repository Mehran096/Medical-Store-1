import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
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
type MedicalUnit = "tablet" | "patta" | "half_patta" | "box" | "bottle" | "syrup" | "ml" | "liter" | "gram" | "kg" | "tube" | "sachet" | "piece" | "capsule" | "injection";
type BaseUnit = "tablet" | "ml" | "gram" | "piece";

type SaleUpdateBody = {
  quantity?: number; sellPrice?: number; price?: number; customerName?: string;
  paymentType?: string; unit?: MedicalUnit; baseUnit?: BaseUnit; qtyPerUnit?: number;
  tabletsPerPatta?: number; pattaPerBox?: number; quantityInTablets?: number; quantityInSub?: number;
  status?: SaleStatus; isCredit?: boolean;
};

function isValidObjectId(id: string): boolean { return Types.ObjectId.isValid(id); }
function normalizeName(name: string | undefined): string { return (name || "Walk-in").trim() || "Walk-in"; }

function calcBaseQty(unit: MedicalUnit, baseUnit: BaseUnit, qty: number, tpp: number, ppb: number, qpu: number): number {
  if (baseUnit==="tablet"){ if(unit==='patta') return qty*tpp; if(unit==='half_patta') return qty*(tpp/2); if(unit==='box') return qty*tpp*ppb; return qty; }
  if (baseUnit==="ml"){ if(['bottle','box','liter','syrup'].includes(unit)) return qty*qpu; return qty; }
  if (baseUnit==="gram"){ if(['tube','box','kg'].includes(unit)) return qty*qpu; return qty; }
  return qty;
}
function calcPricePerUnit(unit: MedicalUnit, baseUnit: BaseUnit, perBase: number, tpp: number, ppb: number, qpu: number): number {
  if (baseUnit==="tablet"){ if(unit==='patta') return perBase*tpp; if(unit==='half_patta') return perBase*(tpp/2); if(unit==='box') return perBase*tpp*ppb; return perBase; }
  if (baseUnit==="ml"||baseUnit==="gram"){ if(["bottle","tube","box","liter","kg","syrup"].includes(unit)) return perBase*qpu; return perBase; }
  return perBase;
}

async function upsertKhataGrouped(userId: Types.ObjectId, name: string, amount: number, saleId: Types.ObjectId) {
  const safeName = normalizeName(name); const normalized = safeName.toLowerCase();
  return Customer.findOneAndUpdate({ userId, normalizedName: normalized, isPaid: false },
    { $setOnInsert: { name: safeName, normalizedName: normalized, userId, isPaid: false, paidAmount: 0 },
      $inc: { totalUdhar: Math.round(amount), totalBusiness: Math.round(amount), billsCount: 1 },
      $set: { lastUdharDate: new Date() }, $addToSet: { saleIds: saleId } },
    { upsert: true, new: true });
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params; if (!isValidObjectId(id)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  try { const session = await getServerSession(authOptions); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect(); const sale = await Sale.findOne({ _id: id, userId: new Types.ObjectId(session.user.id) }).lean();
    if (!sale) return NextResponse.json({ error: "Sale not found" }, { status: 404 }); return NextResponse.json(sale);
  } catch { return NextResponse.json({ error: "Failed to fetch" }, { status: 500 }); }
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params; if (!isValidObjectId(id)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  try { const session = await getServerSession(authOptions); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect(); const body = (await req.json()) as SaleUpdateBody; const userObjectId = new Types.ObjectId(session.user.id);
    const existingSale = await Sale.findOne({ _id: id, userId: userObjectId }); if (!existingSale) return NextResponse.json({ error: "Sale not found" }, { status: 404 });
    const newQuantity = body.quantity ?? existingSale.quantity;
    const newUnit = (body.unit as MedicalUnit) ?? (existingSale.unit as MedicalUnit) ?? "tablet";
    const newBaseUnit = (body.baseUnit as BaseUnit) ?? (existingSale.baseUnit as BaseUnit) ?? "tablet";
    const tpp = body.tabletsPerPatta ?? existingSale.tabletsPerPatta ?? 10; const ppb = body.pattaPerBox ?? existingSale.pattaPerBox ?? 10;
    const qpu = body.qtyPerUnit ?? existingSale.qtyPerUnit ?? (newBaseUnit==="ml"?120:newBaseUnit==="gram"?20:10);
    const newQtyInBase = body.quantityInTablets ?? body.quantityInSub ?? calcBaseQty(newUnit, newBaseUnit, newQuantity, tpp, ppb, qpu);
    const oldQtyInBase = existingSale.quantityInSub ?? existingSale.quantityInTablets ?? existingSale.totalTablets ?? existingSale.quantity;
    const newSellPrice = body.sellPrice ?? body.price ?? existingSale.sellPrice;
    const pricePerUnit = calcPricePerUnit(newUnit, newBaseUnit, newSellPrice, tpp, ppb, qpu);
    const newTotal = Math.round(pricePerUnit * newQuantity); const oldTotal = Math.round(existingSale.total);
    if (newQuantity < 0.001) return NextResponse.json({ error: "Valid quantity required" }, { status: 400 });
    const diffBase = newQtyInBase - oldQtyInBase;
    if (diffBase > 0.0001) { const product = await Product.findOne({ _id: existingSale.productId, userId: userObjectId }); if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });
      if (product.stock < diffBase - 0.0001) return NextResponse.json({ error: `Only ${product.stock} ${newBaseUnit} left` }, { status: 400 }); }
    if (Math.abs(diffBase) > 0.0001) await Product.findOneAndUpdate({ _id: existingSale.productId, userId: userObjectId }, { $inc: { stock: -diffBase }, $set: { lastSyncedAt: new Date() } });
    const buyPrice = existingSale.buyPrice || 0; const originalPrice = existingSale.originalPrice || newSellPrice;
    const oldCustomerName = normalizeName(existingSale.customerName); const oldNormalized = oldCustomerName.toLowerCase(); const oldIsCredit = existingSale.isCredit || existingSale.status === "pending";
    existingSale.quantity = newQuantity; existingSale.unit = newUnit; existingSale.baseUnit = newBaseUnit; existingSale.qtyPerUnit = qpu;
    existingSale.tabletsPerPatta = tpp; existingSale.pattaPerBox = ppb;
    existingSale.quantityInTablets = newBaseUnit==="tablet"?newQtyInBase:0; existingSale.totalTablets = newBaseUnit==="tablet"?newQtyInBase:0;
    existingSale.quantityInSub = newQtyInBase; existingSale.sellPrice = Number(newSellPrice); existingSale.price = Number(pricePerUnit);
    existingSale.total = newTotal; existingSale.profit = Math.round((Number(newSellPrice) - buyPrice) * newQtyInBase);
    existingSale.discount = Math.round((originalPrice - Number(newSellPrice)) * newQtyInBase); existingSale.originalPrice = Number(originalPrice);
    if (body.customerName) existingSale.customerName = body.customerName.trim();
    if (body.paymentType) { const rawType = body.paymentType.toLowerCase(); const isCreditNow = rawType === "credit" || rawType === "udhar" || body.isCredit === true;
      existingSale.paymentType = isCreditNow ? "credit" : rawType; existingSale.isCredit = isCreditNow; existingSale.status = isCreditNow ? "pending" : "paid";
      existingSale.paidAmount = isCreditNow ? 0 : newTotal; existingSale.pendingAmount = isCreditNow ? newTotal : 0;
    } else if (body.status) { existingSale.status = body.status; existingSale.isCredit = body.status === "pending"; existingSale.paidAmount = body.status === "pending" ? 0 : newTotal; existingSale.pendingAmount = body.status === "pending" ? newTotal : 0; }
    await existingSale.save();
    try { const newIsCredit = existingSale.isCredit || existingSale.status === "pending"; const newCustomerName = normalizeName(existingSale.customerName); const newNormalized = newCustomerName.toLowerCase(); const amountDiff = newTotal - oldTotal;
      if (oldIsCredit && !newIsCredit) { await Customer.findOneAndUpdate({ userId: userObjectId, saleIds: existingSale._id, isPaid: false }, { $inc: { totalUdhar: -oldTotal, totalBusiness: -oldTotal, billsCount: -1 }, $pull: { saleIds: existingSale._id } }); await Customer.deleteOne({ userId: userObjectId, isPaid: false, billsCount: { $lte: 0 } }); }
      else if (!oldIsCredit && newIsCredit) { await upsertKhataGrouped(userObjectId, newCustomerName, newTotal, existingSale._id as Types.ObjectId); }
      else if (oldIsCredit && newIsCredit) { if (oldNormalized !== newNormalized) { await Customer.findOneAndUpdate({ userId: userObjectId, normalizedName: oldNormalized, isPaid: false }, { $inc: { totalUdhar: -oldTotal, totalBusiness: -oldTotal, billsCount: -1 }, $pull: { saleIds: existingSale._id } }); await Customer.deleteOne({ userId: userObjectId, normalizedName: oldNormalized, isPaid: false, billsCount: { $lte: 0 } }); await upsertKhataGrouped(userObjectId, newCustomerName, newTotal, existingSale._id as Types.ObjectId); }
        else if (amountDiff !== 0) { await Customer.findOneAndUpdate({ userId: userObjectId, normalizedName: newNormalized, isPaid: false }, { $inc: { totalUdhar: amountDiff, totalBusiness: amountDiff }, $set: { lastUdharDate: new Date() } }); } }
    } catch (e) { console.error("Khata PUT error", e); }
    return NextResponse.json(existingSale);
  } catch { return NextResponse.json({ error: "Failed to update sale" }, { status: 400 }); }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params; try { const session = await getServerSession(authOptions); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect(); const userObjectId = new Types.ObjectId(session.user.id); let saleDoc = null; if (isValidObjectId(id)) saleDoc = await Sale.findOne({ _id: id, userId: userObjectId });
    if (!saleDoc) saleDoc = await Sale.findOne({ localId: id, userId: userObjectId }); if (!saleDoc) return NextResponse.json({ error: "Sale not found" }, { status: 404 });
    const restoreQty = saleDoc.quantityInSub ?? saleDoc.quantityInTablets ?? saleDoc.totalTablets ?? saleDoc.quantity;
    await Product.findOneAndUpdate({ _id: saleDoc.productId, userId: userObjectId }, { $inc: { stock: restoreQty }, $set: { lastSyncedAt: new Date() } });
    if (saleDoc.isCredit || saleDoc.status === "pending" || saleDoc.paymentType === "credit") { try { const saleAmount = Math.round(saleDoc.total);
        const updated = await Customer.findOneAndUpdate({ userId: userObjectId, saleIds: saleDoc._id, isPaid: false }, { $inc: { totalUdhar: -saleAmount, totalBusiness: -saleAmount, billsCount: -1 }, $pull: { saleIds: saleDoc._id } }, { new: true });
        if (updated) { if ((updated.totalUdhar ?? 0) <= 0.5 || (updated.billsCount ?? 0) <= 0) await Customer.deleteOne({ _id: updated._id }); else if ((updated.totalUdhar ?? 0) < 0) await Customer.updateOne({ _id: updated._id }, { $set: { totalUdhar: 0 } }); }
        else { const custName = normalizeName(saleDoc.customerName); await Customer.updateOne({ userId: userObjectId, normalizedName: custName.toLowerCase(), isPaid: false }, { $inc: { totalUdhar: -saleAmount, totalBusiness: -saleAmount, billsCount: -1 } });
          await Customer.deleteOne({ userId: userObjectId, normalizedName: custName.toLowerCase(), isPaid: false, $or: [{ billsCount: { $lte: 0 } }, { totalUdhar: { $lte: 0.5 } }] }); } } catch (e) { console.error("Khata DELETE error", e); } }
    await Sale.deleteOne({ _id: saleDoc._id, userId: userObjectId }); return NextResponse.json({ message: "Sale deleted, stock restored" });
  } catch (error) { console.error("DELETE error:", error); return NextResponse.json({ error: "Failed to delete sale" }, { status: 500 }); }
}