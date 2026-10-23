import { offlineDB, calcDeduction } from "./offline-db";
import type { OfflineSale, MainUnit, SellUnit, WusoolHistoryEntry } from "./offline-db";

export interface OfflineSaleData {
  productId: string;
  productName: string;
  quantity: number;
  mainUnit: MainUnit;
  sellUnit: SellUnit;
  pattaPerBox: number;
  mlPerBottle: number;
  buyPriceMain?: number;
  sellPrice: number;
  userId: string;
  soldBy?: string;
  customerName?: string;
  customerPhone?: string;
  customerVillage?: string;
  paymentType?: string;
  customerId?: string;
  batchId?: string;
  batchNo?: string;
  deductionMain?: number;
}

type SyncManager = { register: (tag: string) => Promise<void> };
type SyncRegistration = ServiceWorkerRegistration & { sync: SyncManager };

function isSyncRegistration(reg: ServiceWorkerRegistration): reg is SyncRegistration {
  const candidate = reg as unknown as { sync: SyncManager };
  return typeof candidate.sync === "object" && candidate.sync !== null;
}

function genLocalId(): string {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveSaleOffline(saleData: OfflineSaleData): Promise<string[]> {
  const ppb = saleData.pattaPerBox || 10;
  const mlB = saleData.mlPerBottle || 120;
  const ded = calcDeduction(saleData.mainUnit, saleData.sellUnit, saleData.quantity, ppb, mlB);
  const needMain = Math.round(ded.main * 1000000) / 1000000;

  const today = new Date(); today.setHours(0,0,0,0);
  const allBatches = await offlineDB.batches.where("productId").equals(saleData.productId)
    .filter((b) => b.quantity > 0.0001 && new Date(b.expiryDate) >= today).toArray();
  allBatches.sort((a,b)=> new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());

  const totalBatchQty = allBatches.reduce((s,b)=>s+b.quantity,0);
  if (allBatches.length===0 || totalBatchQty < needMain - 0.000001) {
    throw new Error(`Only ${totalBatchQty.toFixed(3)} ${saleData.mainUnit} left`);
  }

  const nowISO = new Date().toISOString();
  const isCredit = saleData.paymentType==="credit" || saleData.paymentType==="udhar";
  const status: "paid" | "pending" = isCredit ? "pending" : "paid";
  const firstBatch = allBatches[0];

  let total=0; let profit=0;
  if(saleData.mainUnit==="box"){
    const buyPerPatta = firstBatch.buyPrice / ppb;
    if(saleData.sellUnit==="patta"){ total=saleData.sellPrice*saleData.quantity; profit=(saleData.sellPrice-buyPerPatta)*saleData.quantity; }
    else if(saleData.sellUnit==="half_patta"){ total=saleData.sellPrice*saleData.quantity; profit=(saleData.sellPrice-buyPerPatta/2)*saleData.quantity; }
    else { total=saleData.sellPrice*saleData.quantity; profit=(saleData.sellPrice-firstBatch.buyPrice)*saleData.quantity; }
  } else { total=saleData.sellPrice*saleData.quantity; profit=(saleData.sellPrice-firstBatch.buyPrice)*saleData.quantity; }

  total = Math.round(total*1000000)/1000000;
  profit = Math.round(profit*1000000)/1000000;

  let createdId="";
  await offlineDB.transaction("rw", offlineDB.batches, offlineDB.sales, offlineDB.products, offlineDB.customers, offlineDB.syncQueue, async ()=>{
    let remaining = needMain;
    for(const batch of allBatches){
      if(remaining<=0.000001) break;
      const take = Math.min(batch.quantity, remaining);
      await offlineDB.batches.update(batch.localId, { quantity: Math.round((batch.quantity - take)*1000000)/1000000 });
      remaining = Math.round((remaining - take)*1000000)/1000000;
    }

    const localId = genLocalId(); createdId=localId;

    const newSale: OfflineSale = {
      localId, saleId: localId, productId: saleData.productId, productName: saleData.productName,
      batchId: firstBatch.localId, batchNo: firstBatch.batchNo, expiryDate: firstBatch.expiryDate,
      mainUnit: saleData.mainUnit, sellUnit: saleData.sellUnit, quantity: saleData.quantity,
      pattaPerBox: ppb, mlPerBottle: mlB, buyPriceMain: firstBatch.buyPrice, sellPrice: saleData.sellPrice,
      total, profit, deductionMain: needMain, deductionPatta: Math.round(ded.patta*1000000)/1000000,
      userId: saleData.userId, createdAt: nowISO, synced: 0,
      customerName: saleData.customerName ?? "Walk-in",
      normalizedCustomerName: (saleData.customerName ?? "Walk-in").trim().toLowerCase(),
      paymentType: isCredit ? "credit" : saleData.paymentType ?? "cash",
      customerId: saleData.customerId, status, isCredit,
    };

    await offlineDB.sales.put(newSale);
    await offlineDB.syncQueue.add({ type: "sale", localId, payload: newSale, createdAt: new Date(), attempts: 0 });

    const prod = await offlineDB.products.where("_id").equals(saleData.productId).or("localId").equals(saleData.productId).first();
    if(prod){
      const allForProd = await offlineDB.batches.where("productId").equals(saleData.productId).toArray();
      const sum = allForProd.reduce((s,b)=>s+b.quantity,0);
      await offlineDB.products.update(prod.localId, { stock: Math.round(sum*1000000)/1000000, synced: 0 });
    }

    // FIXED: inline khata upsert — no nested transaction
    if(isCredit && saleData.customerName && saleData.customerName.trim().toLowerCase()!=="walk-in"){
      const name = saleData.customerName.trim();
      const normalized = name.toLowerCase();
      const candidates = await offlineDB.customers.where("normalizedName").equals(normalized).toArray();
      const existing = candidates.find(c=>!c.isPaid) || null;
      if(existing){
        await offlineDB.customers.update(existing.localId, {
          totalUdhar: Math.round((existing.totalUdhar + total)*1000000)/1000000,
          totalBusiness: Math.round((existing.totalBusiness + total)*1000000)/1000000,
          saleIds: [...(existing.saleIds||[]), localId],
          billsCount: (existing.billsCount||1)+1,
          lastUdharDate: nowISO,
          synced: 0,
        });
        await offlineDB.sales.update(localId, { customerId: existing.localId });
      } else {
        const custLocalId = `cust_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
        await offlineDB.customers.add({
          localId: custLocalId, saleIds: [localId], name, normalizedName: normalized,
          phone: saleData.customerPhone??"", village: saleData.customerVillage??"",
          totalUdhar: total, totalBusiness: total,
          lastUdharDate: nowISO, synced: 0, createdAt: nowISO, billsCount: 1,
          isPaid: false, paidAmount: 0, wusoolHistory: [],
        });
        await offlineDB.sales.update(localId, { customerId: custLocalId });
      }
    }
  });

  if(typeof window!=="undefined" && "serviceWorker" in navigator){
    try{
      const reg = await navigator.serviceWorker.ready;
      if(isSyncRegistration(reg)) await reg.sync.register("sync-sales");
    }catch{}
  }
  return [createdId];
}

export async function wusoolOffline(customerLocalId: string, amount: number, note=""): Promise<boolean> {
  const customer = await offlineDB.customers.get(customerLocalId);
  if(!customer) return false;
  const paid = Math.round(amount*1000000)/1000000;
  const newUdhar = Math.round((customer.totalUdhar - paid)*1000000)/1000000;
  const now = new Date().toISOString();
  const entry: WusoolHistoryEntry = { amount: paid, date: now, note };
  const existingHistory = customer.wusoolHistory ?? [];
  if(newUdhar<=0.000001){
    await offlineDB.customers.update(customerLocalId, {
      totalUdhar: 0, isPaid: true, paidAmount: customer.totalBusiness,
      lastWusoolDate: now, wusoolHistory: [...existingHistory, entry], synced: 0,
    });
    for(const sId of customer.saleIds ?? []){
      await offlineDB.sales.update(sId, { status: "paid", isCredit: false }).catch(()=>{});
    }
  } else {
    await offlineDB.customers.update(customerLocalId, {
      totalUdhar: newUdhar,
      paidAmount: Math.round(((customer.paidAmount??0)+paid)*1000000)/1000000,
      lastWusoolDate: now, wusoolHistory: [...existingHistory, entry], synced: 0,
    });
  }
  await offlineDB.syncQueue.add({ type: "wusool", localId: customerLocalId, payload: { amount: paid, note, date: now }, createdAt: new Date(), attempts: 0 });
  return true;
}

export async function syncOfflineSales(): Promise<{ synced: number; failed: number }> {
  if(typeof window==="undefined" || !navigator.onLine) return { synced: 0, failed: 0 };
  const unsynced = await offlineDB.sales.where("synced").equals(0).toArray();
  let synced=0; let failed=0;
  for(const sale of unsynced){
    try{
      const res = await fetch("/api/sales", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: sale.productId, batchId: sale.batchId, batchNo: sale.batchNo, expiryDate: sale.expiryDate,
          mainUnit: sale.mainUnit, sellUnit: sale.sellUnit, quantity: sale.quantity,
          pattaPerBox: sale.pattaPerBox, mlPerBottle: sale.mlPerBottle,
          buyPriceMain: sale.buyPriceMain, sellPrice: sale.sellPrice,
          total: sale.total, profit: sale.profit,
          deductionMain: sale.deductionMain, deductionPatta: sale.deductionPatta,
          localId: sale.localId, customerName: sale.customerName ?? "Walk-in",
          paymentType: sale.paymentType ?? "cash", customerId: sale.customerId,
        }),
      });
      if(res.ok){ await offlineDB.sales.update(sale.localId, { synced: 1 }); synced++; }
      else { const txt=await res.text(); if(txt.includes("Batch only")||txt.includes("expired")) break; failed++; }
    }catch{ failed++; }
  }
  return { synced, failed };
}

export async function syncOfflinePurchases(): Promise<{ synced: number; failed: number }> {
  if(typeof window==="undefined" || !navigator.onLine) return { synced: 0, failed: 0 };
  const unsynced = await offlineDB.purchases.where("synced").equals(0).toArray();
  let synced=0; let failed=0;
  for(const pur of unsynced){
    try{
      const res = await fetch("/api/purchases", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplier: pur.supplier, invoiceNo: pur.invoiceNo, totalBuyAmount: pur.totalBuyAmount,
          items: pur.items, paymentType: pur.paymentType, localId: pur.localId, createdAt: pur.createdAt,
        }),
      });
      if(res.ok){ await offlineDB.purchases.update(pur.localId, { synced: 1 }); synced++; }
      else failed++;
    }catch{ failed++; }
  }
  return { synced, failed };
}

export async function syncAllOffline(): Promise<{ sales: number; purchases: number }> {
  const s=await syncOfflineSales(); const p=await syncOfflinePurchases();
  return { sales: s.synced, purchases: p.synced };
}

if(typeof window!=="undefined"){
  window.addEventListener("online", ()=>{ void syncAllOffline(); });
}