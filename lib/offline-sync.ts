import { offlineDB, OfflineSale, OfflineProduct, OfflineCustomer, upsertOfflineCustomer, WusoolHistoryEntry, MedicalUnit, BaseUnit } from './offline-db';

export interface OfflineSaleData {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  buyPrice?: number;
  sellPrice?: number;
  profit?: number;
  total: number;
  userId: string;
  soldBy?: string;
  customerName?: string;
  customerPhone?: string;
  customerVillage?: string;
  paymentType?: string;
  unit?: MedicalUnit;
  baseUnit?: BaseUnit;
  qtyPerUnit?: number;
  tabletsPerPatta?: number;
  pattaPerBox?: number;
  customerId?: string;
  paidAmount?: number;
  pendingAmount?: number;
  status?: "paid" | "pending" | "partial";
  isCredit?: boolean;
}

export type WusoolSyncPayload = {
  amount: number;
  note?: string;
  date: string;
};

export interface SyncQueueItem {
  id?: number;
  type: 'sale' | 'product' | 'customer' | 'wusool';
  localId: string;
  payload: WusoolSyncPayload | OfflineSale | OfflineProduct | OfflineCustomer;
  createdAt: Date;
  attempts: number;
}

type SyncManager = { register: (tag: string) => Promise<void> };
type SyncRegistration = ServiceWorkerRegistration & { sync: SyncManager };

function isSyncRegistration(reg: ServiceWorkerRegistration): reg is SyncRegistration {
  return 'sync' in reg && typeof (reg as { sync?: unknown }).sync === 'object';
}

function genLocalId(): string {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function calcBaseQty(unit: MedicalUnit, baseUnit: BaseUnit, qty: number, tpp: number, ppb: number, qpu: number): number {
  if (baseUnit === "tablet") {
    if (unit === 'patta') return qty * tpp;
    if (unit === 'half_patta') return qty * (tpp / 2);
    if (unit === 'box') return qty * tpp * ppb;
    return qty;
  }
  if (baseUnit === "ml") {
    if (unit === 'bottle' || unit === 'box' || unit === 'liter' || unit === 'syrup') return qty * qpu;
    return qty;
  }
  if (baseUnit === "gram") {
    if (unit === 'tube' || unit === 'box' || unit === 'kg') return qty * qpu;
    return qty;
  }
  return qty;
}

function calcPricePerUnit(unit: MedicalUnit, baseUnit: BaseUnit, perBasePrice: number, tpp: number, ppb: number, qpu: number): number {
  if (baseUnit === "tablet") {
    if (unit === 'patta') return perBasePrice * tpp;
    if (unit === 'half_patta') return perBasePrice * (tpp / 2);
    if (unit === 'box') return perBasePrice * tpp * ppb;
    return perBasePrice;
  }
  if (baseUnit === "ml" || baseUnit === "gram") {
    if (["bottle","tube","box","liter","kg","syrup"].includes(unit)) return perBasePrice * qpu;
    return perBasePrice;
  }
  return perBasePrice;
}

export async function saveSaleOffline(saleData: OfflineSaleData): Promise<string> {
  const localId = genLocalId();
  const now = new Date().toISOString();
  const buyPerBase = saleData.buyPrice ?? 0;
  const sellPerBase = saleData.sellPrice ?? saleData.price;
  const unit: MedicalUnit = saleData.unit ?? "tablet";
  const baseUnit: BaseUnit = saleData.baseUnit ?? "tablet";
  const tpp = saleData.tabletsPerPatta ?? 10;
  const ppb = saleData.pattaPerBox ?? 10;
  const qpu = saleData.qtyPerUnit ?? (baseUnit === "ml" ? 120 : baseUnit === "gram" ? 20 : 10);
  const totalBaseQty = calcBaseQty(unit, baseUnit, saleData.quantity, tpp, ppb, qpu);
  const pricePerUnit = calcPricePerUnit(unit, baseUnit, sellPerBase, tpp, ppb, qpu);
  const totalRounded = Math.round(pricePerUnit * saleData.quantity);
  const profitTotal = Math.round((sellPerBase - buyPerBase) * totalBaseQty);
  const isCredit = saleData.paymentType === "credit" || saleData.paymentType === "udhar" || saleData.isCredit === true;
  const status: "paid" | "pending" | "partial" = isCredit ? "pending" : "paid";

  const newSale: OfflineSale = {
    localId, saleId: localId,
    productId: saleData.productId, productName: saleData.productName,
    quantity: saleData.quantity, price: pricePerUnit,
    buyPrice: buyPerBase, sellPrice: sellPerBase,
    profit: saleData.profit ?? profitTotal, total: totalRounded,
    soldBy: saleData.soldBy ?? 'Yasir Medical',
    customerName: saleData.customerName ?? 'Walk-in',
    normalizedCustomerName: (saleData.customerName ?? 'Walk-in').trim().toLowerCase(),
    paymentType: isCredit ? "credit" : (saleData.paymentType ?? 'cash'),
    userId: saleData.userId, createdAt: now, offlineCreatedAt: now, synced: 0,
    unit, baseUnit, tabletsPerPatta: tpp, pattaPerBox: ppb, qtyPerUnit: qpu,
    quantityInTablets: baseUnit === "tablet" ? totalBaseQty : 0,
    totalTablets: baseUnit === "tablet" ? totalBaseQty : 0,
    quantityInSub: totalBaseQty,
    customerId: saleData.customerId,
    paidAmount: isCredit ? 0 : totalRounded,
    pendingAmount: isCredit ? totalRounded : 0,
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
      await offlineDB.products.update(prod.localId, { stock: prod.stock - totalBaseQty, synced: 0 });
    } else {
      const matched = await offlineDB.products.where('_id').equals(saleData.productId).or("localId").equals(saleData.productId).toArray();
      for (const p of matched) {
        await offlineDB.products.update(p.localId, { stock: p.stock - totalBaseQty, synced: 0 });
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
      paidAt: now, lastWusoolDate: now, wusoolHistory: [...existingHistory, entry], synced: 0,
    });
    for (const sId of customer.saleIds ?? []) {
      await offlineDB.sales.update(sId, { status: "paid", isCredit: false }).catch(()=>{});
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
          quantity: sale.quantity,
          quantityInTablets: sale.quantityInTablets ?? sale.quantity,
          totalTablets: sale.totalTablets ?? sale.quantity,
          quantityInSub: sale.quantityInSub ?? sale.quantity,
          unit: sale.unit ?? "tablet", baseUnit: sale.baseUnit ?? "tablet",
          qtyPerUnit: sale.qtyPerUnit ?? 10,
          tabletsPerPatta: sale.tabletsPerPatta ?? 10, pattaPerBox: sale.pattaPerBox ?? 10,
          price: sale.sellPrice ?? sale.price, buyPrice: sale.buyPrice ?? 0,
          sellPrice: sale.sellPrice ?? sale.price, profit: sale.profit ?? 0,
          total: sale.total, localId: sale.localId,
          customerName: sale.customerName ?? "Walk-in",
          normalizedCustomerName: sale.normalizedCustomerName ?? "walk-in",
          paymentType: sale.paymentType ?? "cash", customerId: sale.customerId,
          paidAmount: sale.paidAmount ?? sale.total, pendingAmount: sale.pendingAmount ?? 0,
          status: sale.status ?? "paid", isCredit: sale.isCredit ?? false,
          offlineCreatedAt: sale.createdAt, soldBy: sale.soldBy ?? "Yasir Medical",
        }),
      });
      if (res.ok) {
        await offlineDB.sales.update(sale.localId, { synced: 1 });
        const allCustomers = await offlineDB.customers.toArray();
        const withSale = allCustomers.filter((c) => (c.saleIds ?? []).includes(sale.localId) || c.saleId === sale.localId);
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

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { void syncOfflineSales(); });
}