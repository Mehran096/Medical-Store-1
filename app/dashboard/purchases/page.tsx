"use client";
import { useEffect, useState } from "react";
import { offlineDB, addOfflinePurchase } from "@/lib/offline-db";
import type { OfflinePurchaseItem, OfflineProduct } from "@/lib/offline-db";

type Product = { _id: string; name: string; company?: string; buyPrice: number; buyPriceAvg?: number; sellPrice: number; stock: number; mainUnit: "box" | "bottle" | "tube" | "piece"; pattaPerBox?: number; mlPerBottle?: number; };
type BillItem = { productId?: string; name: string; company?: string; quantity: number; buyPricePerUnit: number; sellPricePerUnit: number; mainUnit: Product["mainUnit"]; pattaPerBox: number; batchNo: string; expiryDate: string; };

export default function PurchasesPage() {
  const [search, setSearch] = useState(""); const [products, setProducts] = useState<Product[]>([]);
  const [bill, setBill] = useState<BillItem[]>([]); const [supplier, setSupplier] = useState("Peshawar Market");
  const [invoiceNo, setInvoiceNo] = useState(""); const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false); const [userId, setUserId] = useState<string>("");

  useEffect(() => { fetch("/api/auth/session").then(r=>r.json()).then((s: { user?: { id?: string } })=>{ if(s?.user?.id) setUserId(s.user.id); }).catch(()=>{}); }, []);

  useEffect(() => {
    const load = async () => {
      if (search.length < 2) { setProducts([]); return; }
      setLoading(true);
      try {
        if (!navigator.onLine) {
          const offline = await offlineDB.products.where('name').startsWithIgnoreCase(search).limit(10).toArray();
          setProducts(offline.map(o=>({ _id: o._id || o.localId, name: o.name, company: o.company, buyPrice: o.buyPriceAvg || 0, buyPriceAvg: o.buyPriceAvg, sellPrice: o.sellPrice, stock: o.stock, mainUnit: o.mainUnit, pattaPerBox: o.pattaPerBox, mlPerBottle: o.mlPerBottle })) as Product[]);
        } else {
          const res = await fetch(`/api/products?search=${encodeURIComponent(search)}&page=1&limit=10`);
          const data = await res.json() as { products: Product[] };
          setProducts(data.products || []);
        }
      } catch { setProducts([]); } setLoading(false);
    }; const id = setTimeout(load, 300); return () => clearTimeout(id);
  }, [search]);

  const addToBill = (p: Product) => {
    if (bill.find((b) => b.productId === p._id)) { setSearch(""); setProducts([]); return; }
    const ppb = p.pattaPerBox || 10;
    const displaySell = p.mainUnit === "box" ? p.sellPrice * ppb : p.sellPrice;
    setBill(prev => [...prev, { productId: p._id, name: p.name, company: p.company, quantity: 1, buyPricePerUnit: p.buyPriceAvg || p.buyPrice, sellPricePerUnit: displaySell, mainUnit: p.mainUnit, pattaPerBox: ppb, batchNo: "", expiryDate: "" }]);
    setSearch(""); setProducts([]);
  };
  const addCustom = () => {
    if (!search.trim()) return;
    if (bill.find(b => b.name.toLowerCase() === search.trim().toLowerCase())) { setSearch(""); return; }
    setBill(prev => [...prev, { name: search.trim(), company: "", quantity: 1, buyPricePerUnit: 0, sellPricePerUnit: 0, mainUnit: "box", pattaPerBox: 10, batchNo: "", expiryDate: "" }]);
    setSearch(""); setProducts([]);
  };
  const updateField = (idx: number, field: keyof BillItem, val: string) => {
    setBill(prev => prev.map((b,i) => {
      if (i!==idx) return b;
      if (field === "quantity") return { ...b, quantity: val==="" ? 0 : parseInt(val.replace(/[^0-9]/g,""))||0 };
      if (field === "buyPricePerUnit" || field === "sellPricePerUnit") return { ...b, [field]: val==="" ? 0 : parseFloat(val)||0 };
      return { ...b, [field]: val };
    }));
  };
  const totalBuy = bill.reduce((s, it) => s + it.quantity * it.buyPricePerUnit, 0);

  const saveBill = async () => {
    if(saving) return;
    if (!bill.length) return alert("Add medicines first");
    const clean = bill.filter(b => b.quantity>0);
    if(!clean.length) return alert("Qty can't be 0");
    for (const it of clean) { if (!it.batchNo.trim()) return alert(`Batch No required for ${it.name}`); if (!it.expiryDate) return alert(`Expiry Date required for ${it.name}`); }

    const itemsForApi = clean.map(c=>{ if(c.mainUnit === "box") return { ...c, sellPricePerUnit: c.sellPricePerUnit / (c.pattaPerBox || 10) }; return c; });

    const aggForApi = new Map<string, typeof itemsForApi[0]>();
    for(const it of itemsForApi){
      const expiryDay = it.expiryDate ? new Date(it.expiryDate).toISOString().slice(0,10) : "no";
      const key = `${it.productId || it.name}_${String(it.batchNo).trim().toLowerCase()}_${expiryDay}`;
      const prev = aggForApi.get(key);
      if(prev) aggForApi.set(key, { ...prev, quantity: prev.quantity + it.quantity });
      else aggForApi.set(key, it);
    }
    const finalItems = Array.from(aggForApi.values());

    const offlineItems: OfflinePurchaseItem[] = finalItems.map(c=>({
      productId: c.productId || `local_${Date.now()}_${c.name.replace(/\s/g,"_")}_${Math.random().toString(36).slice(2,5)}`,
      name: c.name, company: c.company, quantity: c.quantity, mainUnit: c.mainUnit,
      batchNo: c.batchNo.trim(), expiryDate: new Date(c.expiryDate).toISOString(),
      buyPricePerUnit: c.buyPricePerUnit, sellPricePerUnit: c.sellPricePerUnit,
    }));
    
    const totalAmount = finalItems.reduce((s,it)=>s+it.quantity*it.buyPricePerUnit,0);
    setSaving(true);
    try {
      if (typeof window!== 'undefined' && !navigator.onLine) {
        for (const it of offlineItems) {
          const exists = await offlineDB.products.where('_id').equals(it.productId).or('localId').equals(it.productId).first();
          if (!exists) {
            const newProd: OfflineProduct = {
              _id: it.productId, localId: it.productId, name: it.name, company: it.company || "Unknown",
              generic: "", mainUnit: it.mainUnit, pattaPerBox: 10, mlPerBottle: 120,
              sellPrice: it.sellPricePerUnit || it.buyPricePerUnit * 1.2,
              stock: 0, buyPriceAvg: it.buyPricePerUnit, userId: userId || "offline_user", synced: 0, createdAt: new Date().toISOString()
            };
            await offlineDB.products.put(newProd);
          }
        }
        await addOfflinePurchase(offlineItems, supplier, invoiceNo, userId || "offline_user", "cash");
        alert(`Saved Offline Rs.${totalAmount}`); setBill([]); setInvoiceNo(""); return;
      }

      const controller = new AbortController(); const to = setTimeout(()=>controller.abort(), 10000);
      const res = await fetch("/api/purchases", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ supplier, invoiceNo, items: finalItems, totalBuyAmount: totalAmount, paymentType:"cash", localId: `pur_${Date.now()}_${Math.random().toString(36).slice(2,5)}` }),
        signal: controller.signal
      });
      clearTimeout(to);
      if(!res.ok) throw new Error(await res.text());

      // FIXED: instant show on sales page + clear stale offline cache
      localStorage.setItem("stock-updated", Date.now().toString());
      window.dispatchEvent(new Event("stock-updated"));
      await offlineDB.products.clear();
      await offlineDB.batches.clear();

      alert(`Saved Rs.${totalAmount}`); setBill([]); setInvoiceNo("");
    } catch(e){
      try {
        await addOfflinePurchase(offlineItems, supplier, invoiceNo, userId || "offline_user", "cash");
        alert(`Server error - Saved Offline Rs.${totalAmount}`); setBill([]); setInvoiceNo("");
      } catch { alert((e as Error).message); }
    } finally{ setSaving(false); }
  };

  return (
    <div className="min-h-screen bg-gray-50 md:bg-gray-100">
      <div className="w-full max-w-5xl mx-auto p-2 md:p-6 pb-32">
        <h1 className="text-[13px] md:text-xl font-bold mb-2 md:mb-4">📦 New Purchase — V19 FIX {typeof window!=='undefined' &&!navigator.onLine && <span className="ml-2 text-[9px] bg-red-100 text-red-600 px-2 py-0.5 rounded-full">OFFLINE</span>}</h1>
        <div className="bg-white border rounded-xl p-2 md:p-4 mb-2 flex gap-2">
          <input value={supplier} onChange={e=>setSupplier(e.target.value)} placeholder="Supplier" className="flex-1 border rounded-lg px-2 md:px-4 py-1 text-[11px] md:text-[15px] h-8 md:h-11" />
          <input value={invoiceNo} onChange={e=>setInvoiceNo(e.target.value)} placeholder="#Inv No" className="w-24 md:w-36 border rounded-lg px-2 md:px-4 py-1 text-[11px] md:text-[15px] h-8 md:h-11" />
        </div>
        <div className="relative bg-white border rounded-xl p-2 md:p-4 mb-2">
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Search medicine e.g. panadol" className="w-full border rounded-lg px-2 md:px-4 py-1 text-[11px] md:text-[15px] h-8 md:h-12 focus:ring-2 focus:ring-green-500 outline-none" />
          {loading && <p className="text-[10px] md:text-sm text-gray-400 mt-2">Searching...</p>}
          {products.length>0 && (
            <div className="absolute left-2 right-2 md:left-4 md:right-4 top-11 md:top-16 bg-white border shadow-2xl rounded-xl z-60 max-h-72 overflow-auto">
              {products.map(p=>{
                const displaySell = p.mainUnit === "box" ? p.sellPrice * (p.pattaPerBox||10) : p.sellPrice;
                return (
                  <button key={p._id} onClick={()=>addToBill(p)} className="w-full text-left p-2 md:p-3 border-b hover:bg-green-50 flex justify-between items-center">
                    <span className="text-[11px] md:text-[14px] font-bold truncate">{p.name} <span className="font-normal text-gray-400 text-[9px] md:text-xs ml-1">{p.company}</span></span>
                    <span className="text-[8px] md:text-xs bg-gray-100 px-2 py-1 rounded-full shrink-0 ml-2">Stk {p.stock} {p.mainUnit} • Buy Rs.{p.buyPriceAvg || p.buyPrice} • Sell Rs.{displaySell}</span>
                  </button>
                );
              })}
              <button onClick={addCustom} className="w-full p-2 md:p-3 text-[11px] md:text-sm text-blue-600 bg-blue-50 font-bold">+ Add as new: {search}</button>
            </div>
          )}
        </div>
        <div className="bg-white border rounded-xl overflow-hidden">
          {bill.length===0? <p className="p-6 md:p-10 text-center text-[11px] md:text-sm text-gray-400">No items — search and add medicine</p> :
            bill.map((it, idx)=>(
              <div key={idx} className="p-2 md:p-4 border-b">
                <div className="flex justify-between items-center mb-2">
                  <p className="font-bold text-[11px] md:text-[15px] truncate pr-2">{it.name} {it.company? `(${it.company})`:""} {!it.productId && <span className="ml-1 text-[8px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">NEW</span>}</p>
                  <button onClick={()=>setBill(prev=>prev.filter((_,i)=>i!==idx))} className="text-[9px] md:text-xs bg-red-50 text-red-600 px-2 md:px-3 py-0.5 rounded-full">Del</button>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
                  <div><label className="text-[8px] md:text-[11px] text-gray-500 block">Qty ({it.mainUnit})</label><input type="text" inputMode="numeric" value={it.quantity===0?"":it.quantity} onFocus={e=>e.target.select()} onChange={e=>updateField(idx,"quantity",e.target.value)} className="w-full border rounded-lg px-2 py-1 text-[11px] h-8 text-center" /></div>
                  <div><label className="text-[8px] text-blue-600 font-bold block">Buy/box</label><input type="text" inputMode="decimal" value={it.buyPricePerUnit===0?"":it.buyPricePerUnit} onFocus={e=>e.target.select()} onChange={e=>updateField(idx,"buyPricePerUnit",e.target.value)} className="w-full border rounded-lg px-2 py-1 text-[11px] h-8 bg-blue-50/40" /></div>
                  <div><label className="text-[8px] text-green-600 font-bold block">Sell/box</label><input type="text" inputMode="decimal" value={it.sellPricePerUnit===0?"":it.sellPricePerUnit} onFocus={e=>e.target.select()} onChange={e=>updateField(idx,"sellPricePerUnit",e.target.value)} className="w-full border rounded-lg px-2 py-1 text-[11px] h-8 bg-green-50/40" /></div>
                  <div><label className="text-[8px] text-amber-700 font-bold block">Batch No *</label><input value={it.batchNo} onChange={e=>updateField(idx,"batchNo",e.target.value)} placeholder="B123" className="w-full border-2 border-amber-200 rounded-lg px-2 py-1 text-[11px] h-8" /></div>
                  <div><label className="text-[8px] text-amber-700 font-bold block">Expiry *</label><input type="date" value={it.expiryDate} onChange={e=>updateField(idx,"expiryDate",e.target.value)} className="w-full border-2 border-amber-200 rounded-lg px-2 py-1 text-[11px] h-8" /></div>
                  <div className="text-[10px] font-bold h-8 flex items-center justify-center bg-gray-100 rounded-lg">Rs.{it.quantity*it.buyPricePerUnit}</div>
                </div>
              </div>
            ))
          }
        </div>
        {/* FIXED: z-20 not z-30, so dropdown z-[60] stays on top, lg:left for sidebar */}
        <div className="bg-green-600 text-white rounded-xl md:mt-4 p-3 md:p-4 flex justify-between items-center fixed md:sticky bottom-2 md:bottom-0 left-2 right-2 md:left-auto md:right-auto md:mx-auto shadow-xl z-20 max-w-5xl border border-green-700">
          <div><p className="text-[10px] opacity-80">{bill.length} items • Total Kharidari</p><p className="text-[15px] font-bold">Rs.{totalBuy}</p></div>
          <button onClick={saveBill} disabled={saving||!bill.length} className="bg-white text-green-700 px-5 md:px-8 py-2 rounded-full text-[11px] font-bold disabled:opacity-50 active:scale-95">{saving?"Saving...":"Save Bill"}</button>
        </div>
      </div>
    </div>
  );
}