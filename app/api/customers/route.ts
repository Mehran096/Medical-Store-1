import dbConnect from "@/lib/mongodb";
import Customer from "@/models/Customer";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";

type CustomerBody = {
  name?: string;
  phone?: string;
  village?: string;
  totalUdhar?: number;
  totalBusiness?: number;
  saleId?: string;
  age?: number;
  customerType?: string;
};

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await dbConnect();

    const search = req.nextUrl.searchParams.get("search")?.trim() || "";
    const userId = new Types.ObjectId(session.user.id);

    const query: Record<string, unknown> = { userId };
    if (search) {
      query.normalizedName = { $regex: search.toLowerCase(), $options: "i" };
    }

    const customers = await Customer.find(query)
     .sort({ isPaid: 1, lastUdharDate: -1, createdAt: -1 })
     .lean();

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

    const saleObjectId =
      body.saleId && Types.ObjectId.isValid(body.saleId)
       ? new Types.ObjectId(body.saleId)
        : undefined;

    const existing = await Customer.findOne({
      userId,
      normalizedName: normalized,
      isPaid: false,
    });

    if (existing) {
      existing.totalUdhar = Math.round((existing.totalUdhar || 0) + total);
      existing.totalBusiness = Math.round((existing.totalBusiness || 0) + totalBiz);
      existing.billsCount = (existing.billsCount || existing.saleIds?.length || 0) + (saleObjectId? 1 : 0);
      existing.lastUdharDate = new Date();
      if (body.phone?.trim()) existing.phone = body.phone.trim();
      if (body.village?.trim()) existing.village = body.village.trim();
      if (body.age && body.age > 0) existing.age = body.age;
      if (body.customerType) existing.customerType = body.customerType;
      if (saleObjectId) {
        if (!existing.saleIds) existing.saleIds = [];
        const exists = existing.saleIds.some(
          (id: Types.ObjectId) => id.toString() === saleObjectId.toString()
        );
        if (!exists) {
          existing.saleIds.push(saleObjectId);
        }
      }
      await existing.save();
      return NextResponse.json(existing, { status: 200 });
    }

    try {
      const cust = await Customer.create({
        name: trimmedName,
        normalizedName: normalized,
        phone: body.phone?.trim() || "",
        village: body.village?.trim() || "",
        totalUdhar: total,
        totalBusiness: totalBiz,
        saleIds: saleObjectId? [saleObjectId] : [],
        billsCount: saleObjectId? 1 : 1,
        lastUdharDate: new Date(),
        userId,
        isPaid: false,
        paidAmount: 0,
        wusoolHistory: [],
        age: body.age && body.age > 0? body.age : undefined,
        customerType: body.customerType || "regular",
      });
      return NextResponse.json(cust, { status: 201 });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("E11000")) {
        const retry = await Customer.findOne({ userId, normalizedName: normalized, isPaid: false });
        if (retry) {
          retry.totalUdhar = Math.round((retry.totalUdhar || 0) + total);
          retry.totalBusiness = Math.round((retry.totalBusiness || 0) + totalBiz);
          if (saleObjectId) {
            if (!retry.saleIds) retry.saleIds = [];
            const exists = retry.saleIds.some(
              (id: Types.ObjectId) => id.toString() === saleObjectId.toString()
            );
            if (!exists) {
              retry.saleIds.push(saleObjectId);
              retry.billsCount = (retry.billsCount || 0) + 1;
            }
          }
          await retry.save();
          return NextResponse.json(retry, { status: 200 });
        }
      }
      throw err;
    }
  } catch (error) {
    console.error("POST /api/customers error:", error);
    return NextResponse.json({ error: "Failed to create customer" }, { status: 500 });
  }
}