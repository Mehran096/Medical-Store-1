import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import Batch from "@/models/Batch";
import Sale from "@/models/Sale";
import Purchase from "@/models/Purchase";
import Customer from "@/models/Customer";

type DocCreate = { create: (d: unknown) => Promise<unknown>; findById: (id: string) => Promise<unknown>; findOne: (q: unknown) => Promise<unknown> };
type CustomerDoc = {
  totalUdhar: number;
  totalBusiness: number;
  paidAmount: number;
  totalWusool: number;
  saleIds: unknown;
  billsCount: number;
  wusoolHistory: unknown;
  save: () => Promise<void>;
};
type WusoolItem = { amount: number; date?: string };
type BackupItem = Record<string, unknown> & { _id?: string; localId?: string };

export async function POST(req: NextRequest) {
  try {
    await dbConnect();
    const body = await req.json() as { data?: Record<string, unknown> };
    const src = (body.data || body) as {
      products: BackupItem[];
      batches: BackupItem[];
      sales: BackupItem[];
      purchases: BackupItem[];
      customers: BackupItem[];
    };

    const products = src.products || [];
    const batches = src.batches || [];
    const sales = src.sales || [];
    const purchases = src.purchases || [];
    const customers = src.customers || [];

    const restored = { products: 0, batches: 0, sales: 0, purchases: 0, customers: 0 };
    const skipped = { products: 0, batches: 0, sales: 0, purchases: 0, customers: 0 };

    const ProductModel = Product as unknown as DocCreate;
    const BatchModel = Batch as unknown as DocCreate;
    const SaleModel = Sale as unknown as DocCreate;
    const PurchaseModel = Purchase as unknown as DocCreate;
    const CustomerModel = Customer as unknown as DocCreate;

    // 1. PRODUCTS
    for (const p of products) {
      const id = p._id || p.localId;
      let exists: unknown = null;
      try { exists = id ? await ProductModel.findById(id as string) : null; } catch { /* ignore */ }
      if (!exists && p.localId) { exists = await ProductModel.findOne({ localId: p.localId }); }
      if (!exists) {
        try { await ProductModel.create({ ...p }); restored.products++; } catch { skipped.products++; }
      } else { skipped.products++; }
    }

    // 2. BATCHES
    for (const b of batches) {
      const rec = b as { _id?: string; localId?: string; productId?: string; batchNo?: string; userId?: string };
      let exists: unknown = null;
      try { if (rec._id) exists = await BatchModel.findById(rec._id); } catch { /* ignore */ }
      if (!exists && rec.localId) { exists = await BatchModel.findOne({ localId: rec.localId, userId: rec.userId }); }
      if (!exists) { exists = await BatchModel.findOne({ productId: rec.productId, batchNo: rec.batchNo, userId: rec.userId }); }
      if (!exists) {
        try { await BatchModel.create({ ...b }); restored.batches++; } catch { skipped.batches++; }
      } else { skipped.batches++; }
    }

    // 3. PURCHASES
    for (const p of purchases) {
      const rec = p as { _id?: string; localId?: string };
      let exists: unknown = null;
      try { if (rec._id) exists = await PurchaseModel.findById(rec._id); } catch { /* ignore */ }
      if (!exists && rec.localId) { exists = await PurchaseModel.findOne({ localId: rec.localId }); }
      if (!exists) {
        try { await PurchaseModel.create({ ...p }); restored.purchases++; } catch { skipped.purchases++; }
      } else { skipped.purchases++; }
    }

    // 4. SALES
    for (const s of sales) {
      const rec = s as { _id?: string; localId?: string };
      let exists: unknown = null;
      try { if (rec._id) exists = await SaleModel.findById(rec._id); } catch { /* ignore */ }
      if (!exists && rec.localId) { exists = await SaleModel.findOne({ localId: rec.localId }); }
      if (!exists) {
        try {
          const rest = { ...s } as Record<string, unknown>;
          delete rest.__v;
          await SaleModel.create(rest);
          restored.sales++;
        } catch { skipped.sales++; }
      } else { skipped.sales++; }
    }

    // 5. CUSTOMERS - FIXED WUSOOL 1000 not 1500 - NO ANY
    for (const c of customers) {
      const rec = c as { _id?: string; name?: string; normalizedName?: string; userId?: string; totalBusiness?: number; wusoolHistory?: WusoolItem[]; saleIds?: unknown; billsCount?: number };
      const norm = (rec.normalizedName || rec.name || "").trim().toLowerCase();
      if (!norm || !rec.userId) { skipped.customers++; continue; }

      const srcHistory = rec.wusoolHistory || [];
      const totalWusool = srcHistory.reduce((sum, h) => sum + (Number(h.amount) || 0), 0);
      const totalBusiness = Number(rec.totalBusiness) || 0;
      const remaining = Math.max(0, totalBusiness - totalWusool);

      const existing = await CustomerModel.findOne({ userId: rec.userId, normalizedName: norm, isPaid: false }) as unknown as CustomerDoc | null;

      if (existing) {
        existing.totalBusiness = totalBusiness;
        existing.wusoolHistory = srcHistory as unknown as CustomerDoc["wusoolHistory"];
        existing.paidAmount = totalWusool;
        existing.totalWusool = totalWusool;
        existing.totalUdhar = remaining;
        existing.saleIds = rec.saleIds as unknown as CustomerDoc["saleIds"];
        if (rec.billsCount) existing.billsCount = rec.billsCount;
        await existing.save();
        restored.customers++;
      } else {
        try {
          let byId: unknown = null;
          try { if (rec._id) byId = await CustomerModel.findById(rec._id); } catch { /* ignore */ }
          if (!byId) {
            await CustomerModel.create({
              ...c,
              normalizedName: norm,
              totalBusiness,
              totalUdhar: remaining,
              paidAmount: totalWusool,
              totalWusool,
              wusoolHistory: srcHistory,
            });
            restored.customers++;
          } else { skipped.customers++; }
        } catch { skipped.customers++; }
      }
    }

    return NextResponse.json({ success: true, restored, skipped });
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 500 });
  }
}