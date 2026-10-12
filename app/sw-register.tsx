"use client";
import { useEffect } from "react";

const CURRENT_CACHE = "yasir-medical-v9";

export default function SWRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const cleanOldCaches = async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => k !== CURRENT_CACHE)
            .filter((k) => k.startsWith("al-farooq-") || k.startsWith("yasir-") || k.includes("sona-shop") || k.includes("agri-pwa"))
            .map((k) => caches.delete(k))
        );
      } catch {}
    };

    const unregisterAll = async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {}
    };

    void cleanOldCaches();

    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js?v=9", { scope: "/" })
        .then((reg) => {
          console.log("SW Yasir Medical v9:", reg.scope);

          reg.addEventListener("updatefound", () => {
            const nw = reg.installing;
            if (!nw) return;
            nw.addEventListener("statechange", () => {
              if (nw.state === "installed" && navigator.serviceWorker.controller) {
                console.log("New SW ready - reloading");
                window.location.reload();
              }
            });
          });

          const check = () => reg.update().catch(() => {});
          window.addEventListener("focus", check);
          const id = window.setInterval(check, 60 * 60 * 1000);
          return () => {
            window.clearInterval(id);
            window.removeEventListener("focus", check);
          };
        })
        .catch(async (err) => {
          console.error("SW register failed, clearing broken SW:", err);
          await unregisterAll();
          setTimeout(() => window.location.reload(), 1000);
        });
    };

    if (document.readyState === "complete") onLoad();
    else {
      window.addEventListener("load", onLoad);
      return () => window.removeEventListener("load", onLoad);
    }
  }, []);

  return null;
}