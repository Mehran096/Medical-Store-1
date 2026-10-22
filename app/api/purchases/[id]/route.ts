import dbConnect from "@/lib/mongodb";
import Purchase from "@/models/Purchase";
import Product from "@/models/Product";
import Batch from "@/models/Batch";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string }> };
type UpdateBody = { supplier?: string; invoiceNo?: string; paymentType?: "cash" | "credit"; };
type UpdateSet = { supplier?: string; invoiceNo?: string; paymentType?: "cash" | "credit"; };
type PurchaseItemDoc = { productId?: Types.ObjectId; quantity?: number; batchNo?: string; };

function getCleanId(raw: string): string {
  const trimmed = (raw || "").toString().trim();
  if (Types.ObjectId.isValid(trimmed)) return trimmed;
  const hexOnly = trimmed.replace(/[^a-fA-F0-9]/g, "");
  return hexOnly.length >= 24 ? hexOnly.slice(-24) : hexOnly;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();
  const { id } = await params;
  const cleanId = getCleanId(id);
  if (!Types.ObjectId.isValid(cleanId)) return NextResponse.json({ error: "Invalid id: " + id }, { status: 400 });
  const purchase = await Purchase.findOne({ _id: cleanId, userId: new Types.ObjectId(session.user.id) }).lean();
  if (!purchase) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(purchase);
}

export async function PUT(req: NextRequest, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();
  const { id } = await params;
  const cleanId = getCleanId(id);
  if (!Types.ObjectId.isValid(cleanId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const body = (await req.json()) as UpdateBody;
  const setFields: UpdateSet = {};
  if (typeof body.supplier === "string") setFields.supplier = body.supplier;
  if (typeof body.invoiceNo === "string") setFields.invoiceNo = body.invoiceNo;
  if (body.paymentType) setFields.paymentType = body.paymentType;
  if (Object.keys(setFields).length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  const updated = await Purchase.findOneAndUpdate(
    { _id: cleanId, userId: new Types.ObjectId(session.user.id) },
    { $set: setFields }, { new: true }
  );
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();
  const { id } = await params;
  const cleanId = getCleanId(id);
  if (!Types.ObjectId.isValid(cleanId)) return NextResponse.json({ error: "Invalid id: " + id }, { status: 400 });
  const userId = new Types.ObjectId(session.user.id);

  const deleted = await Purchase.findOneAndDelete({ _id: cleanId, userId });
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const items = (deleted.items || []) as PurchaseItemDoc[];
    // FIXED: aggregate same product+batch in deleted bill to avoid double subtract
    const agg = new Map<string, PurchaseItemDoc>();
    for (const it of items) {
      const key = `${String(it.productId)}_${String(it.batchNo || "").trim().toLowerCase()}`;
      const prev = agg.get(key);
      if (prev) agg.set(key, { ...prev, quantity: Number(prev.quantity || 0) + Number(it.quantity || 0) });
      else agg.set(key, { ...it, batchNo: String(it.batchNo || "").trim() });
    }

    for (const item of agg.values()) {
      const qty = Number(item.quantity || 0);
      const batchNo = String(item.batchNo || "").trim();
      if (!item.productId || qty <= 0) continue;

      if (batchNo) {
        // FIXED: case-insensitive find B26 vs b26
        const batch = await Batch.findOne({ 
          productId: item.productId, userId,
          batchNo: { $regex: `^${batchNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
        });
        if (batch) {
          const newQty = Math.round((batch.quantity - qty) * 1000) / 1000;
          if (newQty <= 0.0001) await Batch.deleteOne({ _id: batch._id, userId });
          else await Batch.updateOne({ _id: batch._id, userId }, { $set: { quantity: newQty } });
        }
      }

      // FIXED: recalc stock = SUM(batches) not $inc - prevents 5 → -5 → 10 double
      const allBatches = await Batch.find({ productId: item.productId, userId, quantity: { $gt: 0 } }).lean();
      const sumQty = allBatches.reduce((s, b) => s + (b as { quantity: number }).quantity, 0);
      const earliest = allBatches.sort((a,b) => new Date((a as { expiryDate: Date }).expiryDate).getTime() - new Date((b as { expiryDate: Date }).expiryDate).getTime())[0] as { expiryDate: Date; batchNo: string } | undefined;

      await Product.updateOne({ _id: item.productId, userId }, { 
        $set: { 
          stock: Math.round(sumQty*1000)/1000,
          nearestExpiry: earliest?.expiryDate,
          expiryDate: earliest?.expiryDate,
          batchNo: earliest?.batchNo,
          lastSyncedAt: new Date() 
        } 
      });
    }
  } catch (err) {
    console.error("Stock revert error on purchase delete:", err);
  }

  return NextResponse.json({ success: true });
}