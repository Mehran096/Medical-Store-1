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
type PurchaseItemDoc = { productId: Types.ObjectId | string; quantity: number; batchNo: string; expiryDate?: string | Date };
type BatchQuery = {
  productId: Types.ObjectId;
  userId: Types.ObjectId;
  batchNo: { $regex: string; $options: string };
  expiryDate?: { $gte: Date; $lt: Date };
};

function getCleanId(raw: string): string {
  const trimmed = raw.trim();
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
  const body = (await req.json()) as { supplier?: string; invoiceNo?: string; paymentType?: "cash" | "credit" };
  const updated = await Purchase.findOneAndUpdate(
    { _id: cleanId, userId: new Types.ObjectId(session.user.id) },
    { $set: body },
    { new: true }
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
    const agg = new Map<string, { qty: number; pid: Types.ObjectId; bNo: string; expiry?: Date }>();

    for (const it of items) {
      const bNo = String(it.batchNo).trim();
      const pid = toObjectId(it.productId);
      if (!bNo || !pid) continue;
      const expiry = it.expiryDate ? new Date(it.expiryDate) : undefined;
      const expiryDay = expiry ? expiry.toISOString().slice(0,10) : "no-expiry";
      const key = `${pid.toString()}_${bNo.toLowerCase()}_${expiryDay}`;
      const cur = agg.get(key);
      if (cur) cur.qty += Number(it.quantity);
      else agg.set(key, { qty: Number(it.quantity), pid, bNo, expiry });
    }

    for (const v of agg.values()) {
      const escaped = v.bNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const batchQuery: BatchQuery = {
        productId: v.pid,
        userId,
        batchNo: { $regex: `^${escaped}$`, $options: "i" },
      };
      if (v.expiry) {
        const day = v.expiry.toISOString().slice(0,10);
        batchQuery.expiryDate = {
          $gte: new Date(day),
          $lt: new Date(new Date(day).getTime() + 24*60*60*1000)
        };
      }
      const batch = await Batch.findOne(batchQuery);

      if (batch) {
        const newQty = Math.round(Math.max(0, batch.quantity - v.qty) * 1000000) / 1000000;
        if (newQty <= 0.001) await Batch.deleteOne({ _id: batch._id });
        else await Batch.updateOne({ _id: batch._id }, { $set: { quantity: newQty } });

        const allBatches = await Batch.find({ productId: v.pid, userId }).sort({ expiryDate: 1 }).lean();
        const sumQty = allBatches.reduce((acc: number, b: { quantity: number }) => acc + b.quantity, 0);
        const earliest = allBatches[0] as { expiryDate?: Date; batchNo?: string } | undefined;

        await Product.updateOne(
          { _id: v.pid, userId },
          {
            $set: {
              stock: Math.round(sumQty * 1000000) / 1000000,
              nearestExpiry: earliest?.expiryDate,
              expiryDate: earliest?.expiryDate,
              batchNo: earliest?.batchNo ?? "",
            },
          }
        );
      }
    }
  } catch (err) {
    console.error("Stock revert error:", err);
  }
  return NextResponse.json({ success: true });
}