"use client";
import { useEffect, useState } from "react";

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

  useEffect(() => {
    const load = async () => {
      if (search.length < 2) { setProducts([]); return; }
      setLoading(true);
      try {
        const res = await fetch(`/api/products?search=${encodeURIComponent(search)}&page=1&limit=10`);
        const data = await res.json() as { products: Product[] };
        setProducts(data.products || []);
      } catch { setProducts([]); }
      setLoading(false);
    };
    const id = setTimeout(load, 300);
    return () => clearTimeout(id);
  }, [search]);

  const addToBill = (p: Product) => {
    if (bill.find((b) => b.productId === p._id)) {
      setSearch(""); setProducts([]); return;
    }
    setBill((prev) => [
     ...prev,
      {
        productId: p._id,
        name: p.name,
        company: p.company,
        quantity: 1,
        buyPricePerUnit: p.buyPrice,
        sellPricePerUnit: p.sellPrice,
        mainUnit: p.mainUnit,
      },
    ]);
    setSearch("");
    setProducts([]);
  };

  const addCustom = () => {
    if (!search.trim()) return;
    if (bill.find(b => b.name.toLowerCase() === search.trim().toLowerCase())) {
      setSearch(""); return;
    }
    setBill(prev => [
     ...prev,
      {
        name: search.trim(),
        company: "",
        quantity: 1,
        buyPricePerUnit: 100,
        sellPricePerUnit: 120,
        mainUnit: "box",
      }
    ]);
    setSearch("");
    setProducts([]);
  };

  const totalBuy = bill.reduce((s, it) => s + it.quantity * it.buyPricePerUnit, 0);

  const saveBill = async () => {
    if (!bill.length) { alert("Add medicines first"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplier,
          invoiceNo,
          items: bill,
          totalBuyAmount: totalBuy,
          paymentType: "cash",
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err);
      }
      alert(`Purchase saved! Rs.${totalBuy} — Stock updated`);
      setBill([]);
      setInvoiceNo("");
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-2">
      <h1 className="text-[14px] font-bold mb-2">📦 New Purchase — Yasir Medical</h1>

      <div className="bg-white border rounded-xl p-2 mb-2 flex gap-1">
        <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Supplier" className="flex-1 border rounded-lg p-2 text-[11px] h-8" />
        <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="Invoice No" className="flex-1 border rounded-lg p-2 text-[11px] h-8" />
      </div>

      <div className="relative bg-white border rounded-xl p-2 mb-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Search medicine e.g. panadol" className="w-full border rounded-lg p-2 text-[11px] h-9" />
        {loading && <p className="text-[10px] text-gray-400 mt-1">Searching...</p>}
        {products.length > 0 && (
          <div className="absolute left-2 right-2 top-12 bg-white border shadow-xl rounded-xl z-20 max-h-60 overflow-y-auto">
            {products.map((p) => (
              <button key={p._id} onClick={() => addToBill(p)} className="w-full text-left p-2 border-b hover:bg-green-50 flex justify-between">
                <span className="text-[11px] font-bold">{p.name} <span className="font-normal text-gray-400">{p.company}</span></span>
                <span className="text-[9px] bg-gray-100 px-2 rounded-full">Stk {p.stock} • Buy {p.buyPrice}</span>
              </button>
            ))}
            <button onClick={addCustom} className="w-full p-2 text-[11px] text-blue-600 bg-blue-50 font-bold">+ Add as new: {search}</button>
          </div>
        )}
        {search.length >=2 && products.length===0 &&!loading && (
          <div className="mt-2">
            <p className="text-[10px] text-gray-400">Not in stock</p>
            <button onClick={addCustom} className="mt-1 bg-blue-600 text-white px-3 py-1 rounded-full text-[11px]">+ Add new medicine: {search}</button>
          </div>
        )}
      </div>

      <div className="bg-white border rounded-xl overflow-hidden mb-3">
        {bill.length === 0? (
          <p className="p-6 text-center text-[11px] text-gray-400">No items — search and add medicine</p>
        ) : bill.map((it, idx) => (
          <div key={idx} className="p-2 border-b flex flex-col gap-1">
            <div className="flex justify-between">
              <p className="font-bold text-[11px]">{it.name} {it.company? `(${it.company})`:""} {it.productId? "" : "(NEW)"}</p>
              <button onClick={() => setBill((prev) => prev.filter((_, i) => i!== idx))} className="text-[9px] bg-red-50 text-red-600 px-2 rounded-full">Del</button>
            </div>
            <div className="flex gap-1">
              <div className="flex-1">
                <label className="text-[8px] text-gray-500">Qty ({it.mainUnit})</label>
                <input type="number" value={it.quantity} onChange={(e) => setBill((prev) => prev.map((b,i) => i===idx? {...b, quantity: Math.max(1, Number(e.target.value)||1)}:b))} className="w-full border rounded-lg p-1 text-[11px] h-7" />
              </div>
              <div className="flex-1">
                <label className="text-[8px] text-blue-600 font-bold">Buy Price</label>
                <input type="number" value={it.buyPricePerUnit} onChange={(e) => setBill((prev) => prev.map((b,i) => i===idx? {...b, buyPricePerUnit: Number(e.target.value)||0}:b))} className="w-full border rounded-lg p-1 text-[11px] h-7 bg-blue-50/50" />
              </div>
              <div className="flex-1">
                <label className="text-[8px] text-gray-500">Sell Price</label>
                <input type="number" value={it.sellPricePerUnit} onChange={(e) => setBill((prev) => prev.map((b,i) => i===idx? {...b, sellPricePerUnit: Number(e.target.value)||0}:b))} className="w-full border rounded-lg p-1 text-[11px] h-7" />
              </div>
              <div className="text-[10px] font-bold flex items-end">Rs.{it.quantity*it.buyPricePerUnit}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-green-600 text-white rounded-xl p-3 flex justify-between items-center sticky bottom-2">
        <div>
          <p className="text-[11px] opacity-80">{bill.length} items • Total Kharidari</p>
          <p className="text-[16px] font-bold">Rs.{totalBuy}</p>
        </div>
        <button onClick={saveBill} disabled={saving || bill.length===0} className="bg-white text-green-700 px-6 py-2 rounded-full text-[11px] font-bold disabled:opacity-50">{saving? "Saving...":"Save Bill & Update Stock"}</button>
      </div>
    </div>
  );
}