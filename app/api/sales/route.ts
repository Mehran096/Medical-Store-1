import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import Sale from "@/models/Sale";
import Customer from "@/models/Customer";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SaleStatus = "paid" | "pending" | "partial";
type MainUnit = "box" | "bottle" | "tube" | "piece";
type SellUnit = "patta" | "half_patta" | "box" | "bottle" | "ml" | "tube" | "piece";

type SaleBody = {
  productId: string; quantity: number;
  sellUnit?: SellUnit; mainUnit?: MainUnit;
  sellPrice?: number; buyPriceMain?: number;
  pattaPerBox?: number; mlPerBottle?: number;
  soldBy?: string; localId?: string;
  customerName?: string; customerPhone?: string;
  customerVillage?: string; paymentType?: string;
};

type DateFilter = { $gte: Date; $lte?: Date };
type SearchRegex = { $regex: string; $options: string };
type SaleQuery = {
  userId: Types.ObjectId;
  createdAt?: DateFilter;
  $or?: Array<{ productName?: SearchRegex; customerName?: SearchRegex; status?: SaleStatus; isCredit?: boolean; paymentType?: string }>;
  $and?: Array<{ $or: Array<{ productName?: SearchRegex; customerName?: SearchRegex; status?: SaleStatus; isCredit?: boolean; paymentType?: string }> }>;
};

type CustomerQuery = {
  userId: Types.ObjectId;
  isPaid: boolean;
  name?: SearchRegex;
};

function getDateRange(filter: string): { start: Date; end: Date } {
  const now = new Date(); const start = new Date(now); const end = new Date(now);
  if (filter === "today") start.setHours(0,0,0,0);
  else if (filter === "yesterday") { start.setDate(now.getDate()-1); start.setHours(0,0,0,0); end.setDate(now.getDate()-1); end.setHours(23,59,59,999); }
  else if (filter === "weekly") { start.setDate(now.getDate()-7); start.setHours(0,0,0,0); }
  else if (filter === "monthly") { start.setDate(1); start.setHours(0,0,0,0); }
  else if (filter === "yearly") { start.setMonth(0,1); start.setHours(0,0,0,0); }
  return { start, end };
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const searchParams = req.nextUrl.searchParams;
    const filter = searchParams.get("filter") || "all";
    const search = searchParams.get("search")?.trim() || "";
    const statusParam = searchParams.get("status")?.trim() || "";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));
    const skip = (page - 1) * limit;
    const userObjectId = new Types.ObjectId(session.user.id);
    const { start, end } = getDateRange(filter);

    const saleQuery: SaleQuery = { userId: userObjectId };
    if (filter!== "all") {
      saleQuery.createdAt = filter === "yesterday"? { $gte: start, $lte: end } : { $gte: start };
    }
    if (search) {
      const r: SearchRegex = { $regex: search, $options: "i" };
      saleQuery.$or = [{ productName: r }, { customerName: r }];
    }
    if (statusParam === "pending") {
      const pendingOr = [{ status: "pending" as SaleStatus }, { isCredit: true }, { paymentType: "credit" }, { paymentType: "udhar" }];
      if (saleQuery.$or) {
        const prevOr = saleQuery.$or;
        saleQuery.$and = [{ $or: prevOr }, { $or: pendingOr }];
        delete saleQuery.$or;
      } else {
        saleQuery.$or = pendingOr;
      }
    }

    const totalMatch: SaleQuery = { userId: userObjectId };
    if (saleQuery.createdAt) totalMatch.createdAt = saleQuery.createdAt;
    if (search) {
      const r: SearchRegex = { $regex: search, $options: "i" };
      totalMatch.$or = [{ productName: r }, { customerName: r }];
    }

    const customerQuery: CustomerQuery = { userId: userObjectId, isPaid: false };
    if (search) {
      customerQuery.name = { $regex: search, $options: "i" };
    }

    const [sales, totalCount, totalAgg, pendingAgg] = await Promise.all([
      Sale.find(saleQuery).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Sale.countDocuments(saleQuery),
      Sale.aggregate([{ $match: totalMatch }, { $group: { _id: null, total: { $sum: "$total" }, profit: { $sum: "$profit" } } }]),
      Customer.aggregate([{ $match: customerQuery }, { $group: { _id: null, total: { $sum: "$totalUdhar" } } }]),
    ]);

    const totalResult = totalAgg[0] as { total: number; profit: number } | undefined;
    const pendingResult = pendingAgg[0] as { total: number } | undefined;

    return NextResponse.json({
      sales, total: totalResult?.total?? 0, profit: totalResult?.profit?? 0,
      pendingTotal: Math.round(pendingResult?.total?? 0), filter, count: totalCount,
      pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit), hasMore: skip + sales.length < totalCount },
    });
  } catch (error) {
    console.error("GET /api/sales error:", error);
    return NextResponse.json({ error: "Failed to fetch sales" }, { status: 500 });
  }
}

async function upsertKhataGrouped(userId: Types.ObjectId, name: string, amount: number, saleId: Types.ObjectId, phone = "", village = "") {
  const normalized = name.trim().toLowerCase();
  return Customer.findOneAndUpdate(
    { userId, normalizedName: normalized, isPaid: false },
    { $setOnInsert: { name: name.trim(), normalizedName: normalized, userId, phone, village, isPaid: false, paidAmount: 0 },
      $inc: { totalUdhar: Math.round(amount), totalBusiness: Math.round(amount), billsCount: 1 },
      $set: { lastUdharDate: new Date() }, $addToSet: { saleIds: saleId } },
    { upsert: true, new: true }
  );
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const body = (await req.json()) as SaleBody;
    if (!body.productId || body.quantity === undefined) return NextResponse.json({ error: "productId, quantity required" }, { status: 400 });
    if (body.quantity < 0.001) return NextResponse.json({ error: "Quantity must be > 0" }, { status: 400 });
    const userObjectId = new Types.ObjectId(session.user.id);
    if (body.localId) {
      const existing = await Sale.findOne({ localId: body.localId, userId: userObjectId }).lean();
      if (existing) return NextResponse.json(existing, { status: 200 });
    }
    if (!Types.ObjectId.isValid(body.productId)) return NextResponse.json({ error: "Invalid productId" }, { status: 400 });
    const product = await Product.findOne({ _id: body.productId, userId: userObjectId });
    if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

    const quantity = Number(body.quantity);
    // ✅ FINAL V14.2: mainUnit ONLY from Product, sellUnit decided at counter
    const mainUnit = (body.mainUnit ?? product.mainUnit) as MainUnit;
    const sellUnit = (body.sellUnit ?? (mainUnit === "box" ? "patta" : mainUnit)) as SellUnit;
    const ppb = Number(body.pattaPerBox?? product.pattaPerBox?? 10);
    const mlB = Number(body.mlPerBottle?? product.mlPerBottle?? 120);
    const buyMain = Number(body.buyPriceMain?? product.buyPrice?? 0);
    const sellPrice = Number(body.sellPrice?? product.sellPrice?? 0); // EDITABLE at counter

    let deductionMain = 0;
    if (mainUnit === "box") {
      if (sellUnit === "patta") deductionMain = quantity / ppb;
      else if (sellUnit === "half_patta") deductionMain = (quantity * 0.5) / ppb;
      else deductionMain = quantity;
    } else {
      deductionMain = sellUnit === "ml"? quantity / mlB : quantity;
    }
    deductionMain = Math.round(deductionMain * 1000) / 1000;

    if (!body.localId && product.stock < deductionMain - 0.0001) {
      return NextResponse.json({ error: `Only ${product.stock} ${mainUnit} left (${mainUnit==="box"? Math.floor(product.stock*ppb)+" Patta":""})` }, { status: 400 });
    }

    const isCredit = body.paymentType === "credit" || body.paymentType === "udhar";
    const customerName = body.customerName?.trim() || "Walk-in";
    const status: SaleStatus = isCredit? "pending" : "paid";
    if (isCredit && customerName.toLowerCase() === "walk-in") return NextResponse.json({ error: "Customer name required for Udhar" }, { status: 400 });

    const sale = await Sale.create({
      productId: new Types.ObjectId(body.productId),
      productName: product.name,
      mainUnit,
      sellUnit, // patta/half_patta/box decided at counter
      quantity,
      pattaPerBox: ppb,
      mlPerBottle: mlB,
      buyPriceMain: buyMain,
      sellPrice, // EDITABLE - e.g., 100 Rs per patta
      total: 0, // calculated in pre-validate
      profit: 0,
      deductionMain,
      userId: userObjectId,
      localId: body.localId || `online_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      customerName,
      paymentType: isCredit? "credit" : (body.paymentType ?? "cash"),
      status,
      isCredit,
    });

    if (isCredit) {
      try {
        const customerDoc = await upsertKhataGrouped(userObjectId, customerName, sale.total, sale._id as Types.ObjectId, body.customerPhone || "", body.customerVillage || "");
        if (customerDoc?._id) {
          await Sale.updateOne({ _id: sale._id }, { $set: { customerId: customerDoc._id } });
        }
      } catch (err) {
        console.error("Khata grouping error:", err);
      }
    }

    await Product.findOneAndUpdate({ _id: body.productId, userId: userObjectId }, { $inc: { stock: -deductionMain }, $set: { lastSyncedAt: new Date() } });
    return NextResponse.json(sale, { status: 201 });
  } catch (error) {
    console.error("POST /api/sales error:", error);
    return NextResponse.json({ error: "Failed to create sale" }, { status: 500 });
  }
}