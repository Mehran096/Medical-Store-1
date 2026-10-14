"use client";
import { useEffect, useState, useMemo, useCallback, useSyncExternalStore } from "react";
import { offlineDB, OfflineProduct } from "@/lib/offline-db";
import { saveSaleOffline, syncOfflineSales } from "@/lib/offline-sync";
import { getOfflineUser } from "@/lib/offline-auth";

type MainUnit = "box" | "bottle" | "tube" | "piece";
type SellUnit = "patta" | "half_patta" | "box" | "bottle" | "ml" | "tube" | "piece";

type Product = {
  _id: string; name: string; company?: string;
  mainUnit: MainUnit;
  pattaPerBox: number; mlPerBottle: number;
  buyPrice: number; sellPrice: number;
  stock: number; expiryDate?: string; rack?: string; batchNo?: string;
};

type Sale = {
  _id: string; productId: string; productName: string;
  mainUnit: MainUnit; sellUnit: SellUnit; quantity: number;
  sellPrice: number; deductionMain: number; total: number; profit: number;
  createdAt: string; customerName?: string; status?: string; paymentType?: string;
};

type FilterType = "today" | "yesterday" | "weekly" | "monthly" | "yearly" | "all";
type Pagination = { page: number; totalPages: number; hasMore: boolean; totalCount: number };
type SalesApiResponse = { sales: Sale[]; total: number; profit: number; pendingTotal?: number; pagination: Pagination };

const FILTERS: FilterType[] = ["today", "yesterday", "weekly", "monthly", "yearly", "all"];
const PRODUCTS_PER_PAGE = 12;

function useIsOnline(){
  const subscribe = useCallback((cb:()=>void)=>{ window.addEventListener("online",cb); window.addEventListener("offline",cb); return ()=>{ window.removeEventListener("online",cb); window.removeEventListener("offline",cb);};},[]);
  const getSnapshot = useCallback(()=> navigator.onLine,[]);
  const getServerSnapshot = useCallback(()=> true,[]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
function generateLocalId(){ return `local_${Date.now()}_${Math.random().toString(36).slice(2,9)}`; }
function isExpired(e?:string){ if(!e) return false; return new Date(e) < new Date(); }
function fmt(n:number, d=1){ if(isNaN(n)) return "0"; const v = Number(n); if(!Number.isFinite(v)) return "0"; return v % 1 === 0? v.toFixed(0) : v.toFixed(d).replace(/\.0+$/,""); }
function fmt2(n:number){ return fmt(n,2); }
function getExpiryStatus(e?: string): "expired" | "soon" | "ok" {
  if(!e) return "ok";
  const now = new Date(); const exp = new Date(e);
  const diffDays = Math.ceil((exp.getTime() - now.getTime()) / (1000*60*60*24));
  if(diffDays < 0) return "expired";
  if(diffDays <= 30) return "soon";
  return "ok";
}

function toOfflineProduct(p: Product, userId: string): OfflineProduct {
  return {
    _id: p._id,
    localId: p._id,
    name: p.name,
    company: p.company?? "",
    generic: "",
    batchNo: p.batchNo?? "",
    expiryDate: p.expiryDate,
    barcode: "",
    rack: p.rack?? "",
    mainUnit: p.mainUnit,
    pattaPerBox: p.pattaPerBox,
    mlPerBottle: p.mlPerBottle,
    buyPrice: p.buyPrice,
    sellPrice: p.sellPrice,
    stock: p.stock,
    userId,
    synced: 1,
    createdAt: new Date().toISOString(),
  };
}

export default function SalesPage() {
  const [sales, setSales] = useState<Sale[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [expiryProducts, setExpiryProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0); const [profit, setProfit] = useState(0); const [pendingTotal, setPendingTotal] = useState(0);
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({});
  const [sellUnitMap, setSellUnitMap] = useState<Record<string, SellUnit>>({});
  const [priceMap, setPriceMap] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<FilterType>("today"); const [page, setPage] = useState(1);
  const [productPage, setProductPage] = useState(1); const [productPagination, setProductPagination] = useState<Pagination>({ page: 1, totalPages: 1, hasMore: false, totalCount: 0 });
  const [loadingProducts, setLoadingProducts] = useState(true); const [loadingMoreProducts, setLoadingMoreProducts] = useState(false);
  const [loadingSales, setLoadingSales] = useState(true);
  const [productSearch, setProductSearch] = useState("");
  const [pagination, setPagination] = useState<Pagination>({ page: 1, totalPages: 1, hasMore: false, totalCount: 0 });
  const [mounted, setMounted] = useState(false); const isOnline = useIsOnline(); const isOffline = mounted &&!isOnline;
  const [pendingCount, setPendingCount] = useState(0); const [syncing, setSyncing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null); const [sellingId, setSellingId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("Walk-in"); const [paymentType, setPaymentType] = useState<"cash" | "credit">("cash");
  const [showExpiry, setShowExpiry] = useState(false);
  const [nowMs, setNowMs] = useState(0);
 

useEffect(() => {
  // eslint-disable-next-line react-hooks/set-state-in-effect
  setMounted(true);
  setNowMs(Date.now());
}, []); // <- run once on mount, no loop 

      const expiryNotifications = useMemo(() => {
  if (nowMs === 0) return [];
  return expiryProducts
  .map((p) => ({
    ...p,
      status: getExpiryStatus(p.expiryDate),
      daysLeft: p.expiryDate
      ? Math.ceil((new Date(p.expiryDate).getTime() - nowMs) / (1000 * 60 * 60 * 24))
        : 999,
    }))
  .filter((p) => p.status!== "ok")
  .sort((a, b) => a.daysLeft - b.daysLeft);
}, [expiryProducts, nowMs]);

  const expiredCount = useMemo(() => expiryNotifications.filter((n) => n.status === "expired").length, [expiryNotifications]);
  const soonCount = useMemo(() => expiryNotifications.filter((n) => n.status === "soon").length, [expiryNotifications]);

   

  const sellOptions = (main: MainUnit): SellUnit[] => {
    if (main === "box") return ["patta", "half_patta", "box"];
    if (main === "bottle") return ["bottle", "ml"];
    if (main === "tube") return ["tube"];
    return ["piece"];
  };
  const getDefaultSellUnit = (main: MainUnit): SellUnit => main==="box"?"patta":main as SellUnit;
  const getDefaultPrice = (p:Product, u:SellUnit):number => {
    const ppb=p.pattaPerBox||10;
    if(p.mainUnit==="box"){
      if(u==="patta") return p.sellPrice;
      if(u==="half_patta") return Math.round((p.sellPrice/2)*10)/10;
      if(u==="box") return Math.round(p.sellPrice*ppb*10)/10;
    }
    return Math.round(p.sellPrice*10)/10;
  };

  const getSellCalc = useCallback((p: Product) => {
    const sellUnit = (sellUnitMap[p._id] || getDefaultSellUnit(p.mainUnit)) as SellUnit;
    const qty = qtyMap[p._id] || 1;
    const ppb = p.pattaPerBox || 10; const mlB = p.mlPerBottle || 120;
    const defaultPrice = getDefaultPrice(p, sellUnit);
    const str = priceMap[p._id];
    const sellPrice = str===undefined||str===""? defaultPrice : Number(str)||defaultPrice;
    let deductMain=0; let totalCalc=0; let profitCalc=0;
    if(p.mainUnit==="box"){
      const buyPerPatta=p.buyPrice/ppb;
      if(sellUnit==="patta"){ deductMain=qty/ppb; totalCalc=sellPrice*qty; profitCalc=(sellPrice-buyPerPatta)*qty; }
      else if(sellUnit==="half_patta"){ deductMain=(qty*0.5)/ppb; totalCalc=sellPrice*qty; profitCalc=(sellPrice-buyPerPatta/2)*qty; }
      else{ deductMain=qty; totalCalc=sellPrice*qty; profitCalc=(sellPrice-p.buyPrice)*qty; }
    }else{
      if(sellUnit==="ml"){ const buyPerMl=p.buyPrice/mlB; deductMain=qty/mlB; totalCalc=sellPrice*qty; profitCalc=(sellPrice-buyPerMl)*qty; }
      else{ deductMain=qty; totalCalc=sellPrice*qty; profitCalc=(sellPrice-p.buyPrice)*qty; }
    }
    return { sellUnit, qty, sellPrice, defaultPrice, deductMain: Math.round(deductMain*100)/100, total: Math.round(totalCalc*100)/100, profit: Math.round(profitCalc*100)/100 };
  }, [sellUnitMap, qtyMap, priceMap]);

  const refreshSalesOnly = useCallback(async () => {
    setPage(1); setLoadingSales(true);
    if(typeof window!=="undefined"&&!window.navigator.onLine){
      const offlineSales = await offlineDB.sales.reverse().toArray();
      const mapped:Sale[] = offlineSales.map(o=>({_id:o.localId,productId:o.productId,productName:o.productName,mainUnit:o.mainUnit as MainUnit,sellUnit:o.sellUnit as SellUnit,quantity:o.quantity,sellPrice:o.sellPrice,deductionMain:o.deductionMain,total:o.total,profit:o.profit,createdAt:o.createdAt,customerName:o.customerName,status:o.status,paymentType:o.paymentType}));
      setSales(mapped); setTotal(mapped.reduce((a,b)=>a+b.total,0)); setProfit(mapped.reduce((a,b)=>a+b.profit,0)); setLoadingSales(false); return;
    }
    try{ const res=await fetch(`/api/sales?filter=${filter}&page=1&limit=15`); const data=await res.json() as SalesApiResponse; setSales(data.sales); setTotal(data.total); setProfit(data.profit); setPendingTotal(data.pendingTotal??0); setPagination(data.pagination);}catch{ /* ignore */ } setLoadingSales(false);
  }, [filter]);

  const syncPendingSales = useCallback(async () => {
    if(typeof window==="undefined"||!window.navigator.onLine) return; setSyncing(true);
    const result=await syncOfflineSales(); setPendingCount(prev=>Math.max(0,prev-result.synced)); setSyncing(false);
    if(result.synced>0) void refreshSalesOnly();
  }, [refreshSalesOnly]);

  useEffect(()=>{ if(!mounted) return; (async()=>{ setPendingCount(await offlineDB.sales.where("synced").equals(0).count()); })(); window.addEventListener("online", syncPendingSales); return()=>window.removeEventListener("online", syncPendingSales); },[mounted,syncPendingSales]);

  useEffect(()=>{
    let cancelled=false; const controller=new AbortController();
    const loadProducts=async()=>{
      try{
        if(productPage===1) setLoadingProducts(true); else setLoadingMoreProducts(true);
        const cached=await offlineDB.products.toArray();
        const isOfflineNow=typeof window!=="undefined"&&!window.navigator.onLine;

        if(isOfflineNow){
          const filtered = productSearch? cached.filter(c=>c.name.toLowerCase().includes(productSearch.toLowerCase()) || (c.company||"").toLowerCase().includes(productSearch.toLowerCase())) : cached;
          const totalCount = filtered.length;
          const totalPages = Math.ceil(totalCount / PRODUCTS_PER_PAGE) || 1;
          const hasMore = productPage < totalPages;
          const pageSlice = filtered.slice(0, productPage * PRODUCTS_PER_PAGE);
          if(!cancelled){
            setProducts(pageSlice.map(c=>({_id:c._id||c.localId,name:c.name,company:c.company,mainUnit:c.mainUnit as MainUnit,pattaPerBox:c.pattaPerBox,mlPerBottle:c.mlPerBottle,buyPrice:c.buyPrice,sellPrice:c.sellPrice,stock:c.stock,expiryDate:c.expiryDate,rack:c.rack,batchNo:c.batchNo})));
            setProductPagination({ page: productPage, totalPages, hasMore, totalCount });
          }
          setLoadingProducts(false); setLoadingMoreProducts(false);
          return;
        }

        const res=await fetch(`/api/products?search=${encodeURIComponent(productSearch)}&page=${productPage}&limit=${PRODUCTS_PER_PAGE}`,{signal:controller.signal});
        const data=await res.json() as {products:Product[];pagination:Pagination}|Product[];
        const list=Array.isArray(data)?data:data.products;
        if(cancelled) return;
        if(productPage===1) setProducts(list); else setProducts(prev=>[...prev,...list]);
        if(!Array.isArray(data)&&data.pagination) setProductPagination(data.pagination);

        if(list && list.length>0){
          const offlineUser = getOfflineUser();
          const userId = offlineUser?._id?? "offline";
          const toCache = list.map(p=>toOfflineProduct(p, userId));
          await offlineDB.products.bulkPut(toCache);
        }
      }catch(err){ if((err as Error).name!=="AbortError") console.error(err);} finally{ if(!cancelled){ setLoadingProducts(false); setLoadingMoreProducts(false);} }
    }; void loadProducts(); return()=>{ cancelled=true; controller.abort(); };
  },[productSearch,productPage]);

  useEffect(()=>{
    const loadAllForExpiry = async () => {
      try {
        const cached = await offlineDB.products.toArray();
        if(cached.length>0){
          setExpiryProducts(cached.map(c=>({_id:c._id||c.localId,name:c.name,company:c.company,mainUnit:c.mainUnit as MainUnit,pattaPerBox:c.pattaPerBox,mlPerBottle:c.mlPerBottle,buyPrice:c.buyPrice,sellPrice:c.sellPrice,stock:c.stock,expiryDate:c.expiryDate,rack:c.rack,batchNo:c.batchNo})));
        }
        if(typeof window!=="undefined"&&!window.navigator.onLine) return;
        const res = await fetch(`/api/products?limit=1000`);
        const data = await res.json() as {products:Product[]}|Product[];
        const list = Array.isArray(data)? data : data.products;
        if(list && list.length>0){
          setExpiryProducts(list);
          const offlineUser = getOfflineUser();
          const userId = offlineUser?._id?? "offline";
          const toCache = list.map(p=>toOfflineProduct(p, userId));
          await offlineDB.products.bulkPut(toCache);
        }
      } catch { /* ignore */ }
    };
    void loadAllForExpiry();
  },[]);

  useEffect(()=>{
    const controller=new AbortController();
    const fetchData=async()=>{
      setLoadingSales(true);
      try{
        if(typeof window!=="undefined"&&!window.navigator.onLine){
          const offlineAll=await offlineDB.sales.reverse().toArray();
          const mapped=offlineAll.map(o=>({_id:o.localId,productId:o.productId,productName:o.productName,mainUnit:o.mainUnit as MainUnit,sellUnit:o.sellUnit as SellUnit,quantity:o.quantity,sellPrice:o.sellPrice,deductionMain:o.deductionMain,total:o.total,profit:o.profit,createdAt:o.createdAt,customerName:o.customerName,status:o.status,paymentType:o.paymentType}));
          setSales(mapped); setTotal(mapped.reduce((a,b)=>a+b.total,0)); setProfit(mapped.reduce((a,b)=>a+b.profit,0)); setPagination({page:1,totalPages:1,hasMore:false,totalCount:mapped.length}); setLoadingSales(false); return;
        }
        const res=await fetch(`/api/sales?filter=${filter}&page=${page}&limit=15`,{signal:controller.signal});
        const data=await res.json() as SalesApiResponse; if(page===1) setSales(data.sales); else setSales(prev=>[...prev,...data.sales]); setTotal(data.total); setProfit(data.profit); setPendingTotal(data.pendingTotal??0); setPagination(data.pagination);
      }catch(err){ if((err as Error).name!=="AbortError") console.error(err);} finally{ setLoadingSales(false); }
    }; void fetchData(); return()=>controller.abort();
  },[filter,page]);

  const sell=async(p:Product)=>{
    if(sellingId) return; if(isExpired(p.expiryDate)&&!confirm(`⚠️ ${p.name} EXPIRED - Sell?`)) return;
    if(paymentType==="credit"&&(!customerName||customerName.toLowerCase()==="walk-in"||customerName.trim().length<2)){ alert("Enter customer name for Udhar"); return; }
    const calc=getSellCalc(p); if(p.stock<calc.deductMain-0.0001){ alert(`Only ${fmt(p.stock,1)} ${p.mainUnit} left`); return; }
    const offlineUser=getOfflineUser(); setSellingId(p._id); const finalCustomer=customerName.trim()||"Walk-in";
    setProducts(prev=>prev.map(prod=>prod._id===p._id?{...prod,stock:Math.round((prod.stock-calc.deductMain)*100)/100}:prod));
    setExpiryProducts(prev=>prev.map(prod=>prod._id===p._id?{...prod,stock:Math.round((prod.stock-calc.deductMain)*100)/100}:prod));
    const optimistic:Sale={_id:generateLocalId(),productId:p._id,productName:p.name,mainUnit:p.mainUnit,sellUnit:calc.sellUnit,quantity:calc.qty,sellPrice:calc.sellPrice,deductionMain:calc.deductMain,total:calc.total,profit:calc.profit,createdAt:new Date().toISOString(),customerName:finalCustomer,status:paymentType==="credit"?"pending":"paid",paymentType};
    setSales(prev=>[optimistic,...prev]); setTotal(t=>t+calc.total); setProfit(pr=>pr+calc.profit); setTimeout(()=>setSellingId(null),400);
    try{
      await saveSaleOffline({productId:p._id,productName:p.name,quantity:calc.qty,mainUnit:p.mainUnit,sellUnit:calc.sellUnit,pattaPerBox:p.pattaPerBox,mlPerBottle:p.mlPerBottle,buyPriceMain:p.buyPrice,sellPrice:calc.sellPrice,userId:offlineUser?._id||"offline",customerName:finalCustomer,paymentType});
      if(window.navigator.onLine) void syncPendingSales(); else setPendingCount(c=>c+1);
    }catch{ setPendingCount(c=>c+1); }
  };

  const handleDeleteSale=async(id:string)=>{
    if(!confirm("Delete sale and restore stock?")) return; setDeletingId(id);
    try{
      const saleToDelete=sales.find(s=>s._id===id); const restore=saleToDelete?.deductionMain??0;
      setSales(prev=>prev.filter(s=>s._id!==id)); if(saleToDelete){ setTotal(t=>Math.max(0,t-saleToDelete.total)); setProfit(pr=>Math.max(0,pr-saleToDelete.profit)); }
      if(saleToDelete?.productId){
        setProducts(prev=>prev.map(prod=>prod._id===saleToDelete.productId?{...prod,stock:Math.round((prod.stock+restore)*100)/100}:prod));
        setExpiryProducts(prev=>prev.map(prod=>prod._id===saleToDelete.productId?{...prod,stock:Math.round((prod.stock+restore)*100)/100}:prod));
      }
      if(id.startsWith("local_")){
        await offlineDB.sales.delete(id);
        if(saleToDelete?.productId) await offlineDB.products.where("_id").equals(saleToDelete.productId).or("localId").equals(saleToDelete.productId).modify(prod=>{prod.stock+=restore;});
        setPendingCount(c=>Math.max(0,c-1));
      }else{ const res=await fetch(`/api/sales/${id}`,{method:"DELETE"}); if(!res.ok) throw new Error("Delete failed"); }
      await refreshSalesOnly();
    }catch(e){ alert((e as Error).message); void refreshSalesOnly(); } finally{ setDeletingId(null); }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-30 bg-white border-b px-2 py-2">
        <div className="max-w-7xl mx-auto flex flex-col gap-1.5">
          <div className="flex justify-between items-center">
            <h1 className="text-[12px] font-bold">💊 Yasir Medical V14.6 {isOffline?"📶 Offline":""}</h1>
            <div className="flex gap-1.5 items-center">
              <div className="relative">
                <button onClick={()=>setShowExpiry(!showExpiry)} className="relative p-1.5 bg-gray-100 rounded-full hover:bg-gray-200">
                  <span className="text-[16px]">🔔</span>
                  {expiryNotifications.length>0 && (
                    <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-bold animate-pulse">
                      {expiryNotifications.length}
                    </span>
                  )}
                </button>
                {showExpiry && (
                  <>
                    <div className="fixed inset-0 bg-black/20 z-40 md:hidden" onClick={()=>setShowExpiry(false)}></div>
                    <div className="fixed md:absolute left-2 right-2 md:left-auto md:right-0 top-27.5 md:top-9 w-auto md:w-80 bg-white border shadow-xl rounded-xl z-50 max-h-[70vh] md:max-h-80 overflow-hidden flex flex-col">
                      <div className="p-2.5 border-b bg-red-50 flex justify-between items-center">
                        <p className="text-[11px] font-bold">⚠️ Expiry Alerts - All Stock</p>
                        <button onClick={()=>setShowExpiry(false)} className="text-[11px] bg-white border px-2.5 py-1 rounded-full">✕</button>
                      </div>
                      <div className="overflow-y-auto flex-1">
                        {expiryNotifications.length===0? (
                          <p className="p-4 text-[11px] text-center text-green-600">✅ No expiry - All good 👍</p>
                        ) : expiryNotifications.map(n=>(
                          <div key={n._id} className={`p-2 border-b text-[10px] ${n.status==="expired"?"bg-red-50":"bg-amber-50"}`}>
                            <div className="flex justify-between gap-1">
                              <span className="font-bold truncate flex-1">{n.name}</span>
                              <span className={`px-1.5 py-0.5 rounded-full text-[8px] font-bold whitespace-nowrap ${n.status==="expired"?"bg-red-600 text-white":"bg-amber-500 text-white"}`}>
                                {n.status==="expired"?`EXPIRED ${Math.abs(n.daysLeft)}d`:`${n.daysLeft}d left`}
                              </span>
                            </div>
                            <p className="text-[9px] text-gray-500 mt-0.5">Stock {fmt(n.stock,1)} {n.mainUnit} • Exp: {n.expiryDate?.slice(0,10)} • Rack {n.rack||"?"}</p>
                          </div>
                        ))}
                      </div>
                      <div className="p-1.5 bg-gray-50 text-[9px] text-center text-gray-600">
                        {expiredCount} Expired • {soonCount} Soon - From {expiryProducts.length} medicines
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="flex gap-1">
                <div className="bg-green-600 text-white px-2 py-1 rounded-full text-[9px] font-bold">{filter.toUpperCase()}: Rs.{fmt(total,0)}</div>
                <div className="bg-blue-600 text-white px-2 py-1 rounded-full text-[9px] font-bold">+{fmt(profit,0)}</div>
                {pendingTotal>0&&<div className="bg-red-600 text-white px-2 py-1 rounded-full text-[9px] font-bold">Udhar {fmt(pendingTotal,0)}</div>}
              </div>
            </div>
          </div>
          <div className="flex gap-1">
            <input value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder="Walk-in" className="flex-1 p-1.5 rounded-lg border text-[11px] h-8 bg-white"/>
            <div className="flex bg-gray-100 rounded-lg p-0.5 h-8"><button onClick={()=>setPaymentType("cash")} className={`px-3 rounded-md text-[10px] font-bold ${paymentType==="cash"?"bg-green-600 text-white":"text-gray-600"}`}>Cash</button><button onClick={()=>setPaymentType("credit")} className={`px-3 rounded-md text-[10px] font-bold ${paymentType==="credit"?"bg-red-600 text-white":"text-gray-600"}`}>Udhar</button></div>
          </div>
          {mounted&&(isOffline||pendingCount>0)&&<div className="text-[10px] p-1.5 rounded-lg flex justify-between bg-blue-50 border"><span>{isOffline?`Offline Mode - ${pendingCount} pending`:`${pendingCount} pending sync`}</span>{!isOffline&&<button onClick={()=>syncPendingSales()} disabled={syncing} className="bg-blue-600 text-white px-2 py-0.5 rounded text-[10px]">{syncing?"Syncing...":"Sync Now"}</button>}</div>}
          {expiryNotifications.length>0 && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-[10px] p-1.5 rounded-lg flex justify-between">
              <span>⚠️ {expiredCount} Expired, {soonCount} Expiring Soon - Total {expiryNotifications.length}</span>
              <button onClick={()=>setShowExpiry(true)} className="font-bold underline">View</button>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-2">
        <input placeholder="🔍 Search medicine" value={productSearch} onChange={e=>{setProductSearch(e.target.value); setProductPage(1);}} className="border p-2 rounded-xl w-full bg-white text-[11px] h-8 mb-2"/>

        {loadingProducts?(
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
            {[1,2,3,4,5,6].map(i=>(
              <div key={i} className="bg-white border rounded-xl p-2.5 animate-pulse"><div className="h-3 bg-gray-200 rounded w-3/4 mb-2"></div></div>
            ))}
          </div>
        ):(
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2 mb-3">
            {products.map(p=>{
              const calc=getSellCalc(p); const out=p.stock<=0.001; const isSelling=sellingId===p._id;
              const totalBuyStock = p.stock * p.buyPrice;
              const expStatus = getExpiryStatus(p.expiryDate);
              return(
                <div key={p._id} className={`bg-white border rounded-xl p-2 shadow-sm ${isSelling?"ring-2 ring-green-400":""} ${expStatus==="expired"?"border-red-400 bg-red-50/40":expStatus==="soon"?"border-amber-300 bg-amber-50/40":""}`}>
                  <div className="flex justify-between gap-1">
                    <p className="font-bold text-[11px] leading-tight truncate w-[60%]">{p.name} <span className="font-normal text-[8px] text-gray-400">{p.company}</span>{expStatus==="expired"&&<span className="ml-1 text-[8px] bg-red-600 text-white px-1 rounded">EXPIRED</span>}{expStatus==="soon"&&<span className="ml-1 text-[8px] bg-amber-500 text-white px-1 rounded">SOON</span>}</p>
                    <span className="text-[8px] bg-gray-100 px-1.5 py-0.5 rounded-full h-fit whitespace-nowrap">{fmt(p.stock,1)} {p.mainUnit} • TotBuy Rs.{fmt(totalBuyStock,0)}</span>
                  </div>
                  <p className="text-[9px] text-gray-500 mt-0.5">Stk {fmt(p.stock,1)} = Buy Rs.{fmt(p.buyPrice,1)}/{p.mainUnit} • Sell Rs.{fmt(p.sellPrice,1)}/{p.mainUnit==="box"?"Patta":p.mainUnit} {p.rack?`• ${p.rack}`:""} {p.expiryDate?`• ${p.expiryDate.slice(0,10)}`:""}</p>
                  <div className="flex bg-gray-100 rounded-full p-0.5 mt-1.5 w-fit gap-0.5">
                    {sellOptions(p.mainUnit).map(u=>(
                      <button key={u} onClick={()=>{ const def=getDefaultPrice(p,u as SellUnit); setSellUnitMap({...sellUnitMap,[p._id]:u as SellUnit}); setPriceMap({...priceMap,[p._id]:fmt(def,1)});}} className={`px-2.5 py-1 rounded-full text-[9px] ${calc.sellUnit===u?"bg-green-600 text-white font-bold":"text-gray-600"}`}>{u}</button>
                    ))}
                  </div>
                  <div className="flex gap-1 mt-1.5">
                    <input type="text" inputMode="decimal" value={priceMap[p._id]??fmt(calc.defaultPrice,1)} onFocus={e=>e.target.select()} onChange={e=>{ const v=e.target.value; if(v===""||/^[0-9]*\.?[0-9]*$/.test(v)) setPriceMap({...priceMap,[p._id]:v});}} onBlur={()=>{ const v=priceMap[p._id]; if(v===""||Number(v)<=0) setPriceMap({...priceMap,[p._id]:fmt(calc.defaultPrice,1)});}} className="flex-1 border rounded-lg px-2 py-1 text-[11px] h-8 bg-blue-50/50" placeholder={`Price ${calc.sellUnit}`}/>
                    <div className="text-[9px] bg-gray-50 border rounded-lg px-2 flex items-center h-8">{calc.qty} {calc.sellUnit}</div>
                  </div>
                  <div className="bg-gray-50 border rounded-lg px-2 py-1 mt-1 flex justify-between text-[10px]"><span>{fmt(calc.qty,1)} {calc.sellUnit} = -{fmt2(calc.deductMain)} {p.mainUnit}</span><span className="font-bold text-green-700">Rs.{fmt(calc.total,0)} +{fmt(calc.profit,0)}</span></div>
                  <div className="flex gap-1 mt-1.5">
                    <div className="flex border rounded-lg overflow-hidden h-8"><button onClick={()=>setQtyMap({...qtyMap,[p._id]:Math.max(0.5,(qtyMap[p._id]||1)-0.5)})} className="px-2.5 bg-gray-50 text-[12px]">-</button><div className="w-8 flex items-center justify-center border-x text-[11px]">{fmt(qtyMap[p._id]||1,1)}</div><button onClick={()=>setQtyMap({...qtyMap,[p._id]:(qtyMap[p._id]||1)+0.5})} className="px-2.5 bg-gray-50 text-[12px]">+</button></div>
                    <button onClick={()=>sell(p)} disabled={out||!!isSelling} className={`flex-1 rounded-lg text-[10px] h-8 font-bold ${out?"bg-gray-200 text-gray-500":"bg-green-600 text-white"}`}>{isSelling?"Selling...":paymentType==="credit"?`Udhar Rs.${fmt(calc.total,0)}`:`Sell Rs.${fmt(calc.total,0)}`}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {productPagination.hasMore&&<button onClick={()=>setProductPage(pr=>pr+1)} disabled={loadingMoreProducts} className="w-full mb-3 py-2 bg-white border border-green-600 text-green-700 rounded-xl text-[11px] h-9">{loadingMoreProducts?"Loading...":`Load More (${productPagination.totalCount - products.length} left)`}</button>}

        <div className="flex gap-1 mb-2 overflow-x-auto pb-1">{FILTERS.map(f=><button key={f} onClick={()=>{setFilter(f); setPage(1);}} className={`px-3 py-1 rounded-full text-[10px] capitalize whitespace-nowrap ${filter===f?"bg-green-600 text-white":"bg-white border"}`}>{f}</button>)}</div>

        <div className="bg-white rounded-xl border overflow-hidden relative">
          {deletingId && <div className="absolute inset-0 bg-white/70 z-10 flex items-center justify-center"><p className="bg-red-600 text-white px-4 py-2 rounded-full text-[12px] animate-pulse">⏳ Deleting sale... restoring stock</p></div>}
          {loadingSales?<div className="p-3 text-[11px] text-center">Loading sales...</div>:sales.length===0?<p className="p-6 text-center text-gray-400 text-[11px]">No sales {filter}</p>:sales.map(s=>(
            <div key={s._id} className={`p-2 border-b flex justify-between ${s._id.startsWith("local_")?"bg-amber-50/50":""} ${s.status==="pending"?"bg-red-50/30":""} ${deletingId===s._id?"opacity-40":""}`}>
              <div><p className="font-bold text-[11px]">{s.productName} {fmt(s.quantity,1)} {s.sellUnit} @ Rs.{fmt(s.sellPrice,1)} <span className="text-[9px] text-gray-500">(-{fmt2(s.deductionMain)} {s.mainUnit})</span></p><p className="text-[9px] text-gray-400">{new Date(s.createdAt).toLocaleTimeString()} {s.customerName&&s.customerName!=="Walk-in"?`👤${s.customerName}`:""}</p></div>
              <div className="text-right"><div className="font-bold text-[11px]">Rs.{fmt(s.total,0)}</div><div className="text-[9px] text-green-600">+{fmt(s.profit,0)}</div><button onClick={()=>handleDeleteSale(s._id)} disabled={!!deletingId} className={`text-[9px] px-2 py-0.5 rounded mt-0.5 ${deletingId===s._id?"bg-gray-300 text-gray-500":"bg-red-50 text-red-600"}`}>{deletingId===s._id?"Deleting...":"Del"}</button></div>
            </div>
          ))}
          {pagination.hasMore&&<div className="p-1.5 bg-gray-50"><button onClick={()=>setPage(p=>p+1)} disabled={!!deletingId} className="w-full py-2 bg-white border rounded-lg text-[11px]">More</button></div>}
        </div>
      </div>
    </div>
  );
}