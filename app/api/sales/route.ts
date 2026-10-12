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
type MedicalUnit = "tablet" | "patta" | "half_patta" | "box" | "bottle" | "syrup" | "ml" | "liter" | "gram" | "kg" | "tube" | "sachet" | "piece" | "capsule" | "injection";
type BaseUnit = "tablet" | "ml" | "gram" | "piece";

type SaleBody = {
  productId: string; productName?: string; quantity: number;
  price?: number; buyPrice?: number; sellPrice?: number;
  originalPrice?: number; discount?: number; profit?: number; total?: number;
  soldBy?: string; localId?: string; customerName?: string; customerPhone?: string;
  customerVillage?: string; paymentType?: string; offlineCreatedAt?: string;
  unit?: MedicalUnit; baseUnit?: BaseUnit; qtyPerUnit?: number;
  tabletsPerPatta?: number; pattaPerBox?: number;
  quantityInTablets?: number; totalTablets?: number; quantityInSub?: number;
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

function calcBaseQty(unit: MedicalUnit, baseUnit: BaseUnit, qty: number, tpp: number, ppb: number, qpu: number): number {
  if (baseUnit === "tablet") {
    if (unit === 'patta') return qty*tpp;
    if (unit === 'half_patta') return qty*(tpp/2);
    if (unit === 'box') return qty*tpp*ppb;
    return qty;
  }
  if (baseUnit === "ml") {
    if (['bottle','box','liter','syrup'].includes(unit)) return qty*qpu;
    return qty;
  }
  if (baseUnit === "gram") {
    if (['tube','box','kg'].includes(unit)) return qty*qpu;
    return qty;
  }
  return qty;
}

function calcPricePerUnit(unit: MedicalUnit, baseUnit: BaseUnit, perBasePrice: number, tpp: number, ppb: number, qpu: number): number {
  if (baseUnit === "tablet") {
    if (unit === 'patta') return perBasePrice*tpp;
    if (unit === 'half_patta') return perBasePrice*(tpp/2);
    if (unit === 'box') return perBasePrice*tpp*ppb;
    return perBasePrice;
  }
  if (baseUnit === "ml" || baseUnit === "gram") {
    if (["bottle","tube","box","liter","kg","syrup"].includes(unit)) return perBasePrice*qpu;
    return perBasePrice;
  }
  return perBasePrice;
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
    const saleQuery: Record<string, unknown> = { userId: userObjectId };
    if (filter !== "all") saleQuery.createdAt = filter === "yesterday" ? { $gte: start, $lte: end } : { $gte: start };
    if (search) saleQuery.$or = [{ productName: { $regex: search, $options: "i" } }, { customerName: { $regex: search, $options: "i" } }];
    if (statusParam === "pending") {
      const pendingOr = [{ status: "pending" as SaleStatus }, { isCredit: true }, { paymentType: "credit" }, { paymentType: "udhar" }];
      const existingOr = saleQuery.$or as unknown[] | undefined;
      if (existingOr) { saleQuery.$and = [{ $or: existingOr }, { $or: pendingOr }]; delete saleQuery.$or; }
      else saleQuery.$or = pendingOr;
    }
    const totalMatch: Record<string, unknown> = { userId: userObjectId };
    if (saleQuery.createdAt) totalMatch.createdAt = saleQuery.createdAt;
    if (search) totalMatch.$or = [{ productName: { $regex: search, $options: "i" } }, { customerName: { $regex: search, $options: "i" } }];
    const customerQuery: Record<string, unknown> = { userId: userObjectId, isPaid: false };
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
      sales, total: totalResult?.total ?? 0, profit: totalResult?.profit ?? 0,
      pendingTotal: Math.round(pendingResult?.total ?? 0), filter, count: totalCount,
      pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit), hasMore: skip + sales.length < totalCount },
    });
  } catch (error) { console.error("GET /api/sales error:", error); return NextResponse.json({ error: "Failed to fetch sales" }, { status: 500 }); }
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
    const unit: MedicalUnit = (body.unit as MedicalUnit) || (product.unit as MedicalUnit) || "tablet";
    const baseUnit: BaseUnit = (body.baseUnit as BaseUnit) || (product.baseUnit as BaseUnit) || "tablet";
    const tpp = body.tabletsPerPatta ?? product.tabletsPerPatta ?? 10;
    const ppb = body.pattaPerBox ?? product.pattaPerBox ?? 10;
    const qpu = body.qtyPerUnit ?? product.qtyPerUnit ?? (baseUnit === "ml" ? 120 : baseUnit === "gram" ? 20 : 10);
    const qtyInBase = body.quantityInTablets ?? body.totalTablets ?? body.quantityInSub ?? calcBaseQty(unit, baseUnit, quantity, tpp, ppb, qpu);

    if (!body.localId && product.stock < qtyInBase - 0.0001) {
      const pretty = (product as unknown as { stockInPatta?: string }).stockInPatta || `${product.stock} ${baseUnit}`;
      return NextResponse.json({ error: `Only ${pretty} left` }, { status: 400 });
    }

    const buyPrice = body.buyPrice ?? product.buyPrice ?? 0;
    const originalPrice = body.originalPrice ?? product.sellPrice ?? product.price ?? 0;
    const sellPrice = body.sellPrice ?? body.price ?? originalPrice;
    const pricePerUnit = calcPricePerUnit(unit, baseUnit, sellPrice, tpp, ppb, qpu);
    const total = Math.round(body.total ?? pricePerUnit * quantity);
    const profit = Math.round(body.profit ?? (sellPrice - buyPrice) * qtyInBase);

    const isCredit = (body.paymentType || "").toLowerCase() === "credit" || (body.paymentType || "").toLowerCase() === "udhar";
    const customerName = body.customerName?.trim() || "Walk-in";
    const status: SaleStatus = isCredit ? "pending" : "paid";
    if (isCredit && customerName.toLowerCase() === "walk-in") return NextResponse.json({ error: "Customer name required for Udhar" }, { status: 400 });

    const sale = await Sale.create({
      productId: new Types.ObjectId(body.productId),
      productName: body.productName?.trim() || product.name,
      quantity, price: Number(pricePerUnit), buyPrice: Number(buyPrice), sellPrice: Number(sellPrice),
      originalPrice: Number(originalPrice), discount: 0, profit: Number(profit), total: Number(total),
      soldBy: body.soldBy?.trim() || "Yasir Medical", userId: userObjectId,
      localId: body.localId || `online_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      customerName, paymentType: isCredit ? "credit" : "cash",
      offlineCreatedAt: body.offlineCreatedAt ? new Date(body.offlineCreatedAt) : new Date(),
      unit, baseUnit, qtyPerUnit: qpu, tabletsPerPatta: Number(tpp), pattaPerBox: Number(ppb),
      quantityInTablets: baseUnit === "tablet" ? Number(qtyInBase) : 0,
      totalTablets: baseUnit === "tablet" ? Number(qtyInBase) : 0,
      quantityInSub: Number(qtyInBase),
      paidAmount: isCredit ? 0 : Number(total), pendingAmount: isCredit ? Number(total) : 0, status, isCredit,
    });

    if (isCredit) {
      try {
        const customerDoc = await upsertKhataGrouped(userObjectId, customerName, total, sale._id as Types.ObjectId, body.customerPhone || "", body.customerVillage || "");
        await Sale.updateOne({ _id: sale._id }, { $set: { customerId: customerDoc._id } });
      } catch (err) { console.error("Khata grouping error:", err); }
    }

    await Product.findOneAndUpdate({ _id: body.productId, userId: userObjectId }, { $inc: { stock: -qtyInBase }, $set: { lastSyncedAt: new Date() } });
    return NextResponse.json(sale, { status: 201 });
  } catch (error) { console.error("POST /api/sales error:", error); return NextResponse.json({ error: "Failed to create sale" }, { status: 500 }); }
}