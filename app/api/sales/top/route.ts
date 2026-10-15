import dbConnect from "@/lib/mongodb";
import Sale from "@/models/Sale";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

type PKTRange = { gte: Date; lt: Date } | null;

type SaleMatch = {
  userId: Types.ObjectId;
  createdAt?: { $gte: Date; $lt: Date };
};

function getPKTRange(filter: string): PKTRange {
  const now = new Date();
  const nowPKT = new Date(now.getTime() + PKT_OFFSET_MS);
  const y = nowPKT.getUTCFullYear();
  const m = nowPKT.getUTCMonth();
  const d = nowPKT.getUTCDate();

  const startToday = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startTomorrow = new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startMonth = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startYear = new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0) - PKT_OFFSET_MS);

  if (filter === "today") return { gte: startToday, lt: startTomorrow };
  if (filter === "monthly") return { gte: startMonth, lt: startTomorrow };
  if (filter === "yearly") return { gte: startYear, lt: startTomorrow };
  return null;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ top: [] }, { status: 401 });
  }
  await dbConnect();

  const userId = new Types.ObjectId(session.user.id);
  const filter = req.nextUrl.searchParams.get("filter") || "monthly";
  const range = getPKTRange(filter);

  const match: SaleMatch = {
    userId,
    ...(range ? { createdAt: { $gte: range.gte, $lt: range.lt } } : {}),
  };

  const top = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$productName",
        totalQty: { $sum: "$quantity" },
        totalSale: { $sum: "$total" },
        totalProfit: { $sum: "$profit" },
        count: { $sum: 1 },
      },
    },
    { $sort: { totalQty: -1 } },
    { $limit: 6 },
  ]);

  return NextResponse.json({ top });
}