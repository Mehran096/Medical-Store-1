"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

type TopItem = { _id: string; totalQty: number; totalSale: number; totalProfit: number; count: number };
type TopFilter = "today" | "monthly" | "yearly" | "all";
type TopResponse = { top: TopItem[] };

function fmt(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return v % 1 === 0? v.toFixed(0) : v.toFixed(1);
}

export default function TopPage(){
  const [filter,setFilter]=useState<TopFilter>("monthly");
  const [top,setTop]=useState<TopItem[]>([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(`/api/sales/top?filter=${filter}`)
     .then(r=>r.json() as Promise<TopResponse>)
     .then(d=>setTop(d.top || []))
     .catch(()=>setTop([]))
     .finally(()=>setLoading(false));
  },[filter]);

  return (
    <div className="p-2 sm:p-4 max-w-4xl mx-auto min-h-screen bg-gray-50">
      {/* Header */}
      <div className="flex justify-between items-center mb-3">
        <div>
          <h1 className="font-bold text-[14px] sm:text-[18px]">🔥 Top Selling</h1>
          <p className="text-[10px] text-gray-400 capitalize">{filter} • {top.length} products</p>
        </div>
        <Link href="/dashboard" className="text-[10px] bg-white border px-3 py-1.5 rounded-full font-bold">← Dashboard</Link>
      </div>

      {/* Filters */}
      <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1">
        {(["today","monthly","yearly","all"] as const).map(f=>(
          <button key={f} onClick={()=>setFilter(f)} className={`shrink-0 px-3 py-1.5 rounded-full text-[10px] sm:text-[11px] capitalize font-bold transition ${filter===f?"bg-green-600 text-white shadow":"bg-white border text-gray-600"}`}>{f}</button>
        ))}
      </div>

      {loading? (
        <p className="text-[11px] text-gray-400 text-center py-10">Loading...</p>
      ) : top.length===0? (
        <div className="bg-white border rounded-xl p-8 text-center">
          <p className="text-[12px] text-gray-400">No sales {filter}</p>
        </div>
      ) : (
        <>
          {/* Mobile Cards - show on mobile */}
          <div className="grid gap-2 sm:hidden">
            {top.map((p,i)=>(
              <div key={p._id} className="bg-white border rounded-xl p-2.5 flex justify-between items-center">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold ${i===0?"bg-yellow-400":i===1?"bg-gray-300":i===2?"bg-orange-300":"bg-gray-100 border"}`}>{i+1}</span>
                  <div className="min-w-0">
                    <p className="font-bold text-[11px] truncate max-w-32.5">{p._id}</p>
                    <p className="text-[9px] text-gray-500">{p.count} bills • {fmt(p.totalQty)} qty</p>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-bold text-[11px] text-green-700">Rs.{fmt(p.totalSale)}</p>
                  <p className="text-[9px] text-gray-500">+{fmt(p.totalProfit)}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop Table - hidden on mobile */}
          <div className="hidden sm:block bg-white border rounded-xl overflow-hidden">
            <div className="grid grid-cols-12 bg-gray-50 px-3 py-2 text-[10px] font-bold text-gray-500">
              <div className="col-span-1">#</div>
              <div className="col-span-5">Product</div>
              <div className="col-span-2 text-center">Qty / Bills</div>
              <div className="col-span-2 text-right">Sale</div>
              <div className="col-span-2 text-right">Profit</div>
            </div>
            {top.map((p,i)=>(
              <div key={p._id} className="grid grid-cols-12 px-3 py-2.5 border-t text-[12px] items-center hover:bg-gray-50">
                <div className="col-span-1"><span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${i===0?"bg-yellow-400":i===1?"bg-gray-300":i===2?"bg-orange-300":"bg-gray-100 border"}`}>{i+1}</span></div>
                <div className="col-span-5 font-bold truncate">{p._id}</div>
                <div className="col-span-2 text-center text-[11px] text-gray-600">{fmt(p.totalQty)} • {p.count}</div>
                <div className="col-span-2 text-right font-bold text-green-700">Rs.{fmt(p.totalSale)}</div>
                <div className="col-span-2 text-right text-[11px] text-gray-500">+Rs.{fmt(p.totalProfit)}</div>
              </div>
            ))}
          </div>

          {/* Summary */}
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-[10px]">
            <div className="bg-white border p-2.5 rounded-xl text-center"><p className="text-gray-400">Total Sale {filter}</p><p className="font-bold text-[12px] text-green-700">Rs.{fmt(top.reduce((a,b)=>a+b.totalSale,0))}</p></div>
            <div className="bg-white border p-2.5 rounded-xl text-center"><p className="text-gray-400">Total Profit</p><p className="font-bold text-[12px]">Rs.{fmt(top.reduce((a,b)=>a+b.totalProfit,0))}</p></div>
            <div className="bg-white border p-2.5 rounded-xl text-center col-span-2 sm:col-span-1"><p className="text-gray-400">Bills</p><p className="font-bold text-[12px]">{top.reduce((a,b)=>a+b.count,0)}</p></div>
          </div>
        </>
      )}
    </div>
  );
}