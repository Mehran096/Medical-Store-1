import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import Batch from "@/models/Batch";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LeanProduct = { _id: Types.ObjectId; name: string; company?: string; sellPrice?: number; mainUnit?: string; };
type ExpiringBatchResponse = { _id: string; productId: string; productName: string; company: string; sellPrice: number; mainUnit: string; batchNo: string; expiryDate: Date; buyPrice: number; quantity: number; };
type LeanBatch = { _id: Types.ObjectId; productId: Types.ObjectId; batchNo: string; expiryDate: Date; buyPrice: number; quantity: number; };

function escapeRegex(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const userObjectId = new Types.ObjectId(session.user.id);
    const expiringDays = req.nextUrl.searchParams.get("expiring");
    if (expiringDays) {
      const days = parseInt(expiringDays, 10);
      const future = new Date(); future.setDate(future.getDate() + days);
      const batches = await Batch.find({ userId: userObjectId, quantity: { $gt: 0.0001 }, expiryDate: { $lte: future } }).sort({ expiryDate: 1 }).limit(150).lean<LeanBatch[]>();
      const productIdStrings = [...new Set(batches.map(b => String(b.productId)))];
      const productObjectIds = productIdStrings.map(id => new Types.ObjectId(id));
      const products = await Product.find({ _id: { $in: productObjectIds } }).select("name company sellPrice mainUnit").lean<LeanProduct[]>();
      const prodMap = new Map<string, LeanProduct>(products.map(p => [String(p._id), p]));
      const result: ExpiringBatchResponse[] = batches.map(b => {
        const prod = prodMap.get(String(b.productId));
        return { _id: String(b._id), productId: String(b.productId), productName: prod?.name ?? b.batchNo, company: prod?.company ?? "", sellPrice: prod?.sellPrice ?? 0, mainUnit: prod?.mainUnit ?? "box", batchNo: b.batchNo, expiryDate: b.expiryDate, buyPrice: b.buyPrice, quantity: b.quantity };
      });
      return NextResponse.json(result);
    }
    const batches = await Batch.find({ userId: userObjectId, quantity: { $gt: 0.0001 } }).sort({ expiryDate: 1 }).limit(200).lean();
    return NextResponse.json(batches);
  } catch (e) { console.error("GET /api/batches", e); return NextResponse.json([], { status: 200 }); }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const body = await req.json() as { productId: string; batchNo: string; expiryDate: string; buyPrice?: number; quantity?: number; localId?: string; };
    const { productId, batchNo, expiryDate, buyPrice, quantity, localId } = body;
    if (!productId || !batchNo || !expiryDate) return NextResponse.json({ error: "productId, batchNo, expiryDate required" }, { status: 400 });

    const userObjectId = new Types.ObjectId(session.user.id);
    let prodObjectId: Types.ObjectId;
    if (Types.ObjectId.isValid(productId)) { prodObjectId = new Types.ObjectId(productId); }
    else {
      const prod = await Product.findOne({ localId: productId, userId: userObjectId }).lean<LeanProduct>();
      if (!prod) return NextResponse.json({ error: "Product not found for batch" }, { status: 404 });
      prodObjectId = prod._id;
    }

    if (localId) {
      const existingByLocal = await Batch.findOne({ localId, userId: userObjectId }).lean();
      if (existingByLocal) return NextResponse.json(existingByLocal, { status: 200 });
    }

    const trimmedBatchNo = String(batchNo).trim();
    const expiryDateObj = new Date(expiryDate);
    const expiryDay = expiryDateObj.toISOString().slice(0,10);
    const startDay = new Date(expiryDay);
    const endDay = new Date(new Date(expiryDay).getTime() + 24*60*60*1000 -1);

    // FIXED: find by batchNo (case-insensitive) + expiry DAY - prevents 5→15 overwrite
    const existingBatch = await Batch.findOne({
      productId: prodObjectId,
      batchNo: { $regex: `^${escapeRegex(trimmedBatchNo)}$`, $options: 'i' },
      expiryDate: { $gte: startDay, $lte: endDay },
      userId: userObjectId,
    });

    if (existingBatch) {
      // SAME batchNo + SAME expiry DAY → ADD qty, DON'T overwrite expiryDate
      existingBatch.quantity = Math.round((existingBatch.quantity + (Number(quantity) || 0)) * 1000) / 1000;
      existingBatch.buyPrice = Number(buyPrice) || existingBatch.buyPrice;
      await existingBatch.save();
      
      const allBatches = await Batch.find({ productId: prodObjectId, userId: userObjectId, quantity: { $gt: 0.0001 } }).lean<LeanBatch[]>();
      const sumQty = allBatches.reduce((s,b)=>s+b.quantity,0);
      const earliest = allBatches.sort((a,b)=> new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())[0];
      await Product.updateOne({ _id: prodObjectId }, { $set: { stock: Math.round(sumQty*1000)/1000, nearestExpiry: earliest?.expiryDate, expiryDate: earliest?.expiryDate, batchNo: earliest?.batchNo } });
      return NextResponse.json(existingBatch, { status: 200 });
    }

    const batch = await Batch.create({
      productId: prodObjectId, batchNo: trimmedBatchNo, expiryDate: expiryDateObj, buyPrice: Number(buyPrice) || 0, quantity: Math.round((Number(quantity) || 0)*1000)/1000, userId: userObjectId, localId: localId || undefined,
    });

    const allBatches = await Batch.find({ productId: prodObjectId, userId: userObjectId, quantity: { $gt: 0.0001 } }).lean<LeanBatch[]>();
    const sumQty = allBatches.reduce((s,b)=>s+b.quantity,0);
    const earliest = allBatches.sort((a,b)=> new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())[0];
    await Product.updateOne({ _id: prodObjectId }, { $set: { stock: Math.round(sumQty*1000)/1000, nearestExpiry: earliest?.expiryDate, expiryDate: earliest?.expiryDate, batchNo: earliest?.batchNo } });

    return NextResponse.json(batch, { status: 201 });
  } catch (e) { console.error("POST /api/batches", e); return NextResponse.json({ error: "Failed to create batch" }, { status: 500 }); }
}