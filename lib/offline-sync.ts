import { offlineDB, upsertOfflineCustomer, calcDeduction } from './offline-db';
import type { OfflineSale, MainUnit, SellUnit, WusoolHistoryEntry, WusoolSyncPayload } from './offline-db';

export interface OfflineSaleData {
  productId: string;
  productName: string;
  quantity: number;
  mainUnit: MainUnit;
  sellUnit: SellUnit;
  pattaPerBox: number;
  mlPerBottle: number;
  buyPriceMain: number;
  sellPrice: number;
  userId: string;
  soldBy?: string;
  customerName?: string;
  customerPhone?: string;
  customerVillage?: string;
  paymentType?: string;
  customerId?: string;
}

type SyncManager = { register: (tag: string) => Promise<void> };
type SyncRegistration = ServiceWorkerRegistration & { sync: SyncManager };

function isSyncRegistration(reg: ServiceWorkerRegistration): reg is SyncRegistration {
  return 'sync' in reg && typeof (reg as { sync?: unknown }).sync === 'object';
}

function genLocalId(): string {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveSaleOffline(saleData: OfflineSaleData): Promise<string> {
  const localId = genLocalId();
  const now = new Date().toISOString();
  const ppb = saleData.pattaPerBox || 10;
  const mlB = saleData.mlPerBottle || 120;

  const ded = calcDeduction(saleData.mainUnit, saleData.sellUnit, saleData.quantity, ppb, mlB);
  
  let total = 0;
  let profit = 0;

  if (saleData.mainUnit === "box") {
    const buyPerPatta = saleData.buyPriceMain / ppb;
    if (saleData.sellUnit === "patta") {
      total = saleData.sellPrice * saleData.quantity;
      profit = (saleData.sellPrice - buyPerPatta) * saleData.quantity;
    } else if (saleData.sellUnit === "half_patta") {
      total = saleData.sellPrice * saleData.quantity;
      profit = (saleData.sellPrice - buyPerPatta / 2) * saleData.quantity;
    } else {
      total = saleData.sellPrice * saleData.quantity;
      profit = (saleData.sellPrice - saleData.buyPriceMain) * saleData.quantity;
    }
  } else {
    if (saleData.sellUnit === "ml") {
      const buyPerMl = saleData.buyPriceMain / mlB;
      total = saleData.sellPrice * saleData.quantity;
      profit = (saleData.sellPrice - buyPerMl) * saleData.quantity;
    } else {
      total = saleData.sellPrice * saleData.quantity;
      profit = (saleData.sellPrice - saleData.buyPriceMain) * saleData.quantity;
    }
  }

  const isCredit = saleData.paymentType === "credit" || saleData.paymentType === "udhar";
  const status: "paid" | "pending" = isCredit ? "pending" : "paid";

  const newSale: OfflineSale = {
    localId, saleId: localId,
    productId: saleData.productId, productName: saleData.productName,
    mainUnit: saleData.mainUnit, sellUnit: saleData.sellUnit,
    quantity: saleData.quantity,
    pattaPerBox: ppb, mlPerBottle: mlB,
    buyPriceMain: saleData.buyPriceMain, 
    sellPrice: saleData.sellPrice,
    total: Math.round(total), 
    profit: Math.round(profit),
    deductionMain: ded.main, 
    deductionPatta: ded.patta,
    userId: saleData.userId, createdAt: now, synced: 0,
    customerName: saleData.customerName ?? 'Walk-in',
    normalizedCustomerName: (saleData.customerName ?? 'Walk-in').trim().toLowerCase(),
    paymentType: isCredit ? "credit" : (saleData.paymentType ?? 'cash'),
    customerId: saleData.customerId,
    status, isCredit,
  };

  await offlineDB.sales.put(newSale);

  if (isCredit && saleData.customerName && saleData.customerName.trim().toLowerCase() !== "walk-in") {
    try {
      const customerLocalId = await upsertOfflineCustomer(newSale, saleData.customerVillage ?? "", saleData.customerPhone ?? "");
      if (customerLocalId) await offlineDB.sales.update(localId, { customerId: customerLocalId });
    } catch {}
  }

  try {
    const prod = await offlineDB.products.get(saleData.productId);
    if (prod) {
      await offlineDB.products.update(prod.localId, { stock: Math.round((prod.stock - ded.main) * 1000) / 1000, synced: 0 });
    } else {
      const matched = await offlineDB.products.where('_id').equals(saleData.productId).or("localId").equals(saleData.productId).toArray();
      for (const p of matched) {
        await offlineDB.products.update(p.localId, { stock: Math.round((p.stock - ded.main) * 1000) / 1000, synced: 0 });
      }
    }
  } catch {}

  if (typeof window !== 'undefined' && 'serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (isSyncRegistration(reg)) await reg.sync.register('sync-sales');
    } catch {}
  }
  return localId;
}

export async function wusoolOffline(customerLocalId: string, amount: number, note = ""): Promise<boolean> {
  const customer = await offlineDB.customers.get(customerLocalId);
  if (!customer) return false;
  const paid = Math.round(amount);
  const newUdhar = Math.round((customer.totalUdhar ?? 0) - paid);
  const now = new Date().toISOString();
  const entry: WusoolHistoryEntry = { amount: paid, date: now, note };
  const existingHistory = customer.wusoolHistory ?? [];
  if (newUdhar <= 0) {
    await offlineDB.customers.update(customerLocalId, {
      totalUdhar: 0, isPaid: true, paidAmount: customer.totalBusiness,
      lastWusoolDate: now, wusoolHistory: [...existingHistory, entry], synced: 0,
    });
    for (const sId of customer.saleIds ?? []) {
      await offlineDB.sales.update(sId, { status: "paid", isCredit: false }).catch(() => {});
    }
  } else {
    await offlineDB.customers.update(customerLocalId, {
      totalUdhar: newUdhar, paidAmount: (customer.paidAmount ?? 0) + paid,
      lastWusoolDate: now, wusoolHistory: [...existingHistory, entry], synced: 0,
    });
  }
  await offlineDB.syncQueue.add({
    type: 'wusool', localId: customerLocalId,
    payload: { amount: paid, note, date: now },
    createdAt: new Date(), attempts: 0,
  });
  return true;
}

export async function syncOfflineSales(): Promise<{ synced: number; failed: number }> {
  if (typeof window === 'undefined' || !navigator.onLine) return { synced: 0, failed: 0 };
  const unsynced = await offlineDB.sales.where('synced').equals(0).toArray();
  let synced = 0; let failed = 0;
  for (const sale of unsynced) {
    try {
      const res = await fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: sale.productId, productName: sale.productName,
          mainUnit: sale.mainUnit, sellUnit: sale.sellUnit,
          quantity: sale.quantity,
          pattaPerBox: sale.pattaPerBox, mlPerBottle: sale.mlPerBottle,
          buyPriceMain: sale.buyPriceMain, sellPrice: sale.sellPrice,
          total: sale.total, profit: sale.profit,
          deductionMain: sale.deductionMain, deductionPatta: sale.deductionPatta,
          localId: sale.localId,
          customerName: sale.customerName ?? "Walk-in",
          paymentType: sale.paymentType ?? "cash",
          customerId: sale.customerId,
          status: sale.status ?? "paid", isCredit: sale.isCredit ?? false,
        }),
      });
      if (res.ok) {
        await offlineDB.sales.update(sale.localId, { synced: 1 });
        const allCustomers = await offlineDB.customers.toArray();
        const withSale = allCustomers.filter((c) => (c.saleIds ?? []).includes(sale.localId));
        for (const wc of withSale) await offlineDB.customers.update(wc.localId, { synced: 1 });
        synced++;
      } else failed++;
    } catch { failed++; }
  }
  try {
    const wusoolQueue = await offlineDB.syncQueue.where('type').equals('wusool').toArray();
    for (const q of wusoolQueue) {
      try {
        const p = q.payload as WusoolSyncPayload;
        const cust = await offlineDB.customers.get(q.localId);
        if (!cust) continue;
        await fetch('/api/khata/wusool', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: cust._id ?? cust.localId, customerName: cust.name, amount: p.amount, note: p.note }),
        });
        if (q.id) await offlineDB.syncQueue.delete(q.id);
      } catch {}
    }
  } catch {}
  return { synced, failed };
}

export async function syncOfflinePurchases(): Promise<{ synced: number; failed: number }> {
  if (typeof window === 'undefined' || !navigator.onLine) return { synced: 0, failed: 0 };
  const unsynced = await offlineDB.purchases.where('synced').equals(0).toArray();
  let synced = 0; let failed = 0;
  for (const pur of unsynced) {
    try {
      const res = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier: pur.supplier,
          invoiceNo: pur.invoiceNo,
          totalBuyAmount: pur.totalBuyAmount,
          items: pur.items,
          paymentType: pur.paymentType,
          localId: pur.localId,
          createdAt: pur.createdAt,
        }),
      });
      if (res.ok) {
        await offlineDB.purchases.update(pur.localId, { synced: 1 });
        synced++;
      } else failed++;
    } catch { failed++; }
  }
  try {
    const queue = await offlineDB.syncQueue.where('type').equals('purchase').toArray();
    for (const q of queue) {
      if (q.id) await offlineDB.syncQueue.delete(q.id).catch(() => {});
    }
  } catch {}
  return { synced, failed };
}

export async function syncOfflineWusool(): Promise<{ synced: number; failed: number }> {
  if (typeof window === 'undefined' || !navigator.onLine) return { synced: 0, failed: 0 };
  let synced = 0; let failed = 0;
  try {
    const wusoolQueue = await offlineDB.syncQueue.where('type').equals('wusool').toArray();
    for (const q of wusoolQueue) {
      try {
        const p = q.payload as WusoolSyncPayload;
        const cust = await offlineDB.customers.get(q.localId);
        if (!cust) continue;
        const res = await fetch('/api/khata/wusool', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: cust._id ?? cust.localId, customerName: cust.name, amount: p.amount, note: p.note }),
        });
        if (res.ok) {
          if (q.id) await offlineDB.syncQueue.delete(q.id);
          synced++;
        } else failed++;
      } catch { failed++; }
    }
  } catch {}
  return { synced, failed };
}

export async function syncAllOffline(): Promise<{ sales: number; purchases: number; wusool: number }> {
  const s = await syncOfflineSales();
  const p = await syncOfflinePurchases();
  const w = await syncOfflineWusool();
  return { sales: s.synced, purchases: p.synced, wusool: w.synced };
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { 
    void syncAllOffline(); 
  });
}