"use client";
import { signIn } from "next-auth/react";
import { useState, Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cacheUserForOffline, getOfflineUser, type CachedUser } from "@/lib/offline-auth";
import Image from "next/image";

function LoginContent() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isOffline, setIsOffline] = useState(false);
  const [offlineUser, setOfflineUser] = useState<CachedUser | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";

  useEffect(() => {
    // Load offline data only on client — fixes hydration
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEmail(getOfflineUser()?.email || "");
    setOfflineUser(getOfflineUser());
    setIsOffline(typeof window!== "undefined"?!window.navigator.onLine : false);

    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    if (typeof window!== "undefined" &&!window.navigator.onLine) {
      const cached = getOfflineUser();
      if (cached && cached.email.toLowerCase() === email.trim().toLowerCase()) {
        localStorage.setItem("offline_mode", "true");
        router.push(callbackUrl);
        router.refresh();
        setLoading(false);
        return;
      } else {
        setError("No internet. Login online once first with this email.");
        setLoading(false);
        return;
      }
    }

    try {
      const res = await signIn("credentials", {
        email: email.trim().toLowerCase(),
        password,
        redirect: false,
      });

      if (res?.error) {
        setError("Invalid email or password");
      } else if (res?.ok) {
        try {
          const sessionRes = await fetch("/api/auth/session");
          if (sessionRes.ok) {
            const sessionData = await sessionRes.json() as { user?: { id: string; email: string; name: string; role: "owner" | "worker" } };
            if (sessionData?.user) {
              cacheUserForOffline({
                _id: sessionData.user.id,
                email: sessionData.user.email,
                name: sessionData.user.name,
                role: sessionData.user.role || "worker",
              });
            }
          }
        } catch {}
        if (typeof window!== "undefined") localStorage.removeItem("offline_mode");
        router.push(callbackUrl);
        router.refresh();
      }
    } catch {
      setError("Login failed, try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-[#f0fdfa] p-4">
      <div className="w-full max-w-90">
        <div className="text-center mb-6">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-white border-2 border-teal-600 shadow-md overflow-hidden">
            <Image src="/logo.png" alt="Yasir Medical" width={56} height={56} className="h-12 w-12 object-contain" priority />
          </div>
          <h1 className="mt-3 text-[20px] font-bold tracking-tight text-gray-900 leading-tight">
            💊 Yasir Medical Store
          </h1>
          <p className="text-[12px] font-medium text-teal-700 mt-0.5">Medicines • Patta • Box • Offline Ready</p>
          <p className="text-[11px] text-gray-400 mt-1">Yasir Medical • Retail & Wholesale</p>
        </div>

        {isOffline && (
          <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 text-[12px] p-3 rounded-xl text-center font-medium">
            📶 You are offline {offlineUser? `- Welcome back ${offlineUser.name}` : "- Connect once first"}
          </div>
        )}

        <form onSubmit={handleLogin} className="bg-white rounded-3xl shadow-[0_8px_40px_rgba(0,0,0,0.06)] border border-gray-100 p-5 space-y-4">
          <div className="space-y-3">
            <div>
              <label className="text-[11px] font-semibold tracking-widest text-gray-500 uppercase ml-1">Email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@medical.com" type="email" required autoComplete="email" className="mt-1.5 w-full border border-gray-200 bg-gray-50/50 p-3.5 rounded-xl text-[14px] outline-none focus:bg-white focus:border-teal-600 focus:ring-4 focus:ring-teal-600/10 transition" />
            </div>
            <div>
              <label className="text-[11px] font-semibold tracking-widest text-gray-500 uppercase ml-1">Password</label>
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="••••••••" required disabled={isOffline &&!!offlineUser} autoComplete="current-password" className="mt-1.5 w-full border border-gray-200 bg-gray-50/50 p-3.5 rounded-xl text-[14px] outline-none focus:bg-white focus:border-teal-600 focus:ring-4 focus:ring-teal-600/10 transition disabled:bg-gray-100" />
              {isOffline && offlineUser && <p className="text-[10px] text-gray-400 mt-1 ml-1">Offline login - password not needed</p>}
            </div>
          </div>

          {error && <div className="bg-red-50 border border-red-100 text-red-600 text-[13px] p-3 rounded-xl text-center font-medium">{error}</div>}

          <button type="submit" disabled={loading} className="w-full bg-teal-600 hover:bg-teal-700 text-white p-3.5 rounded-xl font-bold text-[14px] disabled:opacity-60 active:scale-[0.98] transition shadow-[0_6px_20px_rgba(15,118,110,0.3)]">
            {loading? "Logging in..." : isOffline? "Login Offline" : "Login to Yasir Medical"}
          </button>

          <p className="text-center text-[11px] text-gray-400 pt-1">{isOffline? "Offline mode • 7 days cache" : "Secure • Yasir Medical • Works offline"}</p>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh flex items-center justify-center bg-[#f0fdfa]"><div className="h-10 w-10 rounded-full border-2 border-teal-600 border-t-transparent animate-spin" /></div>}>
      <LoginContent />
    </Suspense>
  );
}