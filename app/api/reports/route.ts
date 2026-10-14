import dbConnect from "@/lib/mongodb";
import Sale from "@/models/Sale";
import Customer from "@/models/Customer";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AggResult = { count: number; total: number; profit: number; buy: number; cash: number; credit: number };

function empty(): AggResult {
  return { count: 0, total: 0, profit: 0, buy: 0, cash: 0, credit: 0 };
}

function fmt(arr: AggResult[]): AggResult {
  if (!arr?.[0]) return empty();
  return {
    count: arr[0].count || 0,
    total: arr[0].total || 0,
    profit: arr[0].profit || 0,
    buy: Math.round((arr[0].total - arr[0].profit) * 100) / 100,
    cash: arr[0].cash || 0,
    credit: arr[0].credit || 0,
  };
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({
        today: empty(), month: empty(), year: empty(), all: empty(),
        khata: { totalUdhar: 0, customers: 0, paid: 0, totalWusool: 0 },
      });
    }

    await dbConnect();
    const userId = new Types.ObjectId(session.user.id);

    // Peshawar time
    const now = new Date();
    const pkOffset = 5 * 60;
    const localNow = new Date(now.getTime() + (pkOffset + now.getTimezoneOffset()) * 60000);

    const startToday = new Date(localNow); startToday.setHours(0,0,0,0);
    const startTodayUTC = new Date(startToday.getTime() - pkOffset * 60000);
    const startMonth = new Date(localNow.getFullYear(), localNow.getMonth(), 1);
    const startMonthUTC = new Date(startMonth.getTime() - pkOffset * 60000);
    const startYear = new Date(localNow.getFullYear(), 0, 1);
    const startYearUTC = new Date(startYear.getTime() - pkOffset * 60000);

    const agg = (match: Record<string, unknown>) =>
      Sale.aggregate<AggResult>([
        { $match: match },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            total: { $sum: "$total" },
            profit: { $sum: { $ifNull: ["$profit", 0] } },
            cash: { $sum: { $cond: [{ $in: ["$paymentType", ["cash","jazzcash","easypaisa","card"]] }, "$total", 0] } },
            credit: { $sum: { $cond: [{ $in: ["$paymentType", ["credit","udhar"]] }, "$total", 0] } },
          },
        },
      ]);

    const [todayAgg, monthAgg, yearAgg, allAgg, khataAgg, paidAgg] = await Promise.all([
      agg({ userId, createdAt: { $gte: startTodayUTC } }),
      agg({ userId, createdAt: { $gte: startMonthUTC } }),
      agg({ userId, createdAt: { $gte: startYearUTC } }),
      agg({ userId }),
      Customer.aggregate([
        { $match: { userId, isPaid: false, totalUdhar: { $gt: 0.5 } } },
        { $group: { _id: null, totalUdhar: { $sum: "$totalUdhar" }, count: { $sum: 1 } } },
      ]),
      Customer.aggregate([
        { $match: { userId, isPaid: true } },
        { $group: { _id: null, totalUdhar: { $sum: "$paidAmount" }, count: { $sum: 1 } } },
      ]),
    ]);

    return NextResponse.json({
      today: fmt(todayAgg),
      month: fmt(monthAgg),
      year: fmt(yearAgg),
      all: fmt(allAgg),
      khata: {
        totalUdhar: khataAgg[0]?.totalUdhar || 0,
        customers: khataAgg[0]?.count || 0,
        paid: paidAgg[0]?.count || 0,
        totalWusool: paidAgg[0]?.totalUdhar || 0,
      },
    });
  } catch (e) {
    console.error("GET /api/reports error:", e);
    return NextResponse.json({
      today: empty(), month: empty(), year: empty(), all: empty(),
      khata: { totalUdhar: 0, customers: 0, paid: 0, totalWusool: 0 },
    });
  }
}