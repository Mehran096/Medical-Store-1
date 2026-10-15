import Image from "next/image";
import Link from "next/link";

export default function OfflinePage() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-[#f0fdfa] p-6 text-center">
      <Image src="/logo.png" unoptimized alt="Yasir Medical" width={80} height={80} className="w-20 h-20 rounded-full border-2 border-teal-600 mb-4 bg-white" />
      <h1 className="text-xl font-bold">💊 Yasir Medical Store</h1>
      <p className="text-teal-700 text-sm font-medium">Medicines • Patta • Box • Offline Ready</p>
      <p className="text-gray-500 text-[12px] mt-3">You are offline. Your data is safe.</p>
      <p className="text-[11px] text-gray-400 mt-1">Sales & Stock work offline • Auto-sync when online</p>
      <div className="flex gap-2 mt-5">
        <Link href="/" className="bg-teal-600 text-white px-4 py-2 rounded-xl text-sm font-bold">Home</Link>
        <Link href="/dashboard" className="bg-white border px-4 py-2 rounded-xl text-sm">Dashboard</Link>
      </div>
      <p className="text-[10px] text-gray-400 mt-6">Yasir Medical Store • Offline V9</p>
    </div>
  );
}