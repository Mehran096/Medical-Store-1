import Dexie, { Table } from 'dexie';

export type MainUnit = "box" | "bottle" | "tube" | "piece";
export type SellUnit = "patta" | "half_patta" | "box" | "bottle" | "ml" | "tube" | "piece";
export type WusoolHistoryEntry = { amount: number; date: string; note?: string; }
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
  localId: string; _id?: string; saleIds: string[]; name: string; normalizedName: string;
  phone?: string; village?: string; totalUdhar: number; totalBusiness: number;
  lastUdharDate?: string; lastWusoolDate?: string; paidAt?: string;
  synced: number; createdAt?: string; billsCount: number;
  isPaid?: boolean; paidAmount?: number; wusoolHistory?: WusoolHistoryEntry[];
}

export type OfflinePayload = OfflineSale | OfflineProduct | OfflineCustomer | WusoolSyncPayload | OfflinePurchase | OfflineBatch;

export interface SyncQueueItem {
  id?: number; type: 'sale' | 'product' | 'customer' | 'wusool' | 'purchase' | 'batch';
  localId: string; payload: OfflinePayload; createdAt: Date; attempts: number;
}

export class OfflineDB extends Dexie {
  products!: Table<OfflineProduct, string>;
  batches!: Table<OfflineBatch, string>;
  sales!: Table<OfflineSale, string>;
  purchases!: Table<OfflinePurchase, string>;
  customers!: Table<OfflineCustomer, string>;
  syncQueue!: Table<SyncQueueItem, number>;

  constructor() {
    super('YasirMedicalOfflineV16');
    this.version(17).stores({
      products: 'localId, _id, userId, synced, name, mainUnit',
      batches: 'localId, _id, productId, userId, synced, expiryDate, batchNo, quantity',
      sales: 'localId, productId, batchId, userId, synced, createdAt, customerName, status',
      purchases: 'localId, _id, userId, synced, createdAt, supplier',
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

export async function getExpiringBatches(userId: string, days = 90) {
  const limitDate = new Date();
  limitDate.setDate(limitDate.getDate() + days);
  const limitISO = limitDate.toISOString();
  return await offlineDB.batches
    .where('userId').equals(userId)
    .filter(b => b.expiryDate <= limitISO && b.quantity > 0)
    .sortBy('expiryDate');
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
  
  await offlineDB.transaction('rw', offlineDB.purchases, offlineDB.batches, offlineDB.products, offlineDB.syncQueue, async () => {
    await offlineDB.purchases.add(purchase);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const batchLocalId = `batch_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`;
      const batch: OfflineBatch = {
        localId: batchLocalId,
        productId: item.productId,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        buyPrice: item.buyPricePerUnit,
        quantity: item.quantity,
        userId,
        synced: 0,
        createdAt: new Date().toISOString()
      };
      await offlineDB.batches.add(batch);
      await offlineDB.syncQueue.add({
        type: 'batch',
        localId: batchLocalId,
        payload: batch,
        createdAt: new Date(),
        attempts: 0
      });
      const prod = await offlineDB.products.where('_id').equals(item.productId).or('localId').equals(item.productId).first();
      if (prod) {
        const newStock = (prod.stock || 0) + item.quantity;
        const newAvg = prod.buyPriceAvg ? ((prod.buyPriceAvg * (prod.stock || 0)) + (item.buyPricePerUnit * item.quantity)) / newStock : item.buyPricePerUnit;
        await offlineDB.products.update(prod.localId, {
          stock: newStock,
          buyPriceAvg: newAvg
        });
      }
    }
    await offlineDB.syncQueue.add({
      type: 'purchase',
      localId,
      payload: purchase,
      createdAt: new Date(),
      attempts: 0,
    });
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

export async function addOfflineWusool(customerLocalId: string, amount: number, note = "") {
  const customer = await offlineDB.customers.get(customerLocalId);
  if (!customer) return null;
  const paid = Math.round(amount);
  const newUdhar = Math.round((customer.totalUdhar || 0) - paid);
  const entry = { amount: paid, date: new Date().toISOString(), note };
  if (newUdhar <= 0) {
    await offlineDB.customers.update(customerLocalId, { totalUdhar: 0, isPaid: true, paidAmount: customer.totalBusiness, wusoolHistory: [...(customer.wusoolHistory || []), entry], synced: 0 });
  } else {
    await offlineDB.customers.update(customerLocalId, { totalUdhar: newUdhar, paidAmount: (customer.paidAmount || 0) + paid, wusoolHistory: [...(customer.wusoolHistory || []), entry], synced: 0 });
  }
  await offlineDB.syncQueue.add({ type: 'wusool', localId: customerLocalId, payload: { amount: paid, note, date: entry.date }, createdAt: new Date(), attempts: 0 });
  return entry;
}