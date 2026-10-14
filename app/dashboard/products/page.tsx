"use client";
import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { offlineDB } from "@/lib/offline-db";
import type { OfflineProduct } from "@/lib/offline-db";
import { getOfflineUser } from "@/lib/offline-auth";

type MainUnit = "box" | "bottle" | "tube" | "piece";

type Product = {
  _id: string; name: string; company?: string; generic?: string; batchNo?: string; expiryDate?: string; rack?: string; barcode?: string;
  mainUnit: MainUnit;
  pattaPerBox: number; mlPerBottle: number;
  buyPrice: number; sellPrice: number;
  stock: number;
  localId?: string; synced?: number;
};

type FormState = {
  name: string; company: string; generic: string; batchNo: string; expiryDate: string; rack: string; barcode: string;
  mainUnit: MainUnit;
  pattaPerBox: string; mlPerBottle: string;
  buyPrice: string; sellPrice: string; stock: string;
};

type Pagination = { page: number; totalPages: number; hasMore: boolean; totalCount: number };
type ProductsResponse = { products: Product[]; pagination: Pagination } | Product[];

function generateLocalId(): string {
  if (typeof crypto!== "undefined" && "randomUUID" in crypto) return `local_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
function useIsOnline(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("online", cb); window.addEventListener("offline", cb);
    return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
  }, []);
  const getSnapshot = useCallback(() => window.navigator.onLine, []);
  const getServerSnapshot = useCallback(() => true, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
function fmt1(n: number | string): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return v % 1 === 0? v.toFixed(0) : v.toFixed(1);
}

export default function ProductsPage() {
  const isOnline = useIsOnline();
  const isOffline =!isOnline;
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState<FormState>({
    name: "", company: "", generic: "", batchNo: "", expiryDate: "", rack: "", barcode: "",
    mainUnit: "box", pattaPerBox: "10", mlPerBottle: "120",
    buyPrice: "", sellPrice: "", stock: "10",
  });
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
        _id: c._id || c.localId, name: c.name, company: c.company, generic: c.generic, batchNo: c.batchNo, expiryDate: c.expiryDate, rack: c.rack, barcode: c.barcode,
        mainUnit: c.mainUnit as MainUnit,
        pattaPerBox: c.pattaPerBox, mlPerBottle: c.mlPerBottle,
        buyPrice: c.buyPrice, sellPrice: c.sellPrice, stock: c.stock,
        localId: c.localId, synced: c.synced,
      }));
      setProducts(filtered); setPagination({ page: 1, totalPages: 1, hasMore: false, totalCount: filtered.length }); return;
    }
    try {
      const res = await fetch(`/api/products?search=${encodeURIComponent(currentSearch)}&page=1&limit=20`);
      const data = (await res.json()) as ProductsResponse;
      if (Array.isArray(data)) {
        setProducts(data as Product[]);
        setPagination({ page: 1, totalPages: 1, hasMore: false, totalCount: data.length });
      } else { setProducts(data.products); setPagination(data.pagination); }
    } catch (err) { console.error(err); }
  }, []);

  const syncPendingProducts = useCallback(async () => {
    if (typeof window === "undefined" ||!window.navigator.onLine) return;
    const pending = await offlineDB.products.where("synced").equals(0).toArray();
    if (pending.length === 0) return; setSyncing(true); let synced = 0;
    for (const p of pending) {
      try {
        const isNew = p.localId.startsWith("local_");
        const url = isNew? "/api/products" : `/api/products/${p._id}`;
        const method = isNew? "POST" : "PUT";
        const res = await fetch(url, {
          method, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: p.name, company: p.company || "Unknown", generic: p.generic || "", batchNo: p.batchNo || "",
            expiryDate: p.expiryDate || undefined, rack: p.rack || "", barcode: p.barcode || "",
            mainUnit: p.mainUnit,
            pattaPerBox: p.pattaPerBox, mlPerBottle: p.mlPerBottle,
            buyPrice: p.buyPrice, sellPrice: p.sellPrice, stock: p.stock,
            localId: p.localId,
          })
        });
        if (res.ok) { await offlineDB.products.update(p.localId, { synced: 1 }); synced++; }
      } catch {}
    }
    setPendingCount((prev) => Math.max(0, prev - synced)); setSyncing(false);
    if (synced > 0) void refreshAfterAction(search);
  }, [refreshAfterAction, search]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (currentSearch: string, currentPage: number, signal: AbortSignal) => {
      if (currentPage === 1) setLoading(true); else setLoadingMore(true);
      try {
        const cached = await offlineDB.products.toArray();
        setPendingCount(cached.filter((c) => c.synced === 0).length);
        if (typeof window!== "undefined" &&!window.navigator.onLine) {
          const filtered = cached.filter((c) =>!currentSearch || c.name.toLowerCase().includes(currentSearch.toLowerCase()));
          const paged = filtered.slice(0, currentPage * 20).map((c) => ({
            _id: c._id || c.localId, name: c.name, company: c.company, generic: c.generic, batchNo: c.batchNo, expiryDate: c.expiryDate, rack: c.rack, barcode: c.barcode,
            mainUnit: c.mainUnit as MainUnit,
            pattaPerBox: c.pattaPerBox, mlPerBottle: c.mlPerBottle,
            buyPrice: c.buyPrice, sellPrice: c.sellPrice, stock: c.stock,
            localId: c.localId, synced: c.synced,
          }));
          setProducts(paged);
          setPagination({ page: 1, totalPages: 1, hasMore: filtered.length > paged.length, totalCount: filtered.length });
          return;
        }
        const res = await fetch(`/api/products?search=${encodeURIComponent(currentSearch)}&page=${currentPage}&limit=20`, { signal });
        const data = (await res.json()) as ProductsResponse;
        if (Array.isArray(data)) {
          setProducts(data as Product[]);
          setPagination({ page: 1, totalPages: 1, hasMore: false, totalCount: data.length });
        } else {
          if (currentPage === 1) setProducts(data.products); else setProducts((prev) => [...prev,...data.products]);
          setPagination(data.pagination);
        }
      } catch (err) { if ((err as Error).name!== "AbortError") console.error(err); }
      finally { setLoading(false); setLoadingMore(false); }
    };
    void load(search, page, controller.signal);
    return () => controller.abort();
  }, [search, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isOnline) void syncPendingProducts();
  }, [isOnline, syncPendingProducts]);

  const handleSearchChange = (value: string) => { setSearch(value); setPage(1); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const buy = Number(form.buyPrice);
    const sellInput = Number(form.sellPrice);
    const stock = Number(form.stock);
    const ppb = Number(form.pattaPerBox) || 10;
    if (sellInput <= 0 || buy <= 0) { alert("Buy & Sell price required"); return; }

    let sellToStore = sellInput;
    if (form.mainUnit === "box") {
      sellToStore = sellInput / ppb;
    }

    const payload = {
      name: form.name.trim(), company: form.company || "Unknown", generic: form.generic, batchNo: form.batchNo,
      expiryDate: form.expiryDate || undefined, rack: form.rack, barcode: form.barcode,
      mainUnit: form.mainUnit,
      pattaPerBox: ppb, mlPerBottle: Number(form.mlPerBottle) || 120,
      buyPrice: buy, sellPrice: sellToStore, stock: stock,
    };
    const offlineUser = getOfflineUser();
    if (typeof window!== "undefined" &&!window.navigator.onLine) {
      const localId = editId && editId.startsWith("local_")? editId : generateLocalId();
      const offlineProd: OfflineProduct = {
        _id: editId &&!editId.startsWith("local_")? editId : localId, localId,
        name: payload.name, company: payload.company, generic: payload.generic, batchNo: payload.batchNo,
        expiryDate: payload.expiryDate, rack: payload.rack, barcode: payload.barcode,
        mainUnit: payload.mainUnit, pattaPerBox: payload.pattaPerBox, mlPerBottle: payload.mlPerBottle,
        buyPrice: payload.buyPrice, sellPrice: payload.sellPrice, stock: payload.stock,
        userId: offlineUser?._id || "offline", synced: 0,
      };
      await offlineDB.products.put(offlineProd);
      setPendingCount((c) => c + 1);
      setForm({ name: "", company: "", generic: "", batchNo: "", expiryDate: "", rack: "", barcode: "", mainUnit: "box", pattaPerBox: "10", mlPerBottle: "120", buyPrice: "", sellPrice: "", stock: "10" });
      setEditId(null); await refreshAfterAction(search); return;
    }
    try {
      const url = editId &&!editId.startsWith("local_")? `/api/products/${editId}` : "/api/products";
      const method = editId &&!editId.startsWith("local_")? "PUT" : "POST";
      const body = editId && editId.startsWith("local_")? {...payload, localId: editId } : payload;
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("failed");
      if (editId && editId.startsWith("local_")) await offlineDB.products.delete(editId);
    } catch {
      const localId = editId || generateLocalId();
      const offlineProd: OfflineProduct = {
        _id: editId &&!editId.startsWith("local_")? editId : localId, localId,
        name: payload.name, company: payload.company, generic: payload.generic, batchNo: payload.batchNo,
        expiryDate: payload.expiryDate, rack: payload.rack, barcode: payload.barcode,
        mainUnit: payload.mainUnit, pattaPerBox: payload.pattaPerBox, mlPerBottle: payload.mlPerBottle,
        buyPrice: payload.buyPrice, sellPrice: payload.sellPrice, stock: payload.stock,
        userId: offlineUser?._id || "offline", synced: 0,
      };
      await offlineDB.products.put(offlineProd); setPendingCount((c) => c + 1);
    }
    setForm({ name: "", company: "", generic: "", batchNo: "", expiryDate: "", rack: "", barcode: "", mainUnit: "box", pattaPerBox: "10", mlPerBottle: "120", buyPrice: "", sellPrice: "", stock: "10" });
    setEditId(null); await refreshAfterAction(search);
  };

  const handleEdit = (p: Product) => {
    setEditId(p._id);
    const ppb = p.pattaPerBox || 10;
    const sellDisplay = p.mainUnit === "box"? String(p.sellPrice * ppb) : String(p.sellPrice);
    setForm({
      name: p.name, company: p.company || "", generic: p.generic || "", batchNo: p.batchNo || "", expiryDate: p.expiryDate? p.expiryDate.slice(0, 10) : "", rack: p.rack || "", barcode: p.barcode || "",
      mainUnit: p.mainUnit, pattaPerBox: String(ppb), mlPerBottle: String(p.mlPerBottle || 120),
      buyPrice: String(p.buyPrice), sellPrice: sellDisplay, stock: String(p.stock),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this medicine?")) return;
    if (id.startsWith("local_")) { await offlineDB.products.delete(id); setPendingCount((c) => Math.max(0, c - 1)); await refreshAfterAction(search); return; }
    try { await fetch(`/api/products/${id}`, { method: "DELETE" }); } catch { await offlineDB.products.delete(id); }
    await refreshAfterAction(search);
  };

  const ppbForm = Number(form.pattaPerBox) || 10;
  const buyForm = Number(form.buyPrice) || 0;
  const sellInputForm = Number(form.sellPrice) || 0;
  let profitPerPatta = 0;
  let profitPerBox = 0;
  let sellPerPattaDisplay = 0;
  if (buyForm > 0 && sellInputForm > 0) {
    if (form.mainUnit === "box") {
      sellPerPattaDisplay = sellInputForm / ppbForm;
      profitPerPatta = sellPerPattaDisplay - buyForm / ppbForm;
      profitPerBox = sellInputForm - buyForm;
    } else {
      profitPerPatta = sellInputForm - buyForm;
    }
  }

  return (
    <div className="p-3 sm:p-6 max-w-6xl mx-auto min-h-screen bg-gray-50">
      {isOffline && <div className="mb-3 bg-amber-50 border border-amber-200 text-amber-800 text-[12px] p-2.5 rounded-xl text-center">📶 Offline • {pendingCount} pending</div>}
      {pendingCount > 0 &&!isOffline && <div className="mb-3 bg-blue-50 border border-blue-200 text-blue-800 text-[12px] p-2.5 rounded-xl flex justify-between"><span>{pendingCount} pending sync</span><button onClick={() => syncPendingProducts()} disabled={syncing} className="bg-blue-600 text-white px-3 py-1 rounded-lg text-[11px]">{syncing? "Syncing..." : "Sync Now"}</button></div>}
      <div className="flex flex-col gap-3 mb-4"><h1 className="text-[20px] font-bold">💊 Yasir Medical - Stock V14.2.1 FIXED</h1><input placeholder="🔍 Search..." value={search} onChange={(e) => handleSearchChange(e.target.value)} className="border p-2.5 rounded-xl w-full sm:w-72 bg-white text-[14px]" /></div>
      <form onSubmit={handleSubmit} className="bg-white p-3 rounded-xl shadow-sm border mb-6">
        <p className="font-semibold mb-3 text-[13px]">{editId? "Edit Medicine" : "Add New Medicine - V14.2.1"}</p>
        <div className="grid grid-cols-2 sm:grid-cols-12 gap-2">
          <input placeholder="Medicine Name" value={form.name} onChange={(e) => setForm({...form, name: e.target.value })} className="border p-2.5 rounded-lg col-span-2 sm:col-span-4 text-[13px]" required />
          <input placeholder="Company" value={form.company} onChange={(e) => setForm({...form, company: e.target.value })} className="border p-2.5 rounded-lg sm:col-span-3 text-[13px]" />
          <input placeholder="Generic" value={form.generic} onChange={(e) => setForm({...form, generic: e.target.value })} className="border p-2.5 rounded-lg text-[13px]" />
          <input placeholder="Batch No" value={form.batchNo} onChange={(e) => setForm({...form, batchNo: e.target.value })} className="border p-2.5 rounded-lg text-[13px]" />
          <input placeholder="Barcode" value={form.barcode} onChange={(e) => setForm({...form, barcode: e.target.value })} className="border p-2.5 rounded-lg text-[13px]" />
          <input type="date" value={form.expiryDate} onChange={(e) => setForm({...form, expiryDate: e.target.value })} className="border p-2.5 rounded-lg text-[13px]" />
          <input placeholder="Rack" value={form.rack} onChange={(e) => setForm({...form, rack: e.target.value })} className="border p-2.5 rounded-lg text-[13px]" />
          <select value={form.mainUnit} onChange={(e) => setForm({...form, mainUnit: e.target.value as MainUnit })} className="border p-2.5 rounded-lg bg-white text-[13px] col-span-2">
            <option value="box">Stock Main: Box (10 Patta) - Enter Buy/Sell per Box</option>
            <option value="bottle">Stock Main: Bottle (120ml)</option>
            <option value="tube">Stock Main: Tube</option>
            <option value="piece">Stock Main: Piece</option>
          </select>
          {form.mainUnit === "box" && <input placeholder="Patta/Box" type="number" value={form.pattaPerBox} onChange={(e) => setForm({...form, pattaPerBox: e.target.value })} className="border p-2.5 rounded-lg text-[13px]" />}
          {form.mainUnit === "bottle" && <input placeholder="ml/Bottle" type="number" value={form.mlPerBottle} onChange={(e) => setForm({...form, mlPerBottle: e.target.value })} className="border p-2.5 rounded-lg text-[13px]" />}
          <input placeholder={`Buy per ${form.mainUnit} (e.g. 300)`} type="number" step="0.01" value={form.buyPrice} onChange={(e) => setForm({...form, buyPrice: e.target.value })} className="border p-2.5 rounded-lg text-[13px] bg-red-50/50" required />
          <input placeholder={form.mainUnit==="box"? "Sell per Box (e.g. 500)" : `Sell per ${form.mainUnit}`} type="number" step="0.01" value={form.sellPrice} onChange={(e) => setForm({...form, sellPrice: e.target.value })} className="border p-2.5 rounded-lg text-[13px] bg-blue-50/50" required />
          <input placeholder={`Stock in ${form.mainUnit} ONLY`} type="number" step="0.001" value={form.stock} onChange={(e) => setForm({...form, stock: e.target.value })} className="border p-2.5 rounded-lg text-[13px]" required />
        </div>
        {buyForm>0 && sellInputForm>0 && (
          <p className={`mt-2 text-[12px] ${profitPerPatta > 0? "text-green-600" : "text-red-600"}`}>
            {form.mainUnit==="box"? (
              <>Box Buy {buyForm} → Patta Buy {(buyForm/ppbForm).toFixed(1)} | Box Sell {sellInputForm} → Patta Sell {sellPerPattaDisplay.toFixed(1)} | <b>Profit Patta: Rs.{profitPerPatta.toFixed(1)} | Profit Box: Rs.{profitPerBox.toFixed(1)}</b> • {form.stock} box = {Number(form.stock)*ppbForm} Patta</>
            ) : (
              <>Profit per {form.mainUnit}: Rs.{profitPerPatta.toFixed(1)} • Stock {form.stock} {form.mainUnit}</>
            )}
          </p>
        )}
        <div className="flex gap-2 mt-3"><button type="submit" className="bg-green-600 text-white px-6 py-2 rounded-lg text-[13px]">{editId? "Update" : "+ Add Box/Bottle"}</button>{editId && <button type="button" onClick={() => { setEditId(null); setForm({ name: "", company: "", generic: "", batchNo: "", expiryDate: "", rack: "", barcode: "", mainUnit: "box", pattaPerBox: "10", mlPerBottle: "120", buyPrice: "", sellPrice: "", stock: "10" }); }} className="bg-gray-100 px-6 py-2 rounded-lg text-[13px]">Cancel</button>}</div>
      </form>
      {loading? <p className="text-center py-10 text-[13px]">Loading...</p> : (
        <><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">{products.map((p) => {
          const totalBuy = p.stock * p.buyPrice;
          const sellPerBox = p.mainUnit==="box"? p.sellPrice * p.pattaPerBox : p.sellPrice;
          const totalSell = p.stock * sellPerBox;
          const totalProfit = totalSell - totalBuy;
          return (
          <div key={p._id} className="bg-white border p-3 rounded-xl shadow-sm">
            <div className="flex justify-between"><p className="font-semibold text-[13px]">{p.name}</p><span className="text-[10px] bg-gray-100 px-2 py-0.5 rounded-full">Stock: {p.mainUnit}</span></div>
            <p className="text-[11px] text-gray-500">{p.company} {p.rack? `• ${p.rack}` : ""}</p>
            <div className="grid grid-cols-3 gap-1 mt-2 text-[10px]">
              <div className="bg-red-50 p-1.5 rounded text-center">
                <div className="text-gray-500 text-[9px]">Buy/{p.mainUnit}</div>
                <div className="font-bold text-[11px]">Rs.{fmt1(p.buyPrice)}</div>
                <div className="mt-1 pt-1 border-t border-red-200 font-bold text-orange-700">Total Buy<br/>Rs.{fmt1(totalBuy)}</div>
                <div className="text-[9px] text-gray-500">{fmt1(p.stock)} {p.mainUnit}</div>
              </div>
              <div className="bg-blue-50 p-1.5 rounded text-center">
                <div className="text-gray-500 text-[9px]">Sell/{p.mainUnit==="box"?`Box`:`${p.mainUnit}`}</div>
                <div className="font-bold text-[11px]">Rs.{p.mainUnit==="box"? fmt1(p.sellPrice) : fmt1(p.sellPrice)}/Patta</div>
                <div className="text-[9px]">Box: Rs.{fmt1(sellPerBox)}</div>
                <div className="mt-1 pt-1 border-t border-blue-200 font-bold text-green-700">Total Sell<br/>Rs.{fmt1(totalSell)}</div>
              </div>
              <div className="bg-green-50 p-1.5 rounded text-center">
                <div className="text-gray-500 text-[9px]">Stock</div>
                <div className="font-bold text-[11px]">{fmt1(p.stock)} {p.mainUnit}</div>
                <div className="text-[9px]">{p.mainUnit==="box"? `${fmt1(p.stock*p.pattaPerBox)} Patta` : `${p.mainUnit}`}</div>
                <div className="mt-1 pt-1 border-t border-green-200 font-bold text-blue-700">Profit<br/>Rs.{fmt1(totalProfit)}</div>
              </div>
            </div>
            <div className="flex gap-1.5 mt-2"><button onClick={() => handleEdit(p)} className="flex-1 bg-blue-50 text-blue-600 py-1.5 rounded-lg text-[11px]">Edit</button><button onClick={() => handleDelete(p._id)} className="flex-1 bg-red-50 text-red-600 py-1.5 rounded-lg text-[11px]">Del</button></div>
          </div>
        )})}</div>{pagination.hasMore && <button onClick={() => setPage((pr) => pr + 1)} disabled={loadingMore} className="w-full mt-4 py-2.5 bg-white border rounded-xl text-[13px]">{loadingMore? "Loading..." : `More (${pagination.totalCount - products.length})`}</button>}</>
      )}
    </div>
  );
}