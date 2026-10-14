import dbConnect from "@/lib/mongodb";
import Purchase from "@/models/Purchase";
import Product from "@/models/Product";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";

type DateFilter = {
  createdAt?: { $gte: Date };
};

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

  let dateFilter: DateFilter = {};
  const now = new Date();
  if (filter === "today") {
    const s = new Date();
    s.setHours(0, 0, 0, 0);
    dateFilter = { createdAt: { $gte: s } };
  } else if (filter === "monthly") {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    dateFilter = { createdAt: { $gte: s } };
  } else if (filter === "yearly") {
    const s = new Date(now.getFullYear(), 0, 1);
    dateFilter = { createdAt: { $gte: s } };
  }

  const query = {
    userId,
   ...dateFilter,
  };

  const [purchases, totalCount, agg] = await Promise.all([
    Purchase.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Purchase.countDocuments(query),
    Purchase.aggregate([
      { $match: query },
      { $group: { _id: null, total: { $sum: "$totalBuyAmount" } } },
    ]),
  ]);

  const totalPurchase = agg.length > 0? (agg[0] as { total: number }).total : 0;

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

type PurchaseItemInput = {
  productId?: string;
  name: string;
  company?: string;
  quantity: number;
  mainUnit?: "box" | "bottle" | "tube" | "piece";
  buyPricePerUnit: number;
  sellPricePerUnit?: number;
};

type PurchaseBody = {
  supplier?: string;
  invoiceNo?: string;
  paymentType?: "cash" | "credit";
  items: PurchaseItemInput[];
  totalBuyAmount?: number;
};

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
      sellPricePerUnit: it.sellPricePerUnit? Number(it.sellPricePerUnit) : undefined,
      productId: it.productId && Types.ObjectId.isValid(it.productId)? new Types.ObjectId(it.productId) : undefined,
      totalBuy: Number(it.quantity) * Number(it.buyPricePerUnit),
    })),
    paymentType: body.paymentType || "cash",
  });

  for (const it of body.items) {
    if (it.productId && Types.ObjectId.isValid(it.productId)) {
      await Product.updateOne(
        { _id: it.productId, userId },
        {
          $inc: { stock: Number(it.quantity) },
          $set: {
            buyPrice: Number(it.buyPricePerUnit),
           ...(it.sellPricePerUnit? { sellPrice: Number(it.sellPricePerUnit) } : {}),
          },
        }
      );
    } else {
      await Product.create({
        userId,
        name: it.name,
        company: it.company || "Unknown",
        generic: "",
        batchNo: "",
        rack: "",
        mainUnit: (it.mainUnit as "box" | "bottle" | "tube" | "piece") || "box",
        pattaPerBox: 10,
        mlPerBottle: 120,
        buyPrice: Number(it.buyPricePerUnit),
        sellPrice: Number(it.sellPricePerUnit || it.buyPricePerUnit * 1.2),
        stock: Number(it.quantity),
      });
    }
  }

  return NextResponse.json(purchase, { status: 201 });
}