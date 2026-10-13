import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

type MainUnit = "box" | "bottle" | "tube" | "piece";

type ProductBody = {
  name?: string; company?: string; generic?: string; batchNo?: string;
  expiryDate?: string; barcode?: string; rack?: string;
  mainUnit?: MainUnit;
  pattaPerBox?: number; mlPerBottle?: number;
  buyPrice?: number; sellPrice?: number;
  stock?: number;
};

function isValidObjectId(id: string): boolean { return Types.ObjectId.isValid(id); }

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
    
    if (body.mainUnit) updateData.mainUnit = body.mainUnit;
    // ❌ NO sellUnit update here - Product has no sellUnit
    if (body.pattaPerBox !== undefined) updateData.pattaPerBox = Number(body.pattaPerBox);
    if (body.mlPerBottle !== undefined) updateData.mlPerBottle = Number(body.mlPerBottle);
    
    if (body.stock !== undefined) updateData.stock = Number(body.stock);
    if (body.buyPrice !== undefined) updateData.buyPrice = Number(body.buyPrice);
    if (body.sellPrice !== undefined) updateData.sellPrice = Number(body.sellPrice);

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
  } catch (error) {
    console.error("DELETE error:", error);
    return NextResponse.json({ message: "Failed to delete" }, { status: 400 });
  }
}