"use client";
import { useEffect, useState, useCallback, useSyncExternalStore, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { offlineDB } from "@/lib/offline-db";

type Product = {
  _id: string; name: string; company?: string; price: number; buyPrice: number; sellPrice: number;
  stock: number; stockInPatta?: string; unit: string; tabletsPerPatta?: number; pattaPerBox?: number; localId?: string; synced?: number
};
type Sale = {
  productName: string; quantity: number; quantityInTablets?: number; totalTablets?: number; unit?: string;
  total: number; profit: number; createdAt: string; localId?: string; synced?: number; customerName?: string; status?: string;
};
type PurchaseLite = { totalBuyAmount: number; createdAt: string; };
type ReportItem = { count: number; total: number; profit: number; buy: number };
type PurchaseItem = { total: number; count: number };
type Reports = {
  today: ReportItem; month: ReportItem; year: ReportItem; all: ReportItem;
  todayPurchase: PurchaseItem; monthPurchase: PurchaseItem; yearPurchase: PurchaseItem; allPurchase: PurchaseItem;
  khata: { totalUdhar: number; customers: number; paid: number; totalWusool: number }
};
type ProductsResponse = Product[] | { products: Product[] };
type CustomerLite = { totalUdhar: number; isPaid?: boolean; paidAmount?: number };
type TopItem = { _id: string; totalQty: number; totalSale: number; totalProfit: number; count: number };
type TopFilter = "today" | "monthly" | "yearly" | "all";
type TopResponse = { top: TopItem[] };

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
function getPKTBounds() {
  const now = new Date(); const nowPKT = new Date(now.getTime() + PKT_OFFSET_MS);
  const y = nowPKT.getUTCFullYear(); const m = nowPKT.getUTCMonth(); const d = nowPKT.getUTCDate();
  const pktTodayUTC = Date.UTC(y, m, d, 0, 0, 0, 0) - PKT_OFFSET_MS;
  const pktTomorrowUTC = Date.UTC(y, m, d + 1, 0, 0, 0, 0) - PKT_OFFSET_MS;
  return { pktTodayUTC, pktTomorrowUTC };
}
function fmt1(n: unknown): string { const v = Number(n); if (!Number.isFinite(v)) return "0"; return v % 1 === 0? v.toFixed(0) : v.toFixed(1); }
function fmtMoney(n: unknown): string { const v = Number(n); if (!Number.isFinite(v)) return "0"; return v % 1 === 0? v.toFixed(0) : v.toFixed(1); }
function fixProduct(p: Product): Product {
  const sell = p.sellPrice || p.price || 0; const buy = p.buyPrice && p.buyPrice > 0? p.buyPrice : Math.round(sell * 0.8);
  return {...p, buyPrice: buy, sellPrice: sell || buy, price: sell || buy, tabletsPerPatta: p.tabletsPerPatta || 10, pattaPerBox: p.pattaPerBox || 10, };
}
function emptyReport(): ReportItem { return { count: 0, total: 0, profit: 0, buy: 0 }; }
function emptyPurchase(): PurchaseItem { return { total: 0, count: 0 }; }
function safeReport(r: unknown): ReportItem {
  if (!r || typeof r!== "object") return emptyReport(); const o = r as Partial<ReportItem>;
  const total = typeof o.total === "number"? o.total : 0; const profit = typeof o.profit === "number"? o.profit : 0; const buy = typeof o.buy === "number"? o.buy : total - profit;
  return { count: typeof o.count === "number"? o.count : 0, total, profit, buy: buy < 0? 0 : buy };
}
function safePurchase(r: unknown): PurchaseItem {
  if (!r || typeof r!== "object") return emptyPurchase(); const o = r as Partial<PurchaseItem>;
  return { total: typeof o.total === "number"? o.total : 0, count: typeof o.count === "number"? o.count : 0 };
}
function safeNum(n: unknown, fb = 0): number { const v = Number(n); return Number.isFinite(v)? v : fb; }
function useIsOnline(): boolean {
  const subscribe = useCallback((cb: () => void) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; }, []);
  const getSnapshot = useCallback(() => window.navigator.onLine, []); const getServerSnapshot = useCallback(() => true, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
function BarChart({ reports }: { reports: Reports }) {
  const data = [ { label: "Today", sale: reports.today.total, purchase: reports.todayPurchase.total }, { label: "Month", sale: reports.month.total, purchase: reports.monthPurchase.total }, { label: "Year", sale: reports.year.total, purchase: reports.yearPurchase.total }, ];
  const max = Math.max(1,...data.flatMap(d => [d.sale, d.purchase]));
  return (
    <div className="bg-white p-4 rounded-xl border mb-5">
      <div className="flex justify-between items-center mb-3"><h3 className="font-bold text-[13px]">📊 Sales vs Purchase Chart</h3><div className="flex gap-2 text-[9px]"><span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-600 rounded-full inline-block"></span> Sale</span><span className="flex items-center gap-1"><span className="w-2 h-2 bg-blue-500 rounded-full inline-block"></span> Purchase</span></div></div>
      <div className="flex items-end justify-around h-32 gap-2">
        {data.map(d => {
          const saleH = Math.max(6, Math.round((d.sale / max) * 90)); const purH = Math.max(6, Math.round((d.purchase / max) * 90));
          return (
            <div key={d.label} className="flex-1 flex flex-col items-center gap-1">
              <div className="flex gap-1 items-end h-24"><div className="w-7 sm:w-10 rounded-t-lg bg-green-600 flex items-end justify-center" style={{ height: `${saleH}%` }}><span className="text-[8px] text-white font-bold mb-1">{d.sale>0? fmtMoney(d.sale):""}</span></div><div className="w-7 sm:w-10 rounded-t-lg bg-blue-500 flex items-end justify-center" style={{ height: `${purH}%` }}><span className="text-[8px] text-white font-bold mb-1">{d.purchase>0? fmtMoney(d.purchase):""}</span></div></div>
              <p className="text-[11px] font-bold">{d.label}</p><p className="text-[9px] text-gray-400">S:{fmtMoney(d.sale)} P:{fmtMoney(d.purchase)}</p>
            </div>
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[10px]">
        <div className="bg-green-50 p-2 rounded-lg text-center"><p className="text-gray-400">Month Net</p><p className={`font-bold ${reports.month.total-reports.monthPurchase.total>=0?"text-green-700":"text-red-600"}`}>Rs.{fmtMoney(reports.month.total-reports.monthPurchase.total)}</p></div>
        <div className="bg-blue-50 p-2 rounded-lg text-center"><p className="text-gray-400">Year Net</p><p className={`font-bold ${reports.year.total-reports.yearPurchase.total>=0?"text-green-700":"text-red-600"}`}>Rs.{fmtMoney(reports.year.total-reports.yearPurchase.total)}</p></div>
        <div className="bg-gray-50 p-2 rounded-lg text-center"><p className="text-gray-400">Profit % Month</p><p className="font-bold text-blue-700">{reports.month.total>0? Math.round((reports.month.profit/reports.month.total)*100):0}%</p></div>
      </div>
    </div>
  );
}
function TopSellingCard({ top, filter, setFilter }: { top: TopItem[]; filter: TopFilter; setFilter: (f: TopFilter) => void }) {
  return (
    <div className="bg-white p-4 rounded-xl border mb-5">
      <div className="flex justify-between items-center mb-3"><h3 className="font-bold text-[13px]">🔥 High Sell Products — {filter}</h3><Link href="/dashboard/sales/top" className="text-[10px] bg-blue-50 text-blue-600 px-2.5 py-1 rounded-full font-bold hover:bg-blue-100">View All →</Link></div>
      <div className="flex gap-1 mb-3">{(["today","monthly","yearly","all"] as const).map((f) => (<button key={f} onClick={() => setFilter(f)} className={`px-2.5 py-1 rounded-full text-[10px] capitalize ${filter===f? "bg-green-600 text-white" : "bg-gray-100 text-gray-600"}`}>{f}</button>))}</div>
      {top.length===0? <p className="text-[11px] text-gray-400 py-4 text-center">No sales {filter}</p> : (
        <div className="space-y-2">{top.slice(0,6).map((p,i)=>(<div key={p._id} className="flex justify-between items-center bg-gray-50 border rounded-lg p-2.5"><div className="flex items-center gap-2"><span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${i===0?"bg-yellow-400":i===1?"bg-gray-300":i===2?"bg-orange-300":"bg-white border"}`}>{i+1}</span><div><p className="font-bold text-[11px] truncate max-w-35">{p._id}</p><p className="text-[9px] text-gray-500">{p.count} bills • {fmt1(p.totalQty)} qty</p></div></div><div className="text-right"><p className="font-bold text-[11px] text-green-700">Rs.{fmtMoney(p.totalSale)}</p><p className="text-[9px] text-gray-500">+Rs.{fmtMoney(p.totalProfit)}</p></div></div>))}</div>
      )}
    </div>
  );
}
type OfflineTable = { toArray: () => Promise<unknown[]>; bulkPut: (items: unknown[]) => Promise<void>; };
type BackupDB = { products: OfflineTable; sales: OfflineTable; batches: OfflineTable; purchases: OfflineTable; customers: OfflineTable; syncQueue: OfflineTable; };
function getDB(): BackupDB { return offlineDB as unknown as BackupDB; }
type SavePicker = { showSaveFilePicker: (opts: { suggestedName: string; types: {description:string; accept: Record<string,string[]>}[] }) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }> };

export default function MainDashboard() {
  const isOnline = useIsOnline(); const isOffline =!isOnline;
  const [products, setProducts] = useState<Product[]>([]); const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [reports, setReports] = useState<Reports>({ today: emptyReport(), month: emptyReport(), year: emptyReport(), all: emptyReport(), todayPurchase: emptyPurchase(), monthPurchase: emptyPurchase(), yearPurchase: emptyPurchase(), allPurchase: emptyPurchase(), khata: { totalUdhar: 0, customers: 0, paid: 0, totalWusool: 0 } });
  const [loading, setLoading] = useState(true); const [pendingCount, setPendingCount] = useState(0);
  const [totalUdhar, setTotalUdhar] = useState(0); const [udharCustomers, setUdharCustomers] = useState(0); const [paidCount, setPaidCount] = useState(0); const [yearLoss, setYearLoss] = useState(0);
  const [topFilter, setTopFilter] = useState<TopFilter>("monthly"); const [topProducts, setTopProducts] = useState<TopItem[]>([]);
  const [backingUp, setBackingUp] = useState(false); const [lastBackup, setLastBackup] = useState<string | null>(null); const [autoBackupOn, setAutoBackupOn] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{ const saved = localStorage.getItem("yasir_last_backup"); if(saved) setLastBackup(saved); const auto = localStorage.getItem("yasir_auto_backup"); if(auto!==null) setAutoBackupOn(auto==="true"); },[]);

  const doFullBackup = useCallback(async (isAuto=false) => {
    if(backingUp) return; setBackingUp(true);
    try{
      const db = getDB();
      const isOnlineNow = typeof window !== "undefined" && window.navigator.onLine;
      const [offlineProds, offlineBatches, offlineSales, offlinePurchases, offlineCustomers] = await Promise.all([
        db.products.toArray().catch(()=>[] as unknown[]),
        db.batches?.toArray().catch(()=>[] as unknown[]) ?? [],
        db.sales.toArray().catch(()=>[] as unknown[]) ?? [],
        db.purchases?.toArray().catch(()=>[] as unknown[]) ?? [],
        db.customers?.toArray().catch(()=>[] as unknown[]) ?? [],
      ]);
      let cloudProducts: unknown[] = []; let cloudSales: unknown[] = []; let cloudPurchases: unknown[] = []; let cloudCustomers: unknown[] = [];
      if(isOnlineNow){
        try{
          const pRes = await fetch("/api/products?limit=1000").then(r=>r.json()).catch(()=>[]);
          cloudProducts = Array.isArray(pRes) ? pRes : (pRes as {products?: unknown[]}).products || [];
          let allSales: unknown[] = []; let sPage=1;
          while(true){
            const sJson = await fetch(`/api/sales?filter=all&limit=100&page=${sPage}`).then(r=>r.json()).catch(()=>null);
            const list = (sJson as {sales?: unknown[]})?.sales || [];
            if(list.length===0) break;
            allSales = [...allSales, ...list];
            if(list.length < 100) break;
            sPage++; if(sPage>10) break;
          }
          cloudSales = allSales;
          let allPur: unknown[] = []; let purPage=1;
          while(true){
            const purJson = await fetch(`/api/purchases?limit=500&page=${purPage}`).then(r=>r.json()).catch(()=>null);
            const list = (purJson as {purchases?: unknown[]})?.purchases || [];
            if(list.length===0) break;
            allPur = [...allPur, ...list];
            const hasMore = (purJson as {pagination?: {hasMore?: boolean}})?.pagination?.hasMore;
            if(!hasMore) break;
            purPage++; if(purPage>20) break;
          }
          cloudPurchases = allPur;
          const cJson = await fetch("/api/customers?search=").then(r=>r.json()).catch(()=>({customers:[]}));
          cloudCustomers = (cJson as {customers?: unknown[]}).customers || [];
        }catch{ /* offline only */ }
      }
      const finalProducts = cloudProducts.length > 0 ? cloudProducts : offlineProds;
      const finalSales = cloudSales.length > 0 ? cloudSales : offlineSales;
      const finalPurchases = cloudPurchases.length > 0 ? cloudPurchases : offlinePurchases;
      const finalCustomers = cloudCustomers.length > 0 ? cloudCustomers : offlineCustomers;
      const backup = {
        version: "V25-USB", date: new Date().toISOString(), shop: "Yasir Medical Store - Ismaila", isOnline: isOnlineNow,
        totals: { products: finalProducts.length, sales: finalSales.length, purchases: finalPurchases.length, customers: finalCustomers.length, batches: offlineBatches.length, udhar: totalUdhar },
        data: { products: finalProducts, batches: offlineBatches, sales: finalSales, purchases: finalPurchases, customers: finalCustomers, offlinePending: offlineSales }
      };
      const jsonStr = JSON.stringify(backup, null, 2);
      const blob = new Blob([jsonStr], {type:"application/json"});
      const fileName = `Yasir-Medical-FULL-BACKUP-${new Date().toISOString().slice(0,10)}-${finalProducts.length}Meds-${finalSales.length}Sales-${finalPurchases.length}Pur.json`;

      let savedToUSB = false;
      if(!isAuto && typeof window !== "undefined" && "showSaveFilePicker" in window){
        try{
          const picker = window as unknown as SavePicker;
          const handle = await picker.showSaveFilePicker({
            suggestedName: fileName,
            types: [{ description: "JSON Backup", accept: { "application/json": [".json"] } }]
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          savedToUSB = true;
        }catch(err){
          if((err as Error).name === "AbortError") { setBackingUp(false); return; }
        }
      }
      if(!savedToUSB){
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = fileName;
        if(!isAuto || !localStorage.getItem(`auto_backup_done_${new Date().toISOString().slice(0,10)}`)){
          a.click();
          if(isAuto) localStorage.setItem(`auto_backup_done_${new Date().toISOString().slice(0,10)}`, "1");
        }
        URL.revokeObjectURL(url);
      }
      const nowStr = new Date().toLocaleString("en-PK",{timeZone:"Asia/Karachi"});
      localStorage.setItem("yasir_last_backup", nowStr); setLastBackup(nowStr);
      if(!isAuto) alert(`✅ Full Backup V25 Saved!\nFile: ${fileName}\n${savedToUSB? "Location: USB (you selected)" : "Location: Downloads"}\nProducts: ${finalProducts.length} | Sales: ${finalSales.length} | Purchases: ${finalPurchases.length}`);
    }catch(e){ alert("Backup failed: "+(e as Error).message); } finally{ setBackingUp(false); }
  },[backingUp, totalUdhar]);

  useEffect(()=>{
    if(!autoBackupOn) return;
    const check = () => {
      const now = new Date(); const hour = now.getHours(); const todayKey = now.toISOString().slice(0,10);
      const lastAutoKey = localStorage.getItem("yasir_last_auto_date");
      if(hour>=23 && lastAutoKey!==todayKey){ localStorage.setItem("yasir_last_auto_date", todayKey); void doFullBackup(true); }
    };
    const interval = setInterval(check, 5*60*1000); check(); return ()=>clearInterval(interval);
  },[autoBackupOn, doFullBackup]);

  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!confirm(`Restore backup from ${file.name}? Will restore OFFLINE + CLOUD. Are you sure?`)) return;

  try {
    const text = await file.text();
    const json = JSON.parse(text) as { data?: { products?: unknown[]; batches?: unknown[]; sales?: unknown[]; purchases?: unknown[]; customers?: unknown[] } };
    const d = (json.data ?? json) as {
      products?: Record<string, unknown>[];
      batches?: Record<string, unknown>[];
      sales?: Record<string, unknown>[];
      purchases?: Record<string, unknown>[];
      customers?: Record<string, unknown>[];
    };

    const fix = (list: Record<string, unknown>[] | undefined) => {
      if (!list) return [];
      return list.map((item) => {
        const fallback = `restored_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const id = (item._id as string) || (item.localId as string) || fallback;
        return {
          ...item,
          _id: (item._id as string) || id,
          localId: (item.localId as string) || (item._id as string) || id,
          synced: 1,
        };
      });
    };

    const db = getDB();
    const prods = fix(d.products);
    const bats = fix(d.batches);
    const sales = fix(d.sales);
    const purs = fix(d.purchases);
    const custs = fix(d.customers);

    // OFFLINE - clear + bulkPut
    try { await offlineDB.products.clear(); } catch {}
    try { await offlineDB.batches.clear(); } catch {}
    try { await offlineDB.sales.clear(); } catch {}
    try { await offlineDB.purchases.clear(); } catch {}
    try { await offlineDB.customers.clear(); } catch {}

    if (prods.length) await db.products.bulkPut(prods);
    if (bats.length) await db.batches.bulkPut(bats);
    if (sales.length) await db.sales.bulkPut(sales);
    if (purs.length) await db.purchases.bulkPut(purs);
    if (custs.length) await db.customers.bulkPut(custs);

    // CLOUD RESTORE - one call to /api/restore (no double deduction)
    if (window.navigator.onLine) {
      try {
        const res = await fetch("/api/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            products: d.products,
            batches: d.batches,
            sales: d.sales,
            purchases: d.purchases,
            customers: d.customers,
          }),
        });
        const result = await res.json();
        if (result.success) {
          alert(
            `✅ Restored OFFLINE + CLOUD!\n\nOffline: ${prods.length} prods, ${sales.length} sales, ${purs.length} purchases\n\nCloud: ${result.restored.products} prods, ${result.restored.sales} sales, ${result.restored.purchases} purchases, ${result.restored.batches} batches\nSkipped: ${JSON.stringify(result.skipped)}`
          );
        } else {
          alert(`✅ Offline Restored, Cloud Failed: ${result.error}\nCheck /api/restore route deployed?`);
        }
      } catch (err) {
        alert(`✅ Offline Restored, Cloud error: ${(err as Error).message}\nYour data is safe offline, will sync when API ready.`);
      }
    } else {
      alert(`✅ Offline Restored!\n${prods.length} products, ${sales.length} sales, ${purs.length} purchases\nConnect internet to restore cloud.`);
    }

    location.reload();
  } catch (err) {
    alert("Restore failed: " + (err as Error).message);
  } finally {
    if (fileInputRef.current) fileInputRef.current.value = "";
  }
};

  useEffect(() => {
    const controller = new AbortController();
    const fetchStats = async () => {
      try {
        const db = getDB();
        const cachedProducts = await db.products.toArray() as unknown as Product[];
        const salesTable = db.sales as unknown as { where: (f:string)=> { equals:(v:number)=> { reverse:()=> { toArray:()=> Promise<Sale[]> } } } };
        const cachedSales = await salesTable.where("synced").equals(0).reverse().toArray() as Sale[];
        const cachedPurchases = await (db.purchases?.toArray() as Promise<PurchaseLite[]>)?.catch(()=>[] as PurchaseLite[]) ?? [];
        const cachedCustomers = await (db.customers?.toArray() as Promise<CustomerLite[]>)?.catch(()=>[] as CustomerLite[]) ?? [];
        setPendingCount(cachedSales.length + cachedProducts.filter(p => p.synced === 0).length);
        const isNowOffline = typeof window!== "undefined" &&!window.navigator.onLine;
        if (isNowOffline) {
          setProducts(cachedProducts.map(c => fixProduct(c))); setRecentSales(cachedSales.slice(0,5));
          const { pktTodayUTC, pktTomorrowUTC } = getPKTBounds();
          const todaySales = cachedSales.filter(s => { const t = new Date(s.createdAt).getTime(); return t >= pktTodayUTC && t < pktTomorrowUTC; });
          const todayPurchases = cachedPurchases.filter(p => { const t = new Date(p.createdAt).getTime(); return t >= pktTodayUTC && t < pktTomorrowUTC; });
          const toReport = (arr: Sale[]): ReportItem => { const total = arr.reduce((a,b)=>a+b.total,0); const profit = arr.reduce((a,b)=>a+(b.profit||0),0); return { count: arr.length, total, profit, buy: total - profit }; };
          setReports({ today: toReport(todaySales), month: toReport(cachedSales), year: toReport(cachedSales), all: toReport(cachedSales), todayPurchase: { total: todayPurchases.reduce((a,b)=>a+(b.totalBuyAmount||0),0), count: todayPurchases.length }, monthPurchase: { total: cachedPurchases.reduce((a,b)=>a+(b.totalBuyAmount||0),0), count: cachedPurchases.length }, yearPurchase: { total: cachedPurchases.reduce((a,b)=>a+(b.totalBuyAmount||0),0), count: cachedPurchases.length }, allPurchase: { total: cachedPurchases.reduce((a,b)=>a+(b.totalBuyAmount||0),0), count: cachedPurchases.length }, khata: { totalUdhar: 0, customers: 0, paid: 0, totalWusool: 0 } });
          setTotalUdhar(cachedCustomers.filter(c=>!c.isPaid).reduce((a,b)=>a+b.totalUdhar,0)); setUdharCustomers(cachedCustomers.filter(c=>!c.isPaid).length); setPaidCount(cachedCustomers.filter(c=>c.isPaid).length); setYearLoss(cachedSales.filter(s=> (s.profit||0) < 0).reduce((a,b)=> a + Math.abs(b.profit||0),0));
          const map = new Map<string, TopItem>(); cachedSales.forEach(s=>{ const ex = map.get(s.productName); if(ex){ ex.totalQty+=s.quantity; ex.totalSale+=s.total; ex.totalProfit+=s.profit; ex.count+=1; } else { map.set(s.productName, { _id: s.productName, totalQty: s.quantity, totalSale: s.total, totalProfit: s.profit, count: 1 }); } }); setTopProducts(Array.from(map.values()).sort((a,b)=>b.totalQty-a.totalQty).slice(0,6)); setLoading(false); return;
        }
        const [prodRes, salesRes, reportRes, khataRes, yearSalesRes, topRes] = await Promise.all([ fetch("/api/products?limit=100", { signal: controller.signal }), fetch("/api/sales?filter=today&limit=5", { signal: controller.signal }), fetch("/api/reports", { signal: controller.signal }), fetch("/api/customers?search=", { signal: controller.signal }), fetch("/api/sales?filter=yearly&limit=500", { signal: controller.signal }), fetch(`/api/sales/top?filter=${topFilter}`, { signal: controller.signal }), ]);
        const prodData = (await prodRes.json()) as ProductsResponse; const prodList = (Array.isArray(prodData)? prodData : prodData.products || []).map(fixProduct); setProducts(prodList);
        try { const salesData = (await salesRes.json()) as { sales: Sale[] }; setRecentSales((salesData.sales || []).slice(0,5)); } catch { setRecentSales([]); }
        let reportData: Reports | null = null; try { reportData = (await reportRes.json()) as Reports; } catch {}
        setReports({ today: safeReport(reportData?.today), month: safeReport(reportData?.month), year: safeReport(reportData?.year), all: safeReport(reportData?.all), todayPurchase: safePurchase(reportData?.todayPurchase), monthPurchase: safePurchase(reportData?.monthPurchase), yearPurchase: safePurchase(reportData?.yearPurchase), allPurchase: safePurchase(reportData?.allPurchase), khata: reportData?.khata || { totalUdhar: 0, customers: 0, paid: 0, totalWusool: 0 } });
        try { const khataData = await khataRes.json() as { customers: CustomerLite[] }; const list = khataData.customers || []; setTotalUdhar(list.filter(c=>!c.isPaid).reduce((a,b)=>a+(b.totalUdhar||0),0)); setUdharCustomers(list.filter(c=>!c.isPaid).length); setPaidCount(list.filter(c=>c.isPaid).length); } catch { setTotalUdhar(reportData?.khata?.totalUdhar || 0); setUdharCustomers(reportData?.khata?.customers || 0); setPaidCount(reportData?.khata?.paid || 0); }
        try { const yData = await yearSalesRes.json() as { sales: Sale[] }; const loss = (yData.sales || []).filter(s=> safeNum(s.profit) < 0).reduce((a,b)=> a + Math.abs(safeNum(b.profit)),0); setYearLoss(Math.round(loss)); } catch { setYearLoss(0); }
        try { const topData = (await topRes.json()) as TopResponse; setTopProducts(topData.top || []); } catch { setTopProducts([]); }
      } catch (err) { if ((err as Error).name!== "AbortError") console.error(err); } finally { setLoading(false); }
    };
    void fetchStats(); return () => controller.abort();
  }, [topFilter]);

  const lowStock = products.filter(p => p.stock < 20); const lowStockWarning = products.filter(p => p.stock >= 20 && p.stock < 100);
  const stockValue = products.reduce((s,p)=> s + (p.sellPrice||p.price)*p.stock,0); const stockBuyValue = products.reduce((s,p)=> s + (p.buyPrice||0)*p.stock,0);
  const stockProfitPotential = products.reduce((s,p)=>{ const buy = p.buyPrice && p.buyPrice>0? p.buyPrice : Math.round((p.sellPrice||p.price)*0.8); return s + ((p.sellPrice||p.price)-buy)*p.stock; },0);

  if (loading) return <p className="p-8 text-center text-gray-400 text-[12px]">Loading Yasir Medical Dashboard...</p>;

  return (
    <div className="p-3 sm:p-6 md:p-8 max-w-6xl mx-auto min-h-screen bg-gray-50">
      {isOffline && <div className="mb-3 bg-amber-50 border border-amber-200 text-amber-800 text-[12px] p-2.5 rounded-xl text-center">📶 Offline • {pendingCount} pending</div>}
      {totalUdhar>0 && <div className="mb-3 bg-red-50 border border-red-200 text-red-800 text-[12px] p-2.5 rounded-xl flex justify-between items-center"><span>📒 Total Udhar: Rs.{totalUdhar.toLocaleString()} • {udharCustomers} pending {paidCount? `| ${paidCount} Wusool Done` : ""}</span><Link href="/dashboard/customers" className="bg-red-600 text-white px-3 py-1 rounded-lg text-[11px]">View Khata</Link></div>}
      {pendingCount > 0 &&!isOffline && <div className="mb-3 bg-blue-50 border border-blue-200 text-blue-800 text-[12px] p-2.5 rounded-xl text-center">{pendingCount} offline pending</div>}
      <div className="mb-4 bg-linear-to-r from-green-600 to-emerald-700 text-white p-4 rounded-xl shadow-lg border border-green-700">
        <div className="flex flex-col sm:flex-row justify-between gap-3">
          <div>
            <h2 className="font-bold text-[14px] flex items-center gap-2">📦 Daily Full Backup — V25 <span className={`text-[9px] px-2 py-0.5 rounded-full ${autoBackupOn?"bg-white text-green-700":"bg-red-100 text-red-600"}`}>{autoBackupOn?"AUTO 11 PM ON":"AUTO OFF"}</span></h2>
            <p className="text-[11px] opacity-90 mt-1">Products + Batches + Sales + Purchases + Udhar Khata → USB Ready</p>
            <p className="text-[10px] opacity-75 mt-1">Last backup: {lastBackup || "Never"} • {products.length} medicines • {reports.all.count} sales</p>
          </div>
          <div className="flex gap-2 items-center">
            <button onClick={()=>void doFullBackup(false)} disabled={backingUp} className="bg-white text-green-700 px-4 py-2 rounded-full text-[11px] font-bold shadow disabled:opacity-50">{backingUp?"Backing up...":"📥 Full Backup"}</button>
            <button onClick={()=>fileInputRef.current?.click()} className="bg-black/20 hover:bg-black/30 text-white border border-white/30 px-4 py-2 rounded-full text-[11px] font-bold">♻️ Restore</button>
            <button onClick={()=>{ const n=!autoBackupOn; setAutoBackupOn(n); localStorage.setItem("yasir_auto_backup", String(n)); }} className="bg-white/20 px-3 py-2 rounded-full text-[10px]">{autoBackupOn?"Auto ON":"Auto OFF"}</button>
          </div>
        </div>
        <input ref={fileInputRef} type="file" accept=".json" onChange={handleRestore} className="hidden" />
        <p className="text-[9px] opacity-70 mt-2">💡 Click Full Backup → Choose USB Drive (E:). Auto saves daily at 11 PM to Downloads.</p>
      </div>
      <div className="flex items-center gap-2.5 mb-1"><Image src="/logo.png" unoptimized alt="logo" width={36} height={36} className="w-9 h-9 rounded-full border-2 border-green-700 shadow-sm" /><h1 className="text-[18px] sm:text-2xl font-bold">💊 Yasir Medical Store</h1></div>
      <p className="text-[11px] text-green-700 font-bold mb-1">Yasir Medical - Medicines Wholesale & Retail</p>
      <p className="text-gray-400 mb-4 text-[11px]">{new Date().toLocaleDateString()} • {isOffline? "Offline" : "Online"} • Tablets, Patta, Box</p>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 mb-3">
        <div className="bg-white p-3 sm:p-5 rounded-xl border"><p className="text-gray-400 text-[10px]">Today Sale</p><p className="text-[16px] font-bold mt-1">Rs. {fmtMoney(reports.today.total)}</p><p className="text-[10px] text-gray-500 mt-1">Buy Rs.{fmtMoney(reports.today.buy)} • <span className="text-green-700 font-bold">+Rs.{fmtMoney(reports.today.profit)}</span></p><p className="text-[10px] text-gray-400 mt-1">{reports.today.count} sales</p></div>
        <div className="bg-blue-50 border-blue-200 p-3 sm:p-5 rounded-xl border"><p className="text-blue-600 text-[10px] font-bold">Today Purchase — Kharidari</p><p className="text-[16px] font-bold mt-1 text-blue-700">Rs. {fmtMoney(reports.todayPurchase.total)}</p><p className="text-[10px] text-gray-500 mt-1">{reports.todayPurchase.count} bills • Stock In</p><Link href="/dashboard/purchases/history" className="text-[10px] text-blue-700 mt-1 inline-block font-bold">History →</Link></div>
        <div className="bg-white p-3 sm:p-5 rounded-xl border"><p className="text-gray-400 text-[10px]">This Month Sale</p><p className="text-[16px] font-bold mt-1">Rs. {fmtMoney(reports.month.total)}</p><p className="text-[10px] text-gray-500 mt-1">Buy Rs.{fmtMoney(reports.month.buy)} • <span className="text-blue-600 font-bold">+Rs.{fmtMoney(reports.month.profit)}</span></p><p className="text-[10px] text-gray-400 mt-1">{reports.month.count} sales</p></div>
        <div className="bg-blue-50 border-blue-200 p-3 sm:p-5 rounded-xl border"><p className="text-blue-600 text-[10px] font-bold">This Month Purchase</p><p className="text-[16px] font-bold mt-1 text-blue-700">Rs. {fmtMoney(reports.monthPurchase.total)}</p><p className="text-[10px] text-gray-500 mt-1">{reports.monthPurchase.count} bills • Kharidari</p><p className="text-[10px] text-gray-600 mt-1">Net: Rs.{fmtMoney(reports.month.total - reports.monthPurchase.total)}</p></div>
        <div className="bg-white p-3 sm:p-5 rounded-xl border"><p className="text-gray-400 text-[10px]">This Year Sale</p><p className="text-[16px] font-bold mt-1">Rs. {fmtMoney(reports.year.total)}</p><p className="text-[10px] text-gray-500 mt-1">Buy Rs.{fmtMoney(reports.year.buy)} • <span className="text-green-700 font-bold">+Rs.{fmtMoney(reports.year.profit)}</span></p><p className="text-[10px] text-gray-400 mt-1">{reports.year.count} sales • Loss Rs.{fmtMoney(yearLoss)}</p></div>
        <div className="bg-blue-50 border-blue-200 p-3 sm:p-5 rounded-xl border"><p className="text-blue-600 text-[10px] font-bold">This Year Purchase</p><p className="text-[16px] font-bold mt-1 text-blue-700">Rs. {fmtMoney(reports.yearPurchase.total)}</p><p className="text-[10px] text-gray-500 mt-1">{reports.yearPurchase.count} bills</p><p className="text-[10px] text-gray-600 mt-1">Net Yearly: Rs.{fmtMoney(reports.year.total - reports.yearPurchase.total)}</p></div>
      </div>
      <BarChart reports={reports} />
      <TopSellingCard top={topProducts} filter={topFilter} setFilter={setTopFilter} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-5">
        <div className="bg-red-50 border-red-200 p-3 sm:p-5 rounded-xl border"><p className="text-red-500 text-[10px] font-bold">Total Udhar - Khata</p><p className="text-[16px] font-bold mt-1 text-red-600">Rs. {totalUdhar.toLocaleString()}</p><p className="text-[10px] text-gray-500 mt-1">{udharCustomers} pending {paidCount? `| ${paidCount} done` : ""}</p><Link href="/dashboard/customers" className="text-[10px] text-red-700 mt-2 inline-block font-bold">Wusool →</Link></div>
        <div className="bg-white p-3 sm:p-5 rounded-xl border"><p className="text-gray-400 text-[10px]">Stock Value (Sell)</p><p className="text-[16px] font-bold mt-1">Rs. {fmtMoney(stockValue)}</p><p className="text-[10px] text-gray-500 mt-1">Buy Rs.{fmtMoney(stockBuyValue)} • <span className="text-green-700 font-bold">+Rs.{fmtMoney(stockProfitPotential)}</span></p><p className="text-[9px] text-gray-400 mt-1">{products.length} medicines • {fmt1(products.reduce((a,p)=>a+p.stock,0))} Tabs</p></div>
        <div className="bg-green-50 border-green-200 p-3 sm:p-5 rounded-xl border"><p className="text-green-700 text-[10px] font-bold">Yearly Profit</p><p className="text-[16px] font-bold mt-1 text-green-700">Rs. {fmtMoney(reports.year.profit)}</p><p className="text-[10px] text-gray-500 mt-1">Gross Rs.{fmtMoney(reports.year.total)}</p><p className="text-[9px] text-gray-400 mt-1">{reports.year.count} bills in {new Date().getFullYear()}</p></div>
        <div className={`p-3 sm:p-5 rounded-xl border ${yearLoss>0? "bg-orange-50 border-orange-200" : "bg-white"}`}><p className={`text-[10px] font-bold ${yearLoss>0? "text-orange-600" : "text-gray-400"}`}>Yearly Loss</p><p className={`text-[16px] font-bold mt-1 ${yearLoss>0? "text-red-600" : "text-green-600"}`}>Rs. {fmtMoney(yearLoss)}</p><p className="text-[10px] text-gray-500 mt-1">{yearLoss>0? "Discount bills" : "No loss 👍"}</p></div>
      </div>
      <div className="flex gap-2 mb-5"><Link href="/dashboard/purchases" className="flex-1 bg-blue-600 text-white p-3 rounded-xl text-center font-bold text-[12px]">📦 Add Purchase Bill</Link><Link href="/dashboard/purchases/history" className="flex-1 bg-white border p-3 rounded-xl text-center font-bold text-[12px]">📊 Purchase History</Link></div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-white p-3.5 rounded-xl border">
          <h2 className="font-bold mb-3 text-[13px]">⚠️ Low Stock &lt;20 Tab: {lowStock.length} | &lt;100: {lowStockWarning.length}</h2>
          {[...lowStock,...lowStockWarning].slice(0,6).map(p=> {
            const buy = p.buyPrice>0? p.buyPrice : Math.round(p.sellPrice*0.8);
            const stockLabel = p.stockInPatta? p.stockInPatta.replace(/(\d+\.\d{2,})\d*/, (m)=> Number(m).toFixed(1)) : `${fmt1(p.stock)} Tab`;
            return <div key={p._id} className="flex justify-between py-2 border-b last:border-0 text-[12px]"><span>{p.name} <span className="text-[10px] text-gray-400">{p.company} • {fmt1(p.tabletsPerPatta)} Tab/Patta</span></span><span className="font-bold text-orange-500">{stockLabel} • Buy {fmt1(buy)} → {fmt1(p.sellPrice)}</span></div>
          })}
          {lowStock.length===0 && lowStockWarning.length===0 && <p className="text-[11px] text-gray-400 py-2">All stocked good 👍</p>}
        </div>
        <div className="bg-white p-3.5 rounded-xl border">
          <h2 className="font-bold mb-3 text-[13px]">🕒 Today Sales • +Rs.{fmtMoney(reports.today.profit)}</h2>
          {recentSales.length===0? <p className="text-[12px] text-gray-400 py-4 text-center">No sales today</p> : recentSales.map((s,i)=> {
            const buy = s.total - s.profit;
            return (
            <div key={`${s.productName}-${i}`} className={`flex justify-between py-2 border-b last:border-0 text-[12px] ${s.status==="pending"?"bg-red-50/50":""}`}>
              <span className="flex-1 pr-2">{s.productName} {s.customerName && s.customerName!=="Walk-in"? <span className="bg-yellow-100 px-1.5 py-0.5 rounded-full text-[9px]">👤 {s.customerName}</span>:null} {s.status==="pending"? <span className="bg-red-600 text-white px-1.5 py-0.5 rounded-full text-[8px]">UDHAR</span>:null}</span>
              <span className="text-right shrink-0"><span className="text-[10px] text-gray-400">Buy {fmtMoney(buy)} → </span>Rs.{fmtMoney(s.total)}</span>
            </div>
          )})}
          <Link href="/dashboard/sales/history" className="text-[11px] text-green-700 mt-3 inline-block">View all history →</Link>
        </div>
      </div>
    </div>
  );
}