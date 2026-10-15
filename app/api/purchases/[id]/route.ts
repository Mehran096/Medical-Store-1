import dbConnect from "@/lib/mongodb";
import Purchase from "@/models/Purchase";
import Product from "@/models/Product";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ id: string }>;
};

type UpdateBody = {
  supplier?: string;
  invoiceNo?: string;
  paymentType?: "cash" | "credit";
};

type UpdateSet = {
  supplier?: string;
  invoiceNo?: string;
  paymentType?: "cash" | "credit";
};

function getCleanId(raw: string) {
  const trimmed = (raw || "").toString().trim();
  // Direct valid ObjectId — no stripping that could match wrong doc
  if (Types.ObjectId.isValid(trimmed)) return trimmed;
  // Fallback: extract last 24 hex chars (old mobile bug)
  const hexOnly = trimmed.replace(/[^a-fA-F0-9]/g, "");
  return hexOnly.length >= 24 ? hexOnly.slice(-24) : hexOnly;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await dbConnect();

  const { id } = await params;
  const cleanId = getCleanId(id);

  if (!Types.ObjectId.isValid(cleanId)) {
    return NextResponse.json({ error: "Invalid id: " + id }, { status: 400 });
  }

  const purchase = await Purchase.findOne({
    _id: cleanId,
    userId: new Types.ObjectId(session.user.id),
  }).lean();

  if (!purchase) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(purchase);
}

export async function PUT(req: NextRequest, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await dbConnect();

  const { id } = await params;
  const cleanId = getCleanId(id);

  if (!Types.ObjectId.isValid(cleanId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const body = (await req.json()) as UpdateBody;

  const setFields: UpdateSet = {};
  if (typeof body.supplier === "string") setFields.supplier = body.supplier;
  if (typeof body.invoiceNo === "string") setFields.invoiceNo = body.invoiceNo;
  if (body.paymentType) setFields.paymentType = body.paymentType;

  if (Object.keys(setFields).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const updated = await Purchase.findOneAndUpdate(
    { _id: cleanId, userId: new Types.ObjectId(session.user.id) },
    { $set: setFields },
    { new: true }
  );

  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await dbConnect();

  const { id } = await params;
  const cleanId = getCleanId(id);

  if (!Types.ObjectId.isValid(cleanId)) {
    return NextResponse.json({ error: "Invalid id: " + id }, { status: 400 });
  }

  const userId = new Types.ObjectId(session.user.id);

  const deleted = await Purchase.findOneAndDelete({
    _id: cleanId,
    userId,
  });

  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Revert stock when purchase deleted - prevents stock value bug
  try {
    for (const item of deleted.items || []) {
      if (item.productId) {
        await Product.updateOne(
          { _id: item.productId, userId },
          { $inc: { stock: -Number(item.quantity) } }
        );
      }
    }
  } catch (err) {
    console.error("Stock revert error on purchase delete:", err);
  }

  return NextResponse.json({ success: true });
}