"use client";
import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { offlineDB, OfflineProduct } from "@/lib/offline-db";
import { getOfflineUser } from "@/lib/offline-auth";

type MedicalUnit = "tablet" | "patta" | "half_patta" | "box" | "bottle" | "syrup" | "ml" | "liter" | "gram" | "kg" | "tube" | "sachet" | "piece" | "capsule" | "injection";
type BaseUnit = "tablet" | "ml" | "gram" | "piece";

type Product = {
  _id: string; name: string; company?: string; generic?: string; batchNo?: string; expiryDate?: string; rack?: string;
  price: number; buyPrice: number; sellPrice: number; unit: MedicalUnit; baseUnit?: BaseUnit; qtyPerUnit?: number; subUnit?: string;
  stock?: number; stockInPatta?: string; localId?: string; synced?: number; tabletsPerPatta?: number; pattaPerBox?: number;
};

type FormState = {
  name: string; company: string; generic: string; batchNo: string; expiryDate: string; rack: string;
  buyPrice: string; sellPrice: string; unit: MedicalUnit; baseUnit: BaseUnit; qtyPerUnit: string;
  stock: string; tabletsPerPatta: string; pattaPerBox: string;
};

type Pagination = { page: number; totalPages: number; hasMore: boolean; totalCount: number };
type ProductsResponse = { products: Product[]; pagination: Pagination } | Product[];

function generateLocalId(): string {
  if (typeof crypto!== "undefined" && "randomUUID" in crypto) return `local_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
function useIsOnline(): boolean {
  const subscribe = useCallback((cb: () => void) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; }, []);
  const getSnapshot = useCallback(() => window.navigator.onLine, []);
  const getServerSnapshot = useCallback(() => true, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
function detectBaseUnit(u: string): BaseUnit {
  if (["ml","liter","bottle","syrup"].includes(u)) return "ml";
  if (["gram","kg","tube"].includes(u)) return "gram";
  if (["piece","injection","capsule","sachet"].includes(u)) return "piece";
  return "tablet";
}

export default function ProductsPage() {
  const isOnline = useIsOnline(); const isOffline =!isOnline;
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState<FormState>({ name: "", company: "", generic: "", batchNo: "", expiryDate: "", rack: "", buyPrice: "", sellPrice: "", unit: "tablet", baseUnit: "tablet", qtyPerUnit: "10", stock: "100", tabletsPerPatta: "10", pattaPerBox: "10" });
  const [editId, setEditId] = useState<string | null>(null);
  const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, totalPages: 1, hasMore: false, totalCount: 0 });
  const [loading, setLoading] = useState(true); const [loadingMore, setLoadingMore] = useState(false);
  const [pendingCount, setPendingCount] = useState(0); const [syncing, setSyncing] = useState(false);

  const refreshAfterAction = useCallback(async (currentSearch: string) => {
    setPage(1);
    if (typeof window!== "undefined" &&!window.navigator.onLine) {
      const cached = await offlineDB.products.toArray();
      const filtered = cached.filter((c) =>!currentSearch || c.name.toLowerCase().includes(currentSearch.toLowerCase())).map((c) => ({
        _id: c._id || c.localId, name: c.name, company: c.company, price: c.price, buyPrice: c.buyPrice || 0, sellPrice: c.sellPrice || c.price,
        unit: (c.unit as MedicalUnit) || "tablet", baseUnit: (c.baseUnit as BaseUnit) || "tablet", qtyPerUnit: c.qtyPerUnit, stock: c.stock, stockInPatta: c.stockInPatta, localId: c.localId, synced: c.synced, tabletsPerPatta: c.tabletsPerPatta, pattaPerBox: c.pattaPerBox,
      }));
      setProducts(filtered); setPagination({ page: 1, totalPages: 1, hasMore: false, totalCount: filtered.length }); return;
    }
    try { const res = await fetch(`/api/products?search=${encodeURIComponent(currentSearch)}&page=1&limit=20`); const data = (await res.json()) as ProductsResponse;
      if (Array.isArray(data)) { setProducts(data as Product[]); setPagination({ page: 1, totalPages: 1, hasMore: false, totalCount: data.length }); }
      else { setProducts(data.products); setPagination(data.pagination); }
    } catch (err) { console.error(err); }
  }, []);

  const syncPendingProducts = useCallback(async () => {
    if (typeof window === "undefined" ||!window.navigator.onLine) return;
    const pending = await offlineDB.products.where("synced").equals(0).toArray(); if (pending.length === 0) return; setSyncing(true); let synced = 0;
    for (const p of pending) {
      try { const isNew = p.localId.startsWith("local_"); const url = isNew? "/api/products" : `/api/products/${p._id}`; const method = isNew? "POST" : "PUT";
        const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: p.name, company: p.company || "Unknown", generic: p.generic || "", batchNo: p.batchNo || "", expiryDate: p.expiryDate || undefined, rack: p.rack || "", buyPrice: p.buyPrice?? Math.round(p.price * 0.8), sellPrice: p.sellPrice?? p.price, price: p.price, unit: p.unit, baseUnit: p.baseUnit, qtyPerUnit: p.qtyPerUnit, stock: p.stock, tabletsPerPatta: p.tabletsPerPatta || 10, pattaPerBox: p.pattaPerBox || 10, localId: p.localId, }) });
        if (res.ok) { await offlineDB.products.update(p.localId, { synced: 1 }); synced++; }
      } catch {}
    }
    setPendingCount((prev) => Math.max(0, prev - synced)); setSyncing(false); if (synced > 0) void refreshAfterAction(search);
  }, [refreshAfterAction, search]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (currentSearch: string, currentPage: number, signal: AbortSignal) => {
      if (currentPage === 1) setLoading(true); else setLoadingMore(true);
      try {
        const cached = await offlineDB.products.toArray();
        const offlineFiltered = cached.filter((c) =>!currentSearch || c.name.toLowerCase().includes(currentSearch.toLowerCase())).map((c) => ({
          _id: c._id || c.localId, name: c.name, company: c.company, price: c.price, buyPrice: c.buyPrice || Math.round(c.price * 0.8), sellPrice: c.sellPrice || c.price,
          unit: (c.unit as MedicalUnit) || "tablet", baseUnit: (c.baseUnit as BaseUnit) || "tablet", qtyPerUnit: c.qtyPerUnit, stock: c.stock, stockInPatta: c.stockInPatta, localId: c.localId, synced: c.synced, tabletsPerPatta: c.tabletsPerPatta, pattaPerBox: c.pattaPerBox,
        }));
        setPendingCount(cached.filter((c) => c.synced === 0).length);
        if (currentPage === 1 && offlineFiltered.length > 0) setProducts(offlineFiltered.slice(0, 20));
        if (typeof window!== "undefined" &&!window.navigator.onLine) { const paged = offlineFiltered.slice(0, currentPage * 20); setProducts(paged); setPagination({ page: 1, totalPages: 1, hasMore: paged.length < offlineFiltered.length, totalCount: offlineFiltered.length }); return; }
        const res = await fetch(`/api/products?search=${encodeURIComponent(currentSearch)}&page=${currentPage}&limit=20`, { signal });
        const data = (await res.json()) as ProductsResponse;
        if (Array.isArray(data)) { setProducts(data as Product[]); setPagination({ page: 1, totalPages: 1, hasMore: false, totalCount: data.length });
          await offlineDB.products.clear(); const toCache: OfflineProduct[] = (data as Product[]).map((p) => ({ _id: p._id, localId: p._id, name: p.name, company: p.company || "Unknown", generic: p.generic || "", batchNo: p.batchNo || "", expiryDate: p.expiryDate, rack: p.rack || "", price: p.sellPrice || p.price, buyPrice: p.buyPrice || Math.round((p.sellPrice || p.price) * 0.8), sellPrice: p.sellPrice || p.price, stock: p.stock?? 0, stockInPatta: p.stockInPatta, unit: p.unit, baseUnit: p.baseUnit || "tablet", qtyPerUnit: p.qtyPerUnit || 10, userId: "cached", synced: 1 as const, tabletsPerPatta: p.tabletsPerPatta || 10, pattaPerBox: p.pattaPerBox || 10, })); await offlineDB.products.bulkAdd(toCache);
        } else { if (currentPage === 1) setProducts([...offlineFiltered.filter((o) => o.synced === 0),...data.products]); else setProducts((prev) => [...prev,...data.products]); setPagination(data.pagination);
          if (currentPage === 1) { const unsynced = cached.filter((c) => c.synced === 0); await offlineDB.products.clear();
            const toCache: OfflineProduct[] = [...unsynced,...data.products.map((p) => ({ _id: p._id, localId: p._id, name: p.name, company: p.company || "Unknown", generic: p.generic || "", batchNo: p.batchNo || "", expiryDate: p.expiryDate, rack: p.rack || "", price: p.sellPrice || p.price, buyPrice: p.buyPrice || Math.round((p.sellPrice || p.price) * 0.8), sellPrice: p.sellPrice || p.price, stock: p.stock?? 0, stockInPatta: p.stockInPatta, unit: p.unit, baseUnit: p.baseUnit || "tablet", qtyPerUnit: p.qtyPerUnit || 10, userId: "cached", synced: 1 as const, tabletsPerPatta: p.tabletsPerPatta || 10, pattaPerBox: p.pattaPerBox || 10, }))]; await offlineDB.products.bulkAdd(toCache); } }
      } catch (err) { if ((err as Error).name!== "AbortError") console.error(err); } finally { setLoading(false); setLoadingMore(false); }
    }; void load(search, page, controller.signal); return () => controller.abort();
  }, [search, page]);

  useEffect(() => { 
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isOnline) void syncPendingProducts(); }, [isOnline, syncPendingProducts]);

  const handleSearchChange = (value: string) => { setSearch(value); setPage(1); };

  const handleUnitChange = (newUnit: MedicalUnit) => {
    const bu = detectBaseUnit(newUnit);
    const qpu = bu === "ml"? "120" : bu === "gram"? "20" : "10";
    setForm({...form, unit: newUnit, baseUnit: bu, qtyPerUnit: qpu });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); const buy = Number(form.buyPrice); const sell = Number(form.sellPrice);
    if (sell <= 0) { alert("Sell price required"); return; }
    const payload = { name: form.name, company: form.company || "Unknown", generic: form.generic, batchNo: form.batchNo, expiryDate: form.expiryDate || undefined, rack: form.rack, buyPrice: buy, sellPrice: sell, price: sell, unit: form.unit, baseUnit: form.baseUnit, qtyPerUnit: Number(form.qtyPerUnit) || 10, subUnit: form.baseUnit, stock: Number(form.stock), tabletsPerPatta: Number(form.tabletsPerPatta) || 10, pattaPerBox: Number(form.pattaPerBox) || 10, };
    const offlineUser = getOfflineUser();
    if (typeof window!== "undefined" &&!window.navigator.onLine) {
      const localId = editId && editId.startsWith("local_")? editId : generateLocalId();
      const offlineProd: OfflineProduct = { _id: editId &&!editId.startsWith("local_")? editId : localId, localId, name: payload.name, company: payload.company, generic: payload.generic, batchNo: payload.batchNo, expiryDate: payload.expiryDate, rack: payload.rack, price: payload.sellPrice, buyPrice: payload.buyPrice, sellPrice: payload.sellPrice, stock: payload.stock, unit: payload.unit, baseUnit: payload.baseUnit, qtyPerUnit: payload.qtyPerUnit, userId: offlineUser?._id || "offline", synced: 0, tabletsPerPatta: payload.tabletsPerPatta, pattaPerBox: payload.pattaPerBox, };
      await offlineDB.products.put(offlineProd); setPendingCount((c) => c + 1); setForm({ name: "", company: "", generic: "", batchNo: "", expiryDate: "", rack: "", buyPrice: "", sellPrice: "", unit: "tablet", baseUnit: "tablet", qtyPerUnit: "10", stock: "100", tabletsPerPatta: "10", pattaPerBox: "10" }); setEditId(null); await refreshAfterAction(search); return;
    }
    try { const url = editId &&!editId.startsWith("local_")? `/api/products/${editId}` : "/api/products"; const method = editId &&!editId.startsWith("local_")? "PUT" : "POST"; const body = editId && editId.startsWith("local_")? {...payload, localId: editId } : payload; const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!res.ok) throw new Error("failed"); if (editId && editId.startsWith("local_")) await offlineDB.products.delete(editId); }
    catch { const localId = editId || generateLocalId(); const offlineProd: OfflineProduct = { _id: editId &&!editId.startsWith("local_")? editId : localId, localId, name: payload.name, company: payload.company, generic: payload.generic, batchNo: payload.batchNo, expiryDate: payload.expiryDate, rack: payload.rack, price: payload.sellPrice, buyPrice: payload.buyPrice, sellPrice: payload.sellPrice, stock: payload.stock, unit: payload.unit, baseUnit: payload.baseUnit, qtyPerUnit: payload.qtyPerUnit, userId: offlineUser?._id || "offline", synced: 0, tabletsPerPatta: payload.tabletsPerPatta, pattaPerBox: payload.pattaPerBox, }; await offlineDB.products.put(offlineProd); setPendingCount((c) => c + 1); }
    setForm({ name: "", company: "", generic: "", batchNo: "", expiryDate: "", rack: "", buyPrice: "", sellPrice: "", unit: "tablet", baseUnit: "tablet", qtyPerUnit: "10", stock: "100", tabletsPerPatta: "10", pattaPerBox: "10" }); setEditId(null); await refreshAfterAction(search);
  };

  const handleEdit = (p: Product) => {
    setEditId(p._id); setForm({ name: p.name, company: p.company || "", generic: p.generic || "", batchNo: p.batchNo || "", expiryDate: p.expiryDate? p.expiryDate.slice(0, 10) : "", rack: p.rack || "", buyPrice: String(p.buyPrice || Math.round((p.sellPrice || p.price) * 0.8)), sellPrice: String(p.sellPrice || p.price), unit: p.unit, baseUnit: p.baseUnit || detectBaseUnit(p.unit), qtyPerUnit: String(p.qtyPerUnit || (detectBaseUnit(p.unit)==="ml"?120:detectBaseUnit(p.unit)==="gram"?20:10)), stock: String(p.stock?? 100), tabletsPerPatta: String(p.tabletsPerPatta || 10), pattaPerBox: String(p.pattaPerBox || 10), }); window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleDelete = async (id: string) => { if (!window.confirm("Delete this medicine?")) return; if (id.startsWith("local_")) { await offlineDB.products.delete(id); setPendingCount((c) => Math.max(0, c - 1)); await refreshAfterAction(search); return; } try { await fetch(`/api/products/${id}`, { method: "DELETE" }); } catch { await offlineDB.products.delete(id); } await refreshAfterAction(search); };
  const liveProfit = form.buyPrice && form.sellPrice? Number(form.sellPrice) - Number(form.buyPrice) : 0;
  const isLiquid = form.baseUnit === "ml"; const isCream = form.baseUnit === "gram"; const isTablet = form.baseUnit === "tablet";

  return (
    <div className="p-3 sm:p-6 md:p-8 max-w-6xl mx-auto min-h-screen bg-gray-50">
      {isOffline && <div className="mb-3 bg-amber-50 border border-amber-200 text-amber-800 text-[12px] p-2.5 rounded-xl text-center font-medium">📶 Offline • {pendingCount} pending</div>}
      {pendingCount > 0 &&!isOffline && <div className="mb-3 bg-blue-50 border border-blue-200 text-blue-800 text-[12px] p-2.5 rounded-xl flex justify-between items-center"><span>{pendingCount} pending sync</span><button onClick={() => syncPendingProducts()} disabled={syncing} className="bg-blue-600 text-white px-3 py-1 rounded-lg text-[11px] disabled:opacity-50">{syncing? "Syncing..." : "Sync Now"}</button></div>}
      <div className="flex flex-col gap-3 mb-4"><h1 className="text-[20px] sm:text-2xl font-bold text-gray-800">💊 Yasir Medical - Stock V11</h1><input placeholder="🔍 Search medicine / company..." value={search} onChange={(e) => handleSearchChange(e.target.value)} className="border border-gray-200 p-2.5 rounded-xl w-full sm:w-72 focus:ring-2 focus:ring-green-500 outline-none bg-white text-[14px] shadow-sm" /></div>
      <form onSubmit={handleSubmit} className="bg-white p-3 sm:p-5 rounded-xl shadow-sm border border-gray-100 mb-6">
        <p className="font-semibold mb-3 text-gray-700 text-[13px]">{editId? "Edit Medicine" : "Add New Medicine"}</p>
        <div className="grid grid-cols-2 sm:grid-cols-12 gap-2">
          <input placeholder="Medicine Name e.g. Panadol" value={form.name} onChange={(e) => setForm({...form, name: e.target.value })} className="border p-2.5 rounded-lg col-span-2 sm:col-span-4 text-[13px] focus:ring-2 focus:ring-green-500 outline-none" required />
          <input placeholder="Company e.g. GSK" value={form.company} onChange={(e) => setForm({...form, company: e.target.value })} className="border p-2.5 rounded-lg col-span-1 sm:col-span-3 text-[13px] outline-none" />
          <input placeholder="Generic" value={form.generic} onChange={(e) => setForm({...form, generic: e.target.value })} className="border p-2.5 rounded-lg col-span-1 sm:col-span-2 text-[13px] outline-none" />
          <input placeholder="Batch No" value={form.batchNo} onChange={(e) => setForm({...form, batchNo: e.target.value })} className="border p-2.5 rounded-lg text-[13px] outline-none" />
          <input type="date" value={form.expiryDate} onChange={(e) => setForm({...form, expiryDate: e.target.value })} className="border p-2.5 rounded-lg text-[13px] outline-none" />
          <input placeholder="Rack A1" value={form.rack} onChange={(e) => setForm({...form, rack: e.target.value })} className="border p-2.5 rounded-lg text-[13px] outline-none" />
          <input placeholder="Buy per base" type="number" step="0.01" value={form.buyPrice} onChange={(e) => setForm({...form, buyPrice: e.target.value })} className="border p-2.5 rounded-lg text-[13px] bg-red-50/50 outline-none" required />
          <input placeholder="Sell per base" type="number" step="0.01" value={form.sellPrice} onChange={(e) => setForm({...form, sellPrice: e.target.value })} className="border p-2.5 rounded-lg text-[13px] bg-blue-50/50 outline-none" required />
          <select value={form.unit} onChange={(e) => handleUnitChange(e.target.value as MedicalUnit)} className="border p-2.5 rounded-lg bg-white text-[13px]">
            <optgroup label="Tablet"><option value="tablet">Tablet</option><option value="patta">Patta</option><option value="half_patta">Half Patta</option><option value="box">Box (tablet)</option><option value="capsule">Capsule</option><option value="sachet">Sachet</option></optgroup>
            <optgroup label="Liquid"><option value="bottle">Bottle (120ml)</option><option value="syrup">Syrup</option><option value="ml">ml</option><option value="liter">Liter</option></optgroup>
            <optgroup label="Cream/Gram"><option value="tube">Tube (20g)</option><option value="gram">Gram</option><option value="kg">KG</option></optgroup>
            <optgroup label="Other"><option value="piece">Piece</option><option value="injection">Injection</option></optgroup>
          </select>
          <select value={form.baseUnit} onChange={(e) => setForm({...form, baseUnit: e.target.value as BaseUnit })} className="border p-2.5 rounded-lg bg-white text-[13px]"><option value="tablet">Base: tablet</option><option value="ml">Base: ml</option><option value="gram">Base: gram</option><option value="piece">Base: piece</option></select>
          <input placeholder={isLiquid? "ml per Bottle e.g.120" : isCream? "gram per Tube e.g.20" : "qty per unit e.g.10"} type="number" value={form.qtyPerUnit} onChange={(e) => setForm({...form, qtyPerUnit: e.target.value })} className="border p-2.5 rounded-lg text-[13px] outline-none" />
          <input placeholder={isLiquid? "Stock (ml)" : isCream? "Stock (gram)" : "Stock (tabs)"} type="number" value={form.stock} onChange={(e) => setForm({...form, stock: e.target.value })} className="border p-2.5 rounded-lg text-[13px] outline-none" />
          {isTablet && <><input placeholder="Tab/Patta e.g.10" type="number" value={form.tabletsPerPatta} onChange={(e) => setForm({...form, tabletsPerPatta: e.target.value })} className="border p-2.5 rounded-lg text-[13px] outline-none" /><input placeholder="Patta/Box e.g.10" type="number" value={form.pattaPerBox} onChange={(e) => setForm({...form, pattaPerBox: e.target.value })} className="border p-2.5 rounded-lg text-[13px] outline-none" /></>}
        </div>
        <div className="mt-2 text-[11px] text-gray-500">
          {isTablet && <>Patta: Rs.{form.sellPrice? (Number(form.sellPrice) * (Number(form.tabletsPerPatta) || 10)).toFixed(0) : 0} | Box: Rs.{form.sellPrice? (Number(form.sellPrice) * (Number(form.tabletsPerPatta) || 10) * (Number(form.pattaPerBox) || 10)).toFixed(0) : 0}</>}
          {isLiquid && <>Bottle ({form.qtyPerUnit}ml): Rs.{form.sellPrice? (Number(form.sellPrice) * (Number(form.qtyPerUnit) || 120)).toFixed(0) : 0}</>}
          {isCream && <>Tube ({form.qtyPerUnit}g): Rs.{form.sellPrice? (Number(form.sellPrice) * (Number(form.qtyPerUnit) || 20)).toFixed(0) : 0}</>}
          {" "}• Base: {form.baseUnit}
        </div>
        {liveProfit!== 0 && <p className={`mt-2 text-[12px] font-medium ${liveProfit > 0? "text-green-600" : "text-red-600"}`}>Profit per {form.baseUnit}: Rs.{liveProfit}</p>}
        <div className="flex gap-2 mt-3"><button type="submit" className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-lg text-[13px] font-medium">{editId? "Update" : "+ Add Medicine"}</button>{editId && <button type="button" onClick={() => { setEditId(null); setForm({ name: "", company: "", generic: "", batchNo: "", expiryDate: "", rack: "", buyPrice: "", sellPrice: "", unit: "tablet", baseUnit: "tablet", qtyPerUnit: "10", stock: "100", tabletsPerPatta: "10", pattaPerBox: "10" }); }} className="bg-gray-100 px-6 py-2 rounded-lg text-[13px]">Cancel</button>}</div>
      </form>
      {loading? <p className="text-center text-gray-400 py-10 text-[13px]">Loading...</p> : (
        <><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">{products.map((p) => { const sell = p.sellPrice || p.price; const buy = p.buyPrice || Math.round(sell * 0.8); return (<div key={p._id} className={`bg-white border p-3 rounded-xl shadow-sm ${p._id.startsWith("local_")? "bg-amber-50/60" : ""}`}><div className="flex justify-between"><p className="font-semibold text-[13px]">{p.name}</p><span className="text-[10px] bg-gray-100 px-2 py-0.5 rounded-full">{p.unit} • {p.baseUnit || "tablet"} • {p.company}</span></div><p className="text-[11px] text-gray-500">{p.generic} {p.rack? `• Rack:${p.rack}` : ""}</p><div className="grid grid-cols-3 gap-1 mt-2 text-[10px]"><div className="bg-red-50 p-1.5 rounded text-center"><div className="text-gray-500">Buy/{p.baseUnit}</div><div className="font-bold text-red-600">Rs.{buy}</div></div><div className="bg-blue-50 p-1.5 rounded text-center"><div className="text-gray-500">Sell/{p.baseUnit}</div><div className="font-bold text-blue-600">Rs.{sell}</div></div><div className="bg-green-50 p-1.5 rounded text-center"><div className="text-gray-500">Profit</div><div className="font-bold text-green-600">Rs.{sell - buy}</div></div></div><p className="text-[11px] text-gray-500 mt-1">Stock: {p.stockInPatta || `${p.stock} ${p.baseUnit || "Tab"}`} {p.qtyPerUnit? `• ${p.qtyPerUnit}${p.baseUnit}` : ""} {p.batchNo? `• B:${p.batchNo}` : ""}</p><div className="flex gap-1.5 mt-2"><button onClick={() => handleEdit(p)} className="flex-1 bg-blue-50 text-blue-600 py-1.5 rounded-lg text-[11px]">Edit</button><button onClick={() => handleDelete(p._id)} className="flex-1 bg-red-50 text-red-600 py-1.5 rounded-lg text-[11px]">Del</button></div></div>); })}</div>{pagination.hasMore && <button onClick={() => setPage((pr) => pr + 1)} disabled={loadingMore} className="w-full mt-4 py-2.5 bg-white border rounded-xl text-[13px]"> {loadingMore? "Loading..." : `More (${pagination.totalCount - products.length})`}</button>}</>
      )}
    </div>
  );
}