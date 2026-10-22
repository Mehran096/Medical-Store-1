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
type PurchaseItemDoc = { productId?: Types.ObjectId | string; quantity?: number; batchNo?: string; expiryDate?: Date | string };

function getCleanId(raw: string): string {
  const trimmed = (raw || "").toString().trim();
  if (Types.ObjectId.isValid(trimmed)) return trimmed;
  const hexOnly = trimmed.replace(/[^a-fA-F0-9]/g, "");
  return hexOnly.length >= 24 ? hexOnly.slice(-24) : hexOnly;
}
function toObjectId(id: unknown): Types.ObjectId | null {
  if (!id) return null;
  const s = String(id);
  return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();
  const { id } = await params;
  const cleanId = getCleanId(id);
  if (!Types.ObjectId.isValid(cleanId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
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
  const body = await req.json() as { supplier?: string; invoiceNo?: string; paymentType?: "cash" | "credit" };
  const updated = await Purchase.findOneAndUpdate(
    { _id: cleanId, userId: new Types.ObjectId(session.user.id) },
    { $set: body }, { new: true }
  );
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
    const items = deleted.items as PurchaseItemDoc[];
    // Group ONLY by batchNo (lowercase) - ignore expiry to avoid mismatch
    const agg = new Map<string, PurchaseItemDoc>();
    for (const it of items) {
      const key = String(it.batchNo||"").trim().toLowerCase();
      if (!key) continue;
      const prev = agg.get(key);
      if (prev) agg.set(key, { ...prev, quantity: Number(prev.quantity||0)+Number(it.quantity||0) });
      else agg.set(key, { ...it, batchNo: String(it.batchNo||"").trim() });
    }

    for (const item of agg.values()) {
      const qty = Number(item.quantity||0);
      const batchNo = String(item.batchNo||"").trim();
      const pidObj = toObjectId(item.productId);
      if (!batchNo || qty <= 0.0001) continue;

      const escaped = batchNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Most robust: find by batchNo + userId only
      const batch = await Batch.findOne({ userId, batchNo: { $regex: `^${escaped}$`, $options: 'i' } });

      if (batch) {
        const newQty = Math.round(Math.max(0, batch.quantity - qty) * 1000000) / 1000000;
        if (newQty <= 0.001) await Batch.deleteOne({ _id: batch._id });
        else await Batch.updateOne({ _id: batch._id }, { $set: { quantity: newQty } });
        
        const allBatches = await Batch.find({ productId: batch.productId, userId }).lean();
        const sumQty = allBatches.reduce((s, b) => s + (b as { quantity: number }).quantity, 0);
        await Product.updateOne({ _id: batch.productId, userId }, { $set: { stock: Math.round(sumQty*1000000)/1000000 } });
      }
    }
  } catch (err) {
    console.error("Stock revert error:", err);
  }
  return NextResponse.json({ success: true });
}