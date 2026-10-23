"use client";
import { useEffect, useState, useCallback } from "react";
import { offlineDB } from "@/lib/offline-db";

type Purchase = {
  _id: string; supplier: string; invoiceNo?: string; totalBuyAmount: number;
  totalItems: number; createdAt: string;
  items: { productId?: string; name: string; quantity: number; buyPricePerUnit: number; batchNo?: string; expiryDate?: string }[];
};

const FILTERS = ["today","monthly","yearly","all"] as const;
type Filter = typeof FILTERS[number];
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

function getPKTBounds() {
  const now = new Date();
  const nowPKT = new Date(now.getTime() + PKT_OFFSET_MS);
  const y = nowPKT.getUTCFullYear(); const m = nowPKT.getUTCMonth(); const d = nowPKT.getUTCDate();
  const pktTodayUTC = Date.UTC(y, m, d, 0, 0, 0, 0) - PKT_OFFSET_MS;
  const pktTomorrowUTC = Date.UTC(y, m, d + 1, 0, 0, 0, 0) - PKT_OFFSET_MS;
  const pktMonthUTC = Date.UTC(y, m, 1, 0, 0, 0, 0) - PKT_OFFSET_MS;
  const pktYearUTC = Date.UTC(y, 0, 1, 0, 0, 0, 0) - PKT_OFFSET_MS;
  return { pktTodayUTC, pktTomorrowUTC, pktMonthUTC, pktYearUTC };
}

export default function PurchaseHistoryPage(){
  const [filter,setFilter]=useState<Filter>("monthly");
  const [list,setList]=useState<Purchase[]>([]);
  const [total,setTotal]=useState(0);
  const [loading,setLoading]=useState(true);
  const [deletingId,setDeletingId]=useState<string | null>(null);

  const load = useCallback(async()=>{
    setLoading(true);
    try{
      if(typeof window!== 'undefined' && !navigator.onLine){
        const all = await offlineDB.purchases.toArray();
        const { pktTodayUTC, pktTomorrowUTC, pktMonthUTC, pktYearUTC } = getPKTBounds();
        let filtered = all;
        if(filter === "today") filtered = all.filter(p=>{ const t = new Date(p.createdAt).getTime(); return t >= pktTodayUTC && t < pktTomorrowUTC; });
        else if(filter === "monthly") filtered = all.filter(p=>{ const t = new Date(p.createdAt).getTime(); return t >= pktMonthUTC && t < pktTomorrowUTC; });
        else if(filter === "yearly") filtered = all.filter(p=>{ const t = new Date(p.createdAt).getTime(); return t >= pktYearUTC && t < pktTomorrowUTC; });
        const mapped = filtered.map(p=>({
          _id: p._id || p.localId, supplier: p.supplier, invoiceNo: p.invoiceNo,
          totalBuyAmount: p.totalBuyAmount, totalItems: p.totalItems, createdAt: p.createdAt,
          items: p.items.map(i=>({ productId: i.productId, name: i.name, quantity: i.quantity, buyPricePerUnit: i.buyPricePerUnit, batchNo: i.batchNo, expiryDate: i.expiryDate })),
        })).sort((a,b)=> new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setList(mapped); setTotal(mapped.reduce((s,x)=>s+x.totalBuyAmount,0));
      } else {
        const res=await fetch(`/api/purchases?filter=${filter}&limit=50`, { cache: "no-store" });
        const data=await res.json() as { purchases: Purchase[]; totalPurchase: number };
        setList(data.purchases||[]); setTotal(data.totalPurchase||0);
      }
    }catch{ /* ignore */ }
    setLoading(false);
  }, [filter]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{ void load(); },[load]);

  const del = async (id: string) => {
  if(!confirm("Delete this purchase bill? Stock and batches will be reverted.")) return;
  setDeletingId(id);
  try{
    if(typeof window!== 'undefined' && !navigator.onLine){
      const pur = await offlineDB.purchases.where('localId').equals(id).or('_id').equals(id).first();
      if (!pur) { alert("Purchase not found offline"); setDeletingId(null); return; }
      await offlineDB.transaction('rw', offlineDB.purchases, offlineDB.batches, offlineDB.products, offlineDB.syncQueue, async () => {
        const agg = new Map<string, typeof pur.items[0]>();
        for (const it of pur.items) {
          const expiryDay = it.expiryDate ? it.expiryDate.slice(0,10) : "no-expiry";
          const key = `${it.productId}_${String(it.batchNo||"").trim().toLowerCase()}_${expiryDay}`;
          const prev = agg.get(key);
          if (prev) agg.set(key, { ...prev, quantity: prev.quantity + it.quantity });
          else agg.set(key, { ...it });
        }
        for (const item of agg.values()) {
          const prodId = item.productId;
          if (!prodId) continue;
          const trimmed = String(item.batchNo||"").trim().toLowerCase();
          const expiryDay = item.expiryDate ? item.expiryDate.slice(0,10) : "";
          const batches = await offlineDB.batches.where('productId').equals(prodId).toArray();
          const batch = batches.find(b=> b.batchNo.trim().toLowerCase() === trimmed && (expiryDay ? b.expiryDate.slice(0,10) === expiryDay : true));
          if (batch) {
            const newQty = Math.round(Math.max(0, batch.quantity - item.quantity)*1000000)/1000000;
            if (newQty <= 0.001) await offlineDB.batches.delete(batch.localId);
            else await offlineDB.batches.update(batch.localId, { quantity: newQty, synced: 0 });
          }
          const remaining = await offlineDB.batches.where('productId').equals(prodId).toArray();
          const sum = remaining.reduce((a,b)=>a+b.quantity,0);
          const prod = await offlineDB.products.where('_id').equals(prodId).or('localId').equals(prodId).first();
          if (prod) {
            await offlineDB.products.update(prod.localId, { stock: Math.round(sum*1000000)/1000000, synced: 0 });
          }
        }
        await offlineDB.purchases.delete(pur.localId);
        await offlineDB.syncQueue.where('localId').equals(id).delete().catch(()=>{});
      });
      await load();
    } else {
      const res = await fetch(`/api/purchases/${id}`,{method:"DELETE", cache: "no-store"});
      const data = await res.json().catch(()=>({}));
      if(!res.ok){
        alert(`Delete failed: ${data.error || res.status} ${data.details || ""}`);
        setDeletingId(null);
        return;
      }
      // FIXED: pure updater — no setTotal inside, no Date.now() inside
      const deletedBill = list.find(p=> p._id === id);
      setList(prev => prev.filter(p=> p._id !== id));
      if(deletedBill){
        setTotal(prev => prev - deletedBill.totalBuyAmount);
      }
      // FIXED: move Date.now() to variable — not inside render callback
      const ts = String(new Date().getTime());
      localStorage.setItem("stock-updated", ts);
      window.dispatchEvent(new Event("stock-updated"));
      await offlineDB.products.clear();
      await offlineDB.batches.clear();
      
      await load();
    }
  } catch(e){ 
    console.error(e);
    alert("Delete error: " + String(e));
  } finally {
    setDeletingId(null);
  }
};

  return(
    <div className="min-h-screen bg-gray-50 p-2 md:p-4 pb-20">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2 mb-3">
          <h1 className="font-bold text-[14px] md:text-lg">Purchase History V35 FIX {typeof window!=='undefined' &&!navigator.onLine && <span className="ml-2 text-[8px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full">OFFLINE</span>}</h1>
          <div className="bg-blue-600 text-white px-3 py-1 rounded-full text-[10px] md:text-xs font-bold w-fit">Total: Rs.{total} {filter!=="all" && `(${list.length} bills)`}</div>
        </div>
        <div className="flex gap-1 mb-3 overflow-x-auto pb-1">
          {FILTERS.map(f=>(
            <button key={f} onClick={()=>setFilter(f)} className={`px-3 py-1.5 rounded-full text-[10px] md:text-xs capitalize transition shrink-0 ${filter===f?"bg-blue-600 text-white":"bg-white border hover:bg-gray-50"}`}>{f}</button>
          ))}
        </div>
        <div className="bg-white border rounded-xl overflow-hidden shadow-sm">
          {loading? <p className="p-4 text-[11px] text-center">Loading...</p> : list.length===0? <p className="p-6 text-center text-[11px] text-gray-400">No purchases {filter}</p> : list.map(p=>(
            <div key={p._id} className="p-3 border-b last:border-0 hover:bg-gray-50/50">
              <div className="flex justify-between gap-2">
                <p className="font-bold text-[11px] md:text-sm truncate">{p.supplier} {p.invoiceNo? `#${p.invoiceNo}`:""} • Rs.{p.totalBuyAmount}</p>
                <span className="text-[9px] text-gray-400 shrink-0">{new Date(p.createdAt).toLocaleString("en-PK", { timeZone: "Asia/Karachi", dateStyle: "short", timeStyle: "short" })}</span>
              </div>
              <div className="mt-1.5 space-y-1">
                {p.items.map((i, idx) => (
                  <p key={idx} className="text-[9px] md:text-[11px] text-gray-600 bg-gray-50 rounded px-2 py-1 flex flex-wrap gap-2">
                    <span className="font-bold">{i.name} x{i.quantity} @ Rs.{i.buyPricePerUnit}</span>
                    {i.batchNo && <span className="text-amber-700 font-bold">Batch:{i.batchNo}</span>}
                    {i.expiryDate && <span className="text-red-600">Exp:{new Date(i.expiryDate).toLocaleDateString()}</span>}
                  </p>
                ))}
              </div>
              <div className="text-right mt-2">
                <button onClick={()=>del(p._id)} disabled={deletingId===p._id} className="text-[9px] md:text-xs bg-red-50 text-red-600 px-3 py-1 rounded-full hover:bg-red-100 disabled:opacity-50">{deletingId===p._id ? "Deleting..." : "Delete + Revert Batch"}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}