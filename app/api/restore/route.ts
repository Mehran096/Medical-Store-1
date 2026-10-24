import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import Batch from "@/models/Batch";
import Sale from "@/models/Sale";
import Purchase from "@/models/Purchase";
import Customer from "@/models/Customer";

export async function POST(req: NextRequest) {
  try {
    await dbConnect();
    const body = await req.json();
    const src = body.data || body;
    const { products = [], batches = [], sales = [], purchases = [], customers = [] } = src as {
      products: Record<string, unknown>[];
      batches: Record<string, unknown>[];
      sales: Record<string, unknown>[];
      purchases: Record<string, unknown>[];
      customers: Record<string, unknown>[];
    };

    const restored = { products: 0, batches: 0, sales: 0, purchases: 0, customers: 0 };
    const skipped = { products: 0, batches: 0, sales: 0, purchases: 0, customers: 0 };

    const ProductModel = Product as unknown as { create: (d: unknown) => Promise<unknown>; findById: (id: string) => Promise<unknown>; findOne: (q: unknown) => Promise<unknown> };
    const BatchModel = Batch as unknown as { create: (d: unknown) => Promise<unknown>; findById: (id: string) => Promise<unknown>; findOne: (q: unknown) => Promise<unknown> };
    const SaleModel = Sale as unknown as { create: (d: unknown) => Promise<unknown>; findById: (id: string) => Promise<unknown>; findOne: (q: unknown) => Promise<unknown> };
    const PurchaseModel = Purchase as unknown as { create: (d: unknown) => Promise<unknown>; findById: (id: string) => Promise<unknown>; findOne: (q: unknown) => Promise<unknown> };
    const CustomerModel = Customer as unknown as { create: (d: unknown) => Promise<unknown>; findById: (id: string) => Promise<unknown>; findOne: (q: unknown) => Promise<unknown> };

    // 1. PRODUCTS
    for (const p of products as { _id?: string; localId?: string }[]) {
      const id = p._id || p.localId;
      let exists = null;
      try { exists = id ? await ProductModel.findById(id) : null; } catch {}
      if (!exists && p.localId) exists = await ProductModel.findOne({ localId: p.localId });
      if (!exists) {
        try {
          await ProductModel.create({ ...p });
          restored.products++;
        } catch { skipped.products++; }
      } else { skipped.products++; }
    }

    // 2. BATCHES
    for (const b of batches as { _id?: string; localId?: string; productId?: string; batchNo?: string; userId?: string }[]) {
      let exists = null;
      try { if (b._id) exists = await BatchModel.findById(b._id); } catch {}
      if (!exists && b.localId) exists = await BatchModel.findOne({ localId: b.localId, userId: b.userId });
      if (!exists) exists = await BatchModel.findOne({ productId: b.productId, batchNo: b.batchNo, userId: b.userId });
      if (!exists) {
        try { await BatchModel.create({ ...b }); restored.batches++; } catch { skipped.batches++; }
      } else { skipped.batches++; }
    }

    // 3. PURCHASES
    for (const p of purchases as { _id?: string; localId?: string }[]) {
      let exists = null;
      try { if (p._id) exists = await PurchaseModel.findById(p._id); } catch {}
      if (!exists && p.localId) exists = await PurchaseModel.findOne({ localId: p.localId });
      if (!exists) {
        try { await PurchaseModel.create({ ...p }); restored.purchases++; } catch { skipped.purchases++; }
      } else { skipped.purchases++; }
    }

    // 4. SALES
    for (const s of sales as { _id?: string; localId?: string; __v?: number }[]) {
      let exists = null;
      try { if (s._id) exists = await SaleModel.findById(s._id); } catch {}
      if (!exists && s.localId) exists = await SaleModel.findOne({ localId: s.localId });
      if (!exists) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { __v: _omit, ...rest } = s as Record<string, unknown>;
          await SaleModel.create(rest);
          restored.sales++;
        } catch { skipped.sales++; }
      } else { skipped.sales++; }
    }

    // 5. CUSTOMERS
    for (const c of customers as { _id?: string; name?: string; normalizedName?: string; userId?: string }[]) {
      const norm = (c.normalizedName || c.name || "").trim().toLowerCase();
      const existing = await Customer.findOne({ userId: c.userId, normalizedName: norm, isPaid: false }) as {
        totalUdhar: number; totalBusiness: number; saleIds: unknown; billsCount: number; wusoolHistory: unknown; save: () => Promise<void>;
      } | null;
      if (existing) {
        const srcC = c as { totalUdhar?: number; totalBusiness?: number; saleIds?: unknown; billsCount?: number; wusoolHistory?: unknown };
        existing.totalUdhar = srcC.totalUdhar as number;
        existing.totalBusiness = srcC.totalBusiness as number;
        existing.saleIds = srcC.saleIds as never;
        existing.billsCount = srcC.billsCount as number;
        existing.wusoolHistory = srcC.wusoolHistory as never;
        await existing.save();
        restored.customers++;
      } else {
        try {
          let byId = null;
          try { if (c._id) byId = await CustomerModel.findById(c._id); } catch {}
          if (!byId) {
            await CustomerModel.create({ ...c, normalizedName: norm });
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