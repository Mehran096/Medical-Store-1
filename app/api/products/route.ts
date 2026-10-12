import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MedicalUnit = "tablet" | "patta" | "half_patta" | "box" | "bottle" | "syrup" | "ml" | "liter" | "gram" | "kg" | "tube" | "sachet" | "piece" | "capsule" | "injection";
type BaseUnit = "tablet" | "ml" | "gram" | "piece";

type ProductBody = {
  name: string;
  company?: string;
  generic?: string;
  batchNo?: string;
  expiryDate?: string;
  barcode?: string;
  rack?: string;
  price?: number;
  buyPrice: number;
  sellPrice: number;
  unit: MedicalUnit;
  baseUnit?: BaseUnit;
  stock?: number;
  tabletsPerPatta?: number;
  pattaPerBox?: number;
  qtyPerUnit?: number;
  subUnit?: string;
  baseQtyInSub?: number;
  localId?: string;
};

type SearchCondition = { $regex: string; $options: string };
type ProductSearchQuery = {
  userId: Types.ObjectId;
  $or?: Array<{ name?: SearchCondition; company?: SearchCondition; generic?: SearchCondition }>;
};

function detectBaseUnit(u: string): BaseUnit {
  if (["ml","liter","bottle","syrup"].includes(u)) return "ml";
  if (["gram","kg","tube"].includes(u)) return "gram";
  if (["piece","injection","capsule","sachet"].includes(u)) return "piece";
  return "tablet";
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const searchParams = req.nextUrl.searchParams;
    const search = searchParams.get("search")?.trim() || "";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
    const skip = (page - 1) * limit;
    const userObjectId = new Types.ObjectId(session.user.id);
    const baseQuery: ProductSearchQuery = { userId: userObjectId };
    if (search) {
      const searchRegex: SearchCondition = { $regex: search, $options: "i" };
      baseQuery.$or = [{ name: searchRegex }, { company: searchRegex }, { generic: searchRegex }];
    }
    const [products, totalCount] = await Promise.all([
      Product.find(baseQuery).sort({ createdAt: -1 }).skip(skip).limit(limit).lean({ virtuals: true }),
      Product.countDocuments(baseQuery),
    ]);
    if (searchParams.has("page") || searchParams.has("search") || searchParams.has("limit")) {
      return NextResponse.json({ products, pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit), hasMore: skip + products.length < totalCount } });
    }
    return NextResponse.json(products);
  } catch (error) {
    console.error("GET /api/products error:", error);
    return NextResponse.json({ error: "Failed to fetch products" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const body = (await req.json()) as ProductBody;
    if (!body.name || !body.unit) return NextResponse.json({ error: "name, unit required" }, { status: 400 });
    const buy = body.buyPrice ?? 0;
    const sell = body.sellPrice ?? body.price;
    if (!sell) return NextResponse.json({ error: "sellPrice or price required" }, { status: 400 });
    const tabletsPerPatta = body.tabletsPerPatta ?? 10;
    const pattaPerBox = body.pattaPerBox ?? 10;
    const baseUnit = body.baseUnit ?? detectBaseUnit(body.unit);
    const qtyPerUnit = body.qtyPerUnit ?? (baseUnit === "ml" ? 120 : baseUnit === "gram" ? 20 : 10);
    const userObjectId = new Types.ObjectId(session.user.id);
    if (body.localId) {
      const existing = await Product.findOne({ localId: body.localId, userId: userObjectId }).lean();
      if (existing) return NextResponse.json(existing, { status: 200 });
    }
    const product = await Product.create({
      name: body.name.trim(),
      company: body.company?.trim() || "Unknown",
      generic: body.generic?.trim() || "",
      batchNo: body.batchNo?.trim() || "",
      expiryDate: body.expiryDate ? new Date(body.expiryDate) : undefined,
      barcode: body.barcode?.trim() || undefined,
      rack: body.rack?.trim() || "",
      buyPrice: Number(buy),
      sellPrice: Number(sell),
      price: Number(sell),
      unit: body.unit,
      baseUnit: baseUnit,
      stock: body.stock ?? 0,
      tabletsPerPatta: Number(tabletsPerPatta),
      pattaPerBox: Number(pattaPerBox),
      qtyPerUnit: Number(qtyPerUnit),
      subUnit: body.subUnit || (baseUnit === "ml" ? "ml" : baseUnit === "gram" ? "gram" : "tablet"),
      baseQtyInSub: body.baseQtyInSub ?? body.stock ?? 0,
      userId: userObjectId,
      localId: body.localId || undefined,
      synced: true,
      lastSyncedAt: new Date(),
    });
    return NextResponse.json(product, { status: 201 });
  } catch (error) {
    console.error("POST /api/products error:", error);
    return NextResponse.json({ error: "Failed to create product" }, { status: 500 });
  }
}