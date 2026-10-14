import dbConnect from "@/lib/mongodb";
import Sale from "@/models/Sale";
import Purchase from "@/models/Purchase";
import Customer from "@/models/Customer";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { Types } from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SaleAgg = {
  count: number;
  total: number;
  profit: number;
  cash: number;
  credit: number;
};

type PurchaseAgg = {
  total: number;
  count: number;
};

function emptySale(): SaleAgg & { buy: number } {
  return { count: 0, total: 0, profit: 0, buy: 0, cash: 0, credit: 0 };
}

function emptyPurchase(): PurchaseAgg {
  return { total: 0, count: 0 };
}

function fmtSale(arr: SaleAgg[]): SaleAgg & { buy: number } {
  if (!arr?.[0]) return emptySale();
  const r = arr[0];
  return {
    count: r.count || 0,
    total: r.total || 0,
    profit: r.profit || 0,
    buy: Math.round(((r.total || 0) - (r.profit || 0)) * 100) / 100,
    cash: r.cash || 0,
    credit: r.credit || 0,
  };
}

function fmtPurchase(arr: PurchaseAgg[]): PurchaseAgg {
  if (!arr?.[0]) return emptyPurchase();
  return {
    total: arr[0].total || 0,
    count: arr[0].count || 0,
  };
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({
        today: emptySale(),
        month: emptySale(),
        year: emptySale(),
        all: emptySale(),
        todayPurchase: emptyPurchase(),
        monthPurchase: emptyPurchase(),
        yearPurchase: emptyPurchase(),
        allPurchase: emptyPurchase(),
        khata: { totalUdhar: 0, customers: 0, paid: 0, totalWusool: 0 },
      });
    }

    await dbConnect();
    const userId = new Types.ObjectId(session.user.id);

    // Peshawar PKT UTC+5
    const now = new Date();
    const pkOffset = 5 * 60;
    const localNow = new Date(now.getTime() + (pkOffset + now.getTimezoneOffset()) * 60000);

    const startToday = new Date(localNow);
    startToday.setHours(0, 0, 0, 0);
    const startTodayUTC = new Date(startToday.getTime() - pkOffset * 60000);

    const startMonth = new Date(localNow.getFullYear(), localNow.getMonth(), 1);
    const startMonthUTC = new Date(startMonth.getTime() - pkOffset * 60000);

    const startYear = new Date(localNow.getFullYear(), 0, 1);
    const startYearUTC = new Date(startYear.getTime() - pkOffset * 60000);

    const saleAgg = (match: { userId: Types.ObjectId; createdAt?: { $gte: Date } }) =>
      Sale.aggregate<SaleAgg>([
        { $match: match },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            total: { $sum: "$total" },
            profit: { $sum: { $ifNull: ["$profit", 0] } },
            cash: {
              $sum: {
                $cond: [{ $in: ["$paymentType", ["cash", "jazzcash", "easypaisa", "card"]] }, "$total", 0],
              },
            },
            credit: {
              $sum: { $cond: [{ $in: ["$paymentType", ["credit", "udhar"]] }, "$total", 0] },
            },
          },
        },
      ]);

    const purchaseAgg = (match: { userId: Types.ObjectId; createdAt?: { $gte: Date } }) =>
      Purchase.aggregate<PurchaseAgg>([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalBuyAmount" },
            count: { $sum: 1 },
          },
        },
      ]);

    const [
      todaySale,
      monthSale,
      yearSale,
      allSale,
      todayPur,
      monthPur,
      yearPur,
      allPur,
      khataAgg,
      paidAgg,
    ] = await Promise.all([
      saleAgg({ userId, createdAt: { $gte: startTodayUTC } }),
      saleAgg({ userId, createdAt: { $gte: startMonthUTC } }),
      saleAgg({ userId, createdAt: { $gte: startYearUTC } }),
      saleAgg({ userId }),
      purchaseAgg({ userId, createdAt: { $gte: startTodayUTC } }),
      purchaseAgg({ userId, createdAt: { $gte: startMonthUTC } }),
      purchaseAgg({ userId, createdAt: { $gte: startYearUTC } }),
      purchaseAgg({ userId }),
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
      today: fmtSale(todaySale),
      month: fmtSale(monthSale),
      year: fmtSale(yearSale),
      all: fmtSale(allSale),
      todayPurchase: fmtPurchase(todayPur),
      monthPurchase: fmtPurchase(monthPur),
      yearPurchase: fmtPurchase(yearPur),
      allPurchase: fmtPurchase(allPur),
      khata: {
        totalUdhar: (khataAgg[0] as { totalUdhar: number } | undefined)?.totalUdhar || 0,
        customers: (khataAgg[0] as { count: number } | undefined)?.count || 0,
        paid: (paidAgg[0] as { count: number } | undefined)?.count || 0,
        totalWusool: (paidAgg[0] as { totalUdhar: number } | undefined)?.totalUdhar || 0,
      },
    });
  } catch (err) {
    console.error("GET /api/reports error:", err);
    return NextResponse.json({
      today: emptySale(),
      month: emptySale(),
      year: emptySale(),
      all: emptySale(),
      todayPurchase: emptyPurchase(),
      monthPurchase: emptyPurchase(),
      yearPurchase: emptyPurchase(),
      allPurchase: emptyPurchase(),
      khata: { totalUdhar: 0, customers: 0, paid: 0, totalWusool: 0 },
    });
  }
}