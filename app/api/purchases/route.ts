import dbConnect from "@/lib/mongodb";
import Purchase from "@/models/Purchase";
import Product from "@/models/Product";
import Batch from "@/models/Batch";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DateRange = { $gte: Date; $lt: Date; };
type PurchaseQuery = { userId: Types.ObjectId; createdAt?: DateRange; };
type BatchLean = { quantity: number; expiryDate: Date; batchNo: string };
type PurchaseItemInput = {
  productId?: string; name: string; company?: string; quantity: number;
  mainUnit?: "box" | "bottle" | "tube" | "piece";
  buyPricePerUnit: number; sellPricePerUnit?: number;
  batchNo?: string; expiryDate?: string; barcode?: string; rack?: string;
};
type PurchaseBody = {
  supplier?: string; invoiceNo?: string; paymentType?: "cash" | "credit";
  items: PurchaseItemInput[]; totalBuyAmount?: number; localId?: string; createdAt?: string;
};

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

function getPKTRange() {
  const now = new Date();
  const nowPKT = new Date(now.getTime() + PKT_OFFSET_MS);
  const y = nowPKT.getUTCFullYear(); const m = nowPKT.getUTCMonth(); const d = nowPKT.getUTCDate();
  const startTodayUTC = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startTomorrowUTC = new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startMonthUTC = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startYearUTC = new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0) - PKT_OFFSET_MS);
  return { startTodayUTC, startTomorrowUTC, startMonthUTC, startYearUTC };
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();
  const userId = new Types.ObjectId(session.user.id);
  const searchParams = req.nextUrl.searchParams;
  const filter = searchParams.get("filter") || "all";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(500, Math.max(1, parseInt(searchParams.get("limit") || "15", 10)));
  const skip = (page - 1) * limit;
  const { startTodayUTC, startTomorrowUTC, startMonthUTC, startYearUTC } = getPKTRange();
  let dateRange: DateRange | undefined;
  if (filter === "today") dateRange = { $gte: startTodayUTC, $lt: startTomorrowUTC };
  else if (filter === "monthly") dateRange = { $gte: startMonthUTC, $lt: startTomorrowUTC };
  else if (filter === "yearly") dateRange = { $gte: startYearUTC, $lt: startTomorrowUTC };
  const query: PurchaseQuery = { userId, ...(dateRange ? { createdAt: dateRange } : {}) };
  const [purchases, totalCount, agg] = await Promise.all([
    Purchase.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Purchase.countDocuments(query),
    Purchase.aggregate([{ $match: query }, { $group: { _id: null, total: { $sum: "$totalBuyAmount" } } }]),
  ]);
  const totalPurchase = agg.length > 0 ? (agg[0] as { total: number }).total : 0;
  return NextResponse.json({
    purchases, totalPurchase,
    pagination: { page, totalPages: Math.ceil(totalCount / limit) || 1, hasMore: skip + purchases.length < totalCount, totalCount },
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();
  const userId = new Types.ObjectId(session.user.id);
  const body = (await req.json()) as PurchaseBody;
  if (!body.items?.length) return NextResponse.json({ error: "items required" }, { status: 400 });

  for (const it of body.items) {
    if (!it.batchNo || !it.expiryDate) return NextResponse.json({ error: `batchNo and expiryDate required for ${it.name}` }, { status: 400 });
    if (Number(it.quantity) <= 0) return NextResponse.json({ error: `Invalid quantity for ${it.name}` }, { status: 400 });
  }

  if (body.localId) {
    const existing = await Purchase.findOne({ localId: body.localId, userId }).lean();
    if (existing) return NextResponse.json(existing, { status: 200 });
  }

  const calculatedTotal = body.items.reduce((sum, it) => sum + Number(it.quantity) * Number(it.buyPricePerUnit), 0);

  const aggMap = new Map<string, PurchaseItemInput>();
  for (const it of body.items) {
    const expiryDay = it.expiryDate ? new Date(it.expiryDate).toISOString().slice(0,10) : "no-expiry";
    const key = `${it.productId || it.name}_${String(it.batchNo).trim().toLowerCase()}_${expiryDay}`;
    const prev = aggMap.get(key);
    if (prev) aggMap.set(key, { ...prev, quantity: prev.quantity + Number(it.quantity) });
    else aggMap.set(key, { ...it, batchNo: String(it.batchNo).trim(), quantity: Number(it.quantity) });
  }

  try {
    const purchase = await Purchase.create({
      userId, supplier: body.supplier || "Peshawar Market", invoiceNo: body.invoiceNo,
      totalBuyAmount: body.totalBuyAmount || calculatedTotal, totalItems: aggMap.size,
      items: Array.from(aggMap.values()).map((it) => ({
        name: it.name, company: it.company, quantity: Number(it.quantity),
        mainUnit: it.mainUnit || "box", buyPricePerUnit: Number(it.buyPricePerUnit),
        sellPricePerUnit: it.sellPricePerUnit ? Number(it.sellPricePerUnit) : undefined,
        productId: it.productId && Types.ObjectId.isValid(it.productId) ? new Types.ObjectId(it.productId) : undefined,
        batchNo: String(it.batchNo).trim(), expiryDate: it.expiryDate ? new Date(it.expiryDate) : undefined,
        totalBuy: Number(it.quantity) * Number(it.buyPricePerUnit),
      })),
      paymentType: body.paymentType || "cash",
      localId: body.localId,
      ...(body.createdAt ? { createdAt: new Date(body.createdAt) } : {}),
    });

    for (const it of aggMap.values()) {
      const qty = Number(it.quantity);
      const buyPrice = Number(it.buyPricePerUnit);
      const sellPrice = it.sellPricePerUnit ? Number(it.sellPricePerUnit) : undefined;
      const batchNoTrimmed = String(it.batchNo).trim();
      const expiryDateObj = it.expiryDate ? new Date(it.expiryDate) : new Date(Date.now() + 365*24*60*60*1000);
      const expiryDay = expiryDateObj.toISOString().slice(0,10);
      const startDay = new Date(expiryDay);
      const endDay = new Date(new Date(expiryDay).getTime() + 24*60*60*1000 - 1);

      let productId: Types.ObjectId;
      if (it.productId && Types.ObjectId.isValid(it.productId)) {
        productId = new Types.ObjectId(it.productId);
        const exists = await Product.findOne({ _id: productId, userId });
        if (!exists) continue;
      } else {
        const newProduct = await Product.create({
          userId, name: it.name.trim(), company: it.company || "Unknown", generic: "", barcode: it.barcode || undefined,
          rack: it.rack || "", mainUnit: it.mainUnit || "box", pattaPerBox: 10, mlPerBottle: 120,
          buyPriceAvg: buyPrice, sellPrice: sellPrice || Math.round(buyPrice * 1.2), stock: 0, synced: true, lastSyncedAt: new Date(),
        });
        productId = newProduct._id as Types.ObjectId;
      }

      const existingBatch = await Batch.findOne({ 
        productId, userId,
        batchNo: { $regex: `^${escapeRegex(batchNoTrimmed)}$`, $options: 'i' },
        expiryDate: { $gte: startDay, $lte: endDay }
      });

      if (existingBatch) {
        existingBatch.quantity = Math.round((existingBatch.quantity + qty) * 1000000) / 1000000;
        existingBatch.buyPrice = buyPrice;
        await existingBatch.save();
      } else {
        await Batch.create({
          productId, batchNo: batchNoTrimmed, expiryDate: expiryDateObj, buyPrice, quantity: Math.round(qty*1000000)/1000000, userId,
          localId: `batch_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        });
      }

      const allBatches = await Batch.find({ productId, userId, quantity: { $gt: 0.0001 } }).lean<BatchLean[]>();
      const sumQty = allBatches.reduce((s, b) => s + b.quantity, 0);
      const earliest = allBatches.sort((a,b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())[0];

      await Product.updateOne({ _id: productId, userId }, {
        $set: { 
          stock: Math.round(sumQty*1000000)/1000000,
          lastSyncedAt: new Date(), 
          nearestExpiry: earliest?.expiryDate,
          expiryDate: earliest?.expiryDate,
          batchNo: earliest?.batchNo,
          ...(sellPrice ? { sellPrice } : {}), 
          ...(it.rack ? { rack: it.rack } : {}) 
        },
      });
    }

    return NextResponse.json(purchase, { status: 201 });
  } catch (e) {
    console.error("purchase error", e);
    return NextResponse.json({ error: "Failed to create purchase" }, { status: 500 });
  }
}