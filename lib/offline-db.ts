import Dexie, { Table } from 'dexie';

export interface WusoolHistoryEntry { amount: number; date: string; note?: string; }

export type MainUnit = "box" | "bottle" | "tube" | "piece";
export type SellUnit = "patta" | "half_patta" | "box" | "bottle" | "ml" | "tube" | "piece";
export type WusoolSyncPayload = { amount: number; note?: string; date: string; };

export interface OfflineProduct {
  _id?: string; localId: string; name: string; company: string; generic: string;
  batchNo: string; expiryDate?: string; barcode?: string; rack?: string;
  mainUnit: MainUnit;
  pattaPerBox: number;
  mlPerBottle: number;
  buyPrice: number;
  sellPrice: number;
  stock: number;
  stockDisplay?: string;
  userId: string; synced: number; createdAt?: string; lastSyncedAt?: string;
}

export interface OfflineSale {
  localId: string; productId: string; productName: string;
  mainUnit: MainUnit; sellUnit: SellUnit;
  quantity: number;
  pattaPerBox: number; mlPerBottle: number;
  buyPriceMain: number; sellPrice: number;
  total: number; profit: number;
  deductionMain: number; deductionPatta: number;
  userId: string; createdAt: string; synced: number;
  customerName?: string; normalizedCustomerName?: string;
  paymentType?: string; status?: "paid" | "pending" | "partial"; isCredit?: boolean;
  customerId?: string; saleId?: string;
}

export interface OfflinePurchaseItem {
  productId?: string;
  name: string;
  company?: string;
  quantity: number;
  mainUnit: MainUnit;
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
  localId: string; _id?: string; saleIds: string[]; name: string; normalizedName: string;
  phone?: string; village?: string; totalUdhar: number; totalBusiness: number;
  lastUdharDate?: string; lastWusoolDate?: string; paidAt?: string;
  synced: number; createdAt?: string; billsCount: number;
  isPaid?: boolean; paidAmount?: number; wusoolHistory?: WusoolHistoryEntry[];
}

export type OfflinePayload = OfflineSale | OfflineProduct | OfflineCustomer | WusoolSyncPayload | OfflinePurchase;

export interface SyncQueueItem {
  id?: number; type: 'sale' | 'product' | 'customer' | 'wusool' | 'purchase';
  localId: string; payload: OfflinePayload; createdAt: Date; attempts: number;
}

export class OfflineDB extends Dexie {
  products!: Table<OfflineProduct, string>;
  sales!: Table<OfflineSale, string>;
  purchases!: Table<OfflinePurchase, string>;
  customers!: Table<OfflineCustomer, string>;
  syncQueue!: Table<SyncQueueItem, number>;

  constructor() {
    super('YasirMedicalOfflineV15');
    this.version(15).stores({
      products: 'localId, _id, userId, synced, name, mainUnit',
      sales: 'localId, productId, userId, synced, createdAt, customerName, status',
      purchases: 'localId, _id, userId, synced, createdAt, supplier',
      customers: 'localId, _id, name, normalizedName, totalUdhar, synced',
      syncQueue: '++id, type, localId, createdAt'
    });
    // keep old versions for migration
    this.version(14).stores({
      products: 'localId, _id, userId, synced, name, mainUnit',
      sales: 'localId, productId, userId, synced, createdAt, customerName, status',
      customers: 'localId, _id, name, normalizedName, totalUdhar, synced',
      syncQueue: '++id, type, localId, createdAt'
    });
  }
}

export const offlineDB = new OfflineDB();
export const db = offlineDB;

export function calcDeduction(main: MainUnit, sell: SellUnit, qty: number, ppb: number, mlB: number): { main: number; patta: number } {
  if (main === "box") {
    if (sell === "patta") return { main: qty / ppb, patta: qty };
    if (sell === "half_patta") return { main: (qty * 0.5) / ppb, patta: qty * 0.5 };
    if (sell === "box") return { main: qty, patta: qty * ppb };
  }
  if (main === "bottle" && sell === "ml") {
    return { main: qty / mlB, patta: 0 };
  }
  return { main: qty, patta: 0 };
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
    items: items.map(it => ({ ...it, totalBuy: it.quantity * it.buyPricePerUnit })),
    paymentType,
    userId,
    createdAt: new Date().toISOString(),
    synced: 0,
  };
  await offlineDB.purchases.add(purchase);
  await offlineDB.syncQueue.add({
    type: 'purchase',
    localId,
    payload: purchase,
    createdAt: new Date(),
    attempts: 0,
  });
  return localId;
}

export async function upsertOfflineCustomer(sale: OfflineSale, village = "", phone = ""): Promise<string | null> {
  const name = (sale.customerName || "").trim();
  if (!name || name.toLowerCase() === "walk-in") return null;
  const normalized = name.toLowerCase();
  const candidates = await offlineDB.customers.where("normalizedName").equals(normalized).toArray();
  const existing = candidates.find((c) => !c.isPaid) || null;
  if (existing) {
    await offlineDB.customers.update(existing.localId, {
      totalUdhar: Math.round((existing.totalUdhar || 0) + sale.total),
      totalBusiness: Math.round((existing.totalBusiness || 0) + sale.total),
      saleIds: [...(existing.saleIds || []), sale.localId],
      billsCount: (existing.billsCount || 1) + 1,
      lastUdharDate: new Date().toISOString(),
    });
    return existing.localId;
  } else {
    const localId = `cust_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await offlineDB.customers.add({
      localId, saleIds: [sale.localId], name, normalizedName: normalized,
      phone, village, totalUdhar: Math.round(sale.total), totalBusiness: Math.round(sale.total),
      lastUdharDate: new Date().toISOString(), synced: 0, createdAt: new Date().toISOString(),
      billsCount: 1, isPaid: false, paidAmount: 0, wusoolHistory: [],
    });
    return localId;
  }
}

export async function addOfflineWusool(customerLocalId: string, amount: number, note = ""): Promise<WusoolHistoryEntry | null> {
  const customer = await offlineDB.customers.get(customerLocalId);
  if (!customer) return null;
  const paid = Math.round(amount);
  const newUdhar = Math.round((customer.totalUdhar || 0) - paid);
  const entry: WusoolHistoryEntry = { amount: paid, date: new Date().toISOString(), note };
  if (newUdhar <= 0) {
    await offlineDB.customers.update(customerLocalId, { totalUdhar: 0, isPaid: true, paidAmount: customer.totalBusiness, wusoolHistory: [...(customer.wusoolHistory || []), entry], synced: 0 });
  } else {
    await offlineDB.customers.update(customerLocalId, { totalUdhar: newUdhar, paidAmount: (customer.paidAmount || 0) + paid, wusoolHistory: [...(customer.wusoolHistory || []), entry], synced: 0 });
  }
  await offlineDB.syncQueue.add({ type: 'wusool', localId: customerLocalId, payload: { amount: paid, note, date: entry.date }, createdAt: new Date(), attempts: 0 });
  return entry;
}