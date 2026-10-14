import dbConnect from "@/lib/mongodb";
import Customer from "@/models/Customer";
import Sale from "@/models/Sale";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

type SaleBill = {
  _id: Types.ObjectId;
  productName: string;
  mainUnit: string;
  sellUnit: string;
  quantity: number;
  pattaPerBox?: number;
  mlPerBottle?: number;
  total: number;
  createdAt?: Date;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await dbConnect();
    const { id } = await params;

    if (!id || !Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    const customer = await Customer.findById(id).lean();
    if (!customer) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const saleIds = customer.saleIds || [];
    const sales = (
      saleIds.length > 0
       ? await Sale.find({ _id: { $in: saleIds } }).sort({ createdAt: 1 }).lean()
        : []
    ) as unknown as SaleBill[];

    const bills = sales.map((s) => ({
      _id: s._id.toString(),
      productName: s.productName,
      quantity: s.quantity,
      mainUnit: s.mainUnit,
      sellUnit: s.sellUnit,
      pattaPerBox: s.pattaPerBox || 10,
      mlPerBottle: s.mlPerBottle || 120,
      total: Math.round(s.total || 0),
      createdAt: s.createdAt?.toISOString(),
    }));

    return NextResponse.json({
      customer: {
        ...customer,
        totalUdhar: Math.round(customer.totalUdhar || 0),
        totalBusiness: Math.round(customer.totalBusiness || 0),
        paidAmount: Math.round(customer.paidAmount || 0),
        wusoolHistory: customer.wusoolHistory || [],
      },
      bills,
    });
  } catch (e) {
    console.error("GET /api/customers/[id] error:", e);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await dbConnect();
    const { id } = await params;

    if (!id || !Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    const userIdStr = session.user.id;
    const isObjectIdUser = Types.ObjectId.isValid(userIdStr);
    const userObjectId = isObjectIdUser ? new Types.ObjectId(userIdStr) : null;

    const filter = {
      _id: new Types.ObjectId(id),
      ...(isObjectIdUser
        ? { $or: [{ userId: userObjectId }, { userId: userIdStr }] }
        : { userId: userIdStr }),
    };

    const customer = await Customer.findOne(filter);
    if (!customer) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await Customer.deleteOne({ _id: customer._id });

    return NextResponse.json({
      success: true,
      deletedId: id,
      deletedName: customer.name,
      deletedBillsCount: customer.billsCount,
    });
  } catch (e) {
    console.error("DELETE /api/customers/[id] error:", e);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}