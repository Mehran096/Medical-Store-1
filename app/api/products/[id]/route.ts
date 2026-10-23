import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import Batch from "@/models/Batch";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };
type MainUnit = "box" | "bottle" | "tube" | "piece";

type ProductBody = {
  name?: string; company?: string; generic?: string;
  batchNo?: string; expiryDate?: string;
  barcode?: string; rack?: string;
  mainUnit?: MainUnit; pattaPerBox?: number; mlPerBottle?: number;
  buyPrice?: number; sellPrice?: number;
  stock?: number; quantity?: number;
};

type BatchLean = { _id: Types.ObjectId; batchNo: string; expiryDate: Date; quantity: number };
type ProductLean = { _id: Types.ObjectId; stock: number; expiryDate?: Date; batchNo?: string; nearestExpiry?: Date };

function isValidObjectId(id: string): boolean { return Types.ObjectId.isValid(id); }

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isValidObjectId(id)) return NextResponse.json({ message: "Invalid ID format" }, { status: 400 });
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const userId = new Types.ObjectId(session.user.id);
    const product = await Product.findOne({ _id: id, userId }).lean();
    if (!product) return NextResponse.json({ message: "Product not found" }, { status: 404 });
    const batches = await Batch.find({ productId: product._id, userId, quantity: { $gt: 0 } }).sort({ expiryDate: 1 }).lean<BatchLean[]>();
    return NextResponse.json({ ...product, batches });
  } catch {
    return NextResponse.json({ message: "Failed to fetch" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isValidObjectId(id)) return NextResponse.json({ message: "Invalid ID format" }, { status: 400 });
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const userId = new Types.ObjectId(session.user.id);
    const body = (await req.json()) as ProductBody;

    const updateData: Record<string, string | number | Date | boolean> = { lastSyncedAt: new Date(), synced: true };
    if (body.name) updateData.name = body.name.trim();
    if (body.company) updateData.company = body.company.trim();
    if (body.generic !== undefined) updateData.generic = body.generic.trim();
    if (body.barcode !== undefined) updateData.barcode = body.barcode.trim();
    if (body.rack !== undefined) updateData.rack = body.rack.trim();
    if (body.mainUnit) updateData.mainUnit = body.mainUnit;
    if (body.pattaPerBox !== undefined) updateData.pattaPerBox = Number(body.pattaPerBox);
    if (body.mlPerBottle !== undefined) updateData.mlPerBottle = Number(body.mlPerBottle);
    if (body.sellPrice !== undefined) updateData.sellPrice = Number(body.sellPrice);
    if (body.buyPrice !== undefined) updateData.buyPriceAvg = Number(body.buyPrice);

    const updated = await Product.findOneAndUpdate({ _id: id, userId }, updateData, { new: true, runValidators: true }).lean<ProductLean>();
    if (!updated) return NextResponse.json({ message: "Product not found" }, { status: 404 });

    // FIXED: update batch if batchNo/expiry/buyPrice/stock/quantity provided
    if (body.batchNo || body.expiryDate || body.buyPrice !== undefined || body.stock !== undefined || body.quantity !== undefined) {
      let targetBatch = null;
      if (body.batchNo) {
        const trimmed = String(body.batchNo).trim();
        const esc = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        targetBatch = await Batch.findOne({ productId: updated._id, userId, batchNo: { $regex: `^${esc}$`, $options: "i" } });
      }
      if (!targetBatch) {
        targetBatch = await Batch.findOne({ productId: updated._id, userId }).sort({ expiryDate: 1 });
      }
      if (targetBatch) {
        if (body.batchNo) targetBatch.batchNo = String(body.batchNo).trim();
        if (body.expiryDate) targetBatch.expiryDate = new Date(body.expiryDate);
        if (body.buyPrice !== undefined) targetBatch.buyPrice = Number(body.buyPrice);
        if (body.stock !== undefined) targetBatch.quantity = Number(body.stock);
        else if (body.quantity !== undefined) targetBatch.quantity = Number(body.quantity);
        await targetBatch.save();
      }
    }

    // ALWAYS recalc stock = sum batches — fixes 5 box bug
    const allBatches = await Batch.find({ productId: updated._id, userId, quantity: { $gt: 0 } }).sort({ expiryDate: 1 }).lean<BatchLean[]>();
    const sumQty = allBatches.reduce((s, b) => s + b.quantity, 0);
    const earliest = allBatches[0];

    await Product.updateOne(
      { _id: updated._id, userId },
      {
        $set: {
          stock: Math.round(sumQty * 1000000) / 1000000,
          nearestExpiry: earliest?.expiryDate ?? null,
          expiryDate: earliest?.expiryDate ?? null,
          batchNo: earliest?.batchNo ?? "",
        },
      }
    );

    const batches = await Batch.find({ productId: updated._id, userId }).sort({ expiryDate: 1 }).lean<BatchLean[]>();
    const refreshed = await Product.findById(updated._id).lean();
    return NextResponse.json({ ...refreshed, batches });
  } catch (error) {
    console.error("PUT error:", error);
    return NextResponse.json({ message: "Failed to update" }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isValidObjectId(id)) return NextResponse.json({ message: "Invalid ID format" }, { status: 400 });
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const productId = new Types.ObjectId(id);
    const userId = new Types.ObjectId(session.user.id);
    const deleted = await Product.findOneAndDelete({ _id: productId, userId });
    if (!deleted) return NextResponse.json({ message: "Product not found" }, { status: 404 });
    await Batch.deleteMany({ productId, userId });
    return NextResponse.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("DELETE error:", error);
    return NextResponse.json({ message: "Failed to delete" }, { status: 400 });
  }
}