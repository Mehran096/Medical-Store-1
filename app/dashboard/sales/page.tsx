"use client";
import { useEffect, useState, useMemo, useCallback, useSyncExternalStore, useRef } from "react";
import { offlineDB } from "@/lib/offline-db";
import type { OfflineBatch } from "@/lib/offline-db";
import { saveSaleOffline, syncOfflineSales } from "@/lib/offline-sync";
import { getOfflineUser } from "@/lib/offline-auth";

type MainUnit = "box" | "bottle" | "tube" | "piece";
type SellUnit = "patta" | "half_patta" | "box" | "bottle" | "tube" | "piece";
type Product = { 
  _id: string; productId?: string; name: string; company?: string; mainUnit: MainUnit; pattaPerBox: number; mlPerBottle: number; 
  buyPrice?: number; buyPriceAvg?: number;
  sellPrice: number; stock: number; expiryDate?: string; rack?: string; batchNo?: string;
  batches?: { _id?: string; productId?: string; batchNo: string; expiryDate: string; buyPrice: number; quantity: number }[]
};
type Sale = { _id: string; productId: string; productName: string; mainUnit: MainUnit; sellUnit: SellUnit; quantity: number; sellPrice: number; deductionMain: number; total: number; profit: number; createdAt: string; customerName?: string; status?: string; paymentType?: string; batchNo?: string; };
type CartItem = { name:string; qty:number; unit:string; price:number; total:number };
type BillType = { items: CartItem[]; total:number; customer:string; time:string; billNo: string };
type FilterType = "today" | "yesterday" | "weekly" | "monthly" | "yearly" | "all";
type Pagination = { page: number; totalPages: number; hasMore: boolean; totalCount: number };
type SalesApiResponse = { sales: Sale[]; total: number; profit: number; pendingTotal?: number; pagination: Pagination };
type BatchApiItem = { _id?: string; productId: string; productName?: string; batchNo: string; expiryDate: string; buyPrice: number; quantity: number; mainUnit?: MainUnit; company?: string; sellPrice?: number };
type ProductApiResponse = { products: Product[]; pagination: Pagination };

const FILTERS: FilterType[] = ["today", "yesterday", "weekly", "monthly", "yearly", "all"];
const PRODUCTS_PER_PAGE = 12;

function useIsOnline(){
  const subscribe = useCallback((cb:()=>void)=>{ window.addEventListener("online",cb); window.addEventListener("offline",cb); return ()=>{ window.removeEventListener("online",cb); window.removeEventListener("offline",cb);};},[]);
  const getSnapshot = useCallback(()=> navigator.onLine,[]);
  const getServerSnapshot = useCallback(()=> true,[]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
function generateLocalId(){ return `local_${Date.now()}_${Math.random().toString(36).slice(2,9)}`; }
function rnd6(n:number){ return Math.round((n||0)*1000000)/1000000; }
function fmt(n:number, d=1){ if(isNaN(n)) return "0"; const v = rnd6(Number(n)); if(!Number.isFinite(v)) return "0"; return v % 1 === 0? v.toFixed(0) : v.toFixed(d).replace(/\.0+$/,""); }
function getExpiryStatus(e?: string): "expired" | "soon" | "ok" {
  if(!e) return "ok"; const now = new Date(); const exp = new Date(e);
  const diffDays = Math.ceil((exp.getTime() - now.getTime()) / 86400000);
  if(diffDays < 0) return "expired"; if(diffDays <= 90) return "soon"; return "ok";
}
function isExpired(e?:string){ if(!e) return false; const t=new Date(); t.setHours(0,0,0,0); return new Date(e) < t; }
function getSaleableBatches(p: Product){
  if(!p.batches || !p.batches.length) return [];
  const today=new Date(); today.setHours(0,0,0,0);
  return p.batches.filter(b=> b.quantity>0.0001 && new Date(b.expiryDate) >= today).sort((a,b)=> new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
}
function getSaleableStock(p: Product): number {
  const saleable = getSaleableBatches(p);
  if(saleable.length>0) return rnd6(saleable.reduce((s,b)=>s+b.quantity,0));
  if(p.batches && p.batches.length>0) return 0;
  if(p.expiryDate && isExpired(p.expiryDate)) return 0;
  return rnd6(p.stock);
}
function getProductBuyPrice(p: Product): number {
  const saleable = getSaleableBatches(p);
  if(saleable.length>0) return saleable[0].buyPrice || p.buyPriceAvg || p.buyPrice || 0;
  if(p.batches && p.batches.length>0){
    const sorted = [...p.batches].sort((a,b)=> new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
    return sorted[0].buyPrice || p.buyPriceAvg || p.buyPrice || 0;
  }
  return p.buyPriceAvg || p.buyPrice || 0;
}
function getProductExpiry(p: Product): string | undefined {
  const saleable = getSaleableBatches(p);
  if(saleable.length>0) return saleable[0].expiryDate;
  if(p.batches && p.batches.length>0){
    const sorted = [...p.batches].sort((a,b)=> new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
    return sorted[0].expiryDate || p.expiryDate;
  }
  return p.expiryDate;
}
function getProductBatchNo(p: Product): string | undefined {
  const saleable = getSaleableBatches(p);
  if(saleable.length>0) return saleable[0].batchNo;
  if(p.batches && p.batches.length>0){
    const sorted = [...p.batches].sort((a,b)=> new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
    return sorted[0].batchNo || p.batchNo;
  }
  return p.batchNo;
}
function toOfflineProduct(p: Product, userId: string){
  return { 
    _id: p._id, localId: p._id, name: p.name, company: p.company?? "", generic: "", barcode: "", rack: p.rack?? "", 
    mainUnit: p.mainUnit, pattaPerBox: p.pattaPerBox, mlPerBottle: p.mlPerBottle, 
    buyPriceAvg: getProductBuyPrice(p), 
    sellPrice: p.sellPrice, stock: p.stock, userId, synced: 1, createdAt: new Date().toISOString(), 
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("Walk-in"); const [paymentType, setPaymentType] = useState<"cash" | "credit">("cash");
  const [showExpiry, setShowExpiry] = useState(false); const [nowMs, setNowMs] = useState(0);
  const [lastBill, setLastBill] = useState<BillType | null>(null);
  const [showPrint, setShowPrint] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { 
    const t = setTimeout(() => { setMounted(true); setNowMs(Date.now()); }, 0);
    return () => clearTimeout(t);
  }, []);

  const expiryNotifications = useMemo(() => {
    if (nowMs === 0) return [];
    return expiryProducts
      .filter(p => p.stock > 0.0001)
      .map((p) => ({...p, status: getExpiryStatus(p.expiryDate), daysLeft: p.expiryDate? Math.ceil((new Date(p.expiryDate).getTime() - nowMs) / 86400000) : 999, }))
      .filter((p) => p.status!== "ok")
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }, [expiryProducts, nowMs]);

  const expiredCount = useMemo(() => expiryNotifications.filter((n) => n.status === "expired").length, [expiryNotifications]);
  const soonCount = useMemo(() => expiryNotifications.filter((n) => n.status === "soon").length, [expiryNotifications]);

  const sellOptions = (main: MainUnit): SellUnit[] => { 
    if (main === "box") return ["box", "patta", "half_patta"]; 
    if (main === "bottle") return ["bottle"];
    if (main === "tube") return ["tube"]; 
    return ["piece"]; 
  };
  const getDefaultSellUnit = (main: MainUnit): SellUnit => main==="box"?"box":main as SellUnit;
  const getDefaultPrice = (p:Product, u:SellUnit):number => { 
    const ppb=p.pattaPerBox||10; 
    if(p.mainUnit==="box"){ 
      if(u==="patta") return rnd6(p.sellPrice); 
      if(u==="half_patta") return rnd6(p.sellPrice/2); 
      if(u==="box") return rnd6(p.sellPrice*ppb); 
    } 
    return rnd6(p.sellPrice); 
  };

  const getSellCalc = useCallback((p: Product) => {
    const sellUnit = (sellUnitMap[p._id] || getDefaultSellUnit(p.mainUnit)) as SellUnit;
    const qty = qtyMap[p._id] || 1; 
    const ppb = p.pattaPerBox && p.pattaPerBox>0 ? p.pattaPerBox : 10;
    const defaultPrice = getDefaultPrice(p, sellUnit); 
    const str = priceMap[p._id];
    const sellPrice = str===undefined||str===""? defaultPrice : Number(str)||defaultPrice;
    let deductMain=0; let totalCalc=0; let profitCalc=0;
    const buyPrice = getProductBuyPrice(p);
    if(p.mainUnit==="box"){ 
      const buyPerPatta=buyPrice/ppb; 
      if(sellUnit==="patta"){ deductMain=qty/ppb; totalCalc=sellPrice*qty; profitCalc=(sellPrice-buyPerPatta)*qty; } 
      else if(sellUnit==="half_patta"){ deductMain=(qty*0.5)/ppb; totalCalc=sellPrice*qty; profitCalc=(sellPrice-buyPerPatta/2)*qty; } 
      else{ deductMain=qty; totalCalc=sellPrice*qty; profitCalc=(sellPrice-buyPrice)*qty; } 
    }
    else{ deductMain=qty; totalCalc=sellPrice*qty; profitCalc=(sellPrice-buyPrice)*qty; }
    return { sellUnit, qty, sellPrice, defaultPrice, deductMain: rnd6(deductMain), total: rnd6(totalCalc), profit: rnd6(profitCalc), buyPrice };
  }, [sellUnitMap, qtyMap, priceMap]);

  const refreshSalesOnly = useCallback(async () => {
    setPage(1); setLoadingSales(true);
    if(typeof window!=="undefined"&&!window.navigator.onLine){
      const offlineSales = await offlineDB.sales.reverse().toArray();
      const mapped:Sale[] = offlineSales.map(o=>({_id:o.localId,productId:o.productId,productName:o.productName,mainUnit:o.mainUnit as MainUnit,sellUnit:o.sellUnit as SellUnit,quantity:o.quantity,sellPrice:o.sellPrice,deductionMain:o.deductionMain,total:o.total,profit:o.profit,createdAt:o.createdAt,customerName:o.customerName,status:o.status,paymentType:o.paymentType,batchNo:o.batchNo}));
      setSales(mapped); setTotal(rnd6(mapped.reduce((a,b)=>a+b.total,0))); setProfit(rnd6(mapped.reduce((a,b)=>a+b.profit,0))); setLoadingSales(false); return;
    }
    try{ const res=await fetch(`/api/sales?filter=${filter}&page=1&limit=15`); const data=await res.json() as SalesApiResponse; setSales(data.sales); setTotal(rnd6(data.total)); setProfit(rnd6(data.profit)); setPendingTotal(rnd6(data.pendingTotal??0)); setPagination(data.pagination);}catch{ } setLoadingSales(false);
  }, [filter]);

  const syncPendingSales = useCallback(async () => {
    if(typeof window==="undefined"||!window.navigator.onLine) return; setSyncing(true);
    const result=await syncOfflineSales(); setPendingCount(prev=>Math.max(0,prev-result.synced)); setSyncing(false);
    if(result.synced>0) void refreshSalesOnly();
  }, [refreshSalesOnly]);

  useEffect(()=>{ 
    if(!mounted) return; 
    void offlineDB.sales.where("synced").equals(0).count().then(c=> setPendingCount(c));
    const onOnline = () => { void syncPendingSales(); };
    window.addEventListener("online", onOnline); 
    return()=>window.removeEventListener("online", onOnline); 
  },[mounted,syncPendingSales]);

  useEffect(()=>{
    let cancelled=false; const controller=new AbortController();
    const loadProducts=async()=>{
      try{
        if(productPage===1) setLoadingProducts(true); else setLoadingMoreProducts(true);
        const isOfflineNow=typeof window!=="undefined"&&!window.navigator.onLine;
        const allBatchesGlobal = await offlineDB.batches.toArray();
        if(isOfflineNow){
          const cached=await offlineDB.products.toArray();
          const filtered = productSearch? cached.filter(c=>c.name.toLowerCase().includes(productSearch.toLowerCase()) || (c.company||"").toLowerCase().includes(productSearch.toLowerCase())) : cached;
          const withStock = filtered.map(p=>{
            const bFor = allBatchesGlobal.filter(b=>b.productId===p._id || b.productId===p.localId);
            if(bFor.length>0){
              const saleable = bFor.filter(b=>b.quantity>0.0001 && new Date(b.expiryDate) >= new Date(new Date().setHours(0,0,0,0))).reduce((s,b)=>s+b.quantity,0);
              return {...p, stock: rnd6(saleable), batches: bFor.map(b=>({_id:b.localId, productId:b.productId, batchNo:b.batchNo, expiryDate:b.expiryDate, buyPrice:b.buyPrice, quantity:b.quantity})) };
            }
            return {...p, batches: []};
          });
          const totalCount = withStock.length; const totalPages = Math.ceil(totalCount / PRODUCTS_PER_PAGE) || 1;
          const hasMore = productPage < totalPages; const pageSlice = withStock.slice(0, productPage * PRODUCTS_PER_PAGE);
          if(!cancelled){ 
  type CachedWithBatches = typeof withStock[number];
  setProducts(pageSlice.map((c: CachedWithBatches)=>({
    _id:c._id||c.localId, name:c.name, company:c.company, mainUnit:c.mainUnit as MainUnit,
    pattaPerBox:c.pattaPerBox, mlPerBottle:c.mlPerBottle,
    buyPrice:c.buyPriceAvg||0, buyPriceAvg:c.buyPriceAvg||0, sellPrice:c.sellPrice, stock:c.stock, rack:c.rack,
    batches: c.batches||[],
  }))); 
  setProductPagination({ page: productPage, totalPages, hasMore, totalCount }); 
}
          setLoadingProducts(false); setLoadingMoreProducts(false); return;
        }
        const res=await fetch(`/api/products?search=${encodeURIComponent(productSearch)}&page=${productPage}&limit=${PRODUCTS_PER_PAGE}`,{signal:controller.signal});
        const data=await res.json() as ProductApiResponse | Product[]; 
        const list: Product[] = Array.isArray(data) ? data : data.products;
        if(cancelled) return;
        const withBatches = list.map(prod=>{
          const apiBatches = (prod as unknown as { batches?: Product["batches"] }).batches || [];
          if(apiBatches.length>0){
            const saleableSum = rnd6(apiBatches.filter(b=>b.quantity>0.0001).reduce((s,b)=>s+b.quantity,0));
            return {...prod, stock: saleableSum, batches: apiBatches};
          }
          return {...prod, stock: rnd6(prod.stock), batches: [] as Product["batches"]};
        });
        if(productPage===1) setProducts(withBatches); else setProducts(prev=>[...prev,...withBatches]); 
        if(!Array.isArray(data)&&data.pagination) setProductPagination(data.pagination);
        if(withBatches.length>0){ 
          const offlineUser = getOfflineUser(); const userId = offlineUser?._id?? "offline"; 
          const toCache = withBatches.map(p=>toOfflineProduct(p, userId)); 
          await offlineDB.products.bulkPut(toCache); 
          for(const p of withBatches){ await offlineDB.batches.where("productId").equals(p._id).delete(); }
          const toCacheBatches = withBatches.flatMap(p=> (p.batches||[]).map(b=>({
            localId: b._id||`${p._id}_${b.batchNo}`, _id: b._id, productId: p._id, batchNo: b.batchNo, expiryDate: b.expiryDate, buyPrice: b.buyPrice, quantity: b.quantity, userId, synced: 1, createdAt: new Date().toISOString()
          } as OfflineBatch)));
          if(toCacheBatches.length>0) await offlineDB.batches.bulkPut(toCacheBatches);
        }
      }catch(err){ if((err as Error).name!=="AbortError") console.error(err);} finally{ if(!cancelled){ setLoadingProducts(false); setLoadingMoreProducts(false);} }
    }; void loadProducts(); return()=>{ cancelled=true; controller.abort(); };
  },[productSearch,productPage]);

  useEffect(()=>{
    const loadAllForExpiry = async () => {
      try { 
        const batches: OfflineBatch[] = await offlineDB.batches.filter(b=>b.quantity>0).toArray();
        if(batches.length>0){
          const mapped = await Promise.all(batches.map(async b=>{
            const prod = await offlineDB.products.where('localId').equals(b.productId).first() || await offlineDB.products.where('_id').equals(b.productId).first();
            return {
              _id: b.localId, productId: b.productId, name: prod?.name || b.batchNo, company: prod?.company,
              mainUnit: (prod?.mainUnit as MainUnit) || "box", pattaPerBox: prod?.pattaPerBox || 10,
              mlPerBottle: prod?.mlPerBottle || 120, buyPrice: b.buyPrice, buyPriceAvg: b.buyPrice,
              sellPrice: prod?.sellPrice || 0, stock: b.quantity, expiryDate: b.expiryDate, batchNo: b.batchNo
            } as Product;
          }));
          setExpiryProducts(mapped);
        }
        if(typeof window!=="undefined"&&!window.navigator.onLine) return; 
        const res = await fetch(`/api/batches?expiring=90`); 
        if(res.ok){
          const json = await res.json() as BatchApiItem[] | { batches: BatchApiItem[] };
          const list: BatchApiItem[] = Array.isArray(json) ? json : json.batches || [];
          if(list.length>0){
            const uniqueMap = new Map<string, BatchApiItem>();
            for (const b of list) {
              const key = `${b.productId}_${b.batchNo}_${b.expiryDate.slice(0,10)}`;
              const prev = uniqueMap.get(key);
              if (!prev) uniqueMap.set(key, b);
              else uniqueMap.set(key, { ...prev, quantity: prev.quantity + b.quantity, _id: prev._id || b._id });
            }
            const deduped = Array.from(uniqueMap.values());
            setExpiryProducts(deduped.map((b)=>({
              _id: b._id || `${b.productId}_${b.batchNo}`, productId: b.productId, name: b.productName || b.batchNo, company: b.company,
              mainUnit: b.mainUnit as MainUnit || "box", pattaPerBox: 10, mlPerBottle: 120,
              buyPrice: b.buyPrice, buyPriceAvg: b.buyPrice, sellPrice: b.sellPrice || 0,
              stock: b.quantity, expiryDate: b.expiryDate, batchNo: b.batchNo
            })));
          } else {
            if(batches.length===0) setExpiryProducts([]);
          }
        }
      } catch { } }; void loadAllForExpiry();
  },[]);

  useEffect(()=>{
    const controller=new AbortController();
    const fetchData=async()=>{
      setLoadingSales(true);
      try{
        if(typeof window!=="undefined"&&!window.navigator.onLine){
          const offlineAll=await offlineDB.sales.reverse().toArray(); const mapped=offlineAll.map(o=>({_id:o.localId,productId:o.productId,productName:o.productName,mainUnit:o.mainUnit as MainUnit,sellUnit:o.sellUnit as SellUnit,quantity:o.quantity,sellPrice:o.sellPrice,deductionMain:o.deductionMain,total:o.total,profit:o.profit,createdAt:o.createdAt,customerName:o.customerName,status:o.status,paymentType:o.paymentType,batchNo:o.batchNo}));
          setSales(mapped); setTotal(rnd6(mapped.reduce((a,b)=>a+b.total,0))); setProfit(rnd6(mapped.reduce((a,b)=>a+b.profit,0))); setPagination({page:1,totalPages:1,hasMore:false,totalCount:mapped.length}); setLoadingSales(false); return;
        }
        const res=await fetch(`/api/sales?filter=${filter}&page=${page}&limit=15`,{signal:controller.signal}); const data=await res.json() as SalesApiResponse; if(page===1) setSales(data.sales); else setSales(prev=>[...prev,...data.sales]); setTotal(rnd6(data.total)); setProfit(rnd6(data.profit)); setPendingTotal(rnd6(data.pendingTotal??0)); setPagination(data.pagination);
      }catch(err){ if((err as Error).name!=="AbortError") console.error(err);} finally{ setLoadingSales(false); }
    }; void fetchData(); return()=>controller.abort();
  },[filter,page]);

  const sell = useCallback((p: Product) => {
    const saleableStock = getSaleableStock(p);
    if (saleableStock <= 0.0001 && p.stock > 0.0001) {
      alert(`⚠️ ${p.name} has only expired stock (Total ${p.stock}). Discard expired first.`);
      return;
    }
    if (paymentType === "credit" && (!customerName || customerName.toLowerCase() === "walk-in" || customerName.trim().length < 2)) {
      alert("Enter customer name for Udhar");
      return;
    }
    const calc = getSellCalc(p);
    const ppb = p.pattaPerBox && p.pattaPerBox>0 ? p.pattaPerBox : 10;
    const saleablePattaRaw = p.mainUnit === "box" ? saleableStock * ppb : saleableStock;
    let needPattaRaw = calc.qty;
    if (p.mainUnit === "box") {
      if (calc.sellUnit === "patta") needPattaRaw = calc.qty;
      else if (calc.sellUnit === "half_patta") needPattaRaw = calc.qty * 0.5;
      else if (calc.sellUnit === "box") needPattaRaw = calc.qty * ppb;
    }
    if (rnd6(saleablePattaRaw) + (calc.sellUnit==="half_patta"?0.03:0.001) < rnd6(needPattaRaw)) {
      alert(`Only ${saleablePattaRaw.toFixed(3)} patta (${saleableStock.toFixed(3)} box) left, need ${needPattaRaw.toFixed(1)} patta`);
      return;
    }
    const offlineUser = getOfflineUser();
    const finalCustomer = customerName.trim() || "Walk-in";
    const batchNo = getProductBatchNo(p);
    const batchObj = p.batches?.find((b) => b.batchNo === batchNo);
    const batchId = batchObj?._id || p._id;

    setProducts(prev => prev.map(prod => prod._id===p._id ? {...prod, stock: rnd6(prod.stock - calc.deductMain), batches: prod.batches?.map(b=> b.batchNo===batchNo ? {...b, quantity: rnd6(Math.max(0,b.quantity - calc.deductMain))} : b)} : prod));
    setExpiryProducts(prev => prev.map(prod => {
      if (prod.productId===p._id && prod.batchNo===batchNo) {
        return {...prod, stock: rnd6(prod.stock - calc.deductMain)};
      }
      return prod;
    }).filter(pr => pr.stock > 0.0001));

    const optimistic: Sale = {
      _id: generateLocalId(), productId: p._id, productName: p.name, mainUnit: p.mainUnit, sellUnit: calc.sellUnit, quantity: calc.qty, sellPrice: calc.sellPrice, deductionMain: calc.deductMain, total: calc.total, profit: calc.profit, createdAt: new Date().toISOString(), customerName: finalCustomer, status: paymentType==="credit"?"pending":"paid", paymentType, batchNo,
    };
    setSales(prev => [optimistic, ...prev]);
    setTotal(t => rnd6(t + calc.total));
    setProfit(pr => rnd6(pr + calc.profit));
    if (paymentType==="credit") setPendingTotal(pt => rnd6(pt + calc.total));

    const newItem: CartItem = { name: p.name, qty: calc.qty, unit: calc.sellUnit, price: calc.sellPrice, total: calc.total };
    setLastBill(prev => {
      const billNo = Date.now().toString().slice(-6);
      const timeStr = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });
      if (!prev || prev.customer !== finalCustomer) return { items: [newItem], total: newItem.total, customer: finalCustomer, time: timeStr, billNo };
      const items = [...prev.items, newItem];
      return { items, total: rnd6(items.reduce((a,b)=>a+b.total,0)), customer: finalCustomer, time: prev.time, billNo: prev.billNo };
    });

    void (async () => {
      try {
        if (typeof window !== "undefined" && window.navigator.onLine) {
          const res = await fetch("/api/sales", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              productId: p._id, quantity: calc.qty, sellUnit: calc.sellUnit, mainUnit: p.mainUnit, sellPrice: calc.sellPrice, pattaPerBox: ppb, mlPerBottle: p.mlPerBottle, deductionMain: calc.deductMain, batchId, batchNo, buyPriceMain: calc.buyPrice, total: calc.total, profit: calc.profit, localId: optimistic._id, customerName: finalCustomer, paymentType, customerPhone: "", customerVillage: "",
            }),
          });
          if (res.ok) {
            const saved = await res.json() as { _id: string };
            setSales(prev => prev.map(s => s._id===optimistic._id ? {...s, _id: saved._id} : s));
            try{
              const bList = await offlineDB.batches.where("productId").equals(p._id).toArray();
              const first = bList.sort((a,b)=>new Date(a.expiryDate).getTime()-new Date(b.expiryDate).getTime())[0];
              if(first) await offlineDB.batches.update(first.localId, { quantity: rnd6(Math.max(0, first.quantity - calc.deductMain)) });
              const sum = rnd6((await offlineDB.batches.where("productId").equals(p._id).toArray()).reduce((a,b)=>a+b.quantity,0));
              await offlineDB.products.where("_id").equals(p._id).or("localId").equals(p._id).modify(pr=>{ pr.stock = sum; });
            }catch{}
            try{
              const r = await fetch(`/api/sales?filter=${filter}&page=1&limit=1`);
              const d = await r.json() as SalesApiResponse;
              setPendingTotal(rnd6(d.pendingTotal??0));
            }catch{}
          } else {
            await saveSaleOffline({
              productId: p._id, productName: p.name, quantity: calc.qty, mainUnit: p.mainUnit, sellUnit: calc.sellUnit, pattaPerBox: ppb, mlPerBottle: p.mlPerBottle, buyPriceMain: calc.buyPrice, sellPrice: calc.sellPrice, userId: offlineUser?._id || "offline", customerName: finalCustomer, customerPhone: "", customerVillage: "", paymentType, batchId, batchNo, deductionMain: calc.deductMain,
            });
            setPendingCount(c=>c+1);
          }
        } else {
          await saveSaleOffline({
            productId: p._id, productName: p.name, quantity: calc.qty, mainUnit: p.mainUnit, sellUnit: calc.sellUnit, pattaPerBox: ppb, mlPerBottle: p.mlPerBottle, buyPriceMain: calc.buyPrice, sellPrice: calc.sellPrice, userId: offlineUser?._id || "offline", customerName: finalCustomer, customerPhone: "", customerVillage: "", paymentType, batchId, batchNo, deductionMain: calc.deductMain,
          });
          setPendingCount(c=>c+1);
        }
      } catch {}
    })();
  }, [getSellCalc, filter, customerName, paymentType]);

       

  const clearCart = () => { 
    setLastBill(null); 
    setShowPrint(false); 
    setCustomerName("Walk-in");
    setProductSearch("");
    setProductPage(1);
    searchRef.current?.focus();
  };
  const handleDirectPrint = useCallback(()=>{
    const content = document.getElementById('print-area')?.innerHTML;
    if(!content) return;
    const printHtml = `<html><head><title>Bill ${lastBill?.billNo}</title><style>@page{size:80mm auto;margin:0} body{margin:0;padding:6mm 4mm;font-family:Courier New,monospace;font-size:11px;color:#000;width:80mm;background:#fff} table{width:100%;border-collapse:collapse} *{box-sizing:border-box}</style></head><body>${content}</body></html>`;
    const iframe = document.createElement('iframe');
    iframe.style.position='fixed'; iframe.style.right='0'; iframe.style.bottom='0'; iframe.style.width='0'; iframe.style.height='0'; iframe.style.border='0';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow?.document;
    if(!doc) return;
    doc.open(); doc.write(printHtml); doc.close();
    setTimeout(()=>{ iframe.contentWindow?.focus(); iframe.contentWindow?.print(); setTimeout(()=>{ try{document.body.removeChild(iframe)}catch{} },1000); }, 500);
  },[lastBill]);
  
  const handleDialogPrint = useCallback(()=>{
    const content = document.getElementById('print-area')?.innerHTML;
    if(!content) return;
    const printHtml = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bill ${lastBill?.billNo}</title><style>@page{size:80mm auto;margin:0} body{margin:0;padding:6mm 4mm;font-family:Courier New,monospace;font-size:11px;color:#000;width:80mm;background:#fff} table{width:100%;border-collapse:collapse} *{box-sizing:border-box} @media screen{body{max-width:80mm;margin:0 auto}} .no-print{margin:10px auto; display:flex; gap:8px; justify-content:center} .no-print button{padding:10px 18px; border-radius:8px; border:1px solid #ccc; font-weight:bold}</style></head><body><div class="no-print"><button onclick="window.print()" style="background:#16a34a;color:#fff;border:0">🖨️ Print Now</button><button onclick="window.close()">Close</button></div>${content}</body></html>`;
    const w = window.open('', '_blank');
    if(!w){ alert("Please allow popups"); return; }
    w.document.open(); w.document.write(printHtml); w.document.close();
  },[lastBill]);


    // POS KEYBOARD SHORTCUTS - clean, no eslint warning
  useEffect(()=>{
    function onKey(e: KeyboardEvent){
      if(e.key==="F2" || (e.ctrlKey && e.key.toLowerCase()==="f") || e.key==="/"){
        const active = document.activeElement as HTMLElement;
        const isCustomerInput = active?.tagName==="INPUT" && (active as HTMLInputElement).placeholder?.includes("customer");
        if(isCustomerInput) return;
        e.preventDefault();
        searchRef.current?.focus();
      }
      //for printing last bill, ctrl+s
      if((e.ctrlKey && e.key.toLowerCase()==="s")){
        if(lastBill){
          e.preventDefault();
          setShowPrint(true);
          setTimeout(()=>{
            handleDirectPrint();
          }, 350);
        }
      }
            // Ctrl+N = New Bill without printing (customer no bill)
      if(e.ctrlKey && e.key.toLowerCase()==="n"){
        e.preventDefault();
        if(lastBill){
          setLastBill(null);
          setShowPrint(false);
          setCustomerName("Walk-in");
          setProductSearch("");
          searchRef.current?.focus();
        }
      }
      if(e.key==="Escape"){
        setProductSearch("");
        setProductPage(1);
        searchRef.current?.focus();
      }
      if(e.key==="Enter" && !e.ctrlKey && productSearch && products.length>0 && document.activeElement===searchRef.current){
        e.preventDefault();
        const first = products[0];
        if(first) sell(first);
      }
    }
    window.addEventListener("keydown", onKey);
    return ()=>{
      window.removeEventListener("keydown", onKey);
    };
  },[productSearch, products, sell, lastBill, handleDirectPrint]);

  const handleDeleteSale = async (id: string) => {
    if (deletingId) return;
    if (!confirm("Delete sale and restore stock?")) return;

    // 1. CHECK
    const saleToDelete = sales.find((s) => s._id === id);
    if (!saleToDelete) return;
    const restore = rnd6(saleToDelete.deductionMain ?? 0);
    setDeletingId(id);

    // 2. UPDATE SALES LIST
    setSales(prev => prev.filter(s => s._id !== id));
    setTotal(t => rnd6(Math.max(0, t - saleToDelete.total)));
    setProfit(pr => rnd6(Math.max(0, pr - saleToDelete.profit)));
    if (saleToDelete.status === "pending") {
      setPendingTotal(pt => rnd6(Math.max(0, pt - saleToDelete.total)));
    }

    // 3. UPDATE PRINT BILL (V63 POS top bar) - THIS WAS MISSING
    setLastBill(prev => {
      if (!prev) return null;
      let removed = false;
      const filtered = prev.items.filter(it => {
        if (!removed && it.name === saleToDelete.productName) {
          removed = true;
          return false;
        }
        return true;
      });
      if (filtered.length === 0) {
        setShowPrint(false);
        return null;
      }
      const newTotal = rnd6(filtered.reduce((a, b) => a + b.total, 0));
      return { ...prev, items: filtered, total: newTotal };
    });

    // 4. RESTORE STOCK - only matching batchNo
    setProducts(prev => prev.map(prod => {
      if (prod._id !== saleToDelete.productId) return prod;
      const updatedBatches = prod.batches?.map(b => {
        if (saleToDelete.batchNo) {
          if (b.batchNo === saleToDelete.batchNo) {
            return { ...b, quantity: rnd6(b.quantity + restore) };
          }
          return b;
        }
        // old sales without batchNo - restore to batch matching sale batchNo logic fallback
        return { ...b, quantity: rnd6(b.quantity + restore) };
      });
      return { ...prod, stock: rnd6(prod.stock + restore), batches: updatedBatches };
    }));

    try {
      if (id.startsWith("local_")) {
        const s = await offlineDB.sales.get(id) || await offlineDB.sales.where("localId").equals(id).first();
        if (!s) {
          setPendingCount(c => Math.max(0, c - 1));
          return;
        }
        if (s.batchId) {
          const b = await offlineDB.batches.where("localId").equals(s.batchId).first();
          if (b) {
            await offlineDB.batches.update(b.localId, { quantity: rnd6(b.quantity + restore) });
          }
        }
        await offlineDB.sales.where("localId").equals(s.localId).delete();
        const remainingBatches = await offlineDB.batches.where("productId").equals(saleToDelete.productId).toArray();
        const sum = rnd6(remainingBatches.reduce((a, b) => a + b.quantity, 0));
        await offlineDB.products.where("localId").equals(saleToDelete.productId).or("_id").equals(saleToDelete.productId).modify(p => {
          p.stock = sum;
        });
        setPendingCount(c => Math.max(0, c - 1));
      } else {
        const res = await fetch(`/api/sales/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error((await res.json() as { error: string }).error || "Delete failed");
        void refreshSalesOnly();
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes("_id") && msg !== "Already deleted") alert(msg);
    } finally {
      setDeletingId(null);
    }
  };

  const handleDiscard = async (n: Product) => {
    if (!confirm(`Discard ${n.name} Batch ${n.batchNo} Qty ${n.stock}?`)) return;
    try {
      const res = await fetch(`/api/discard-expired`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: n._id && n._id.length === 24 ? n._id : undefined, productId: n.productId, batchNo: n.batchNo, expiryDate: n.expiryDate }),
      });
      const data = await res.json() as { newStock?: number; error?: string };
      if (res.ok) {
        alert(`Discarded ${data.newStock !== undefined ? `New stock ${data.newStock}` : ""}`);
        setExpiryProducts(prev => prev.filter(p => !(p.batchNo === n.batchNo && p.expiryDate === n.expiryDate && p.productId === n.productId)));
        setProducts(prev => prev.map(prod => prod._id === n.productId ? { ...prod, stock: rnd6(data.newStock ?? Math.max(0, prod.stock - n.stock)) } : prod));
      } else alert(data.error || "Failed");
    } catch (err) { alert((err as Error).message); }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-30 bg-white border-b px-2 py-2 shadow-sm">
        <div className="max-w-7xl mx-auto flex flex-col gap-1.5">
          <div className="flex flex-wrap justify-between items-center gap-1">
            <div className="flex flex-wrap gap-2 items-center">
              <h1 className="text-[11px] font-bold">💊 V63 POS {isOffline?"📶 Offline":""}</h1>
              {lastBill && (
                <div className="flex gap-1">
                  <button onClick={()=>setShowPrint(true)} className="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-full text-[10px] font-bold animate-pulse shadow">🖨️ Print Bill ({lastBill.items.length} • Rs.{fmt(lastBill.total,0)})</button>
                  <button onClick={clearCart} className="bg-white border border-red-200 text-red-600 hover:bg-red-50 px-2.5 py-1.5 rounded-full text-[9px] font-bold">New Bill ✕</button>
                </div>
              )}
            </div>
            <div className="flex gap-1.5 items-center">
              <div className="relative">
                <button onClick={()=>setShowExpiry(!showExpiry)} className="relative p-1.5 bg-gray-100 rounded-full hover:bg-gray-200"><span className="text-[16px]">🔔</span>{expiryNotifications.length>0 && (<span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-bold animate-pulse">{expiryNotifications.length}</span>)}</button>
                {showExpiry && (<><div className="fixed inset-0 bg-black/20 z-40" onClick={()=>setShowExpiry(false)}></div><div className="fixed md:absolute left-2 right-2 md:left-auto md:right-0 top-20 md:top-9 w-auto md:w-80 bg-white border shadow-xl rounded-xl z-50 max-h-[70vh] md:max-h-80 overflow-hidden flex flex-col"><div className="p-2.5 border-b bg-red-50 flex justify-between items-center"><p className="text-[11px] font-bold">⚠️ Expiry Alerts (90 days)</p><button onClick={()=>setShowExpiry(false)} className="text-[11px] bg-white border px-2.5 py-1 rounded-full">✕</button></div><div className="overflow-y-auto flex-1">{expiryNotifications.length===0? (<p className="p-4 text-[11px] text-center text-green-600">✅ No expiry</p>) : expiryNotifications.map((n, idx)=>(
                  <div key={`${n._id}_${n.batchNo}_${n.expiryDate}_${idx}`} className={`p-2 border-b text-[10px] flex justify-between items-center ${n.status==="expired"?"bg-red-50 border-l-4 border-l-red-600":"bg-amber-50 border-l-4 border-l-amber-400"}`}>
                    <div className="flex-1 pr-2"><div className="font-bold truncate">{n.name} {n.batchNo? `• Batch ${n.batchNo}`:""}</div><p className="text-[9px] text-gray-500 mt-0.5">{n.company? `${n.company} • `:""}Qty {fmt(n.stock,1)} • Exp: {n.expiryDate?.slice(0,10)}</p></div>
                    <div className="flex flex-col gap-1 items-end"><span className={`px-1.5 py-0.5 rounded-full text-[8px] font-bold ${n.status==="expired"?"bg-red-600 text-white":"bg-amber-500 text-white"}`}>{n.status==="expired"?`EXPIRED ${Math.abs(n.daysLeft)}d`:`${n.daysLeft}d left`}</span>{n.status==="expired" && (<button onClick={()=>handleDiscard(n)} className="text-[9px] bg-red-600 text-white px-2 py-1 rounded-full font-bold hover:bg-red-700">Discard</button>)}</div>
                  </div>
                ))}</div></div></>)}
              </div>
              <div className="flex gap-1"><div className="bg-green-600 text-white px-2 py-1 rounded-full text-[9px] font-bold">{filter.toUpperCase()}: Rs.{fmt(total,0)}</div><div className="bg-blue-600 text-white px-2 py-1 rounded-full text-[9px] font-bold">+{fmt(profit,0)}</div>{pendingTotal>0&&<div className="bg-red-600 text-white px-2 py-1 rounded-full text-[9px] font-bold">Udhar {fmt(pendingTotal,0)}</div>}</div>
            </div>
          </div>
          {lastBill && lastBill.items.length>0 && (<div className="bg-green-50 border border-green-200 rounded-lg p-1.5 text-[10px] flex gap-1.5 overflow-x-auto scrollbar-hide"><span className="font-bold whitespace-nowrap">🛒 {lastBill.customer}: </span>{lastBill.items.map((it,i)=><span key={i} className="bg-white border shadow-sm px-2.5 py-1 rounded-full whitespace-nowrap text-[10px]">{it.name} {it.qty} {it.unit} = Rs.{it.total}</span>)}</div>)}
          <div className="flex gap-1"><input value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder="Walk-in customer name" className="flex-1 p-2 rounded-lg border text-[11px] h-9 bg-white focus:ring-2 focus:ring-green-200 outline-none"/><div className="flex bg-gray-100 rounded-lg p-0.5 h-9"><button onClick={()=>setPaymentType("cash")} className={`px-4 rounded-md text-[10px] font-bold transition ${paymentType==="cash"?"bg-green-600 text-white shadow":"text-gray-600"}`}>Cash</button><button onClick={()=>setPaymentType("credit")} className={`px-4 rounded-md text-[10px] font-bold transition ${paymentType==="credit"?"bg-red-600 text-white shadow":"text-gray-600"}`}>Udhar</button></div></div>
          {mounted&&(isOffline||pendingCount>0)&&<div className="text-[10px] p-1.5 rounded-lg flex justify-between bg-blue-50 border"><span>{isOffline?`Offline Mode - ${pendingCount} pending`:`${pendingCount} pending sync`}</span>{!isOffline&&<button onClick={()=>{ void syncPendingSales(); }} disabled={syncing} className="bg-blue-600 text-white px-2 py-0.5 rounded text-[10px]">{syncing?"Syncing...":"Sync Now"}</button>}</div>}
          {expiryNotifications.length>0 && (<div className={`border text-[10px] p-1.5 rounded-lg flex justify-between ${expiredCount>0?"bg-red-50 border-red-300 text-red-700":"bg-amber-50 border-amber-300 text-amber-800"}`}><span>⚠️ {expiredCount} Expired, {soonCount} Soon (90d)</span><button onClick={()=>setShowExpiry(true)} className="font-bold underline">View</button></div>)}
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-2">
        <div className="relative w-full mb-2">
          <input ref={searchRef} placeholder="🔍 Search medicine (Ctrl+F or /) - Enter to sell first" value={productSearch} onChange={e=>{setProductSearch(e.target.value); setProductPage(1);}} className="border p-2.5 pr-8 rounded-xl w-full bg-white text-[11px] h-10 focus:ring-2 focus:ring-green-200 outline-none shadow-sm"/>
          {productSearch && (
            <button onClick={()=>{setProductSearch(""); setProductPage(1); searchRef.current?.focus();}} className="absolute right-2 top-1/2 -translate-y-1/2 bg-gray-100 hover:bg-gray-200 border rounded-full w-6 h-6 flex items-center justify-center text-[12px] font-bold text-gray-600">✕</button>
          )}
        </div>
        <p className="text-[9px] text-gray-400 mb-2 px-1">Ctrl+F or / = Search | Enter = Sell first | Esc = Clear | Ctrl+S = Print | Ctrl+N = New Bill</p>
        {loadingProducts?(<div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">{[1,2,3,4,5,6].map(i=>(<div key={i} className="bg-white border rounded-xl p-2.5 animate-pulse"><div className="h-3 bg-gray-200 rounded w-3/4 mb-2"></div></div>))}</div>):(
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5 mb-3">
            {products.map(p=>{
              const calc=getSellCalc(p); const saleable=getSaleableStock(p); const out=saleable<=0.0001;
              const buyPrice = getProductBuyPrice(p);
              const totalBuyStock = rnd6(p.stock * buyPrice);
              const expiryStr = getProductExpiry(p);
              const expStatus = getExpiryStatus(expiryStr);
              const batchNoStr = getProductBatchNo(p);
              const borderClass = expStatus==="expired" && saleable<=0 ? "border-2 border-red-500 bg-red-50/60 ring-1 ring-red-200" : expStatus==="soon" ? "border-2 border-amber-400 bg-amber-50/60 ring-1 ring-amber-200" : "border";
              const ppbSafe = p.pattaPerBox && p.pattaPerBox>0 ? p.pattaPerBox : 10;
              const saleablePatta = p.mainUnit==="box" ? saleable*ppbSafe : saleable;
              return(
                <div key={p._id} className={`bg-white rounded-xl p-2.5 shadow-sm hover:shadow-md transition ${borderClass}`}>
                  <div className="flex justify-between gap-1"><p className="font-bold text-[11px] leading-tight truncate w-[60%]">{p.name} <span className="font-normal text-[8px] text-gray-400">{p.company}</span>{expStatus==="expired"&&saleable<=0&&<span className="ml-1 text-[8px] bg-red-600 text-white px-1.5 py-0.5 rounded animate-pulse">EXPIRED</span>}{expStatus==="soon"&&<span className="ml-1 text-[8px] bg-amber-500 text-white px-1.5 py-0.5 rounded">SOON</span>}</p><span className={`text-[8px] px-1.5 py-0.5 rounded-full h-fit whitespace-nowrap ${saleable<=0?"bg-red-600 text-white":"bg-gray-100"}`}>Saleable {p.mainUnit==="box"?`${fmt(saleablePatta,3)} patta`:fmt(saleable,3)} / {fmt(p.stock,3)} {p.mainUnit}</span></div>
                  <p className="text-[9px] text-gray-500 mt-0.5">
                    {(() => {
                      const sellPerBox = p.mainUnit === "box" ? p.sellPrice * ppbSafe : p.sellPrice;
                      return `TotBuy Rs.${fmt(totalBuyStock,0)} • Buy Rs.${fmt(buyPrice,1)} • Sell Rs.${fmt(sellPerBox,1)} ${p.rack?`• ${p.rack}`:""} ${expiryStr?`• ${expiryStr.slice(0,10)}`:""} ${batchNoStr?`• Batch ${batchNoStr}`:""} ppb:${ppbSafe}`;
                    })()}
                  </p>
                  <div className="flex bg-gray-100 rounded-full p-0.5 mt-2 w-fit gap-0.5">
                    {sellOptions(p.mainUnit).map(u=>(
                      <button key={u} onClick={()=>{ const def=getDefaultPrice(p,u as SellUnit); setSellUnitMap({...sellUnitMap,[p._id]:u as SellUnit}); setPriceMap({...priceMap,[p._id]:fmt(def,2)});}} className={`px-2.5 py-1 rounded-full text-[9px] ${calc.sellUnit===u?"bg-green-600 text-white font-bold shadow":"text-gray-600"}`}>{u}</button>
                    ))}
                  </div>
                  <div className="flex gap-1 mt-2"><input type="text" inputMode="decimal" value={priceMap[p._id]??fmt(calc.defaultPrice,2)} onFocus={e=>e.target.select()} onChange={e=>{ const v=e.target.value; if(v===""||/^[0-9]*\.?[0-9]*$/.test(v)) setPriceMap({...priceMap,[p._id]:v});}} className="flex-1 border rounded-lg px-2.5 py-1.5 text-[11px] h-9 bg-blue-50/50" placeholder={`Price ${calc.sellUnit}`}/><div className="text-[10px] bg-gray-50 border rounded-lg px-2.5 flex items-center h-9 font-bold">{calc.qty} {calc.sellUnit}</div></div>
                  <div className="bg-gray-50 border rounded-lg px-2.5 py-1.5 mt-1.5 flex justify-between text-[10px]"><span>{fmt(calc.qty,1)} {calc.sellUnit} = -{fmt(calc.deductMain,3)} {p.mainUnit}</span><span className="font-bold text-green-700">Rs.{fmt(calc.total,0)} +{fmt(calc.profit,0)}</span></div>
                  <div className="flex gap-1.5 mt-2"><div className="flex border rounded-lg overflow-hidden h-9"><button onClick={()=>setQtyMap({...qtyMap,[p._id]:Math.max(1,(qtyMap[p._id]||1)-1)})} className="px-3 bg-gray-50 text-[14px] hover:bg-gray-100">-</button><div className="w-10 flex items-center justify-center border-x text-[11px] font-bold">{fmt(qtyMap[p._id]||1,0)}</div><button onClick={()=>setQtyMap({...qtyMap,[p._id]:(qtyMap[p._id]||1)+1})} className="px-3 bg-gray-50 text-[14px] hover:bg-gray-100">+</button></div><button onClick={()=>sell(p)} disabled={out} className={`flex-1 rounded-lg text-[11px] h-9 font-bold shadow-sm transition ${out?"bg-gray-200 text-gray-500":expStatus==="expired"&&saleable<=0?"bg-red-600 text-white":"bg-green-600 hover:bg-green-700 text-white active:scale-95"}`}>{out?`Out of Stock`:paymentType==="credit"?`Udhar Rs.${fmt(calc.total,0)}`:`Sell Rs.${fmt(calc.total,0)}`}</button></div>
                </div>
              );
            })}
          </div>
        )}
        {productPagination.hasMore&&<button onClick={()=>setProductPage(pr=>pr+1)} disabled={loadingMoreProducts} className="w-full mb-3 py-2.5 bg-white border-2 border-green-600 text-green-700 rounded-xl text-[11px] h-10 font-bold hover:bg-green-50">{loadingMoreProducts?"Loading...":`Load More (${productPagination.totalCount - products.length} left)`}</button>}
        <div className="flex gap-1 mb-2 overflow-x-auto pb-1 scrollbar-hide">{FILTERS.map(f=><button key={f} onClick={()=>{setFilter(f); setPage(1);}} className={`px-3.5 py-1.5 rounded-full text-[10px] capitalize whitespace-nowrap font-bold transition ${filter===f?"bg-green-600 text-white shadow":"bg-white border hover:bg-gray-50"}`}>{f}</button>)}</div>
        <div className="bg-white rounded-xl border overflow-hidden relative shadow-sm">
          {deletingId && <div className="absolute inset-0 bg-white/70 z-10 flex items-center justify-center"><p className="bg-red-600 text-white px-4 py-2 rounded-full text-[12px] animate-pulse">⏳ Deleting...</p></div>}
          {loadingSales?<div className="p-4 text-[11px] text-center">Loading sales...</div>:sales.length===0?<p className="p-6 text-center text-gray-400 text-[11px]">No sales {filter}</p>:sales.map(s=>(
            <div key={s._id} className={`p-2.5 border-b flex justify-between hover:bg-gray-50 ${s._id.startsWith("local_")?"bg-amber-50/50":""} ${s.status==="pending"?"bg-red-50/30":""} ${deletingId===s._id?"opacity-40":""}`}>
              <div><p className="font-bold text-[11px]">{s.productName} {fmt(s.quantity,1)} {s.sellUnit} @ Rs.{fmt(s.sellPrice,1)} <span className="text-[9px] text-gray-500">(-{fmt(s.deductionMain,3)} {s.mainUnit})</span>{s.batchNo? <span className="text-[8px] bg-amber-100 px-1 rounded ml-1">{s.batchNo}</span>:""}</p><p className="text-[9px] text-gray-400 mt-0.5">{new Date(s.createdAt).toLocaleTimeString()} {s.customerName&&s.customerName!=="Walk-in"?`👤${s.customerName}`:""}</p></div>
              <div className="text-right"><div className="font-bold text-[11px]">Rs.{fmt(s.total,0)}</div><div className="text-[9px] text-green-600">+{fmt(s.profit,0)}</div><button onClick={()=>handleDeleteSale(s._id)} disabled={!!deletingId} className={`text-[9px] px-2.5 py-1 rounded-full mt-1 font-bold ${deletingId===s._id?"bg-gray-300 text-gray-500":"bg-red-50 text-red-600 hover:bg-red-100"}`}>{deletingId===s._id?"Deleting...":"Del"}</button></div>
            </div>
          ))}
          {pagination.hasMore&&<div className="p-1.5 bg-gray-50"><button onClick={()=>setPage(p=>p+1)} disabled={!!deletingId} className="w-full py-2.5 bg-white border rounded-lg text-[11px] font-bold hover:bg-gray-50">Load More Sales</button></div>}
        </div>
      </div>
      {showPrint && lastBill && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-60 flex items-center justify-center p-2 md:p-3">
          <div className="bg-white w-full max-w-95 md:w-90 rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="p-4 md:p-5 text-[11px] overflow-y-auto flex-1" id="print-area">
              <div className="text-center border-b-2 border-dashed border-black pb-3 mb-3"><h1 className="font-bold text-[18px] tracking-tight">💊 Yasir Medical Store</h1><p className="text-[10px] mt-1 text-gray-700">Main Bazar Ismaila - Swabi</p></div>
              <div className="text-[10px] mb-3 space-y-1 bg-gray-50 p-2 rounded-lg"><div className="flex justify-between"><span className="text-gray-600">Date:</span><span className="font-mono font-bold">{lastBill.time}</span></div><div className="flex justify-between"><span className="text-gray-600">Customer:</span><span className="font-bold">{lastBill.customer}</span></div><div className="flex justify-between"><span className="text-gray-600">Bill #:</span><span className="font-mono">{lastBill.billNo}</span></div></div>
              <table className="w-full text-[11px]"><thead><tr className="text-left text-[9px] text-gray-500 border-b border-dashed border-black"><th className="py-1.5">#</th><th>Item</th><th className="text-right">Amt</th></tr></thead><tbody>{lastBill.items.map((it,i)=>(<tr key={i} className="border-b border-dotted border-gray-200"><td className="py-2 align-top">{i+1}</td><td className="py-2"><div className="font-bold leading-tight">{it.name}</div><div className="text-[9px] text-gray-500">{it.qty} {it.unit} × Rs.{it.price}</div></td><td className="py-2 text-right font-bold align-top">Rs.{it.total}</td></tr>))}</tbody></table>
              <div className="mt-3 space-y-1.5 text-[11px] bg-gray-50 p-2.5 rounded-lg"><div className="flex justify-between font-bold text-[16px] border-t-2 border-dashed border-black pt-2"><span>TOTAL:</span><span>Rs.{fmt(lastBill.total,0)}</span></div></div>
            </div>
            <div className="grid grid-cols-2 gap-2 p-3 bg-gray-50 border-t">
              <button onClick={handleDirectPrint} className="bg-green-600 hover:bg-green-700 text-white py-3 rounded-xl font-bold text-[12px] shadow">🖨️ Direct Print</button>
              <button onClick={handleDialogPrint} className="bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-bold text-[12px] shadow">📄 Dialog</button>
              <button onClick={()=>clearCart()} className="bg-black hover:bg-gray-800 text-white py-2.5 rounded-xl font-bold text-[11px]">New Bill</button>
              <button onClick={()=>setShowPrint(false)} className="bg-white border hover:bg-gray-100 py-2.5 rounded-xl font-bold text-[11px]">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}