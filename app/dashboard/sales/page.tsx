"use client";
import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { offlineDB } from "@/lib/offline-db";
import { saveSaleOffline, syncOfflineSales } from "@/lib/offline-sync";
import { getOfflineUser } from "@/lib/offline-auth";

type MainUnit = "box" | "bottle" | "tube" | "piece";
type SellUnit = "patta" | "half_patta" | "box" | "bottle" | "ml" | "tube" | "piece";

type Product = {
  _id: string; name: string; company?: string;
  mainUnit: MainUnit; // ONLY stock unit - NO sellUnit
  pattaPerBox: number; mlPerBottle: number;
  buyPrice: number; sellPrice: number; // buy per Box, sell per Patta (if box) default
  stock: number; expiryDate?: string; rack?: string; batchNo?: string;
};

type Sale = {
  _id: string; productId: string; productName: string;
  mainUnit: MainUnit; sellUnit: SellUnit; quantity: number;
  sellPrice: number; deductionMain: number; total: number; profit: number;
  createdAt: string; localId?: string;
  customerName?: string; status?: string; paymentType?: string;
};

type FilterType = "today" | "yesterday" | "weekly" | "monthly" | "yearly" | "all";
type Pagination = { page: number; totalPages: number; hasMore: boolean; totalCount: number };
type SalesApiResponse = { sales: Sale[]; total: number; profit: number; pendingTotal?: number; pagination: Pagination };

const FILTERS: FilterType[] = ["today", "yesterday", "weekly", "monthly", "yearly", "all"];
const PRODUCTS_PER_PAGE = 12;

function useIsOnline() {
  const subscribe = useCallback((cb: () => void) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; }, []);
  const getSnapshot = useCallback(() => navigator.onLine, []);
  const getServerSnapshot = useCallback(() => true, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
function generateLocalId() { return `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
function isExpired(expiry?: string): boolean { if(!expiry) return false; return new Date(expiry) < new Date(); }
function expiryLabel(expiry?: string): string { if(!expiry) return ""; return new Date(expiry).toLocaleDateString('en-GB',{month:'short', year:'2-digit'}); }

export default function SalesPage() {
  const [sales, setSales] = useState<Sale[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0); const [profit, setProfit] = useState(0); const [pendingTotal, setPendingTotal] = useState(0);
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({});
  const [sellUnitMap, setSellUnitMap] = useState<Record<string, SellUnit>>({});
  const [priceMap, setPriceMap] = useState<Record<string, number>>({}); // EDITABLE price at counter
  const [loading, setLoading] = useState(true); const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<FilterType>("today"); const [page, setPage] = useState(1);
  const [productPage, setProductPage] = useState(1); const [productPagination, setProductPagination] = useState<Pagination>({ page: 1, totalPages: 1, hasMore: false, totalCount: 0 });
  const [loadingMoreProducts, setLoadingMoreProducts] = useState(false); const [productSearch, setProductSearch] = useState("");
  const [pagination, setPagination] = useState<Pagination>({ page: 1, totalPages: 1, hasMore: false, totalCount: 0 });
  const [mounted, setMounted] = useState(false); const isOnline = useIsOnline(); const isOffline = mounted &&!isOnline;
  const [pendingCount, setPendingCount] = useState(0); const [syncing, setSyncing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null); const [sellingId, setSellingId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("Walk-in"); const [paymentType, setPaymentType] = useState<"cash" | "credit">("cash");

  useEffect(() => { setMounted(true); }, []);

  const sellOptions = (main: MainUnit): SellUnit[] => {
    if (main === "box") return ["patta", "half_patta", "box"];
    if (main === "bottle") return ["bottle", "ml"];
    if (main === "tube") return ["tube"];
    return ["piece"];
  };

  const getDefaultSellUnit = (main: MainUnit): SellUnit => main === "box"? "patta" : main as SellUnit;

  const getSellCalc = useCallback((p: Product) => {
    const sellUnit = (sellUnitMap[p._id] || getDefaultSellUnit(p.mainUnit)) as SellUnit;
    const qty = qtyMap[p._id] || 1;
    const ppb = p.pattaPerBox || 10; const mlB = p.mlPerBottle || 120;
    // EDITABLE price - if not edited, use default logic: patta price = product.sellPrice, half = sell/2, box = sell*ppb
    let defaultPrice = p.sellPrice;
    if (p.mainUnit === "box") {
      if (sellUnit === "half_patta") defaultPrice = Math.round((p.sellPrice / 2) * 100) / 100;
      if (sellUnit === "box") defaultPrice = Math.round(p.sellPrice * ppb * 100) / 100;
    }
    const sellPrice = priceMap[p._id]?? defaultPrice;
    let deductMain = 0; let total = 0; let profitCalc = 0;
    if (p.mainUnit === "box") {
      const buyPerPatta = p.buyPrice / ppb;
      if (sellUnit === "patta") { deductMain = qty / ppb; total = sellPrice * qty; profitCalc = (sellPrice - buyPerPatta) * qty; }
      else if (sellUnit === "half_patta") { deductMain = (qty * 0.5) / ppb; total = sellPrice * qty; profitCalc = (sellPrice - buyPerPatta / 2) * qty; }
      else { deductMain = qty; total = sellPrice * qty; profitCalc = (sellPrice - p.buyPrice) * qty; }
    } else {
      if (sellUnit === "ml") {
        const buyPerMl = p.buyPrice / mlB;
        deductMain = qty / mlB; total = sellPrice * qty; profitCalc = (sellPrice - buyPerMl) * qty;
      } else { deductMain = qty; total = sellPrice * qty; profitCalc = (sellPrice - p.buyPrice) * qty; }
    }
    return { sellUnit, qty, sellPrice, deductMain: Math.round(deductMain*1000)/1000, total: Math.round(total), profit: Math.round(profitCalc) };
  }, [sellUnitMap, qtyMap, priceMap]);

  const refreshSalesOnly = useCallback(async () => {
    setPage(1);
    if (typeof window!== "undefined" &&!window.navigator.onLine) {
      const offlineSales = await offlineDB.sales.where("synced").equals(0).reverse().toArray();
      const mapped: Sale[] = offlineSales.map((o) => ({
        _id: o.localId, productId: o.productId, productName: o.productName,
        mainUnit: o.mainUnit as MainUnit, sellUnit: o.sellUnit as SellUnit,
        quantity: o.quantity, sellPrice: o.sellPrice, deductionMain: o.deductionMain, total: o.total, profit: o.profit,
        createdAt: o.createdAt, localId: o.localId, customerName: o.customerName, status: o.status, paymentType: o.paymentType
      }));
      setSales(mapped); setTotal(mapped.reduce((a,b)=>a+b.total,0)); setProfit(mapped.reduce((a,b)=>a+b.profit,0)); return;
    }
    try {
      const res = await fetch(`/api/sales?filter=${filter}&page=1&limit=15`);
      const data = (await res.json()) as SalesApiResponse;
      setSales(data.sales); setTotal(data.total); setProfit(data.profit); setPendingTotal(data.pendingTotal??0); setPagination(data.pagination);
    } catch {}
  }, [filter]);

  const syncPendingSales = useCallback(async () => {
    if (typeof window === "undefined" ||!window.navigator.onLine) return;
    setSyncing(true);
    const result = await syncOfflineSales();
    setPendingCount((prev) => Math.max(0, prev - result.synced));
    setSyncing(false);
    if (result.synced > 0) void refreshSalesOnly();
  }, [refreshSalesOnly]);

  useEffect(() => {
    if (!mounted) return;
    const init = async () => { const count = await offlineDB.sales.where("synced").equals(0).count(); setPendingCount(count); };
    void init();
    const handleOnline = () => { void syncPendingSales(); };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [mounted, syncPendingSales]);

  useEffect(() => {
    let cancelled = false; const controller = new AbortController();
    const loadProducts = async () => {
      try {
        const cached = await offlineDB.products.toArray();
        const isOfflineNow = typeof window!== "undefined" &&!window.navigator.onLine;
        if (cached.length > 0 &&!cancelled && productSearch === "" && productPage === 1) {
          setProducts(cached.slice(0, PRODUCTS_PER_PAGE).map((c) => ({
            _id: c._id || c.localId, name: c.name, company: c.company,
            mainUnit: c.mainUnit as MainUnit,
            pattaPerBox: c.pattaPerBox, mlPerBottle: c.mlPerBottle,
            buyPrice: c.buyPrice, sellPrice: c.sellPrice, stock: c.stock,
            expiryDate: c.expiryDate, rack: c.rack, batchNo: c.batchNo,
          })));
        }
        if (isOfflineNow) { setLoadingMoreProducts(false); return; }
        setLoadingMoreProducts(true);
        const res = await fetch(`/api/products?search=${encodeURIComponent(productSearch)}&page=${productPage}&limit=${PRODUCTS_PER_PAGE}`, { signal: controller.signal });
        const data = await res.json() as { products: Product[]; pagination: Pagination } | Product[];
        const list = Array.isArray(data)? data : data.products;
        if (cancelled) return;
        if (productPage === 1) setProducts(list); else setProducts((prev) => [...prev,...list]);
        if (!Array.isArray(data) && data.pagination) setProductPagination(data.pagination);
      } catch (err) { if ((err as Error).name!== "AbortError") console.error(err); }
      finally { if (!cancelled) setLoadingMoreProducts(false); }
    };
    void loadProducts();
    return () => { cancelled = true; controller.abort(); };
  }, [productSearch, productPage]);

  useEffect(() => {
    const controller = new AbortController();
    const fetchData = async () => {
      if (page === 1) setLoading(true); else setLoadingMore(true);
      try {
        if (typeof window!== "undefined" &&!window.navigator.onLine) {
          const offlineAll = await offlineDB.sales.reverse().toArray();
          const mapped = offlineAll.map((o) => ({
            _id: o.localId, productId: o.productId, productName: o.productName,
            mainUnit: o.mainUnit as MainUnit, sellUnit: o.sellUnit as SellUnit,
            quantity: o.quantity, sellPrice: o.sellPrice, deductionMain: o.deductionMain, total: o.total, profit: o.profit,
            createdAt: o.createdAt, localId: o.localId, customerName: o.customerName, status: o.status, paymentType: o.paymentType
          }));
          setSales(mapped); setTotal(mapped.reduce((a,b)=>a+b.total,0)); setProfit(mapped.reduce((a,b)=>a+b.profit,0));
          setPagination({ page: 1, totalPages: 1, hasMore: false, totalCount: mapped.length }); return;
        }
        const res = await fetch(`/api/sales?filter=${filter}&page=${page}&limit=15`, { signal: controller.signal });
        const data = (await res.json()) as SalesApiResponse;
        if (page === 1) setSales(data.sales); else setSales((prev) => [...prev,...data.sales]);
        setTotal(data.total); setProfit(data.profit); setPendingTotal(data.pendingTotal??0); setPagination(data.pagination);
      } catch (err) { if ((err as Error).name!== "AbortError") console.error(err); }
      finally { setLoading(false); setLoadingMore(false); }
    };
    void fetchData();
    return () => controller.abort();
  }, [filter, page]);

  const sell = async (p: Product) => {
    if (sellingId) return;
    if (isExpired(p.expiryDate)) { if(!confirm(`⚠️ ${p.name} EXPIRED ${expiryLabel(p.expiryDate)} - Sell?`)) return; }
    if (paymentType === "credit" && (!customerName || customerName.trim().toLowerCase()==="walk-in" || customerName.trim().length<2)) { alert("Enter customer name for Udhar"); return; }
    const calc = getSellCalc(p);
    if (p.stock < calc.deductMain - 0.0001) { alert(`Only ${p.stock} ${p.mainUnit} left (${p.mainUnit==="box"? Math.floor(p.stock*p.pattaPerBox)+" Patta":""})`); return; }
    const offlineUser = getOfflineUser();
    setSellingId(p._id);
    const finalCustomer = customerName.trim() || "Walk-in";

    setProducts((prev) => prev.map((prod) => prod._id === p._id? {...prod, stock: Math.round((prod.stock - calc.deductMain)*1000)/1000 } : prod));
    const optimistic: Sale = {
      _id: generateLocalId(), productId: p._id, productName: p.name,
      mainUnit: p.mainUnit, sellUnit: calc.sellUnit, quantity: calc.qty,
      sellPrice: calc.sellPrice, deductionMain: calc.deductMain, total: calc.total, profit: calc.profit,
      createdAt: new Date().toISOString(), customerName: finalCustomer, status: paymentType==="credit"?"pending":"paid", paymentType
    };
    setSales((prev) => [optimistic,...prev]); setTotal((t) => t + calc.total); setProfit((pr) => pr + calc.profit);
    setTimeout(() => setSellingId(null), 400);

    try {
      await saveSaleOffline({
        productId: p._id, productName: p.name,
        quantity: calc.qty, mainUnit: p.mainUnit, sellUnit: calc.sellUnit,
        pattaPerBox: p.pattaPerBox, mlPerBottle: p.mlPerBottle,
        buyPriceMain: p.buyPrice, sellPrice: calc.sellPrice, // EDITABLE price
        userId: offlineUser?._id || "offline",
        customerName: finalCustomer, paymentType,
      });
      if (typeof window!== "undefined" && window.navigator.onLine) {
        void syncPendingSales();
      } else {
        setPendingCount((c) => c + 1);
      }
    } catch { setPendingCount((c) => c + 1); }
  };

  const handleDeleteSale = async (id: string) => {
    if (!confirm("Delete sale and restore stock?")) return; setDeletingId(id);
    try {
      const saleToDelete = sales.find((s) => s._id === id);
      const restore = saleToDelete?.deductionMain?? 0;
      setSales((prev) => prev.filter((s) => s._id!== id));
      if (saleToDelete) { setTotal((t) => Math.max(0, t - saleToDelete.total)); setProfit((pr) => Math.max(0, pr - saleToDelete.profit)); }
      if (saleToDelete?.productId) setProducts((prev) => prev.map((p) => p._id === saleToDelete.productId? {...p, stock: p.stock + restore } : p));

      if (id.startsWith("local_")) {
        await offlineDB.sales.delete(id);
        if (saleToDelete?.productId) await offlineDB.products.where("_id").equals(saleToDelete.productId).or("localId").equals(saleToDelete.productId).modify((prod) => { prod.stock += restore; });
        setPendingCount((c) => Math.max(0, c - 1));
      } else {
        const res = await fetch(`/api/sales/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Delete failed");
      }
      void refreshSalesOnly();
    } catch (e) { alert((e as Error).message); void refreshSalesOnly(); }
    finally { setDeletingId(null); }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b px-3 py-3">
        <div className="max-w-7xl mx-auto flex flex-col gap-2">
          <div className="flex justify-between gap-2">
            <h1 className="text-[16px] font-bold">💊 Yasir Medical V14.2 {isOffline? "📶 Offline" : ""}</h1>
            <div className="flex gap-1.5"><div className="bg-green-600 text-white px-3 py-2 rounded-xl font-bold text-[11px]">{filter.toUpperCase()}: Rs.{total.toFixed(0)}</div><div className="bg-blue-600 text-white px-3 py-2 rounded-xl font-bold text-[11px]">+{profit.toFixed(0)}</div>{pendingTotal>0 && <div className="bg-red-600 text-white px-3 py-2 rounded-xl font-bold text-[11px]">Udhar {pendingTotal.toFixed(0)}</div>}</div>
          </div>
          <div className="bg-gray-50 border rounded-xl p-2.5 flex gap-2">
            <input value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder="Customer Walk-in" className="flex-1 p-2.5 rounded-xl border text-[13px] bg-white" />
            <div className="flex bg-white border rounded-xl p-1 h-11"><button onClick={()=>setPaymentType("cash")} className={`px-5 rounded-xl text-[12px] font-bold ${paymentType==="cash"?"bg-green-600 text-white":"text-gray-600"}`}>Cash</button><button onClick={()=>setPaymentType("credit")} className={`px-5 rounded-xl text-[12px] font-bold ${paymentType==="credit"?"bg-red-600 text-white":"text-gray-600"}`}>Udhar</button></div>
          </div>
          {mounted && (isOffline || pendingCount>0) && <div className={`text-[11px] p-2 rounded-xl flex justify-between ${isOffline? "bg-amber-50 border-amber-200":"bg-blue-50 border-blue-200"} border`}><span>{isOffline? `Offline ${pendingCount} pending` : `${pendingCount} pending`}</span>{!isOffline && <button onClick={()=>syncPendingSales()} disabled={syncing} className="bg-blue-600 text-white px-3 py-1 rounded-lg">{syncing?"...":"Sync"}</button>}</div>}
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-2 sm:p-4">
        <div className="flex gap-2 mb-3"><input placeholder="🔍 Search medicine" value={productSearch} onChange={(e)=>{setProductSearch(e.target.value); setProductPage(1);}} className="border p-3 rounded-xl w-full sm:w-64 bg-white text-[14px] h-11" /></div>

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3 mb-3">
          {products.map((p) => {
            const calc = getSellCalc(p); const outOfStock = p.stock <= 0.001; const isSelling = sellingId === p._id;
            return (
              <div key={p._id} className={`bg-white border rounded-2xl p-3 shadow-sm ${isSelling?"ring-2 ring-green-400":""} ${isExpired(p.expiryDate)?"border-red-300 bg-red-50/30":""}`}>
                <div className="flex justify-between"><p className="font-semibold text-[13px]">{p.name} <span className="text-[10px] text-gray-400">{p.company}</span></p><span className="text-[9px] bg-gray-100 px-2 py-1 rounded-full h-fit">{p.stock} {p.mainUnit} • {p.mainUnit==="box"? `${Math.floor(p.stock * p.pattaPerBox)} Patta` : ""}</span></div>
                <p className="text-[11px] text-gray-500 mt-1">Stock: {p.stock} {p.mainUnit} = Buy Rs.{p.buyPrice}/{p.mainUnit} • Default Sell Rs.{p.sellPrice}/{p.mainUnit==="box"?"Patta":p.mainUnit} {p.rack? `• ${p.rack}`:""}</p>
                {isExpired(p.expiryDate) && <p className="text-[10px] text-red-600 font-bold">⚠️ EXPIRED {expiryLabel(p.expiryDate)}</p>}
                <div className="flex bg-gray-100 rounded-full p-1 mt-2 w-fit">{sellOptions(p.mainUnit).map((u)=><button key={u} onClick={()=>{ setSellUnitMap({...sellUnitMap, [p._id]: u}); const ppb=p.pattaPerBox||10; let def=p.sellPrice; if(p.mainUnit==="box" && u==="half_patta") def=Math.round(p.sellPrice/2); if(p.mainUnit==="box" && u==="box") def=p.sellPrice*ppb; setPriceMap({...priceMap, [p._id]: def}); }} className={`px-3 py-1 rounded-full text-[11px] ${calc.sellUnit===u?"bg-green-600 text-white":"text-gray-600"}`}>{u}</button>)}</div>
                <div className="flex gap-2 mt-2">
                  <input type="number" value={calc.sellPrice} onChange={(e)=>setPriceMap({...priceMap, [p._id]: Number(e.target.value)})} className="flex-1 border rounded-xl p-2.5 text-[13px] bg-blue-50/50" placeholder={`Price per ${calc.sellUnit}`} />
                  <span className="text-[11px] bg-gray-50 border rounded-xl px-3 py-2.5">{calc.qty} {calc.sellUnit}</span>
                </div>
                <div className="bg-gray-50 border rounded-xl p-2.5 mt-2 flex justify-between text-[12px]"><span>{calc.qty} {calc.sellUnit} = -{calc.deductMain} {p.mainUnit}</span><span className="font-bold text-green-700">Rs.{calc.total} +{calc.profit}</span></div>
                <div className="flex gap-2 mt-3">
                  <div className="flex border rounded-xl overflow-hidden h-11"><button onClick={()=>setQtyMap({...qtyMap, [p._id]: Math.max(0.5, (qtyMap[p._id]||1)-1)})} className="px-4 bg-gray-50">-</button><input type="number" step="0.5" value={qtyMap[p._id]||1} onChange={(e)=>setQtyMap({...qtyMap, [p._id]: Number(e.target.value)||1})} className="w-14 text-center border-x" /><button onClick={()=>setQtyMap({...qtyMap, [p._id]: (qtyMap[p._id]||1)+1})} className="px-4 bg-gray-50">+</button></div>
                  <button onClick={()=>sell(p)} disabled={outOfStock ||!!isSelling} className={`flex-1 rounded-xl text-[13px] h-11 font-bold ${outOfStock?"bg-gray-200":"bg-green-600 text-white"}`}>{isSelling?"...":paymentType==="credit"?`Udhar Rs.${calc.total}`:`Sell Rs.${calc.total}`}</button>
                </div>
              </div>
            );
          })}
        </div>
        {productPagination.hasMore && <button onClick={()=>setProductPage((pr)=>pr+1)} disabled={loadingMoreProducts} className="w-full mb-6 py-3 bg-white border border-green-600 text-green-700 rounded-xl">{loadingMoreProducts?"Loading...":`Load More`}</button>}

        <div className="flex gap-2 mb-3 overflow-x-auto">{FILTERS.map((f)=><button key={f} onClick={()=>{setFilter(f); setPage(1);}} className={`px-4 py-2 rounded-full text-[12px] capitalize ${filter===f?"bg-green-600 text-white":"bg-white border"}`}>{f}</button>)}</div>

        <div className="bg-white rounded-2xl border overflow-hidden">
          {sales.length===0? <p className="p-8 text-center text-gray-400 text-[13px]">No sales {filter}</p> : sales.map((s)=>(
            <div key={s._id} className={`p-3 border-b flex justify-between ${s._id.startsWith("local_")?"bg-amber-50/50":""} ${s.status==="pending"?"bg-red-50/30":""}`}>
              <div><p className="font-semibold text-[13px]">{s.productName} {s.quantity} {s.sellUnit} @ Rs.{s.sellPrice} <span className="text-[10px] text-gray-500">(-{s.deductionMain} {s.mainUnit})</span> {s.customerName && s.customerName!=="Walk-in"? <span className="bg-yellow-100 px-2 py-0.5 rounded-full text-[10px]">👤 {s.customerName}</span>:null}</p><p className="text-[11px] text-gray-400">{new Date(s.createdAt).toLocaleString()} {s._id.startsWith("local_") && <span className="bg-amber-200 px-1.5 rounded-full text-[9px]">OFFLINE</span>}</p></div>
              <div className="text-right"><div className="font-bold text-[14px]">Rs.{s.total.toFixed(0)}</div><div className="text-[11px] text-green-600">+{s.profit.toFixed(0)}</div><button onClick={()=>handleDeleteSale(s._id)} disabled={deletingId===s._id} className="text-[11px] text-red-600 bg-red-50 px-3 py-1 rounded-lg mt-1">{deletingId===s._id?"...":"Del"}</button></div>
            </div>
          ))}
          {pagination.hasMore && <div className="p-2 bg-gray-50"><button onClick={()=>setPage((p)=>p+1)} disabled={loadingMore} className="w-full py-3 bg-white border rounded-xl">{loadingMore?"Loading...":`More`}</button></div>}
        </div>
      </div>
    </div>
  );
}