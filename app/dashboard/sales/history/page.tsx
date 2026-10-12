"use client";
import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import Image from "next/image";
import { offlineDB, OfflineSale } from "@/lib/offline-db";

type MedicalUnit = "tablet" | "patta" | "half_patta" | "box" | "bottle" | "syrup" | "ml" | "liter" | "gram" | "kg" | "tube" | "sachet" | "piece" | "capsule" | "injection";
type BaseUnit = "tablet" | "ml" | "gram" | "piece";

type Sale = {
  _id: string; localId?: string; saleId?: string; productName: string; quantity: number;
  quantityInTablets?: number; quantityInSub?: number; totalTablets?: number;
  unit?: MedicalUnit; baseUnit?: BaseUnit; qtyPerUnit?: number; tabletsPerPatta?: number; pattaPerBox?: number;
  price: number; buyPrice: number; sellPrice: number; profit: number; discount: number; total: number;
  createdAt: string; synced?: number; customerName?: string; status?: string; paymentType?: string; pendingAmount?: number; isCredit?: boolean;
};
type OfflineCustomer = { name: string; totalUdhar?: number; lastUdharDate?: string; createdAt: string; };
type OfflineSaleWithSub = OfflineSale & { quantityInSub?: number; baseUnit?: BaseUnit; qtyPerUnit?: number; saleId?: string; status?: string; };

type FilterType = "today" | "yesterday" | "weekly" | "monthly" | "yearly" | "all";
type Pagination = { page: number; totalPages: number; hasMore: boolean; totalCount: number };
const FILTERS: FilterType[] = ["today", "yesterday", "weekly", "monthly", "yearly", "all"];

function isDateInFilter(dateStr: string | undefined, filter: FilterType): boolean {
  if (filter === "all") return true; if (!dateStr) return true; const d = new Date(dateStr); const now = new Date(); const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  if (filter === "today") return d >= startToday;
  if (filter === "yesterday") { const sy = new Date(startToday); sy.setDate(sy.getDate() - 1); return d >= sy && d < startToday; }
  if (filter === "weekly") { const sw = new Date(now); sw.setDate(now.getDate() - 7); sw.setHours(0, 0, 0, 0); return d >= sw; }
  if (filter === "monthly") { const sm = new Date(now.getFullYear(), now.getMonth(), 1); return d >= sm; }
  if (filter === "yearly") { const sy = new Date(now.getFullYear(), 0, 1); return d >= sy; }
  return true;
}
function useIsOnline(): boolean {
  const subscribe = useCallback((cb: () => void) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; }, []);
  const getSnapshot = useCallback(() => window.navigator.onLine, []); const getServerSnapshot = useCallback(() => true, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
function mapOffline(o: OfflineSaleWithSub): Sale {
  return {
    _id: o.localId, localId: o.localId, saleId: o.saleId || o.localId, productName: o.productName, quantity: o.quantity,
    quantityInTablets: o.quantityInTablets?? o.totalTablets, quantityInSub: o.quantityInSub?? o.quantityInTablets?? o.totalTablets, totalTablets: o.totalTablets?? o.quantityInTablets,
    unit: (o.unit as MedicalUnit)?? "tablet", baseUnit: (o.baseUnit as BaseUnit)?? "tablet", qtyPerUnit: o.qtyPerUnit,
    tabletsPerPatta: o.tabletsPerPatta, pattaPerBox: o.pattaPerBox, price: o.price?? o.sellPrice?? 0, buyPrice: o.buyPrice?? 0, sellPrice: o.sellPrice?? o.price, profit: o.profit?? 0, discount: 0, total: o.total, createdAt: o.createdAt, synced: o.synced,
    customerName: o.customerName, status: o.isCredit || o.paymentType === "credit"? "pending" : "paid", paymentType: o.paymentType, pendingAmount: o.isCredit? o.total : 0, isCredit: o.isCredit,
  };
}

export default function SalesHistoryPage() {
  const isOnline = useIsOnline(); const isOffline =!isOnline;
  const [sales, setSales] = useState<Sale[]>([]); const [total, setTotal] = useState(0); const [profit, setProfit] = useState(0); const [buyTotal, setBuyTotal] = useState(0); const [pendingTotal, setPendingTotal] = useState(0);
  const [filter, setFilter] = useState<FilterType>("all"); const [search, setSearch] = useState(""); const [statusFilter, setStatusFilter] = useState<"all" | "paid" | "pending">("all");
  const [page, setPage] = useState(1); const [pagination, setPagination] = useState<Pagination>({ page: 1, totalPages: 1, hasMore: false, totalCount: 0 });
  const [loading, setLoading] = useState(true); const [pendingCount, setPendingCount] = useState(0);

  const loadData = useCallback(async (currentFilter: FilterType, currentSearch: string, currentPage: number, currentStatus: string, signal?: AbortSignal) => {
    if (currentPage === 1) setLoading(true);
    try {
      const offlineAll = (await offlineDB.sales.reverse().toArray()) as unknown as OfflineSaleWithSub[]; const offlineUnsyncedAll = offlineAll.filter((s) => s.synced === 0);
      const offlineFilteredAll = offlineAll.filter((o) => isDateInFilter(o.createdAt, currentFilter)); const offlineFilteredUnsynced = offlineUnsyncedAll.filter((o) => isDateInFilter(o.createdAt, currentFilter));
      const offlineMappedAll = offlineFilteredAll.filter((o) =>!currentSearch || o.productName.toLowerCase().includes(currentSearch.toLowerCase()) || (o.customerName || "").toLowerCase().includes(currentSearch.toLowerCase())).filter((o) => { if (currentStatus === "all") return true; const isUdhar = o.isCredit || o.paymentType === "credit" || o.status === "pending"; return currentStatus === "pending"? isUdhar :!isUdhar; }).map(mapOffline);
      const offlineMappedUnsynced = offlineFilteredUnsynced.filter((o) =>!currentSearch || o.productName.toLowerCase().includes(currentSearch.toLowerCase()) || (o.customerName || "").toLowerCase().includes(currentSearch.toLowerCase())).filter((o) => { if (currentStatus === "all") return true; const isUdhar = o.isCredit || o.paymentType === "credit" || o.status === "pending"; return currentStatus === "pending"? isUdhar :!isUdhar; }).map(mapOffline);
      const dedupedUnsynced = Array.from(new Map(offlineMappedUnsynced.map((s) => [s.saleId || s._id, s])).values()); const dedupedAll = Array.from(new Map(offlineMappedAll.map((s) => [s.saleId || s._id, s])).values());
      const allCustomers = (await offlineDB.customers.toArray()) as unknown as OfflineCustomer[]; const filteredCustomers = allCustomers.filter((c) => { const d = c.lastUdharDate || c.createdAt; const dateOk = isDateInFilter(d, currentFilter); const searchOk =!currentSearch || c.name.toLowerCase().includes(currentSearch.toLowerCase()); return dateOk && searchOk; }); const netPendingOffline = filteredCustomers.reduce((a, c) => a + (c.totalUdhar || 0), 0);
      setPendingCount(offlineUnsyncedAll.length);
      if (typeof window!== "undefined" &&!window.navigator.onLine) {
        const paged = dedupedAll.slice((currentPage - 1) * 20, currentPage * 20); if (currentPage === 1) setSales(paged); else setSales((prev) => [...prev,...paged]);
        const t = dedupedAll.reduce((a, b) => a + b.total, 0); const p = dedupedAll.reduce((a, b) => a + (b.profit || 0), 0); setTotal(t); setProfit(p); setBuyTotal(t - p); setPendingTotal(netPendingOffline); setPagination({ page: currentPage, totalPages: Math.ceil(dedupedAll.length / 20), hasMore: dedupedAll.length > currentPage * 20, totalCount: dedupedAll.length }); return;
      }
      const statusQ = currentStatus!== "all"? `&status=${currentStatus}` : ""; const res = await fetch(`/api/sales?filter=${currentFilter}&search=${encodeURIComponent(currentSearch)}&page=${currentPage}&limit=20${statusQ}`, { signal }); const data = (await res.json()) as { sales: Sale[]; total: number; profit: number; pendingTotal?: number; pagination: Pagination };
      let combined: Sale[] = [...dedupedUnsynced,...data.sales]; if (combined.length === 0 && dedupedAll.length > 0) combined = [...dedupedAll]; const dedupedCombined = Array.from(new Map(combined.map((s) => [s.saleId || s._id, s])).values());
      let finalArray = dedupedCombined; if (currentStatus === "pending") finalArray = dedupedCombined.filter((s) => s.isCredit || s.status === "pending" || s.paymentType === "credit"); else if (currentStatus === "paid") finalArray = dedupedCombined.filter((s) =>!(s.isCredit || s.status === "pending" || s.paymentType === "credit"));
      if (currentPage === 1) setSales(finalArray); else setSales((prev) => { const merged = [...prev,...finalArray]; return Array.from(new Map(merged.map((s) => [s.saleId || s._id, s])).values()); });
      if (currentPage === 1) { const t = finalArray.reduce((a, b) => a + b.total, 0); const p = finalArray.reduce((a, b) => a + (b.profit || 0), 0); setTotal(t); setProfit(p); setBuyTotal(t - p); setPendingTotal(data.pendingTotal?? netPendingOffline); }
      setPagination(data.pagination);
    } catch (err) { if ((err as Error).name!== "AbortError") console.error(err); } finally { setLoading(false); }
  }, []);

  useEffect(() => { 
    // eslint-disable-next-line react-hooks/set-state-in-effect
    const controller = new AbortController(); void loadData(filter, search, page, statusFilter, controller.signal); return () => controller.abort(); }, [filter, search, page, statusFilter, loadData]);

  const grouped: Record<string, Sale[]> = {}; sales.forEach((s) => { const date = new Date(s.createdAt).toLocaleDateString(); if (!grouped[date]) grouped[date] = []; grouped[date].push(s); });

  const exportCSV = () => {
    const headers = "Date,Product,Customer,Type,Qty,Unit,BaseUnit,QtyBase,BuyPerBase,SellPerBase,Profit,Total,Status,SaleId\n";
    const rows = sales.map((s) => `${new Date(s.createdAt).toLocaleDateString()},${s.productName},${s.customerName || "Walk-in"},${s.paymentType || "cash"},${s.quantity},${s.unit},${s.baseUnit || "tablet"},${s.quantityInSub?? s.quantityInTablets},${s.buyPrice},${s.sellPrice},${s.profit},${s.total},${s.status || ""},${s.saleId || s.localId || ""}`).join("\n");
    const blob = new Blob([headers + rows], { type: "text/csv" }); const url = window.URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `yasir-medical-sales-${filter}-${new Date().toISOString().split("T")[0]}.csv`; a.click(); window.URL.revokeObjectURL(url);
  };

  return (
    <div className="p-3 sm:p-6 md:p-8 max-w-6xl mx-auto min-h-screen bg-gray-50">
      {isOffline && <div className="mb-3 bg-amber-50 border border-amber-200 text-amber-800 text-[12px] p-2.5 rounded-xl text-center font-medium">📶 Offline - {pendingCount} unsynced</div>}
      {pendingTotal > 0 && <div className="mb-3 bg-red-50 border border-red-200 text-red-800 text-[12px] p-2.5 rounded-xl flex justify-between"><span>📒 Net Pending Udhar: Rs.{pendingTotal.toFixed(0)}</span><Link href="/dashboard/customers" className="bg-red-600 text-white px-2 py-0.5 rounded-lg text-[10px]">Khata</Link></div>}
      <div className="flex flex-col gap-3 mb-4">
        <Link href="/dashboard" className="text-[11px] sm:text-sm text-gray-500 hover:text-green-700">← Back</Link>
        <div className="flex flex-col sm:flex-row justify-between gap-2.5">
          <div><div className="flex items-center gap-2"><Image src="/logo.png" alt="logo" width={32} height={32} className="w-8 h-8 rounded-full border" /><h1 className="text-[17px] sm:text-xl font-bold">💊 Sales History V11 - Yasir Medical</h1></div><p className="text-[11px] sm:text-[13px] text-gray-500 mt-1">{filter.toUpperCase()} • {pagination.totalCount + pendingCount} sales • Rs.{total.toFixed(0)} • Udhar Rs.{pendingTotal.toFixed(0)} • +Rs.{profit.toFixed(0)}</p></div>
          <div className="flex gap-2 self-start"><button onClick={exportCSV} className="bg-white border px-3 py-2 rounded-lg text-[11px] font-medium">📥 CSV</button><Link href="/dashboard/sales" className="bg-green-700 text-white px-4 py-2 rounded-lg text-[11px] font-medium">+ New Sale</Link></div>
        </div>
      </div>
      <div className="bg-white p-2.5 rounded-xl shadow-sm border mb-4 flex flex-col gap-2.5">
        <div className="flex gap-1.5 overflow-x-auto pb-1">{FILTERS.map((f) => (<button key={f} onClick={() => { setFilter(f); setPage(1); }} className={`px-3 py-1.5 rounded-full text-[11px] capitalize ${filter === f? "bg-green-700 text-white" : "bg-gray-100"}`}>{f}</button>))}</div>
        <div className="flex gap-1.5"><button onClick={() => { setStatusFilter("all"); setPage(1); }} className={`px-3 py-1.5 rounded-full text-[11px] ${statusFilter === "all"? "bg-black text-white" : "bg-gray-100"}`}>All</button><button onClick={() => { setStatusFilter("paid"); setPage(1); }} className={`px-3 py-1.5 rounded-full text-[11px] ${statusFilter === "paid"? "bg-green-600 text-white" : "bg-gray-100"}`}>Cash</button><button onClick={() => { setStatusFilter("pending"); setPage(1); }} className={`px-3 py-1.5 rounded-full text-[11px] ${statusFilter === "pending"? "bg-red-600 text-white" : "bg-gray-100"}`}>Udhar ({pendingTotal.toFixed(0)})</button></div>
        <input placeholder="🔍 Search product / customer / bottle / tube..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="border p-2.5 rounded-lg w-full outline-none text-[12px] focus:ring-2 focus:ring-green-700" />
      </div>
      {loading && page === 1? <p className="text-center py-10 text-gray-400 text-[12px]">Loading...</p> : (
        <div className="space-y-3">
          {Object.keys(grouped).length === 0? <p className="text-center py-10 text-gray-400 bg-white rounded-xl border text-[12px] px-3">No sales</p> : Object.entries(grouped).map(([date, daySales]) => {
            const dayTotal = daySales.reduce((sum, x) => sum + x.total, 0); const dayProfit = daySales.reduce((sum, x) => sum + (x.profit || 0), 0); const dayBuy = dayTotal - dayProfit;
            return (
              <div key={date} className="bg-white rounded-xl shadow-sm border overflow-hidden">
                <div className="bg-gray-50 px-3 py-2.5 flex justify-between border-b"><span className="font-semibold text-[11px]">{date} • {daySales.length}</span><span className="text-[11px] font-bold"><span className="text-gray-500">Buy {dayBuy.toFixed(0)} → </span><span className="text-green-700">Rs.{dayTotal.toFixed(0)}</span> <span className="text-blue-600 ml-2">+{dayProfit.toFixed(0)}</span></span></div>
                {daySales.map((s) => {
                  const buy = s.total - s.profit; const isOfflineSale = s._id.startsWith("local_") || s.synced === 0; const isUdhar = s.isCredit || s.status === "pending";
                  return (
                    <div key={s._id + (s.saleId || "")} className={`px-3 py-2.5 flex justify-between text-[12px] border-b last:border-0 ${isOfflineSale? "bg-amber-50/50" : ""} ${isUdhar? "bg-red-50/40" : ""}`}>
                      <div className="pr-2 flex-1"><p className="font-medium text-[12px] leading-tight">{s.productName} <span className="text-blue-600">{s.quantity} {s.unit} ({s.quantityInSub?? s.quantityInTablets} {s.baseUnit || "Tab"})</span> <span className="text-gray-400 text-[10px]">@Rs.{s.sellPrice}/{s.baseUnit || "base"}</span> {s.customerName && s.customerName!== "Walk-in"? <span className="bg-yellow-100 px-2 py-0.5 rounded-full text-[10px]">👤 {s.customerName}</span> : null} {isUdhar? <span className="bg-red-600 text-white px-2 py-0.5 rounded-full text-[9px]">UDHAR</span> : null}</p><p className="text-[10px] text-gray-400 mt-0.5">Buy Rs.{buy.toFixed(0)} • Profit Rs.{s.profit.toFixed(0)} • {new Date(s.createdAt).toLocaleTimeString()}</p></div><span className="font-bold text-[12px] shrink-0 ml-2">Rs.{s.total.toFixed(0)}<br /><span className="text-[10px] text-green-700">+{s.profit.toFixed(0)}</span></span></div>
                  );
                })}
              </div>
            );
          })}
          {pagination.hasMore && <button onClick={() => setPage((p) => p + 1)} disabled={loading} className="w-full py-2.5 bg-white border rounded-xl text-[12px] font-medium">{loading? "Loading..." : `Load More (${pagination.totalCount - sales.length})`}</button>}
        </div>
      )}
      <div className="mt-5 bg-green-700 text-white p-3.5 rounded-xl flex justify-between"><div><p className="text-[12px]">Total {filter}</p><p className="text-[11px] opacity-80">Buy Rs.{buyTotal.toFixed(0)} • Udhar Rs.{pendingTotal.toFixed(0)} • +Rs.{profit.toFixed(0)}</p></div><span className="text-[18px] font-bold">Rs.{total.toFixed(0)}</span></div>
    </div>
  );
}