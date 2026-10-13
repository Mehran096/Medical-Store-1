"use client";
import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { offlineDB } from "@/lib/offline-db";
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
function expiryLabel(e?:string){ if(!e) return ""; return new Date(e).toLocaleDateString('en-GB',{month:'short',year:'2-digit'}); }

// FIX: clean numbers 9.7, 6.7, 95.6 not 95.666666666
function fmt(n:number, d=1){ if(isNaN(n)) return "0"; const f=Number(n).toFixed(d); return f.replace(/\.0+$/,"").replace(/(\.\d*[1-9])0+$/,"$1"); }
function fmt2(n:number){ return fmt(n,2); } // for deduction 0.33, 0.1

export default function SalesPage() {
  const [sales, setSales] = useState<Sale[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0); const [profit, setProfit] = useState(0); const [pendingTotal, setPendingTotal] = useState(0);
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({});
  const [sellUnitMap, setSellUnitMap] = useState<Record<string, SellUnit>>({});
  const [priceMap, setPriceMap] = useState<Record<string, string>>({}); // FIX string for editable
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

  useEffect(()=>{ 
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true); },[]);

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
    let deductMain=0; let total=0; let profitCalc=0;
    if(p.mainUnit==="box"){
      const buyPerPatta=p.buyPrice/ppb;
      if(sellUnit==="patta"){ deductMain=qty/ppb; total=sellPrice*qty; profitCalc=(sellPrice-buyPerPatta)*qty; }
      else if(sellUnit==="half_patta"){ deductMain=(qty*0.5)/ppb; total=sellPrice*qty; profitCalc=(sellPrice-buyPerPatta/2)*qty; }
      else{ deductMain=qty; total=sellPrice*qty; profitCalc=(sellPrice-p.buyPrice)*qty; }
    }else{
      if(sellUnit==="ml"){ const buyPerMl=p.buyPrice/mlB; deductMain=qty/mlB; total=sellPrice*qty; profitCalc=(sellPrice-buyPerMl)*qty; }
      else{ deductMain=qty; total=sellPrice*qty; profitCalc=(sellPrice-p.buyPrice)*qty; }
    }
    return { sellUnit, qty, sellPrice, defaultPrice, deductMain: Math.round(deductMain*100)/100, total: Math.round(total), profit: Math.round(profitCalc) };
  }, [sellUnitMap, qtyMap, priceMap]);

  const refreshSalesOnly = useCallback(async () => {
    setPage(1); setLoadingSales(true);
    if(typeof window!=="undefined"&&!window.navigator.onLine){
      const offlineSales = await offlineDB.sales.where("synced").equals(0).reverse().toArray();
      const mapped:Sale[] = offlineSales.map(o=>({_id:o.localId,productId:o.productId,productName:o.productName,mainUnit:o.mainUnit as MainUnit,sellUnit:o.sellUnit as SellUnit,quantity:o.quantity,sellPrice:o.sellPrice,deductionMain:o.deductionMain,total:o.total,profit:o.profit,createdAt:o.createdAt,customerName:o.customerName,status:o.status,paymentType:o.paymentType}));
      setSales(mapped); setTotal(mapped.reduce((a,b)=>a+b.total,0)); setProfit(mapped.reduce((a,b)=>a+b.profit,0)); setLoadingSales(false); return;
    }
    try{ const res=await fetch(`/api/sales?filter=${filter}&page=1&limit=15`); const data=await res.json() as SalesApiResponse; setSales(data.sales); setTotal(data.total); setProfit(data.profit); setPendingTotal(data.pendingTotal??0); setPagination(data.pagination);}catch{} setLoadingSales(false);
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
        if(cached.length>0&&!cancelled&&productSearch===""&&productPage===1){
          setProducts(cached.slice(0,PRODUCTS_PER_PAGE).map(c=>({_id:c._id||c.localId,name:c.name,company:c.company,mainUnit:c.mainUnit as MainUnit,pattaPerBox:c.pattaPerBox,mlPerBottle:c.mlPerBottle,buyPrice:c.buyPrice,sellPrice:c.sellPrice,stock:c.stock,expiryDate:c.expiryDate,rack:c.rack,batchNo:c.batchNo})));
        }
        if(isOfflineNow){ setLoadingProducts(false); setLoadingMoreProducts(false); return;}
        const res=await fetch(`/api/products?search=${encodeURIComponent(productSearch)}&page=${productPage}&limit=${PRODUCTS_PER_PAGE}`,{signal:controller.signal});
        const data=await res.json() as {products:Product[];pagination:Pagination}|Product[]; const list=Array.isArray(data)?data:data.products; if(cancelled) return;
        if(productPage===1) setProducts(list); else setProducts(prev=>[...prev,...list]); if(!Array.isArray(data)&&data.pagination) setProductPagination(data.pagination);
      }catch(err){ if((err as Error).name!=="AbortError") console.error(err);} finally{ if(!cancelled){ setLoadingProducts(false); setLoadingMoreProducts(false);} }
    }; void loadProducts(); return()=>{ cancelled=true; controller.abort(); };
  },[productSearch,productPage]);

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
    if(sellingId) return; if(isExpired(p.expiryDate)&&!confirm(`⚠️ ${p.name} EXPIRED ${expiryLabel(p.expiryDate)} - Sell?`)) return;
    if(paymentType==="credit"&&(!customerName||customerName.toLowerCase()==="walk-in"||customerName.trim().length<2)){ alert("Enter customer name for Udhar"); return; }
    const calc=getSellCalc(p); if(p.stock<calc.deductMain-0.0001){ alert(`Only ${fmt(p.stock,1)} ${p.mainUnit} left`); return; }
    const offlineUser=getOfflineUser(); setSellingId(p._id); const finalCustomer=customerName.trim()||"Walk-in";
    setProducts(prev=>prev.map(prod=>prod._id===p._id?{...prod,stock:Math.round((prod.stock-calc.deductMain)*10)/10}:prod));
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
      if(saleToDelete?.productId) setProducts(prev=>prev.map(p=>p._id===saleToDelete.productId?{...p,stock:Math.round((p.stock+restore)*10)/10}:p));
      if(id.startsWith("local_")){ await offlineDB.sales.delete(id); if(saleToDelete?.productId) await offlineDB.products.where("_id").equals(saleToDelete.productId).or("localId").equals(saleToDelete.productId).modify(prod=>{prod.stock+=restore;}); setPendingCount(c=>Math.max(0,c-1)); }
      else{ const res=await fetch(`/api/sales/${id}`,{method:"DELETE"}); if(!res.ok) throw new Error("Delete failed"); }
      void refreshSalesOnly();
    }catch(e){ alert((e as Error).message); void refreshSalesOnly(); } finally{ setDeletingId(null); }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* HEADER - SMALL MOBILE */}
      <div className="sticky top-0 z-20 bg-white border-b px-2 py-2">
        <div className="max-w-7xl mx-auto flex flex-col gap-1.5">
          <div className="flex justify-between items-center">
            <h1 className="text-[12px] font-bold">💊 Yasir Medical V14.3 {isOffline?"📶":""}</h1>
            <div className="flex gap-1"><div className="bg-green-600 text-white px-2 py-1 rounded-full text-[9px] font-bold">{filter.toUpperCase()}: Rs.{fmt(total,0)}</div><div className="bg-blue-600 text-white px-2 py-1 rounded-full text-[9px] font-bold">+{fmt(profit,0)}</div>{pendingTotal>0&&<div className="bg-red-600 text-white px-2 py-1 rounded-full text-[9px] font-bold">Udhar {fmt(pendingTotal,0)}</div>}</div>
          </div>
          <div className="flex gap-1">
            <input value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder="Walk-in" className="flex-1 p-1.5 rounded-lg border text-[11px] h-8 bg-white"/>
            <div className="flex bg-gray-100 rounded-lg p-0.5 h-8"><button onClick={()=>setPaymentType("cash")} className={`px-3 rounded-md text-[10px] font-bold ${paymentType==="cash"?"bg-green-600 text-white":"text-gray-600"}`}>Cash</button><button onClick={()=>setPaymentType("credit")} className={`px-3 rounded-md text-[10px] font-bold ${paymentType==="credit"?"bg-red-600 text-white":"text-gray-600"}`}>Udhar</button></div>
          </div>
          {mounted&&(isOffline||pendingCount>0)&&<div className="text-[10px] p-1.5 rounded-lg flex justify-between bg-blue-50 border"><span>{isOffline?`Offline ${pendingCount}`:`${pendingCount} pending`}</span>{!isOffline&&<button onClick={()=>syncPendingSales()} disabled={syncing} className="bg-blue-600 text-white px-2 py-0.5 rounded text-[10px]">{syncing?"...":"Sync"}</button>}</div>}
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-2">
        <input placeholder="🔍 Search medicine" value={productSearch} onChange={e=>{setProductSearch(e.target.value); setProductPage(1);}} className="border p-2 rounded-xl w-full bg-white text-[11px] h-8 mb-2"/>

        {/* PRODUCTS - LOADING */}
        {loadingProducts?(
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
            {[1,2,3,4,5,6].map(i=>(
              <div key={i} className="bg-white border rounded-xl p-2.5 animate-pulse">
                <div className="h-3 bg-gray-200 rounded w-3/4 mb-2"></div><div className="h-2 bg-gray-100 rounded w-1/2 mb-3"></div><div className="h-7 bg-gray-100 rounded"></div><div className="h-7 bg-gray-100 rounded mt-2"></div>
              </div>
            ))}
          </div>
        ):(
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2 mb-3">
            {products.map(p=>{
              const calc=getSellCalc(p); const out=p.stock<=0.001; const isSelling=sellingId===p._id;
              return(
                <div key={p._id} className={`bg-white border rounded-xl p-2 shadow-sm ${isSelling?"ring-2 ring-green-400":""} ${isExpired(p.expiryDate)?"border-red-300 bg-red-50/30":""}`}>
                  <div className="flex justify-between gap-1"><p className="font-bold text-[11px] leading-tight truncate w-[70%]">{p.name} <span className="font-normal text-[8px] text-gray-400">{p.company}</span></p><span className="text-[8px] bg-gray-100 px-1.5 py-0.5 rounded-full h-fit whitespace-nowrap">{fmt(p.stock,1)} {p.mainUnit} • {p.mainUnit==="box"?`${Math.floor(p.stock*(p.pattaPerBox||10))}P`:""}</span></div>
                  <p className="text-[9px] text-gray-500 mt-0.5 truncate">Stk {fmt(p.stock,1)} = Buy Rs.{fmt(p.buyPrice,1)}/{p.mainUnit} • Sell Rs.{fmt(p.sellPrice,1)}/{p.mainUnit==="box"?"Patta":p.mainUnit} {p.rack?`• ${p.rack}`:""}</p>
                  {isExpired(p.expiryDate)&&<p className="text-[9px] text-red-600 font-bold">⚠️ EXPIRED {expiryLabel(p.expiryDate)}</p>}

                  <div className="flex bg-gray-100 rounded-full p-0.5 mt-1.5 w-fit gap-0.5">
                    {sellOptions(p.mainUnit).map(u=>(
                      <button key={u} onClick={()=>{ const def=getDefaultPrice(p,u as SellUnit); setSellUnitMap({...sellUnitMap,[p._id]:u as SellUnit}); setPriceMap({...priceMap,[p._id]:fmt(def,1)});}} className={`px-2.5 py-1 rounded-full text-[9px] ${calc.sellUnit===u?"bg-green-600 text-white font-bold":"text-gray-600"}`}>{u}</button>
                    ))}
                  </div>

                  <div className="flex gap-1 mt-1.5">
                    <input type="text" inputMode="decimal" value={priceMap[p._id]??fmt(calc.defaultPrice,1)} onFocus={e=>e.target.select()} onChange={e=>{ const v=e.target.value; if(v===""||/^[0-9]*\.?[0-9]*$/.test(v)) setPriceMap({...priceMap,[p._id]:v});}} onBlur={()=>{ const v=priceMap[p._id]; if(v===""||Number(v)<=0) setPriceMap({...priceMap,[p._id]:fmt(calc.defaultPrice,1)});}} className="flex-1 border rounded-lg px-2 py-1 text-[11px] h-8 bg-blue-50/50" placeholder={`Price ${calc.sellUnit}`}/>
                    <div className="text-[9px] bg-gray-50 border rounded-lg px-2 flex items-center h-8">{calc.qty} {calc.sellUnit}</div>
                  </div>

                  <div className="bg-gray-50 border rounded-lg px-2 py-1 mt-1 flex justify-between text-[10px]"><span>{calc.qty} {calc.sellUnit} = -{fmt2(calc.deductMain)} {p.mainUnit}</span><span className="font-bold text-green-700">Rs.{fmt(calc.total,0)} +{fmt(calc.profit,0)}</span></div>

                  <div className="flex gap-1 mt-1.5">
                    <div className="flex border rounded-lg overflow-hidden h-8"><button onClick={()=>setQtyMap({...qtyMap,[p._id]:Math.max(0.5,(qtyMap[p._id]||1)-0.5)})} className="px-2.5 bg-gray-50 text-[12px]">-</button><div className="w-8 flex items-center justify-center border-x text-[11px]">{fmt(qtyMap[p._id]||1,1)}</div><button onClick={()=>setQtyMap({...qtyMap,[p._id]:(qtyMap[p._id]||1)+0.5})} className="px-2.5 bg-gray-50 text-[12px]">+</button></div>
                    <button onClick={()=>sell(p)} disabled={out||!!isSelling} className={`flex-1 rounded-lg text-[10px] h-8 font-bold ${out?"bg-gray-200 text-gray-500":"bg-green-600 text-white"}`}>{isSelling?"...":paymentType==="credit"?`Udhar Rs.${fmt(calc.total,0)}`:`Sell Rs.${fmt(calc.total,0)}`}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {productPagination.hasMore&&<button onClick={()=>setProductPage(pr=>pr+1)} disabled={loadingMoreProducts} className="w-full mb-3 py-2 bg-white border border-green-600 text-green-700 rounded-xl text-[11px] h-9">{loadingMoreProducts?"Loading...":"Load More"}</button>}

        <div className="flex gap-1 mb-2 overflow-x-auto pb-1">{FILTERS.map(f=><button key={f} onClick={()=>{setFilter(f); setPage(1);}} className={`px-3 py-1 rounded-full text-[10px] capitalize whitespace-nowrap ${filter===f?"bg-green-600 text-white":"bg-white border"}`}>{f}</button>)}</div>

        <div className="bg-white rounded-xl border overflow-hidden">
          {loadingSales?<div className="p-3 text-[11px] text-center"><div className="animate-pulse space-y-2"><div className="h-3 bg-gray-100 rounded"></div><div className="h-3 bg-gray-100 rounded w-5/6"></div><div className="h-3 bg-gray-100 rounded w-4/6"></div></div><p className="mt-2 text-gray-400">Loading sales...</p></div>:sales.length===0?<p className="p-6 text-center text-gray-400 text-[11px]">No sales {filter}</p>:sales.map(s=>(
            <div key={s._id} className={`p-2 border-b flex justify-between ${s._id.startsWith("local_")?"bg-amber-50/50":""} ${s.status==="pending"?"bg-red-50/30":""}`}>
              <div><p className="font-bold text-[11px]">{s.productName} {s.quantity} {s.sellUnit} @ Rs.{fmt(s.sellPrice,1)} <span className="text-[9px] text-gray-500">(-{fmt2(s.deductionMain)} {s.mainUnit})</span></p><p className="text-[9px] text-gray-400">{new Date(s.createdAt).toLocaleTimeString()} {s.customerName&&s.customerName!=="Walk-in"?`👤${s.customerName}`:""}</p></div>
              <div className="text-right"><div className="font-bold text-[11px]">Rs.{fmt(s.total,0)}</div><div className="text-[9px] text-green-600">+{fmt(s.profit,0)}</div><button onClick={()=>handleDeleteSale(s._id)} disabled={deletingId===s._id} className="text-[9px] text-red-600 bg-red-50 px-2 py-0.5 rounded mt-0.5">{deletingId===s._id?"...":"Del"}</button></div>
            </div>
          ))}
          {pagination.hasMore&&<div className="p-1.5 bg-gray-50"><button onClick={()=>setPage(p=>p+1)} className="w-full py-2 bg-white border rounded-lg text-[11px]">More</button></div>}
        </div>
      </div>
    </div>
  );
}