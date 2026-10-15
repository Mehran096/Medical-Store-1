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

type SaleAgg = { count: number; total: number; profit: number; cash: number; credit: number; };
type PurchaseAgg = { total: number; count: number; };
type KhataAgg = { totalUdhar: number; count: number; };

type SaleMatch = {
  userId: Types.ObjectId;
  createdAt?: { $gte: Date; $lt: Date };
};

type PurchaseMatch = {
  userId: Types.ObjectId;
  createdAt?: { $gte: Date; $lt: Date };
};

function emptySale() {
  return { count: 0, total: 0, profit: 0, buy: 0, cash: 0, credit: 0 };
}
function emptyPurchase(): PurchaseAgg {
  return { total: 0, count: 0 };
}

function fmtSale(arr: SaleAgg[]) {
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
  return { total: arr[0].total || 0, count: arr[0].count || 0 };
}

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

function getPKTRange() {
  const now = new Date();
  const nowPKT = new Date(now.getTime() + PKT_OFFSET_MS);

  const y = nowPKT.getUTCFullYear();
  const m = nowPKT.getUTCMonth();
  const d = nowPKT.getUTCDate();

  // PKT midnight = UTC midnight of same Y/M/D minus 5h
  // Example: 15/10/2026 00:00 PKT = 14/10/2026 19:00 UTC
  const startTodayUTC = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startTomorrowUTC = new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startMonthUTC = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const startYearUTC = new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0) - PKT_OFFSET_MS);

  return { startTodayUTC, startTomorrowUTC, startMonthUTC, startYearUTC };
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
    const { startTodayUTC, startTomorrowUTC, startMonthUTC, startYearUTC } = getPKTRange();

    const saleAgg = (match: SaleMatch) =>
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

    const purchaseAgg = (match: PurchaseMatch) =>
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
      saleAgg({ userId, createdAt: { $gte: startTodayUTC, $lt: startTomorrowUTC } }),
      saleAgg({ userId, createdAt: { $gte: startMonthUTC, $lt: startTomorrowUTC } }),
      saleAgg({ userId, createdAt: { $gte: startYearUTC, $lt: startTomorrowUTC } }),
      saleAgg({ userId }),
      purchaseAgg({ userId, createdAt: { $gte: startTodayUTC, $lt: startTomorrowUTC } }),
      purchaseAgg({ userId, createdAt: { $gte: startMonthUTC, $lt: startTomorrowUTC } }),
      purchaseAgg({ userId, createdAt: { $gte: startYearUTC, $lt: startTomorrowUTC } }),
      purchaseAgg({ userId }),
      Customer.aggregate<KhataAgg>([
        { $match: { userId, isPaid: false, totalUdhar: { $gt: 0.5 } } },
        { $group: { _id: null, totalUdhar: { $sum: "$totalUdhar" }, count: { $sum: 1 } } },
      ]),
      Customer.aggregate<KhataAgg>([
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
        totalUdhar: khataAgg[0]?.totalUdhar || 0,
        customers: khataAgg[0]?.count || 0,
        paid: paidAgg[0]?.count || 0,
        totalWusool: paidAgg[0]?.totalUdhar || 0,
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