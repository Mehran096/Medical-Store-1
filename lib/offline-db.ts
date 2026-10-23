import Dexie, { type Table } from "dexie";

export type MainUnit = "box" | "bottle" | "tube" | "piece";
export type SellUnit = "patta" | "half_patta" | "box" | "bottle" | "ml" | "tube" | "piece";
export type WusoolHistoryEntry = { amount: number; date: string; note?: string; };
export type WusoolSyncPayload = { amount: number; note?: string; date: string; };

export interface OfflineBatch {
  localId: string;
  _id?: string;
  productId: string;
  batchNo: string;
  expiryDate: string;
  buyPrice: number;
  quantity: number;
  userId: string;
  synced: number;
  createdAt: string;
}

export interface OfflineProduct {
  _id?: string;
  localId: string;
  name: string;
  company: string;
  generic: string;
  barcode?: string;
  rack?: string;
  mainUnit: MainUnit;
  pattaPerBox: number;
  mlPerBottle: number;
  sellPrice: number;
  stock: number;
  buyPriceAvg?: number;
  userId: string;
  synced: number;
  createdAt?: string;
  lastSyncedAt?: string;
}

export interface OfflineSale {
  localId: string;
  productId: string;
  productName: string;
  batchId?: string;
  batchNo?: string;
  expiryDate?: string;
  mainUnit: MainUnit;
  sellUnit: SellUnit;
  quantity: number;
  pattaPerBox: number;
  mlPerBottle: number;
  buyPriceMain: number;
  sellPrice: number;
  total: number;
  profit: number;
  deductionMain: number;
  deductionPatta: number;
  userId: string;
  createdAt: string;
  synced: number;
  customerName?: string;
  normalizedCustomerName?: string;
  paymentType?: string;
  status?: "paid" | "pending" | "partial";
  isCredit?: boolean;
  customerId?: string;
  saleId?: string;
}

export interface OfflinePurchaseItem {
  productId: string;
  name: string;
  company?: string;
  quantity: number;
  mainUnit: MainUnit;
  batchNo: string;
  expiryDate: string;
  buyPricePerUnit: number;
  sellPricePerUnit: number;
  totalBuy?: number;
}

export interface OfflinePurchase {
  localId: string;
  _id?: string;
  supplier: string;
  invoiceNo?: string;
  totalBuyAmount: number;
  totalItems: number;
  items: OfflinePurchaseItem[];
  paymentType: "cash" | "credit";
  userId: string;
  createdAt: string;
  synced: number;
}

export interface OfflineCustomer {
  localId: string;
  _id?: string;
  saleIds: string[];
  name: string;
  normalizedName: string;
  phone?: string;
  village?: string;
  totalUdhar: number;
  totalBusiness: number;
  lastUdharDate?: string;
  lastWusoolDate?: string;
  paidAt?: string;
  synced: number;
  createdAt?: string;
  billsCount: number;
  isPaid?: boolean;
  paidAmount?: number;
  wusoolHistory?: WusoolHistoryEntry[];
}

export type OfflinePayload = OfflineSale | OfflineProduct | OfflineCustomer | WusoolSyncPayload | OfflinePurchase | OfflineBatch;

export interface SyncQueueItem {
  id?: number;
  type: "sale" | "product" | "customer" | "wusool" | "purchase" | "batch";
  localId: string;
  payload: OfflinePayload;
  createdAt: Date;
  attempts: number;
}

export class OfflineDB extends Dexie {
  products!: Table<OfflineProduct, string>;
  batches!: Table<OfflineBatch, string>;
  sales!: Table<OfflineSale, string>;
  purchases!: Table<OfflinePurchase, string>;
  customers!: Table<OfflineCustomer, string>;
  syncQueue!: Table<SyncQueueItem, number>;

  constructor() {
    super("YasirMedicalOfflineV16");
    this.version(18).stores({
      products: "localId, _id, userId, synced, name, mainUnit",
      batches: "localId, _id, productId, userId, synced, expiryDate, batchNo, quantity",
      sales: "localId, productId, batchId, userId, synced, createdAt, customerName, status",
      purchases: "localId, _id, userId, synced, createdAt, supplier",
      customers: "localId, _id, name, normalizedName, totalUdhar, synced",
      syncQueue: "++id, type, localId, createdAt",
    });
  }
}

export const offlineDB = new OfflineDB();
export const db = offlineDB;

export function calcDeduction(main: MainUnit, sell: SellUnit, qty: number, ppb: number, mlB: number): { main: number; patta: number } {
  let m = 0; let p = 0;
  if (main === "box") {
    if (sell === "patta") { m = qty / ppb; p = qty; }
    else if (sell === "half_patta") { m = (qty * 0.5) / ppb; p = qty * 0.5; }
    else { m = qty; p = qty * ppb; }
  } else if (main === "bottle" && sell === "ml") {
    m = qty / mlB; p = 0;
  } else {
    m = qty; p = 0;
  }
  return { main: Math.round(m * 1000000)/1000000, patta: Math.round(p * 1000000)/1000000 };
}

export async function getExpiringBatches(userId: string, days = 90): Promise<OfflineBatch[]> {
  const limitDate = new Date();
  limitDate.setDate(limitDate.getDate() + days);
  const limitISO = limitDate.toISOString();
  const all = await offlineDB.batches
    .where("userId")
    .equals(userId)
    .filter((b) => b.expiryDate <= limitISO && b.quantity > 0.0001)
    .sortBy("expiryDate");

  const map = new Map<string, OfflineBatch>();
  for (const b of all) {
    const key = `${b.productId}_${b.batchNo.trim().toLowerCase()}_${b.expiryDate.slice(0, 10)}`;
    const prev = map.get(key);
    if (!prev) map.set(key, b);
    else map.set(key, { ...prev, quantity: Math.round((prev.quantity + b.quantity) * 1000000)/1000000 });
  }
  return Array.from(map.values());
}

export async function addOfflinePurchase(
  items: OfflinePurchaseItem[],
  supplier: string,
  invoiceNo: string,
  userId: string,
  paymentType: "cash" | "credit" = "cash"
): Promise<string> {
  const totalBuyAmount = items.reduce((sum, it) => sum + it.quantity * it.buyPricePerUnit, 0);
  const localId = `pur_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const purchase: OfflinePurchase = {
    localId,
    supplier,
    invoiceNo,
    totalBuyAmount,
    totalItems: items.length,
    items: items.map((it) => ({ ...it, batchNo: String(it.batchNo).trim(), totalBuy: it.quantity * it.buyPricePerUnit })),
    paymentType,
    userId,
    createdAt: new Date().toISOString(),
    synced: 0,
  };

  await offlineDB.transaction("rw", offlineDB.purchases, offlineDB.batches, offlineDB.products, offlineDB.syncQueue, async () => {
    await offlineDB.purchases.add(purchase);

    // FIXED V34: key includes expiry day like online
    const agg = new Map<string, OfflinePurchaseItem>();
    for (const it of items) {
      const expiryDay = it.expiryDate ? it.expiryDate.slice(0,10) : "no-expiry";
      const key = `${it.productId}_${String(it.batchNo).trim().toLowerCase()}_${expiryDay}`;
      const prev = agg.get(key);
      if (prev) agg.set(key, { ...prev, quantity: prev.quantity + it.quantity });
      else agg.set(key, { ...it, batchNo: String(it.batchNo).trim() });
    }

    for (const item of agg.values()) {
      const trimmed = String(item.batchNo).trim();
      const lower = trimmed.toLowerCase();
      const expiryDay = item.expiryDate ? item.expiryDate.slice(0,10) : "";

      const allForProduct = await offlineDB.batches.where("productId").equals(item.productId).toArray();
      // FIXED V34: find by batchNo + expiry day
      const existing = allForProduct.find((b) => b.batchNo.trim().toLowerCase() === lower && b.expiryDate.slice(0,10) === expiryDay && b.userId === userId);

      if (existing) {
        const newQty = Math.round((existing.quantity + item.quantity) * 1000000)/1000000;
        await offlineDB.batches.update(existing.localId, {
          quantity: newQty,
          expiryDate: item.expiryDate,
          buyPrice: item.buyPricePerUnit,
          synced: 0,
        });
      } else {
        const batchLocalId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const batch: OfflineBatch = {
          localId: batchLocalId,
          productId: item.productId,
          batchNo: trimmed,
          expiryDate: item.expiryDate,
          buyPrice: item.buyPricePerUnit,
          quantity: Math.round(item.quantity * 1000000)/1000000,
          userId,
          synced: 0,
          createdAt: new Date().toISOString(),
        };
        await offlineDB.batches.add(batch);
      }

      // FIXED V34: SUM + 6 decimals
      const batchesForProduct = await offlineDB.batches.where("productId").equals(item.productId).toArray();
      const sum = batchesForProduct.reduce((s, b) => s + b.quantity, 0);
      const prod = await offlineDB.products.where("_id").equals(item.productId).or("localId").equals(item.productId).first();
      if (prod) {
        const currentStock = prod.stock || 0;
        const newStockForAvg = currentStock + item.quantity;
        const newAvg = prod.buyPriceAvg ? (prod.buyPriceAvg * currentStock + item.buyPricePerUnit * item.quantity) / newStockForAvg : item.buyPricePerUnit;
        await offlineDB.products.update(prod.localId, {
          stock: Math.round(sum * 1000000) / 1000000,
          buyPriceAvg: Math.round(newAvg * 100) / 100,
          synced: 0,
        });
      }
    }
    await offlineDB.syncQueue.add({ type: "purchase", localId, payload: purchase, createdAt: new Date(), attempts: 0 });
  });
  return localId;
}

export async function upsertOfflineCustomer(sale: OfflineSale, village = "", phone = ""): Promise<string | null> {
  const name = (sale.customerName || "").trim();
  if (!name || name.toLowerCase() === "walk-in") return null;
  const normalized = name.toLowerCase();
  const candidates = await offlineDB.customers.where("normalizedName").equals(normalized).toArray();
  const existing = candidates.find((c) => !c.isPaid) || null;
  const exactTotal = Math.round(sale.total * 1000000) / 1000000;
  if (existing) {
    await offlineDB.customers.update(existing.localId, {
      totalUdhar: Math.round((existing.totalUdhar + exactTotal) * 1000000)/1000000,
      totalBusiness: Math.round((existing.totalBusiness + exactTotal) * 1000000)/1000000,
      saleIds: [...(existing.saleIds || []), sale.localId],
      billsCount: (existing.billsCount || 1) + 1,
      lastUdharDate: new Date().toISOString(),
      synced: 0,
    });
    return existing.localId;
  } else {
    const localId = `cust_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await offlineDB.customers.add({
      localId, saleIds: [sale.localId], name, normalizedName: normalized,
      phone, village,
      totalUdhar: exactTotal, totalBusiness: exactTotal,
      lastUdharDate: new Date().toISOString(),
      synced: 0, createdAt: new Date().toISOString(), billsCount: 1,
      isPaid: false, paidAmount: 0, wusoolHistory: [],
    });
    return localId;
  }
}

export async function addOfflineWusool(customerLocalId: string, amount: number, note = ""): Promise<WusoolHistoryEntry | null> {
  const customer = await offlineDB.customers.get(customerLocalId);
  if (!customer) return null;
  const paid = Math.round(amount * 1000000) / 1000000;
  const newUdhar = Math.round((customer.totalUdhar - paid) * 1000000) / 1000000;
  const entry: WusoolHistoryEntry = { amount: paid, date: new Date().toISOString(), note };
  if (newUdhar <= 0.000001) {
    await offlineDB.customers.update(customerLocalId, {
      totalUdhar: 0,
      isPaid: true,
      paidAmount: customer.totalBusiness,
      lastWusoolDate: entry.date,
      wusoolHistory: [...(customer.wusoolHistory || []), entry],
      synced: 0,
    });
  } else {
    await offlineDB.customers.update(customerLocalId, {
      totalUdhar: newUdhar,
      paidAmount: Math.round(((customer.paidAmount || 0) + paid) * 1000000) / 1000000,
      lastWusoolDate: entry.date,
      wusoolHistory: [...(customer.wusoolHistory || []), entry],
      synced: 0,
    });
  }
  await offlineDB.syncQueue.add({ type: "wusool", localId: customerLocalId, payload: { amount: paid, note, date: entry.date }, createdAt: new Date(), attempts: 0 });
  return entry;
}