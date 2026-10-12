import Dexie, { Table } from 'dexie';

export interface WusoolHistoryEntry { amount: number; date: string; note?: string; }

export type MedicalUnit = "tablet" | "patta" | "half_patta" | "box" | "bottle" | "syrup" | "ml" | "liter" | "gram" | "kg" | "tube" | "sachet" | "piece" | "capsule" | "injection";
export type BaseUnit = "tablet" | "ml" | "gram" | "piece";

export interface OfflineProduct {
  _id?: string; localId: string; name: string; company: string; generic: string; batchNo: string;
  expiryDate?: string; barcode?: string; rack?: string;
  price: number; buyPrice: number; sellPrice: number;
  unit: MedicalUnit; baseUnit: BaseUnit; stock: number;
  tabletsPerPatta: number; pattaPerBox: number; qtyPerUnit?: number;
  subUnit?: string; baseQtyInSub?: number; pricePerSub?: number;
  totalStockInSub?: number; stockInPatta?: string; userId: string;
  synced: number; createdAt?: string; lastSyncedAt?: string;
}

export interface OfflineSale {
  localId: string; productId: string; productName: string; quantity: number;
  price: number; buyPrice?: number; sellPrice?: number; profit?: number; total: number;
  soldBy?: string; customerName?: string; normalizedCustomerName?: string; paymentType?: string;
  userId: string; createdAt: string; synced: number; offlineCreatedAt?: string;
  unit?: MedicalUnit; baseUnit?: BaseUnit; tabletsPerPatta?: number; pattaPerBox?: number;
  quantityInTablets: number; totalTablets: number; subUnit?: string; qtyPerUnit?: number;
  quantityInSub?: number; isPartialSale?: boolean; pricePerSub?: number;
  customerId?: string; saleId?: string; paidAmount?: number; pendingAmount?: number;
  status?: "paid" | "pending" | "partial"; isCredit?: boolean; wusoolDate?: string;
}

export interface OfflineCustomer {
  localId: string; _id?: string; saleIds: string[]; saleId?: string; name: string;
  normalizedName: string; phone?: string; village?: string; totalUdhar: number;
  totalBusiness: number; lastUdharDate?: string; synced: number; createdAt?: string;
  billsCount: number; isPaid?: boolean; paidAmount?: number; paidAt?: string;
  lastWusoolDate?: string; wusoolHistory?: WusoolHistoryEntry[]; age?: number; customerType?: string;
}

type LegacyCustomerMigrate = Partial<OfflineCustomer> & { saleId?: string; saleIds?: string[]; totalBusiness?: number; totalUdhar?: number; };
type LegacySaleMigrate = Partial<OfflineSale> & { unit?: string; };
type LegacyProductMigrate = Partial<OfflineProduct> & { unit?: string; };

export type WusoolSyncPayload = { amount: number; note?: string; date: string; };
export interface SyncQueueItem { id?: number; type: 'sale' | 'product' | 'customer' | 'wusool'; localId: string; payload: OfflineSale | OfflineProduct | OfflineCustomer | WusoolSyncPayload; createdAt: Date; attempts: number; }

function detectBaseUnit(unit: string): BaseUnit {
  if (["ml","liter","bottle","syrup"].includes(unit)) return "ml";
  if (["gram","kg","tube"].includes(unit)) return "gram";
  if (["piece","injection","capsule","sachet"].includes(unit)) return "piece";
  return "tablet";
}

export class OfflineDB extends Dexie {
  products!: Table<OfflineProduct, string>; sales!: Table<OfflineSale, string>;
  customers!: Table<OfflineCustomer, string>; syncQueue!: Table<SyncQueueItem, number>;
  constructor() {
    super('YasirMedicalOfflineV11');
    this.version(1).stores({ products: 'localId, _id, userId, synced, name', sales: 'localId, productId, userId, synced, createdAt', syncQueue: '++id, type, localId, createdAt' });
    this.version(2).stores({ products: 'localId, _id, userId, synced, name', sales: 'localId, productId, userId, synced, createdAt', syncQueue: '++id, type, localId, createdAt' })
   .upgrade(tx => tx.table("products").toCollection().modify((p: LegacyProductMigrate) => {
        if (!p.qtyPerUnit) {
          if (p.unit === "bottle" || p.unit === "liter") p.qtyPerUnit = 120;
          else if (p.unit === "tube" || p.unit === "kg") p.qtyPerUnit = 20;
          else p.qtyPerUnit = 10;
        }
        if (!p.subUnit) {
          if (p.unit === "bottle" || p.unit === "liter") p.subUnit = "ml";
          else if (p.unit === "tube" || p.unit === "kg") p.subUnit = "gram";
          else p.subUnit = "tablet";
        }
        if (!p.baseUnit) p.baseUnit = detectBaseUnit(p.unit || "tablet");
    }));
    this.version(3).stores({ products: 'localId, _id, userId, synced, name', sales: 'localId, productId, userId, synced, createdAt, customerName, status, isCredit', customers: 'localId, _id, name, totalUdhar, synced', syncQueue: '++id, type, localId, createdAt' });
    this.version(4).stores({ products: 'localId, _id, userId, synced, name', sales: 'localId, productId, userId, synced, createdAt, customerName, status, isCredit', customers: 'localId, _id, saleId, name, totalUdhar, synced', syncQueue: '++id, type, localId, createdAt' })
     .upgrade(tx => tx.table("customers").toCollection().modify((c: LegacyCustomerMigrate) => { if (!c.saleId) c.saleId = c.localId; }));
    this.version(5).stores({ products: 'localId, _id, userId, synced, name', sales: 'localId, productId, userId, synced, createdAt, customerName, status, isCredit', customers: 'localId, _id, saleId, name, totalUdhar, synced, isPaid', syncQueue: '++id, type, localId, createdAt' })
     .upgrade(tx => tx.table("customers").toCollection().modify((c: LegacyCustomerMigrate) => { if (c.isPaid === undefined) c.isPaid = false; if (c.paidAmount === undefined) c.paidAmount = 0; }));
    this.version(6).stores({ products: 'localId, _id, userId, synced, name', sales: 'localId, productId, userId, synced, createdAt, customerName, normalizedCustomerName, status, isCredit', customers: 'localId, _id, name, normalizedName, totalUdhar, synced, isPaid', syncQueue: '++id, type, localId, createdAt' })
     .upgrade(async tx => {
        await tx.table("customers").toCollection().modify((c: LegacyCustomerMigrate) => {
          if (c.saleId && c.saleIds === undefined) c.saleIds = [c.saleId];
          if (!c.saleIds) c.saleIds = []; if (!c.normalizedName) c.normalizedName = (c.name || "").trim().toLowerCase();
          if (!c.billsCount) c.billsCount = c.saleIds.length || 1;
        });
        await tx.table("sales").toCollection().modify((s: LegacySaleMigrate) => { if (s.customerName &&!s.normalizedCustomerName) s.normalizedCustomerName = s.customerName.trim().toLowerCase(); });
      });
    this.version(7).stores({ products: 'localId, _id, userId, synced, name', sales: 'localId, productId, userId, synced, createdAt, customerName, normalizedCustomerName, status, isCredit', customers: 'localId, _id, name, normalizedName, totalUdhar, synced, isPaid', syncQueue: '++id, type, localId, createdAt' })
     .upgrade(tx => tx.table("customers").toCollection().modify((c: LegacyCustomerMigrate) => { if (!c.wusoolHistory) c.wusoolHistory = []; if (!c.paidAmount) c.paidAmount = (c.totalBusiness || 0) - (c.totalUdhar || 0); }));
    this.version(8).stores({ products: 'localId, _id, userId, synced, name', sales: 'localId, productId, userId, synced, createdAt, customerName, normalizedCustomerName, status, isCredit, saleId', customers: 'localId, _id, name, normalizedName, totalUdhar, synced, isPaid, saleId', syncQueue: '++id, type, localId, createdAt' })
     .upgrade(tx => tx.table("sales").toCollection().modify((s: LegacySaleMigrate) => { if (!s.saleId) s.saleId = s.localId; }));
    this.version(9).stores({ products: 'localId, _id, userId, synced, name, company, expiryDate', sales: 'localId, productId, userId, synced, createdAt, customerName, normalizedCustomerName, status, isCredit, saleId', customers: 'localId, _id, name, normalizedName, totalUdhar, synced, isPaid, saleId', syncQueue: '++id, type, localId, createdAt' })
     .upgrade(async tx => {
        await tx.table("products").toCollection().modify((p: LegacyProductMigrate) => {
          if (!p.company) p.company = "Unknown"; if (!p.generic) p.generic = ""; if (!p.batchNo) p.batchNo = "";
          if (!p.tabletsPerPatta) p.tabletsPerPatta = 10; if (!p.pattaPerBox) p.pattaPerBox = 10;
          if (!p.baseUnit) p.baseUnit = detectBaseUnit(p.unit || "tablet");
        });
        await tx.table("sales").toCollection().modify((s: LegacySaleMigrate) => {
          if (s.quantityInTablets === undefined) { s.quantityInTablets = s.quantityInSub || s.quantity || 0; s.totalTablets = s.quantityInTablets; }
          if (!s.tabletsPerPatta) s.tabletsPerPatta = 10; if (!s.pattaPerBox) s.pattaPerBox = 10;
        });
      });
    this.version(10).stores({ products: 'localId, _id, userId, synced, name, company, expiryDate, baseUnit, unit', sales: 'localId, productId, userId, synced, createdAt, customerName, normalizedCustomerName, status, isCredit, saleId', customers: 'localId, _id, name, normalizedName, totalUdhar, synced, isPaid, saleId', syncQueue: '++id, type, localId, createdAt' })
     .upgrade(tx => tx.table("products").toCollection().modify((p: LegacyProductMigrate) => {
        if (!p.baseUnit) p.baseUnit = detectBaseUnit(p.unit || "tablet");
        if (!p.qtyPerUnit) { if (p.baseUnit === "ml") p.qtyPerUnit = 120; else if (p.baseUnit === "gram") p.qtyPerUnit = 20; else p.qtyPerUnit = 10; }
      }));
    this.version(11).stores({ products: 'localId, _id, userId, synced, name, company, expiryDate, baseUnit, unit', sales: 'localId, productId, userId, synced, createdAt, customerName, normalizedCustomerName, status, isCredit, saleId', customers: 'localId, _id, name, normalizedName, totalUdhar, synced, isPaid, saleId', syncQueue: '++id, type, localId, createdAt' });
  }
}

export const offlineDB = new OfflineDB();
export const db = offlineDB;

export async function upsertOfflineCustomer(sale: OfflineSale, village = "", phone = ""): Promise<string | null> {
  const name = (sale.customerName || "").trim();
  if (!name || name.toLowerCase() === "walk-in") return null;
  const normalized = name.toLowerCase();
  const candidates = await offlineDB.customers.where("normalizedName").equals(normalized).toArray();
  const existing = candidates.filter((c) => c.isPaid === false)[0] || null;
  if (existing) {
    await offlineDB.customers.update(existing.localId, {
      totalUdhar: Math.round((existing.totalUdhar || 0) + sale.total),
      totalBusiness: Math.round((existing.totalBusiness || 0) + sale.total),
      saleIds: [...(existing.saleIds || []), sale.localId], saleId: sale.localId,
      billsCount: (existing.billsCount || 1) + 1, lastUdharDate: new Date().toISOString(),
    });
    return existing.localId;
  } else {
    const localId = `cust_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await offlineDB.customers.add({
      localId, saleIds: [sale.localId], saleId: sale.localId, name, normalizedName: normalized,
      phone, village, totalUdhar: Math.round(sale.total), totalBusiness: Math.round(sale.total),
      lastUdharDate: new Date().toISOString(), synced: 0, createdAt: new Date().toISOString(),
      billsCount: 1, isPaid: false, paidAmount: 0, wusoolHistory: [], customerType: "patient",
    });
    return localId;
  }
}

export async function addOfflineWusool(customerLocalId: string, amount: number, note = "") {
  const customer = await offlineDB.customers.get(customerLocalId);
  if (!customer) return null;
  const paid = Math.round(amount); const newUdhar = Math.round((customer.totalUdhar || 0) - paid);
  const entry: WusoolHistoryEntry = { amount: paid, date: new Date().toISOString(), note };
  if (newUdhar <= 0) {
    await offlineDB.customers.update(customerLocalId, { totalUdhar: 0, isPaid: true, paidAmount: customer.totalBusiness, paidAt: new Date().toISOString(), lastWusoolDate: new Date().toISOString(), wusoolHistory: [...(customer.wusoolHistory || []), entry], synced: 0 });
  } else {
    await offlineDB.customers.update(customerLocalId, { totalUdhar: newUdhar, paidAmount: (customer.paidAmount || 0) + paid, lastWusoolDate: new Date().toISOString(), wusoolHistory: [...(customer.wusoolHistory || []), entry], synced: 0 });
  }
  await offlineDB.syncQueue.add({ type: 'wusool', localId: customerLocalId, payload: { amount: paid, note, date: entry.date }, createdAt: new Date(), attempts: 0 });
  return entry;
}