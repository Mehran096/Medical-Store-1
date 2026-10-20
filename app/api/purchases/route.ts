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

type DateRange = {
  $gte: Date;
  $lt: Date;
};

type PurchaseQuery = {
  userId: Types.ObjectId;
  createdAt?: DateRange;
};

type PurchaseItemInput = {
  productId?: string;
  name: string;
  company?: string;
  quantity: number;
  mainUnit?: "box" | "bottle" | "tube" | "piece";
  buyPricePerUnit: number;
  sellPricePerUnit?: number;
  batchNo?: string;
  expiryDate?: string;
  barcode?: string;
  rack?: string;
};

type PurchaseBody = {
  supplier?: string;
  invoiceNo?: string;
  paymentType?: "cash" | "credit";
  items: PurchaseItemInput[];
  totalBuyAmount?: number;
  localId?: string;
  createdAt?: string;
};

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

function getPKTRange() {
  const now = new Date();
  const nowPKT = new Date(now.getTime() + PKT_OFFSET_MS);
  const y = nowPKT.getUTCFullYear();
  const m = nowPKT.getUTCMonth();
  const d = nowPKT.getUTCDate();

  const startTodayUTC = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startTomorrowUTC = new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startMonthUTC = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startYearUTC = new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0) - PKT_OFFSET_MS);

  return { startTodayUTC, startTomorrowUTC, startMonthUTC, startYearUTC };
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await dbConnect();

  const userId = new Types.ObjectId(session.user.id);
  const searchParams = req.nextUrl.searchParams;
  const filter = searchParams.get("filter") || "all";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "15", 10)));
  const skip = (page - 1) * limit;

  const { startTodayUTC, startTomorrowUTC, startMonthUTC, startYearUTC } = getPKTRange();

  let dateRange: DateRange | undefined;
  if (filter === "today") {
    dateRange = { $gte: startTodayUTC, $lt: startTomorrowUTC };
  } else if (filter === "monthly") {
    dateRange = { $gte: startMonthUTC, $lt: startTomorrowUTC };
  } else if (filter === "yearly") {
    dateRange = { $gte: startYearUTC, $lt: startTomorrowUTC };
  }

  const query: PurchaseQuery = {
    userId,
    ...(dateRange ? { createdAt: dateRange } : {}),
  };

  const [purchases, totalCount, agg] = await Promise.all([
    Purchase.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Purchase.countDocuments(query),
    Purchase.aggregate([
      { $match: query },
      { $group: { _id: null, total: { $sum: "$totalBuyAmount" } } },
    ]),
  ]);

  const totalPurchase = agg.length > 0 ? (agg[0] as { total: number }).total : 0;

  return NextResponse.json({
    purchases,
    totalPurchase,
    pagination: {
      page,
      totalPages: Math.ceil(totalCount / limit) || 1,
      hasMore: skip + purchases.length < totalCount,
      totalCount,
    },
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await dbConnect();

  const userId = new Types.ObjectId(session.user.id);
  const body = (await req.json()) as PurchaseBody;

  if (!body.items?.length) {
    return NextResponse.json({ error: "items required" }, { status: 400 });
  }

  // Validate each item needs batchNo + expiryDate for batch system
  for (const it of body.items) {
    if (!it.batchNo || !it.expiryDate) {
      return NextResponse.json({ error: `batchNo and expiryDate required for ${it.name}` }, { status: 400 });
    }
    if (Number(it.quantity) <= 0) {
      return NextResponse.json({ error: `Invalid quantity for ${it.name}` }, { status: 400 });
    }
  }

  const calculatedTotal = body.items.reduce(
    (sum, it) => sum + Number(it.quantity) * Number(it.buyPricePerUnit),
    0
  );

  const purchase = await Purchase.create({
    userId,
    supplier: body.supplier || "Local Market",
    invoiceNo: body.invoiceNo,
    totalBuyAmount: body.totalBuyAmount || calculatedTotal,
    totalItems: body.items.length,
    items: body.items.map((it) => ({
      name: it.name,
      company: it.company,
      quantity: Number(it.quantity),
      mainUnit: it.mainUnit || "box",
      buyPricePerUnit: Number(it.buyPricePerUnit),
      sellPricePerUnit: it.sellPricePerUnit ? Number(it.sellPricePerUnit) : undefined,
      productId: it.productId && Types.ObjectId.isValid(it.productId) ? new Types.ObjectId(it.productId) : undefined,
      batchNo: it.batchNo,
      expiryDate: it.expiryDate ? new Date(it.expiryDate) : undefined,
      totalBuy: Number(it.quantity) * Number(it.buyPricePerUnit),
    })),
    paymentType: body.paymentType || "cash",
    ...(body.createdAt ? { createdAt: new Date(body.createdAt) } : {}),
  });

  for (const it of body.items) {
    const qty = Number(it.quantity);
    const buyPrice = Number(it.buyPricePerUnit);
    const sellPrice = it.sellPricePerUnit ? Number(it.sellPricePerUnit) : undefined;
    const mainUnit = (it.mainUnit as "box" | "bottle" | "tube" | "piece") || "box";

    let productId: Types.ObjectId;

    if (it.productId && Types.ObjectId.isValid(it.productId)) {
      productId = new Types.ObjectId(it.productId);
      await Product.updateOne(
        { _id: productId, userId },
        {
          $inc: { stock: qty },
          $set: {
            buyPriceAvg: buyPrice,
            lastSyncedAt: new Date(),
            synced: true,
            ...(sellPrice ? { sellPrice } : {}),
            ...(it.rack ? { rack: it.rack } : {}),
          },
        }
      );
    } else {
      const newProduct = await Product.create({
        userId,
        name: it.name.trim(),
        company: it.company || "Unknown",
        generic: "",
        barcode: it.barcode || undefined,
        rack: it.rack || "",
        mainUnit,
        pattaPerBox: 10,
        mlPerBottle: 120,
        buyPriceAvg: buyPrice,
        sellPrice: sellPrice || Math.round(buyPrice * 1.2),
        stock: qty,
        synced: true,
        lastSyncedAt: new Date(),
      });
      productId = newProduct._id as Types.ObjectId;
    }

    // CREATE BATCH - This was missing in your old file
    await Batch.create({
      productId,
      batchNo: it.batchNo?.trim() || `B-${Date.now()}`,
      expiryDate: it.expiryDate ? new Date(it.expiryDate) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      buyPrice,
      quantity: qty,
      userId,
    });
  }

  return NextResponse.json(purchase, { status: 201 });
}