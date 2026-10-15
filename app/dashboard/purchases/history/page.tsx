"use client";
import { useEffect, useState, useCallback } from "react";
import { offlineDB } from "@/lib/offline-db";

type Purchase = {
  _id: string;
  supplier: string;
  invoiceNo?: string;
  totalBuyAmount: number;
  totalItems: number;
  createdAt: string;
  items: { name: string; quantity: number; buyPricePerUnit: number }[];
};

const FILTERS = ["today","monthly","yearly","all"] as const;
type Filter = typeof FILTERS[number];

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

function getPKTBounds() {
  const now = new Date();
  const nowPKT = new Date(now.getTime() + PKT_OFFSET_MS);
  const y = nowPKT.getUTCFullYear();
  const m = nowPKT.getUTCMonth();
  const d = nowPKT.getUTCDate();

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

  const load = useCallback(async()=>{
    setLoading(true);
    try{
      if(typeof window!== 'undefined' &&!navigator.onLine){
        const all = await offlineDB.purchases.toArray();
        const { pktTodayUTC, pktTomorrowUTC, pktMonthUTC, pktYearUTC } = getPKTBounds();
        let filtered = all;
        if(filter === "today"){
          filtered = all.filter(p=> {
            const t = new Date(p.createdAt).getTime();
            return t >= pktTodayUTC && t < pktTomorrowUTC;
          });
        } else if(filter === "monthly"){
          filtered = all.filter(p=>{
            const t = new Date(p.createdAt).getTime();
            return t >= pktMonthUTC && t < pktTomorrowUTC;
          });
        } else if(filter === "yearly"){
          filtered = all.filter(p=>{
            const t = new Date(p.createdAt).getTime();
            return t >= pktYearUTC && t < pktTomorrowUTC;
          });
        }
        const mapped = filtered.map(p=>({
          _id: p._id || p.localId,
          supplier: p.supplier,
          invoiceNo: p.invoiceNo,
          totalBuyAmount: p.totalBuyAmount,
          totalItems: p.totalItems,
          createdAt: p.createdAt,
          items: p.items.map(i=>({ name: i.name, quantity: i.quantity, buyPricePerUnit: i.buyPricePerUnit })),
        })).sort((a,b)=> new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setList(mapped);
        setTotal(mapped.reduce((s,x)=>s+x.totalBuyAmount,0));
      } else {
        const res=await fetch(`/api/purchases?filter=${filter}&limit=50`, { cache: "no-store" });
        const data=await res.json() as { purchases: Purchase[]; totalPurchase: number };
        setList(data.purchases||[]);
        setTotal(data.totalPurchase||0);
      }
    }catch{ /* ignore */ }
    setLoading(false);
  }, [filter]);

  useEffect(()=>{
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  },[load]);

  const del=async(id:string)=>{
    if(!confirm("Delete this purchase bill? Stock will be reverted.")) return;
    try{
      if(typeof window!== 'undefined' &&!navigator.onLine){
        await offlineDB.purchases.where('localId').equals(id).or('_id').equals(id).delete();
        await offlineDB.syncQueue.where('localId').equals(id).delete().catch(()=>{});
      } else {
        await fetch(`/api/purchases/${id}`,{method:"DELETE"});
      }
    } catch{}
    load();
  };

  return(
    <div className="min-h-screen bg-gray-50 p-2">
      <div className="flex justify-between items-center mb-2">
        <h1 className="font-bold text-[14px]">Purchase History {typeof window!=='undefined' &&!navigator.onLine && <span className="ml-2 text-[8px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full">OFFLINE</span>}</h1>
        <div className="bg-blue-600 text-white px-3 py-1 rounded-full text-[10px] font-bold">Total: Rs.{total} {filter!=="all" && `(${list.length} bills)`}</div>
      </div>
      <div className="flex gap-1 mb-2 overflow-x-auto">
        {FILTERS.map(f=>(
          <button key={f} onClick={()=>setFilter(f)} className={`px-3 py-1 rounded-full text-[10px] capitalize transition ${filter===f?"bg-blue-600 text-white":"bg-white border hover:bg-gray-50"}`}>{f}</button>
        ))}
      </div>
      <div className="bg-white border rounded-xl overflow-hidden">
        {loading? <p className="p-4 text-[11px] text-center">Loading...</p> : list.length===0? <p className="p-6 text-center text-[11px] text-gray-400">No purchases {filter}</p> : list.map(p=>(
          <div key={p._id} className="p-2 border-b last:border-0">
            <div className="flex justify-between">
              <p className="font-bold text-[11px]">{p.supplier} {p.invoiceNo? `#${p.invoiceNo}`:""} • Rs.{p.totalBuyAmount}</p>
              <span className="text-[9px] text-gray-400">
                {new Date(p.createdAt).toLocaleString("en-PK", { timeZone: "Asia/Karachi", dateStyle: "short", timeStyle: "short" })}
              </span>
            </div>
            <p className="text-[9px] text-gray-500 mt-1">{p.items.map(i=>`${i.name} x${i.quantity}`).join(", ")}</p>
            <div className="text-right mt-1">
              <button onClick={()=>del(p._id)} className="text-[9px] bg-red-50 text-red-600 px-2 py-1 rounded-full hover:bg-red-100">Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}