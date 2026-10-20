import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import Batch from "@/models/Batch";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";
import { Types, startSession } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MainUnit = "box" | "bottle" | "tube" | "piece";

type ProductBody = {
  name: string; 
  company?: string; 
  generic?: string; 
  batchNo?: string;
  expiryDate?: string;
  barcode?: string; 
  rack?: string;
  mainUnit: MainUnit;
  pattaPerBox?: number; 
  mlPerBottle?: number;
  buyPrice: number;
  sellPrice: number;
  stock?: number; 
  localId?: string;
  unit?: string;
};

type SearchCondition = { $regex: string; $options: string };
type ProductSearchQuery = {
  userId: Types.ObjectId;
  $or?: { name?: SearchCondition; company?: SearchCondition; generic?: SearchCondition }[];
};

function mapLegacyUnit(u: string): MainUnit {
  if (["bottle","ml","liter","syrup"].includes(u)) return "bottle";
  if (["tube","gram","kg"].includes(u)) return "tube";
  if (["piece","injection","capsule","sachet"].includes(u)) return "piece";
  return "box";
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
      const r: SearchCondition = { $regex: search, $options: "i" };
      baseQuery.$or = [{ name: r }, { company: r }, { generic: r }];
    }
    
    const [products, totalCount] = await Promise.all([
      Product.find(baseQuery).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Product.countDocuments(baseQuery),
    ]);

    const productIds = products.map(p => p._id);
    const batches = await Batch.find({ 
      productId: { $in: productIds }, 
      quantity: { $gt: 0 } 
    }).sort({ expiryDate: 1 }).lean();
    
    const batchesByProduct = new Map<string, typeof batches>();
    for (const b of batches) {
      const pid = String(b.productId);
      const list = batchesByProduct.get(pid);
      if (list) list.push(b);
      else batchesByProduct.set(pid, [b]);
    }

    const productsWithBatches = products.map(p => ({
      ...p,
      batches: batchesByProduct.get(String(p._id)) ?? [],
      nearestExpiry: batchesByProduct.get(String(p._id))?.[0]?.expiryDate ?? null
    }));

    if (searchParams.has("page") || searchParams.has("search") || searchParams.has("limit")) {
      return NextResponse.json({ 
        products: productsWithBatches, 
        pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit), hasMore: skip + products.length < totalCount } 
      });
    }
    return NextResponse.json(productsWithBatches);
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
    if (!body.name) return NextResponse.json({ error: "name required" }, { status: 400 });

    const mainUnit: MainUnit = body.mainUnit ?? (body.unit ? mapLegacyUnit(body.unit) : "box");
    const ppb = Number(body.pattaPerBox ?? 10);
    const mlB = Number(body.mlPerBottle ?? 120);
    const buy = Number(body.buyPrice ?? 0);
    const sell = Number(body.sellPrice ?? 0);
    const stock = Number(body.stock ?? 0);
    
    if (!buy || !sell) return NextResponse.json({ error: "buyPrice and sellPrice required" }, { status: 400 });
    if (stock > 0 && (!body.batchNo || !body.expiryDate)) {
      return NextResponse.json({ error: "batchNo and expiryDate required when stock > 0" }, { status: 400 });
    }

    const userObjectId = new Types.ObjectId(session.user.id);
    
    if (body.localId) {
      const existing = await Product.findOne({ localId: body.localId, userId: userObjectId }).lean();
      if (existing) return NextResponse.json(existing, { status: 200 });
    }

    const mongoSession = await startSession();
    let createdProductId: Types.ObjectId | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const created = await Product.create([{
          name: body.name.trim(),
          company: body.company?.trim() || "Unknown",
          generic: body.generic?.trim() || "",
          barcode: body.barcode?.trim() || undefined,
          rack: body.rack?.trim() || "",
          mainUnit,
          pattaPerBox: ppb,
          mlPerBottle: mlB,
          sellPrice: sell,
          buyPriceAvg: buy,
          stock,
          nearestExpiry: stock > 0 ? new Date(body.expiryDate!) : undefined,
          userId: userObjectId,
          localId: body.localId || undefined,
          synced: true,
          lastSyncedAt: new Date(),
        }], { session: mongoSession });

        const prod = created[0];
        createdProductId = prod._id as Types.ObjectId;

        if (stock > 0) {
          await Batch.create([{
            productId: prod._id,
            batchNo: body.batchNo!.trim(),
            expiryDate: new Date(body.expiryDate!),
            buyPrice: buy,
            quantity: stock,
            userId: userObjectId,
            localId: body.localId ? `batch_${body.localId}` : undefined,
          }], { session: mongoSession });
        }
      });
    } finally {
      await mongoSession.endSession();
    }

    if (!createdProductId) {
      return NextResponse.json({ error: "Failed to create product - transaction failed" }, { status: 500 });
    }

    const productWithBatch = await Product.findById(createdProductId).lean();
    return NextResponse.json(productWithBatch, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create product";
    console.error("POST /api/products error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}