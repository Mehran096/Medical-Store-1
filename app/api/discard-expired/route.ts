import dbConnect from "@/lib/mongodb";
import Batch from "@/models/Batch";
import Product from "@/models/Product";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";
import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";

type Body = { batchId?: string; productId?: string; batchNo?: string; expiryDate?: string };
type BDoc = { _id: Types.ObjectId; productId: Types.ObjectId; batchNo: string; expiryDate: Date; quantity: number; save: () => Promise<void> };

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();
  const userId = new Types.ObjectId(session.user.id);
  const body = (await req.json()) as Body;
  let batch: BDoc | null = null;

  if (body.batchId && Types.ObjectId.isValid(body.batchId)) {
    batch = (await Batch.findOne({ _id: new Types.ObjectId(body.batchId), userId })) as BDoc | null;
  }
  if (!batch && body.productId && body.batchNo && Types.ObjectId.isValid(body.productId) && body.expiryDate) {
    const day = new Date(body.expiryDate).toISOString().slice(0,10);
    const s = new Date(day);
    const e = new Date(s.getTime()+86399999);
    batch = (await Batch.findOne({ productId: new Types.ObjectId(body.productId), batchNo: body.batchNo, expiryDate: { $gte: s, $lte: e }, userId })) as BDoc | null;
  }
  if (!batch && body.batchNo && body.expiryDate) {
    const day = new Date(body.expiryDate).toISOString().slice(0,10);
    const s = new Date(day);
    const e = new Date(s.getTime()+86399999);
    batch = (await Batch.findOne({ batchNo: body.batchNo, expiryDate: { $gte: s, $lte: e }, userId })) as BDoc | null;
  }
  if (!batch && body.batchNo) {
    batch = (await Batch.findOne({ batchNo: body.batchNo, userId, quantity: { $gt: 0.0001 } }).sort({ expiryDate: 1 })) as BDoc | null;
  }
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  batch.quantity = 0;
  await batch.save();

  const all = (await Batch.find({ productId: batch.productId, userId, quantity: { $gt: 0.0001 } })) as BDoc[];
  const sum = all.reduce((a,b)=>a+b.quantity,0);
  const earliest = [...all].sort((a,b)=>new Date(a.expiryDate).getTime()-new Date(b.expiryDate).getTime())[0];
  await Product.updateOne({ _id: batch.productId, userId }, { $set: { stock: Math.round(sum*1000)/1000, nearestExpiry: earliest?.expiryDate, expiryDate: earliest?.expiryDate, batchNo: earliest?.batchNo } });
  return NextResponse.json({ ok: true, newStock: sum });
}