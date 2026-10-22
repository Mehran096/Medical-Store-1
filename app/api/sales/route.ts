import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import Batch from "@/models/Batch";
import Sale from "@/models/Sale";
import Customer from "@/models/Customer";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SaleStatus = "paid" | "pending";
type MainUnit = "box" | "bottle" | "tube" | "piece";
type SellUnit = "patta" | "half_patta" | "box" | "bottle" | "ml" | "tube" | "piece";

type SaleBody = {
  productId: string;
  quantity: number;
  sellUnit?: SellUnit;
  mainUnit?: MainUnit;
  sellPrice?: number;
  pattaPerBox?: number;
  mlPerBottle?: number;
  soldBy?: string;
  localId?: string;
  customerName?: string;
  customerPhone?: string;
  customerVillage?: string;
  paymentType?: string;
  batchId?: string;
  batchNo?: string;
  expiryDate?: string;
  buyPriceMain?: number;
  total?: number;
  profit?: number;
  deductionMain?: number;
  deductionPatta?: number;
};

type DateFilter = { $gte: Date; $lte?: Date };
type SearchRegex = { $regex: string; $options: string };
type SaleQuery = {
  userId: Types.ObjectId;
  createdAt?: DateFilter;
  $or?: Array<{ productName?: SearchRegex; customerName?: SearchRegex; status?: SaleStatus; isCredit?: boolean; paymentType?: string }>;
  $and?: Array<{ $or: Array<{ productName?: SearchRegex; customerName?: SearchRegex; status?: SaleStatus; isCredit?: boolean; paymentType?: string }> }>;
};
type CustomerQuery = { userId: Types.ObjectId; isPaid: boolean; name?: SearchRegex };

function getDateRange(filter: string): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (filter === "today") start.setHours(0, 0, 0, 0);
  else if (filter === "yesterday") {
    start.setDate(now.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    end.setDate(now.getDate() - 1);
    end.setHours(23, 59, 59, 999);
  } else if (filter === "weekly") {
    start.setDate(now.getDate() - 7);
    start.setHours(0, 0, 0, 0);
  } else if (filter === "monthly") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  } else if (filter === "yearly") {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
  }
  return { start, end };
}

function calcDeduction(mainUnit: MainUnit, sellUnit: SellUnit, qty: number, ppb: number, mlB: number): number {
  let deductionMain = 0;
  if (mainUnit === "box") {
    if (sellUnit === "patta") deductionMain = qty / ppb;
    else if (sellUnit === "half_patta") deductionMain = (qty * 0.5) / ppb;
    else deductionMain = qty;
  } else {
    deductionMain = sellUnit === "ml" ? qty / mlB : qty;
  }
  return Math.round(deductionMain * 1000) / 1000;
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
    if (filter !== "all") saleQuery.createdAt = filter === "yesterday" ? { $gte: start, $lte: end } : { $gte: start };
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
      } else saleQuery.$or = pendingOr;
    }
    const totalMatch: SaleQuery = { userId: userObjectId };
    if (saleQuery.createdAt) totalMatch.createdAt = saleQuery.createdAt;
    if (search) {
      const r: SearchRegex = { $regex: search, $options: "i" };
      totalMatch.$or = [{ productName: r }, { customerName: r }];
    }
    const customerQuery: CustomerQuery = { userId: userObjectId, isPaid: false };
    if (search) customerQuery.name = { $regex: search, $options: "i" };
    const [sales, totalCount, totalAgg, pendingAgg] = await Promise.all([
      Sale.find(saleQuery).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Sale.countDocuments(saleQuery),
      Sale.aggregate([{ $match: totalMatch }, { $group: { _id: null, total: { $sum: "$total" }, profit: { $sum: "$profit" } } }]),
      Customer.aggregate([{ $match: customerQuery }, { $group: { _id: null, total: { $sum: "$totalUdhar" } } }]),
    ]);
    const totalResult = totalAgg[0] as { total: number; profit: number } | undefined;
    const pendingResult = pendingAgg[0] as { total: number } | undefined;
    return NextResponse.json({
      sales,
      total: totalResult?.total ?? 0,
      profit: totalResult?.profit ?? 0,
      pendingTotal: Math.round(pendingResult?.total ?? 0),
      filter,
      count: totalCount,
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
    {
      $setOnInsert: { name: name.trim(), normalizedName: normalized, userId, phone, village, isPaid: false, paidAmount: 0 },
      $inc: { totalUdhar: Math.round(amount), totalBusiness: Math.round(amount), billsCount: 1 },
      $set: { lastUdharDate: new Date() },
      $addToSet: { saleIds: saleId },
    },
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
    if (!Types.ObjectId.isValid(body.productId)) return NextResponse.json({ error: "Invalid productId" }, { status: 400 });
    const productObjectId = new Types.ObjectId(body.productId);

    if (body.localId) {
      const existing = await Sale.findOne({ localId: body.localId, userId: userObjectId }).lean();
      if (existing) return NextResponse.json(existing, { status: 200 });
    }

    const product = await Product.findOne({ _id: productObjectId, userId: userObjectId });
    if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

    const quantity = Number(body.quantity);
    const mainUnit = (body.mainUnit ?? product.mainUnit) as MainUnit;
    const sellUnit = (body.sellUnit ?? (mainUnit === "box" ? "patta" : mainUnit)) as SellUnit;
    const ppb = Number(body.pattaPerBox ?? product.pattaPerBox ?? 10);
    const mlB = Number(body.mlPerBottle ?? product.mlPerBottle ?? 120);
    const sellPrice = Number(body.sellPrice ?? product.sellPrice ?? 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);

    if (body.batchId && body.deductionMain) {
      let batch = null;
      if (Types.ObjectId.isValid(body.batchId)) {
        batch = await Batch.findOne({ _id: new Types.ObjectId(body.batchId), userId: userObjectId });
      }
      if (!batch) {
        batch = await Batch.findOne({ batchNo: body.batchNo, productId: productObjectId, userId: userObjectId, expiryDate: { $gte: today } }).sort({ expiryDate: 1 });
      }
      if (!batch) return NextResponse.json({ error: "Batch not found for sale" }, { status: 404 });
      if (new Date(batch.expiryDate) < today) return NextResponse.json({ error: `Cannot sell expired batch ${batch.batchNo}` }, { status: 400 });

      const sale = await Sale.create({
        productId: productObjectId, productName: product.name, batchId: batch._id,
        batchNo: body.batchNo ?? batch.batchNo, expiryDate: body.expiryDate ? new Date(body.expiryDate) : batch.expiryDate,
        mainUnit, sellUnit, quantity, pattaPerBox: ppb, mlPerBottle: mlB,
        buyPriceMain: body.buyPriceMain ?? batch.buyPrice ?? product.buyPriceAvg,
        sellPrice, total: body.total ?? Math.round(sellPrice * quantity), profit: body.profit ?? 0,
        deductionMain: body.deductionMain, deductionPatta: body.deductionPatta ?? 0,
        userId: userObjectId, localId: body.localId || `online_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        customerName: body.customerName?.trim() || "Walk-in",
        paymentType: body.paymentType === "credit" || body.paymentType === "udhar" ? "credit" : body.paymentType ?? "cash",
        status: body.paymentType === "credit" || body.paymentType === "udhar" ? ("pending" as SaleStatus) : ("paid" as SaleStatus),
        isCredit: body.paymentType === "credit" || body.paymentType === "udhar",
      });
      await Batch.updateOne({ _id: batch._id, userId: userObjectId }, { $inc: { quantity: -Number(body.deductionMain) } });
      const remaining = await Batch.find({ productId: productObjectId, userId: userObjectId, quantity: { $gt: 0.0001 } });
      const sum = remaining.reduce((s, b) => s + b.quantity, 0);
      const first = remaining.sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())[0];
      await Product.updateOne({ _id: productObjectId, userId: userObjectId }, { $set: { stock: Math.round(sum * 1000) / 1000, nearestExpiry: first?.expiryDate, expiryDate: first?.expiryDate, batchNo: first?.batchNo } });
      return NextResponse.json(sale, { status: 201 });
    }

    const needMain = calcDeduction(mainUnit, sellUnit, quantity, ppb, mlB);
    const allBatches = await Batch.find({ productId: product._id, userId: userObjectId, quantity: { $gt: 0.0001 }, expiryDate: { $gte: today } }).sort({ expiryDate: 1 });

    if (allBatches.length === 0) {
      const expiredCount = await Batch.countDocuments({ productId: product._id, userId: userObjectId, quantity: { $gt: 0.0001 }, expiryDate: { $lt: today } });
      if (expiredCount > 0) return NextResponse.json({ error: `All ${product.stock} ${mainUnit} expired. Discard in Expiry Alerts.` }, { status: 400 });
      return NextResponse.json({ error: `Only ${product.stock} ${mainUnit} left` }, { status: 400 });
    }

    const saleableQty = allBatches.reduce((s, b) => s + b.quantity, 0);

    // V24 FINAL - fixes 0.5 patta ghost (0.157 box = 0.471 patta rounded to 0.5)
    const saleablePattaRaw = mainUnit === "box" ? saleableQty * ppb : saleableQty;
    let needPattaRaw = quantity;
    if (mainUnit === "box") {
      if (sellUnit === "patta") needPattaRaw = quantity;
      else if (sellUnit === "half_patta") needPattaRaw = quantity * 0.5;
      else needPattaRaw = quantity * ppb;
    }
    const saleablePatta = Math.round(saleablePattaRaw * 1000) / 1000;
    const needPatta = Math.round(needPattaRaw * 1000) / 1000;
    const EPS = sellUnit === "half_patta" ? 0.03 : 0.005;
    if (saleablePatta + EPS < needPatta) {
      return NextResponse.json({ error: `Only ${saleablePatta.toFixed(3)} patta (${saleableQty.toFixed(3)} ${mainUnit}) left, need ${needPatta.toFixed(1)} patta` }, { status: 400 });
    }

    const isCredit = body.paymentType === "credit" || body.paymentType === "udhar";
    const customerName = body.customerName?.trim() || "Walk-in";
    if (isCredit && customerName.toLowerCase() === "walk-in") return NextResponse.json({ error: "Customer name required for Udhar" }, { status: 400 });

    let remaining = needMain;
    let totalProfit = 0;
    const usedBatches: { batchId: Types.ObjectId; take: number }[] = [];

    for (const batch of allBatches) {
      if (remaining <= 0) break;
      const take = Math.min(batch.quantity, remaining);
      const ratio = needMain > 0 ? take / needMain : 0;
      const qtyForBatch = quantity * ratio;
      if (mainUnit === "box") {
        const buyPerPatta = batch.buyPrice / ppb;
        if (sellUnit === "patta") totalProfit += (sellPrice - buyPerPatta) * qtyForBatch;
        else if (sellUnit === "half_patta") totalProfit += (sellPrice - buyPerPatta / 2) * qtyForBatch;
        else totalProfit += (sellPrice - batch.buyPrice) * qtyForBatch;
      } else {
        totalProfit += (sellPrice - batch.buyPrice) * qtyForBatch;
      }
      usedBatches.push({ batchId: batch._id as Types.ObjectId, take });
      remaining = Math.round((remaining - take) * 1000) / 1000;
    }

    const firstBatch = allBatches[0];
    const totalSale = Math.round(sellPrice * quantity);

    const saleDoc = await Sale.create({
      productId: productObjectId, productName: product.name, batchId: firstBatch._id, batchNo: firstBatch.batchNo, expiryDate: firstBatch.expiryDate,
      mainUnit, sellUnit, quantity, pattaPerBox: ppb, mlPerBottle: mlB, buyPriceMain: firstBatch.buyPrice, sellPrice,
      total: totalSale, profit: Math.round(totalProfit), deductionMain: needMain, deductionPatta: mainUnit === "box" ? needMain * ppb : 0,
      userId: userObjectId, localId: body.localId || `online_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      customerName, paymentType: isCredit ? "credit" : body.paymentType ?? "cash",
      status: isCredit ? ("pending" as SaleStatus) : ("paid" as SaleStatus), isCredit,
    });

    for (const { batchId, take } of usedBatches) {
      await Batch.updateOne({ _id: batchId, userId: userObjectId }, { $inc: { quantity: -take } });
    }

    const remainingBatches = await Batch.find({ productId: productObjectId, userId: userObjectId, quantity: { $gt: 0.0001 } });
    const sum = remainingBatches.reduce((s, b) => s + b.quantity, 0);
    const nextEarliest = remainingBatches.sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())[0];
    await Product.updateOne({ _id: productObjectId, userId: userObjectId }, { $set: { stock: Math.round(sum * 1000) / 1000, nearestExpiry: nextEarliest?.expiryDate, expiryDate: nextEarliest?.expiryDate, batchNo: nextEarliest?.batchNo } });

    if (isCredit) {
      try {
        const customerDoc = await upsertKhataGrouped(userObjectId, customerName, totalSale, saleDoc._id as Types.ObjectId, body.customerPhone || "", body.customerVillage || "");
        if (customerDoc?._id) await Sale.updateOne({ _id: saleDoc._id }, { $set: { customerId: customerDoc._id } });
      } catch (err) { console.error("Khata error:", err); }
    }

    const created = await Sale.findById(saleDoc._id).lean();
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error("POST /api/sales error:", error);
    return NextResponse.json({ error: "Failed to create sale" }, { status: 500 });
  }
}