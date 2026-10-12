"use client";
import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { offlineDB, OfflineProduct, OfflineSale, OfflineCustomer } from "@/lib/offline-db";
import { getOfflineUser } from "@/lib/offline-auth";

type MedicalUnit = "tablet" | "patta" | "half_patta" | "box" | "bottle" | "syrup" | "ml" | "liter" | "gram" | "kg" | "tube" | "sachet" | "piece" | "capsule" | "injection";
type BaseUnit = "tablet" | "ml" | "gram" | "piece";

type Product = {
  _id: string; name: string; company?: string; price: number; buyPrice: number; sellPrice: number;
  stock: number; stockInPatta?: string; unit: MedicalUnit; baseUnit?: BaseUnit; qtyPerUnit?: number;
  tabletsPerPatta?: number; pattaPerBox?: number; expiryDate?: string; rack?: string; batchNo?: string;
};
type Sale = {
  _id: string; productId: string; productName: string; quantity: number; quantityInTablets?: number; quantityInSub?: number;
  unit?: MedicalUnit; baseUnit?: BaseUnit; tabletsPerPatta?: number; qtyPerUnit?: number; price: number; buyPrice: number;
  sellPrice: number; profit: number; total: number; createdAt: string; localId?: string;
  customerName?: string; status?: string; paymentType?: string;
};
type FilterType = "today" | "yesterday" | "weekly" | "monthly" | "yearly" | "all";
type Pagination = { page: number; totalPages: number; hasMore: boolean; totalCount: number };
type ProductsResponse = Product[] | { products: Product[]; pagination: Pagination };
type SalesApiResponse = { sales: Sale[]; total: number; profit: number; pendingTotal?: number; pagination: Pagination };

const FILTERS: FilterType[] = ["today", "yesterday", "weekly", "monthly", "yearly", "all"];
const PRODUCTS_PER_PAGE = 12;

function calcBaseQty(unit: MedicalUnit, baseUnit: BaseUnit, qty: number, tpp: number, ppb: number, qpu: number): number {
  if (baseUnit==="tablet"){ if(unit==='patta') return qty*tpp; if(unit==='half_patta') return qty*(tpp/2); if(unit==='box') return qty*tpp*ppb; return qty; }
  if (baseUnit==="ml"){ if(['bottle','box','liter','syrup'].includes(unit)) return qty*qpu; return qty; }
  if (baseUnit==="gram"){ if(['tube','box','kg'].includes(unit)) return qty*qpu; return qty; }
  return qty;
}
function calcPricePerUnit(unit: MedicalUnit, baseUnit: BaseUnit, perBase: number, tpp: number, ppb: number, qpu: number): number {
  if (baseUnit==="tablet"){ if(unit==='patta') return perBase*tpp; if(unit==='half_patta') return perBase*(tpp/2); if(unit==='box') return perBase*tpp*ppb; return perBase; }
  if (baseUnit==="ml"||baseUnit==="gram"){ if(["bottle","tube","box","liter","kg","syrup"].includes(unit)) return perBase*qpu; return perBase; }
  return perBase;
}
function fixProduct(p: Product): Product {
  const sell = p.sellPrice?? p.price?? 0; const buy = p.buyPrice && p.buyPrice > 0? p.buyPrice : Math.round(sell * 0.8);
  const base = p.baseUnit || (["ml","bottle","syrup","liter"].includes(p.unit)?"ml": ["gram","tube","kg"].includes(p.unit)?"gram":"tablet") as BaseUnit;
  return {...p, buyPrice: buy, sellPrice: sell || buy, price: sell || buy, baseUnit: base, qtyPerUnit: p.qtyPerUnit || (base==="ml"?120:base==="gram"?20:10), tabletsPerPatta: p.tabletsPerPatta || 10, pattaPerBox: p.pattaPerBox || 10 };
}
function isExpired(expiry?: string): boolean { if(!expiry) return false; return new Date(expiry) < new Date(); }
function isExpiringSoon(expiry?: string): boolean { if(!expiry) return false; const d=new Date(expiry); const now=new Date(); const diff=(d.getTime()-now.getTime())/(1000*3600*24); return diff>=0 && diff<=60; }
function expiryLabel(expiry?: string): string { if(!expiry) return ""; const d=new Date(expiry); return d.toLocaleDateString('en-GB',{month:'short', year:'2-digit'}); }

function useIsOnline() {
  const subscribe = useCallback((cb: () => void) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; }, []);
  const getSnapshot = useCallback(() => navigator.onLine, []); const getServerSnapshot = useCallback(() => true, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
function generateLocalId() { if (typeof crypto!== "undefined" && "randomUUID" in crypto) return `local_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`; return `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
function dedupeProducts(arr: Product[]): Product[] { const m = new Map<string, Product>(); for (const p of arr) m.set(p._id, p); return Array.from(m.values()); }

export default function SalesPage() {
  const [sales, setSales] = useState<Sale[]>([]); const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0); const [profit, setProfit] = useState(0); const [pendingTotal, setPendingTotal] = useState(0);
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({}); const [unitMap, setUnitMap] = useState<Record<string, MedicalUnit>>({});
  const [priceMap, setPriceMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true); const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<FilterType>("today"); const [page, setPage] = useState(1);
  const [productPage, setProductPage] = useState(1); const [productPagination, setProductPagination] = useState<Pagination>({ page: 1, totalPages: 1, hasMore: false, totalCount: 0 });
  const [loadingMoreProducts, setLoadingMoreProducts] = useState(false); const [productSearch, setProductSearch] = useState("");
  const [pagination, setPagination] = useState<Pagination>({ page: 1, totalPages: 1, hasMore: false, totalCount: 0 });
  const [mounted, setMounted] = useState(false); const isOnline = useIsOnline(); const isOffline = mounted &&!isOnline;
  const [pendingCount, setPendingCount] = useState(0); const [syncing, setSyncing] = useState(false); const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sellingId, setSellingId] = useState<string | null>(null); const [customerName, setCustomerName] = useState("Walk-in");
  const [paymentType, setPaymentType] = useState<"cash" | "credit">("cash"); const [customerSuggest, setCustomerSuggest] = useState<string[]>([]);

  useEffect(() => { 
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true); }, []);

  const getSellCalc = useCallback((p: Product) => {
    const unit = (unitMap[p._id] as MedicalUnit) || p.unit || "tablet"; const baseUnit = p.baseUnit || "tablet"; const tpp = p.tabletsPerPatta || 10; const ppb = p.pattaPerBox || 10; const qpu = p.qtyPerUnit || 10;
    const qty = qtyMap[p._id] || (unit === 'tablet'? 10 : 1); const raw = priceMap[p._id]; const hasEdit = raw!== undefined && raw!== ""; const sellPerBase = hasEdit? Number(raw) : p.sellPrice;
    const pricePerUnit = calcPricePerUnit(unit, baseUnit, sellPerBase, tpp, ppb, qpu); const totalBase = calcBaseQty(unit, baseUnit, qty, tpp, ppb, qpu);
    const total = Math.round(pricePerUnit * qty); const profitCalc = Math.round((sellPerBase - p.buyPrice) * totalBase);
    return { unit, baseUnit, qty, totalBase, pricePerUnit, sellPerBase, total, profit: profitCalc, tpp, ppb, qpu };
  }, [unitMap, qtyMap, priceMap]);

  const refreshSalesOnly = useCallback(async () => {
    setPage(1);
    if (typeof window!== "undefined" &&!window.navigator.onLine) {
      const offlineSales = await offlineDB.sales.where("synced").equals(0).reverse().toArray();
      const mapped: Sale[] = offlineSales.map((o) => ({ _id: o.localId, productId: o.productId, productName: o.productName, quantity: o.quantity?? 1, quantityInTablets: o.quantityInTablets, quantityInSub: o.quantityInSub, unit: o.unit as MedicalUnit, baseUnit: o.baseUnit as BaseUnit, price: o.price?? 0, buyPrice: o.buyPrice?? 0, sellPrice: o.sellPrice?? 0, profit: o.profit?? 0, total: o.total?? 0, createdAt: o.createdAt, localId: o.localId, tabletsPerPatta: o.tabletsPerPatta, customerName: o.customerName, status: o.paymentType==="credit"?"pending":"paid", paymentType: o.paymentType }));
      setSales(mapped); setTotal(mapped.reduce((a, b) => a + b.total, 0)); setProfit(mapped.reduce((a, b) => a + b.profit, 0)); setPendingTotal(0); return;
    }
    try { const salesRes = await fetch(`/api/sales?filter=${filter}&page=1&limit=15`); const salesData = (await salesRes.json()) as SalesApiResponse; setSales(salesData.sales); setTotal(salesData.total); setProfit(salesData.profit); setPendingTotal(salesData.pendingTotal??0); setPagination(salesData.pagination); } catch {}
  }, [filter]);

  const syncPendingSales = useCallback(async () => {
    if (typeof window === "undefined" ||!window.navigator.onLine) return; const pending = await offlineDB.sales.where("synced").equals(0).toArray(); if (pending.length === 0) return; setSyncing(true); let synced = 0;
    for (const s of pending) { try { const res = await fetch("/api/sales", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: s.productId, productName: s.productName, quantity: s.quantity, quantityInTablets: s.quantityInTablets, quantityInSub: s.quantityInSub, totalTablets: s.totalTablets, unit: s.unit, baseUnit: s.baseUnit, qtyPerUnit: s.qtyPerUnit, tabletsPerPatta: s.tabletsPerPatta, pattaPerBox: s.pattaPerBox, price: s.sellPrice, buyPrice: s.buyPrice, sellPrice: s.sellPrice, profit: s.profit, total: s.total, localId: s.localId, customerName: s.customerName, paymentType: s.paymentType, offlineCreatedAt: s.createdAt, soldBy: s.soldBy }) }); if (res.ok) { await offlineDB.sales.update(s.localId, { synced: 1 }); await offlineDB.customers.where('saleId').equals(s.localId).modify({ synced: 1 }); synced++; } } catch {} }
    setPendingCount((prev) => Math.max(0, prev - synced)); setSyncing(false); if (synced > 0) void refreshSalesOnly();
  }, [refreshSalesOnly]);

  useEffect(() => { if (!mounted) return; const init = async () => { const count = await offlineDB.sales.where("synced").equals(0).count(); setPendingCount(count); }; void init(); const handleOnline = () => { void syncPendingSales(); }; window.addEventListener("online", handleOnline); return () => window.removeEventListener("online", handleOnline); }, [mounted, syncPendingSales]);

  useEffect(() => {
    let cancelled = false; const controller = new AbortController();
    const loadProducts = async () => {
      try {
        const cached = await offlineDB.products.toArray(); const isOfflineNow = typeof window!== "undefined" &&!window.navigator.onLine; const searchLower = productSearch.toLowerCase();
        if (cached.length > 0 &&!cancelled) {
          const filteredCache = cached.map((c: OfflineProduct) => fixProduct({ _id: c._id || c.localId, name: c.name, company: c.company, price: c.sellPrice?? c.price?? 0, buyPrice: c.buyPrice?? 0, sellPrice: c.sellPrice?? c.price?? 0, stock: c.stock, stockInPatta: c.stockInPatta, unit: (c.unit as MedicalUnit) || "tablet", baseUnit: (c.baseUnit as BaseUnit) || "tablet", qtyPerUnit: c.qtyPerUnit, tabletsPerPatta: c.tabletsPerPatta, pattaPerBox: c.pattaPerBox, expiryDate: c.expiryDate } as Product)).filter((p) =>!searchLower || p.name.toLowerCase().includes(searchLower) || (p.company||"").toLowerCase().includes(searchLower));
          const dedupedCache = dedupeProducts(filteredCache); const pagedCache = dedupedCache.slice(0, productPage * PRODUCTS_PER_PAGE); setProducts(pagedCache); setProductPagination({ page: productPage, totalPages: Math.ceil(dedupedCache.length / PRODUCTS_PER_PAGE), hasMore: pagedCache.length < dedupedCache.length, totalCount: dedupedCache.length }); if (isOfflineNow) { setLoadingMoreProducts(false); return; }
        } else if (isOfflineNow) { setProducts([]); setProductPagination({ page: 1, totalPages: 1, hasMore: false, totalCount: 0 }); setLoadingMoreProducts(false); return; }
        setLoadingMoreProducts(true); const res = await fetch(`/api/products?search=${encodeURIComponent(productSearch)}&page=${productPage}&limit=${PRODUCTS_PER_PAGE}`, { signal: controller.signal }); const data = (await res.json()) as ProductsResponse; let list: Product[] = Array.isArray(data)? data : data.products; list = dedupeProducts(list.map(fixProduct)); if (cancelled) return;
        try { if (list.length > 0) { await offlineDB.products.bulkPut(list.map((p)=>({ _id: p._id, localId: p._id, name: p.name, company: p.company, price: p.sellPrice, sellPrice: p.sellPrice, buyPrice: p.buyPrice, stock: p.stock, stockInPatta: p.stockInPatta, unit: p.unit, baseUnit: p.baseUnit, qtyPerUnit: p.qtyPerUnit, expiryDate: p.expiryDate, userId: "cached", synced: 1, tabletsPerPatta: p.tabletsPerPatta, pattaPerBox: p.pattaPerBox } as OfflineProduct))) } } catch {}
        if (productSearch) { setProducts(list); setProductPagination({ page: 1, totalPages: 1, hasMore: false, totalCount: list.length }); } else { if (productPage === 1) setProducts(list); else setProducts((prev) => dedupeProducts([...prev,...list])); if (!Array.isArray(data) && data.pagination) setProductPagination(data.pagination); else { const hasMore = list.length >= PRODUCTS_PER_PAGE; setProductPagination({ page: productPage, totalPages: hasMore? productPage + 1 : productPage, hasMore, totalCount: hasMore? 999 : list.length }); } }
      } catch (err) { if ((err as Error).name!== "AbortError") console.error(err); } finally { if (!cancelled) setLoadingMoreProducts(false); }
    }; void loadProducts(); return () => { cancelled = true; controller.abort(); };
  }, [productSearch, productPage]);

  useEffect(() => {
    const controller = new AbortController();
    const fetchData = async () => {
      if (page === 1) setLoading(true); else setLoadingMore(true);
      try {
        const offlineAll = await offlineDB.sales.reverse().toArray(); const offlineUnsynced = offlineAll.filter((s) => s.synced === 0);
        const offlineMappedUnsynced: Sale[] = offlineUnsynced.map((o) => ({ _id: o.localId, productId: o.productId, productName: o.productName, quantity: o.quantity?? 1, quantityInTablets: o.quantityInTablets, quantityInSub: o.quantityInSub, unit: o.unit as MedicalUnit, baseUnit: o.baseUnit as BaseUnit, price: o.price?? 0, buyPrice: o.buyPrice?? 0, sellPrice: o.sellPrice?? 0, profit: o.profit?? 0, total: o.total?? 0, createdAt: o.createdAt, localId: o.localId, tabletsPerPatta: o.tabletsPerPatta, customerName: o.customerName, status: o.paymentType==="credit"?"pending":"paid", paymentType: o.paymentType }));
        const dedupedUnsynced = Array.from(new Map(offlineMappedUnsynced.map((s) => [s.localId || s._id, s])).values());
        if (typeof window!== "undefined" &&!window.navigator.onLine) { setSales(dedupedUnsynced); setTotal(dedupedUnsynced.reduce((a, b) => a + b.total, 0)); setProfit(dedupedUnsynced.reduce((a, b) => a + b.profit, 0)); setPendingTotal(0); setPagination({ page: 1, totalPages: 1, hasMore: false, totalCount: dedupedUnsynced.length }); return; }
        const salesRes = await fetch(`/api/sales?filter=${filter}&page=${page}&limit=15`, { signal: controller.signal }); const salesData = (await salesRes.json()) as SalesApiResponse; const combined = [...dedupedUnsynced,...salesData.sales]; const finalSales = Array.from(new Map(combined.map((s) => [s._id, s])).values());
        if (page === 1) setSales(finalSales); else setSales((prev) => { const merged = [...prev,...salesData.sales]; return Array.from(new Map(merged.map((s) => [s._id, s])).values()); });
        setTotal(salesData.total); setProfit(salesData.profit); setPendingTotal(salesData.pendingTotal??0); setPagination(salesData.pagination);
      } catch (err) { if ((err as Error).name!== "AbortError") console.error(err); } finally { setLoading(false); setLoadingMore(false); }
    }; void fetchData(); return () => controller.abort();
  }, [filter, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (customerName.length < 2 || customerName === "Walk-in") { setCustomerSuggest([]); return; }
    const t = setTimeout(async () => { try { const res = await fetch(`/api/customers?search=${encodeURIComponent(customerName)}`); const data = await res.json(); const uniqueNames = [...new Set((data.customers || []).map((c: {name:string}) => c.name.trim()).filter(Boolean))] as string[]; setCustomerSuggest(uniqueNames.slice(0,5)); } catch {} }, 300);
    return () => clearTimeout(t);
  }, [customerName]);

  const sell = async (p: Product) => {
    if (sellingId) return;
    if (isExpired(p.expiryDate)) { if(!window.confirm(`⚠️ ${p.name} EXPIRED ${expiryLabel(p.expiryDate)} - Sell anyway?`)) return; }
    if (paymentType==="credit" && (!customerName || customerName.trim().toLowerCase()==="walk-in" || customerName.trim().length<2)) { window.alert("Enter customer name for Udhar"); return; }
    const calc = getSellCalc(p); if (calc.qty < 0.001) { window.alert("Enter quantity"); return; } if (p.stock < calc.totalBase - 0.0001) { window.alert(`Only ${p.stockInPatta || p.stock + ' ' + calc.baseUnit} left`); return; }
    const offlineUser = getOfflineUser(); const localId = generateLocalId(); const now = new Date().toISOString(); const finalCustomer = customerName.trim() || "Walk-in";
    const newSale: Sale = { _id: localId, productId: p._id, productName: p.name, quantity: calc.qty, quantityInTablets: calc.baseUnit==="tablet"?calc.totalBase:0, quantityInSub: calc.totalBase, unit: calc.unit, baseUnit: calc.baseUnit, price: calc.pricePerUnit, buyPrice: p.buyPrice, sellPrice: calc.sellPerBase, profit: calc.profit, total: calc.total, createdAt: now, localId, tabletsPerPatta: calc.tpp, customerName: finalCustomer, status: paymentType==="credit"?"pending":"paid", paymentType };
    setSellingId(p._id); setProducts((prev) => prev.map((prod) => (prod._id === p._id? {...prod, stock: prod.stock - calc.totalBase } : prod))); setSales((prev) => [newSale,...prev]); setTotal((t) => t + calc.total); setProfit((pr) => pr + calc.profit); setTimeout(() => setSellingId(null), 400);
    const offlineSale: OfflineSale = { localId, productId: p._id, productName: p.name, quantity: calc.qty, quantityInTablets: calc.baseUnit==="tablet"?calc.totalBase:0, quantityInSub: calc.totalBase, totalTablets: calc.totalBase, price: calc.pricePerUnit, buyPrice: p.buyPrice, sellPrice: calc.sellPerBase, profit: calc.profit, total: calc.total, soldBy: offlineUser?.name || "Yasir Medical", customerName: finalCustomer, paymentType, createdAt: now, offlineCreatedAt: now, synced: 0, userId: offlineUser?._id || "offline", unit: calc.unit, baseUnit: calc.baseUnit, qtyPerUnit: calc.qpu, tabletsPerPatta: calc.tpp, pattaPerBox: calc.ppb, };
    void (async () => {
      try {
        await offlineDB.sales.put(offlineSale);
        if (paymentType==="credit" && finalCustomer.toLowerCase()!=="walk-in") { const cust: OfflineCustomer = { localId: generateLocalId(), saleId: localId, saleIds: [localId], name: finalCustomer, normalizedName: finalCustomer.trim().toLowerCase(), totalUdhar: Math.round(calc.total), totalBusiness: Math.round(calc.total), lastUdharDate: now, synced: 0, createdAt: now, billsCount: 1, isPaid: false, paidAmount: 0, wusoolHistory: [], }; await offlineDB.customers.put(cust); }
        await offlineDB.products.where("_id").equals(p._id).or("localId").equals(p._id).modify((prod) => { prod.stock -= calc.totalBase; });
        if (typeof window!== "undefined" && window.navigator.onLine) { const res = await fetch("/api/sales", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: p._id, productName: p.name, quantity: calc.qty, quantityInTablets: calc.baseUnit==="tablet"?calc.totalBase:0, quantityInSub: calc.totalBase, totalTablets: calc.totalBase, unit: calc.unit, baseUnit: calc.baseUnit, qtyPerUnit: calc.qpu, tabletsPerPatta: calc.tpp, pattaPerBox: calc.ppb, price: calc.sellPerBase, buyPrice: p.buyPrice, sellPrice: calc.sellPerBase, profit: calc.profit, total: calc.total, localId, customerName: finalCustomer, paymentType, offlineCreatedAt: now }) }); if (res.ok) { await offlineDB.sales.update(localId, { synced: 1 }); await offlineDB.customers.where('saleId').equals(localId).modify({ synced: 1 }); void refreshSalesOnly(); } } else setPendingCount((c) => c + 1);
      } catch { setPendingCount((c) => c + 1); }
    })();
  };

  const handleDeleteSale = async (id: string) => {
    if (!window.confirm("Delete sale and restore stock + Khata?")) return; setDeletingId(id);
    try {
      const saleToDelete = sales.find((s) => s._id === id); const qtyToRestore = saleToDelete?.quantityInSub?? saleToDelete?.quantityInTablets?? saleToDelete?.quantity?? 0; const productId = saleToDelete?.productId;
      setSales((prev) => prev.filter((s) => s._id!== id)); if (saleToDelete) { const amt = Math.round(saleToDelete.total); const pr = Math.round(saleToDelete.profit); setTotal((t) => Math.max(0, t - amt)); setProfit((prv) => Math.max(0, prv - pr)); }
      if (productId) setProducts((prev) => prev.map((p) => p._id === productId? {...p, stock: p.stock + qtyToRestore } : p));
      if (id.startsWith("local_")) {
        const rec = await offlineDB.sales.get(id); await offlineDB.sales.delete(id); await offlineDB.customers.where('saleId').equals(id).delete();
        if (productId) await offlineDB.products.where("_id").equals(productId).or("localId").equals(productId).modify((prod) => { prod.stock += qtyToRestore; });
        if (rec?.synced === 1) { try { await fetch(`/api/sales/${id}`, { method: "DELETE" }); } catch {} } else setPendingCount((c) => Math.max(0, c - 1));
      } else { const res = await fetch(`/api/sales/${id}`, { method: "DELETE" }); if (!res.ok) { const errData = await res.json().catch(() => null); throw new Error(errData?.error || "Delete failed"); } if (productId) await offlineDB.products.where("_id").equals(productId).or("localId").equals(productId).modify((prod) => { prod.stock += qtyToRestore; }); }
      void refreshSalesOnly();
    } catch (e) { window.alert((e as Error).message || "Delete failed"); void refreshSalesOnly(); } finally { setDeletingId(null); }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b px-3 sm:px-4 lg:px-6 py-3">
        <div className="max-w-7xl mx-auto flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-[16px] sm:text-[18px] font-bold truncate">💊 Yasir Medical Sell V11 {isOffline? "📶 Offline" : ""}</h1>
            <div className="flex gap-1.5 shrink-0"><div className="bg-green-600 text-white px-2.5 sm:px-3.5 py-2 rounded-xl font-bold text-[11px] sm:text-[12px]">{filter.toUpperCase()}: Rs.{total.toFixed(0)}</div><div className="bg-blue-600 text-white px-2.5 sm:px-3.5 py-2 rounded-xl font-bold text-[11px] sm:text-[12px]">+Rs.{profit.toFixed(0)}</div>{pendingTotal>0 && <div className="bg-red-600 text-white px-2.5 sm:px-3.5 py-2 rounded-xl font-bold text-[11px] sm:text-[12px]">Udhar Rs.{pendingTotal.toFixed(0)}</div>}</div>
          </div>
          <div className="bg-gray-50 border rounded-xl p-2.5 flex flex-col sm:flex-row gap-2">
            <div className="flex-1 relative"><input value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder="Customer name (Walk-in)" className="w-full p-2.5 rounded-xl border text-[13px] bg-white" />
              {customerSuggest.length>0 && (<div className="absolute z-30 bg-white border rounded-xl mt-1 w-full shadow">{customerSuggest.map((name, idx)=>(<button key={`${name}-${idx}`} onClick={()=>{setCustomerName(name); setCustomerSuggest([]); setPaymentType("credit");}} className="w-full text-left px-3 py-2 text-[12px] hover:bg-gray-50">{name}</button>))}</div>)}</div>
            <div className="flex bg-white border rounded-xl p-1 h-11"><button onClick={()=>setPaymentType("cash")} className={`flex-1 px-5 rounded-xl text-[12px] font-bold ${paymentType==="cash"?"bg-green-600 text-white":"text-gray-600"}`}>Cash</button><button onClick={()=>setPaymentType("credit")} className={`flex-1 px-5 rounded-xl text-[12px] font-bold ${paymentType==="credit"?"bg-red-600 text-white":"text-gray-600"}`}>Udhar</button></div>
          </div>
          {mounted && (isOffline || pendingCount > 0) && (<div className={`text-[11px] p-2 rounded-xl flex justify-between items-center ${isOffline? "bg-amber-50 border border-amber-200 text-amber-800" : "bg-blue-50 border border-blue-200 text-blue-800"}`}><span>{isOffline? `📶 Offline • ${pendingCount} pending` : `${pendingCount} pending`}</span>{!isOffline && <button onClick={() => syncPendingSales()} disabled={syncing} className="bg-blue-600 text-white px-3 py-1 rounded-lg text-[11px]">{syncing? "..." : "Sync"}</button>}</div>)}
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-2 sm:p-4 lg:p-6">
        <div className="flex flex-col sm:flex-row gap-2 mb-3"><h2 className="font-semibold text-[13px] flex-1 hidden sm:block">Quick Sell {isOffline? "(Offline)" : ""} {paymentType==="credit"? `→ ${customerName}`:""}</h2><input placeholder="🔍 Search medicine + expiry..." value={productSearch} onChange={(e) => { setProductSearch(e.target.value); setProductPage(1); }} className="border p-3 sm:p-2.5 rounded-xl w-full sm:w-64 bg-white text-[14px] sm:text-[13px] h-11 sm:h-auto" /></div>

        {products.length === 0? <p className="text-center text-gray-400 py-8 bg-white rounded-xl border mb-5 text-[12px]">{loadingMoreProducts? "Loading..." : isOffline? "No cached" : "No medicines"}</p> : (
          <><div className="grid grid-cols-1 sm:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-2 sm:gap-3 mb-3">
              {products.map((p) => {
                const calc = getSellCalc(p); const outOfStock = p.stock <= 0.001; const isSelling = sellingId === p._id; const expired = isExpired(p.expiryDate); const expSoon = isExpiringSoon(p.expiryDate);
                return (
                  <div key={p._id} className={`bg-white border rounded-2xl p-3 shadow-sm flex flex-col ${isSelling? "ring-2 ring-green-400" : ""} ${expired? "border-red-300 bg-red-50/50" : expSoon? "border-amber-300 bg-amber-50/30" : ""} ${paymentType==="credit"?"border-red-200":""}`}>
                    <div className="flex justify-between gap-2">
                      <p className="font-semibold text-[14px] flex-1">{p.name} <span className="text-[10px] text-gray-400">{p.company} • {p.baseUnit} {p.qtyPerUnit? `${p.qtyPerUnit}`: ""}</span></p>
                      <span className={`text-[9px] px-2 py-1 rounded-full h-fit ${expired? "bg-red-600 text-white" : expSoon? "bg-amber-400 text-black" : "bg-gray-100"}`}>{p.stockInPatta || `${p.stock} ${p.baseUnit}`} {p.expiryDate? `• Exp:${expiryLabel(p.expiryDate)}`: ""}</span>
                    </div>
                    <p className="text-[11px] text-gray-500 mt-1">Buy Rs.{p.buyPrice}/{p.baseUnit} • Sell Rs.{p.sellPrice}/{p.baseUnit} {p.unit==='bottle'? `• Bottle Rs.${(p.sellPrice*(p.qtyPerUnit||120)).toFixed(0)}` : p.unit==='tube'? `• Tube Rs.${(p.sellPrice*(p.qtyPerUnit||20)).toFixed(0)}` : `• Patta Rs.${(p.sellPrice*(p.tabletsPerPatta||10)).toFixed(0)}`} {p.rack? `• ${p.rack}`:""} {p.batchNo? `• B:${p.batchNo}`:""}</p>
                    {expired && <p className="text-[10px] text-red-600 font-bold mt-1">⚠️ EXPIRED {expiryLabel(p.expiryDate)}</p>}
                    {expSoon && <p className="text-[10px] text-amber-600 font-bold mt-1">⚠️ Expiring Soon {expiryLabel(p.expiryDate)}</p>}
                    <div className="flex bg-gray-100 rounded-full p-1 mt-2.5 w-fit overflow-x-auto">
                      {(p.baseUnit==="ml"? (["bottle","ml","syrup"] as MedicalUnit[]) : p.baseUnit==="gram"? (["tube","gram"] as MedicalUnit[]) : (["tablet","patta","half_patta","box"] as MedicalUnit[])).map((u)=>(
                        <button key={u} onClick={() => setUnitMap({...unitMap, [p._id]: u})} className={`px-3 py-1 rounded-full text-[11px] capitalize ${calc.unit===u?"bg-green-600 text-white shadow":"text-gray-600"}`}>{u.replace('_',' ')}</button>
                      ))}
                    </div>
                    <div className="bg-gray-50 border rounded-xl p-2.5 mt-2.5 flex justify-between text-[12px] font-medium"><span>{calc.qty} {calc.unit} = {calc.totalBase} {calc.baseUnit}</span><span className="font-bold text-green-700">Rs.{calc.total} <span className="text-[10px]">+{calc.profit}</span></span></div>
                    <div className="flex gap-2 mt-3 items-center">
                      <div className="flex items-center border rounded-xl overflow-hidden h-11"><button onClick={() => setQtyMap({...qtyMap, [p._id]: Math.max(1, (qtyMap[p._id] || 1) - 1)})} className="px-4 py-3 bg-gray-50 font-bold">-</button><input type="number" value={qtyMap[p._id] || (calc.unit==='tablet'?10:1)} onChange={(e) => setQtyMap({...qtyMap, [p._id]: Number(e.target.value) || 1})} className="w-16 text-center p-2 text-[14px] border-x outline-none h-full" /><button onClick={() => setQtyMap({...qtyMap, [p._id]: (qtyMap[p._id] || 1) + 1})} className="px-4 py-3 bg-gray-50 font-bold">+</button></div>
                      <input value={priceMap[p._id]?? String(p.sellPrice)} onChange={(e) => setPriceMap({...priceMap, [p._id]: e.target.value.replace(/[^0-9.]/g, "")})} className="w-20 border border-amber-300 bg-amber-50 rounded-xl p-2 text-[12px] font-bold text-center h-11" placeholder={`Rs/${p.baseUnit}`} />
                      <button onClick={() => sell(p)} disabled={outOfStock || isSelling} className={`flex-1 rounded-xl text-[13px] h-11 font-bold ${outOfStock? "bg-gray-200 text-gray-500" : isSelling? "bg-green-300 text-white" : paymentType==="credit"?"bg-red-600 text-white":"bg-green-600 text-white"}`}>{isSelling? "..." : paymentType==="credit"?"Udhar": "Sell"}</button>
                    </div>
                  </div>
                );
              })}
            </div>
            {productPagination.hasMore && <button onClick={() => setProductPage((pr) => pr + 1)} disabled={loadingMoreProducts} className="w-full mb-6 py-3 bg-white border border-green-600 text-green-700 rounded-xl text-[13px] font-medium disabled:opacity-50 h-12">{loadingMoreProducts? "Loading..." : `Load More (${productPagination.totalCount - products.length})`}</button>}
          </>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3 mt-4"><h2 className="font-bold text-[14px] capitalize flex-1 order-2 sm:order-1">{filter} - Rs.{total.toFixed(0)} | Profit Rs.{profit.toFixed(0)} | Udhar Rs.{pendingTotal.toFixed(0)} {loading? "(...)" : ""}</h2><div className="flex gap-1.5 overflow-x-auto pb-2 sm:pb-1 order-1 sm:order-2 -mx-2 px-2 sm:mx-0 sm:px-0">{FILTERS.map((f) => (<button key={f} onClick={() => { setFilter(f); setPage(1); }} className={`px-4 sm:px-3 py-2 sm:py-1.5 rounded-full text-[12px] sm:text-[11px] capitalize whitespace-nowrap min-h-9 ${filter === f? "bg-green-600 text-white" : "bg-white border"}`}>{f}</button>))}</div></div>

        <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
          {sales.length === 0? <p className="p-8 text-center text-gray-400 text-[13px]">No sales for {filter}</p> : (
            <>{sales.map((s) => { const isDeleting = deletingId === s._id; return (<div key={s._id} className={`p-3 border-b last:border-0 ${s._id.startsWith("local_")? "bg-amber-50/50" : ""} ${s.status==="pending"?"bg-red-50/30":""} ${isDeleting? "opacity-60 bg-red-50" : ""}`}><div className="flex justify-between gap-3"><div className="flex-1"><p className="font-semibold text-[13px]">{s.productName} {s.quantity} {s.unit} ({s.quantityInSub?? s.quantityInTablets} {s.baseUnit||"Tab"}) {s.customerName && s.customerName!=="Walk-in"? <span className="bg-yellow-100 px-2 py-0.5 rounded-full text-[10px]">👤 {s.customerName}</span> : null} {s.status==="pending"? <span className="bg-red-600 text-white px-2 py-0.5 rounded-full text-[9px] ml-1">UDHAR</span>:null}</p><p className="text-[11px] text-gray-400 mt-1">{mounted? new Date(s.createdAt).toLocaleString() : ""} {s._id.startsWith("local_") && <span className="bg-amber-200 px-1.5 py-0.5 rounded-full text-[9px] ml-1">OFFLINE</span>}</p></div><div className="text-right shrink-0"><div className="font-bold text-[14px]">Rs.{s.total.toFixed(0)}</div><div className="text-[12px] font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full mt-1 inline-block">+{s.profit.toFixed(0)}</div></div></div><div className="flex justify-end mt-2"><button onClick={() => handleDeleteSale(s._id)} disabled={isDeleting} className={`text-[11px] px-4 py-1.5 rounded-lg font-medium ${isDeleting? "bg-gray-200" : "text-red-600 bg-red-50"}`}>{isDeleting? "Deleting..." : "Delete"}</button></div></div>); })}{pagination.hasMore && <div className="p-2.5 bg-gray-50"><button onClick={() => setPage((p) => p + 1)} disabled={loadingMore} className="w-full py-3 bg-white border rounded-xl text-[13px] font-medium h-12">{loadingMore? "Loading..." : `Load More (${pagination.totalCount - sales.length})`}</button></div>}</>
          )}
        </div>
      </div>
    </div>
  );
}