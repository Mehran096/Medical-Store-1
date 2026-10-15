"use client";
import { useEffect, useState } from "react";
import { offlineDB, addOfflinePurchase } from "@/lib/offline-db";
import type { OfflinePurchaseItem } from "@/lib/offline-db";
import { syncAllOffline } from "@/lib/offline-sync";

type Product = {
  _id: string;
  name: string;
  company?: string;
  buyPrice: number;
  sellPrice: number;
  stock: number;
  mainUnit: "box" | "bottle" | "tube" | "piece";
};

type BillItem = {
  productId?: string;
  name: string;
  company?: string;
  quantity: number;
  buyPricePerUnit: number;
  sellPricePerUnit: number;
  mainUnit: Product["mainUnit"];
};

export default function PurchasesPage() {
  const [search, setSearch] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [bill, setBill] = useState<BillItem[]>([]);
  const [supplier, setSupplier] = useState("Peshawar Market");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [userId, setUserId] = useState<string>("");

  useEffect(() => {
    fetch("/api/auth/session").then(r=>r.json()).then((s: { user?: { id?: string } })=>{
      if(s?.user?.id) setUserId(s.user.id);
    }).catch(()=>{});
  }, []);

  useEffect(() => {
    const load = async () => {
      if (search.length < 2) { setProducts([]); return; }
      setLoading(true);
      try {
        if (!navigator.onLine) {
          const offline = await offlineDB.products.where('name').startsWithIgnoreCase(search).limit(10).toArray();
          setProducts(offline.map(o=>({
            _id: o._id || o.localId,
            name: o.name,
            company: o.company,
            buyPrice: o.buyPrice,
            sellPrice: o.sellPrice,
            stock: o.stock,
            mainUnit: o.mainUnit,
          })) as Product[]);
        } else {
          const res = await fetch(`/api/products?search=${encodeURIComponent(search)}&page=1&limit=10`);
          const data = await res.json() as { products: Product[] };
          setProducts(data.products || []);
        }
      } catch { setProducts([]); }
      setLoading(false);
    };
    const id = setTimeout(load, 300);
    return () => clearTimeout(id);
  }, [search]);

  const addToBill = (p: Product) => {
    if (bill.find((b) => b.productId === p._id)) { setSearch(""); setProducts([]); return; }
    setBill(prev => [...prev, { productId: p._id, name: p.name, company: p.company, quantity: 1, buyPricePerUnit: p.buyPrice, sellPricePerUnit: p.sellPrice, mainUnit: p.mainUnit }]);
    setSearch(""); setProducts([]);
  };

  const addCustom = () => {
    if (!search.trim()) return;
    if (bill.find(b => b.name.toLowerCase() === search.trim().toLowerCase())) { setSearch(""); return; }
    setBill(prev => [...prev, { name: search.trim(), company: "", quantity: 1, buyPricePerUnit: 0, sellPricePerUnit: 0, mainUnit: "box" }]);
    setSearch(""); setProducts([]);
  };

  const updateQty = (idx: number, val: string) => {
    setBill(prev => prev.map((b,i) => i!==idx? b : val===""? {...b, quantity:0} : {...b, quantity: parseInt(val.replace(/[^0-9]/g,""))||0}));
  };
  const updatePrice = (idx: number, field: "buyPricePerUnit"|"sellPricePerUnit", val: string) => {
    setBill(prev => prev.map((b,i) => i!==idx? b : val===""? {...b, [field]:0} : {...b, [field]: parseFloat(val)||0}));
  };

  const totalBuy = bill.reduce((s, it) => s + it.quantity * it.buyPricePerUnit, 0);

  const saveBill = async () => {
    if (!bill.length) return alert("Add medicines first");
    const clean = bill.filter(b => b.quantity>0);
    if(!clean.length) return alert("Qty can't be 0");
    const offlineItems: OfflinePurchaseItem[] = clean.map(c=>({
      productId: c.productId,
      name: c.name,
      company: c.company,
      quantity: c.quantity,
      mainUnit: c.mainUnit,
      buyPricePerUnit: c.buyPricePerUnit,
      sellPricePerUnit: c.sellPricePerUnit,
    }));
    const totalAmount = clean.reduce((s,it)=>s+it.quantity*it.buyPricePerUnit,0);
    setSaving(true);
    try {
      if (typeof window!== 'undefined' &&!navigator.onLine) {
        await addOfflinePurchase(offlineItems, supplier, invoiceNo, userId || "offline_user", "cash");
        alert(`Saved Offline Rs.${totalAmount} - will sync when online`);
        setBill([]); setInvoiceNo("");
        return;
      }
      const res = await fetch("/api/purchases", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ supplier, invoiceNo, items: clean, totalBuyAmount: totalAmount, paymentType:"cash"})
      });
      if(!res.ok) throw new Error(await res.text());
      void syncAllOffline();
      alert(`Saved Rs.${totalAmount}`);
      setBill([]); setInvoiceNo("");
    } catch(e){
      try {
        await addOfflinePurchase(offlineItems, supplier, invoiceNo, userId || "offline_user", "cash");
        alert(`Server error - Saved Offline Rs.${totalAmount}`);
        setBill([]); setInvoiceNo("");
      } catch {
        alert((e as Error).message);
      }
    } finally{ setSaving(false); }
  };

  return (
    <div className="min-h-screen bg-gray-50 md:bg-gray-100">
      <div className="w-full max-w-5xl mx-auto p-2 md:p-6 pb-28">
        <h1 className="text-[12px] md:text-xl font-bold mb-2 md:mb-4">📦 New Purchase — Yasir Medical {typeof window!=='undefined' &&!navigator.onLine && <span className="ml-2 text-[9px] bg-red-100 text-red-600 px-2 py-0.5 rounded-full">OFFLINE</span>}</h1>

        <div className="bg-white border rounded-xl p-2 md:p-4 mb-2 md:mb-4 flex gap-2">
          <input value={supplier} onChange={e=>setSupplier(e.target.value)} placeholder="Supplier" className="flex-1 border rounded-lg px-2 md:px-4 py-1 text-[11px] md:text-[15px] h-8 md:h-11 outline-none focus:border-green-600 focus:ring-1 focus:ring-green-600" />
          <input value={invoiceNo} onChange={e=>setInvoiceNo(e.target.value)} placeholder="#Inv No" className="w-24 md:w-36 border rounded-lg px-2 md:px-4 py-1 text-[11px] md:text-[15px] h-8 md:h-11 outline-none focus:border-green-600" />
        </div>

        <div className="relative bg-white border rounded-xl p-2 md:p-4 mb-2 md:mb-4">
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Search medicine e.g. panadol" className="w-full border rounded-lg px-2 md:px-4 py-1 text-[11px] md:text-[15px] h-8 md:h-12 outline-none focus:border-green-600 focus:ring-1 focus:ring-green-600" />
          {loading && <p className="text-[10px] md:text-sm text-gray-400 mt-2">Searching...</p>}
          {products.length>0 && (
            <div className="absolute left-2 right-2 md:left-4 md:right-4 top-11 md:top-[60px] bg-white border shadow-xl rounded-xl z-20 max-h-72 overflow-auto">
              {products.map(p=>(
                <button key={p._id} onClick={()=>addToBill(p)} className="w-full text-left p-2 md:p-3 border-b hover:bg-green-50 flex justify-between items-center">
                  <span className="text-[11px] md:text-[14px] font-bold">{p.name} <span className="font-normal text-gray-400 text-[9px] md:text-xs ml-1">{p.company}</span></span>
                  <span className="text-[8px] md:text-xs bg-gray-100 px-2 py-1 rounded-full">Stk {p.stock} • Rs.{p.buyPrice}</span>
                </button>
              ))}
              <button onClick={addCustom} className="w-full p-2 md:p-3 text-[11px] md:text-sm text-blue-600 bg-blue-50 font-bold">+ Add as new: {search}</button>
            </div>
          )}
          {search.length>=2 && products.length===0 &&!loading && (
            <div className="mt-2 flex gap-2 items-center">
              <p className="text-[10px] md:text-sm text-gray-400">Not found</p>
              <button onClick={addCustom} className="bg-blue-600 text-white px-3 py-1 rounded-full text-[10px] md:text-xs">+ Add {search}</button>
            </div>
          )}
        </div>

        <div className="bg-white border rounded-xl overflow-hidden">
          {bill.length===0? <p className="p-6 md:p-10 text-center text-[11px] md:text-sm text-gray-400">No items — search and add medicine</p> :
            bill.map((it, idx)=>(
              <div key={idx} className="p-2 md:p-4 border-b hover:bg-gray-50/50">
                <div className="flex justify-between items-center mb-1 md:mb-2">
                  <p className="font-bold text-[11px] md:text-[15px] truncate pr-2">{it.name} {it.company? `(${it.company})`:""} {!it.productId && <span className="ml-1 text-[8px] md:text-[10px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">NEW</span>}</p>
                  <button onClick={()=>setBill(prev=>prev.filter((_,i)=>i!==idx))} className="text-[9px] md:text-xs bg-red-50 text-red-600 px-2 md:px-3 py-0.5 md:py-1 rounded-full hover:bg-red-100">Del</button>
                </div>
                <div className="grid grid-cols-4 md:grid-cols-[120px_1fr_1fr_110px] gap-1 md:gap-4 items-end">
                  <div>
                    <label className="text-[8px] md:text-[11px] text-gray-500 block mb-0.5">Qty ({it.mainUnit})</label>
                    <input type="text" inputMode="numeric" value={it.quantity===0?"":it.quantity} placeholder="1" onFocus={e=>e.target.select()} onChange={e=>updateQty(idx,e.target.value)} className="w-full border rounded-lg px-2 md:px-3 py-1 text-[11px] md:text-[15px] h-7 md:h-11 text-center md:text-left outline-none focus:border-green-600" />
                  </div>
                  <div>
                    <label className="text-[8px] md:text-[11px] text-blue-600 font-bold block mb-0.5">Buy Price</label>
                    <input type="text" inputMode="decimal" value={it.buyPricePerUnit===0?"":it.buyPricePerUnit} placeholder="0" onFocus={e=>e.target.select()} onChange={e=>updatePrice(idx,"buyPricePerUnit",e.target.value)} className="w-full border rounded-lg px-2 md:px-3 py-1 text-[11px] md:text-[15px] h-7 md:h-11 bg-blue-50/40 outline-none focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="text-[8px] md:text-[11px] text-gray-500 block mb-0.5">Sell Price</label>
                    <input type="text" inputMode="decimal" value={it.sellPricePerUnit===0?"":it.sellPricePerUnit} placeholder="0" onFocus={e=>e.target.select()} onChange={e=>updatePrice(idx,"sellPricePerUnit",e.target.value)} className="w-full border rounded-lg px-2 md:px-3 py-1 text-[11px] md:text-[15px] h-7 md:h-11 outline-none focus:border-green-600" />
                  </div>
                  <div className="text-[10px] md:text-[14px] font-bold h-7 md:h-11 flex items-center justify-center bg-gray-100 md:bg-gray-50 rounded-lg">Rs.{it.quantity*it.buyPricePerUnit}</div>
                </div>
              </div>
            ))
          }
        </div>

        <div className="bg-green-600 text-white rounded-xl p-3 md:p-4 flex justify-between items-center fixed md:sticky bottom-2 md:bottom-0 left-2 right-2 md:left-auto md:right-auto md:mt-4 shadow-xl z-30 max-w-5xl mx-auto">
          <div>
            <p className="text-[10px] md:text-xs opacity-80">{bill.length} items • Total Kharidari</p>
            <p className="text-[15px] md:text-xl font-bold">Rs.{totalBuy}</p>
          </div>
          <button onClick={saveBill} disabled={saving||!bill.length} className="bg-white text-green-700 px-5 md:px-8 py-2 md:py-3 rounded-full text-[11px] md:text-sm font-bold disabled:opacity-50 hover:bg-gray-50 active:scale-95 transition">{saving?"Saving...":"Save Bill"}</button>
        </div>
      </div>
    </div>
  );
}