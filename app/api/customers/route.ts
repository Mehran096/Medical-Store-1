import dbConnect from "@/lib/mongodb";
import Customer, { ICustomer } from "@/models/Customer";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";

type CustomerBody = {
  name?: string;
  phone?: string;
  village?: string; // area for medical
  totalUdhar?: number;
  totalBusiness?: number;
  saleId?: string;
  age?: number;
  customerType?: string;
};

type CustomerQuery = {
  userId: Types.ObjectId;
  name?: { $regex: string; $options: string };
  normalizedName?: string;
  isPaid?: boolean;
};

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const search = req.nextUrl.searchParams.get("search")?.trim() || "";
    const userId = new Types.ObjectId(session.user.id);

    const query: CustomerQuery = { userId };
    if (search) {
      query.name = { $regex: search, $options: "i" };
    }

    const customers = await Customer.find(query)
     .sort({ isPaid: 1, lastUdharDate: -1, createdAt: -1 })
     .lean<ICustomer[]>();

    const rounded = customers.map((c) => ({
     ...c,
      totalUdhar: Math.round(c.totalUdhar || 0),
      totalBusiness: Math.round(c.totalBusiness || 0),
      paidAmount: Math.round(c.paidAmount || 0),
      billsCount: c.billsCount || c.saleIds?.length || 1,
      wusoolHistory: c.wusoolHistory || [],
    }));

    return NextResponse.json({ customers: rounded });
  } catch (error) {
    console.error("GET /api/customers error:", error);
    return NextResponse.json({ error: "Failed to fetch customers" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();
    const body = (await req.json()) as CustomerBody;

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Name required" }, { status: 400 });
    }

    const userId = new Types.ObjectId(session.user.id);
    const trimmedName = body.name.trim();
    const normalized = trimmedName.toLowerCase();
    const total = Math.round(body.totalUdhar || 0);
    const totalBiz = Math.round(body.totalBusiness || body.totalUdhar || 0);

    const saleObjectId = body.saleId && Types.ObjectId.isValid(body.saleId)? new Types.ObjectId(body.saleId) : undefined;

    const existing = await Customer.findOne({
      userId,
      normalizedName: normalized,
      isPaid: false,
    });

    if (existing) {
      existing.totalUdhar = Math.round((existing.totalUdhar || 0) + total);
      existing.totalBusiness = Math.round((existing.totalBusiness || 0) + totalBiz);
      existing.billsCount = (existing.billsCount || existing.saleIds?.length || 1) + (saleObjectId? 1 : 0);
      existing.lastUdharDate = new Date();
      if (body.phone) existing.phone = body.phone;
      if (body.village) existing.village = body.village;
      if (body.age) existing.age = body.age;
      if (body.customerType) existing.customerType = body.customerType;
      if (saleObjectId) {
        if (!existing.saleIds) existing.saleIds = [];
        const alreadyHas = existing.saleIds.some((id: Types.ObjectId) => id.toString() === saleObjectId.toString());
        if (!alreadyHas) {
          existing.saleIds.push(saleObjectId);
        }
      }
      await existing.save();
      return NextResponse.json(existing, { status: 200 });
    }

    const doc = {
      name: trimmedName,
      normalizedName: normalized,
      phone: body.phone || "",
      village: body.village || "", // area
      totalUdhar: total,
      totalBusiness: totalBiz,
      saleIds: saleObjectId? [saleObjectId] : [],
      billsCount: saleObjectId? 1 : 0,
      lastUdharDate: new Date(),
      userId,
      isPaid: false,
      paidAmount: 0,
      wusoolHistory: [],
      age: body.age || 0,
      customerType: body.customerType || "patient",
    };

    const cust = await Customer.create(doc);
    return NextResponse.json(cust, { status: 201 });
  } catch (error) {
    console.error("POST /api/customers error:", error);
    return NextResponse.json({ error: "Failed to create customer" }, { status: 500 });
  }
}