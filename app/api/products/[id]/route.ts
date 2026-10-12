import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

type MedicalUnit = "tablet" | "patta" | "half_patta" | "box" | "bottle" | "syrup" | "ml" | "liter" | "gram" | "kg" | "tube" | "sachet" | "piece" | "capsule" | "injection";
type BaseUnit = "tablet" | "ml" | "gram" | "piece";

type ProductBody = {
  name?: string; company?: string; generic?: string; batchNo?: string;
  expiryDate?: string; barcode?: string; rack?: string;
  price?: number; buyPrice?: number; sellPrice?: number;
  unit?: MedicalUnit; baseUnit?: BaseUnit;
  stock?: number; tabletsPerPatta?: number; pattaPerBox?: number;
  qtyPerUnit?: number; subUnit?: string;
};

function isValidObjectId(id: string): boolean { return Types.ObjectId.isValid(id); }

function detectBaseUnit(u: string): BaseUnit {
  if (["ml","liter","bottle","syrup"].includes(u)) return "ml";
  if (["gram","kg","tube"].includes(u)) return "gram";
  if (["piece","injection","capsule","sachet"].includes(u)) return "piece";
  return "tablet";
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isValidObjectId(id)) return NextResponse.json({ message: "Invalid ID format" }, { status: 400 });
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const product = await Product.findOne({ _id: id, userId: new Types.ObjectId(session.user.id) }).lean({ virtuals: true });
    if (!product) return NextResponse.json({ message: "Product not found" }, { status: 404 });
    return NextResponse.json(product);
  } catch { return NextResponse.json({ message: "Failed to fetch" }, { status: 500 }); }
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isValidObjectId(id)) return NextResponse.json({ message: "Invalid ID format" }, { status: 400 });
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const body = (await req.json()) as ProductBody;

    const updateData: Record<string, string | number | Date | boolean> = { lastSyncedAt: new Date(), synced: true };

    if (body.name) updateData.name = body.name.trim();
    if (body.company) updateData.company = body.company.trim();
    if (body.generic !== undefined) updateData.generic = body.generic.trim();
    if (body.batchNo !== undefined) updateData.batchNo = body.batchNo.trim();
    if (body.barcode !== undefined) updateData.barcode = body.barcode.trim();
    if (body.rack !== undefined) updateData.rack = body.rack.trim();
    if (body.expiryDate) updateData.expiryDate = new Date(body.expiryDate);
    if (body.unit) {
      updateData.unit = body.unit;
      updateData.baseUnit = body.baseUnit ?? detectBaseUnit(body.unit);
      if (!body.qtyPerUnit) {
        const bu = (body.baseUnit ?? detectBaseUnit(body.unit)) as BaseUnit;
        updateData.qtyPerUnit = bu === "ml" ? 120 : bu === "gram" ? 20 : 10;
        updateData.subUnit = bu === "ml" ? "ml" : bu === "gram" ? "gram" : "tablet";
      }
    }
    if (body.baseUnit) updateData.baseUnit = body.baseUnit;
    if (body.qtyPerUnit !== undefined) updateData.qtyPerUnit = Number(body.qtyPerUnit);
    if (body.subUnit !== undefined) updateData.subUnit = body.subUnit;
    if (body.stock !== undefined) updateData.stock = Number(body.stock);
    if (body.buyPrice !== undefined) updateData.buyPrice = Number(body.buyPrice);
    if (body.sellPrice !== undefined) { updateData.sellPrice = Number(body.sellPrice); updateData.price = Number(body.sellPrice); }
    else if (body.price !== undefined) { updateData.sellPrice = Number(body.price); updateData.price = Number(body.price); }
    if (body.tabletsPerPatta !== undefined) updateData.tabletsPerPatta = Number(body.tabletsPerPatta);
    if (body.pattaPerBox !== undefined) updateData.pattaPerBox = Number(body.pattaPerBox);

    const updated = await Product.findOneAndUpdate(
      { _id: id, userId: new Types.ObjectId(session.user.id) },
      updateData,
      { new: true, runValidators: true }
    ).lean({ virtuals: true });

    if (!updated) return NextResponse.json({ message: "Product not found" }, { status: 404 });
    return NextResponse.json(updated);
  } catch (error) {
    console.error("PUT error:", error);
    return NextResponse.json({ message: "Failed to update" }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isValidObjectId(id)) return NextResponse.json({ message: "Invalid ID format" }, { status: 400 });
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const deleted = await Product.findOneAndDelete({ _id: id, userId: new Types.ObjectId(session.user.id) });
    if (!deleted) return NextResponse.json({ message: "Product not found" }, { status: 404 });
    return NextResponse.json({ message: "Product deleted successfully" });
  } catch { return NextResponse.json({ message: "Failed to delete" }, { status: 400 }); }
}