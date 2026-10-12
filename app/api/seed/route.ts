import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import User from "@/models/User";
import mongoose from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MedicalUnit = "tablet" | "patta" | "half_patta" | "box" | "bottle" | "syrup" | "ml" | "liter" | "gram" | "kg" | "tube" | "sachet" | "piece" | "capsule" | "injection";
type BaseUnit = "tablet" | "ml" | "gram" | "piece";

type SeedMed = {
  name: string; company: string; generic: string; unit: MedicalUnit; baseUnit: BaseUnit;
  qtyPerUnit: number; buy: number; sell: number; stock: number; // stock in baseUnit
  expiryMonths: number; // months from now
};

function randomExpiry(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  d.setDate(15);
  return d;
}

// 50 REAL MEDICINES — V11 MIXED TABLET / SYRUP / TUBE / INJECTION / SACHET
const MEDICINES_50: SeedMed[] = [
  // Tablets
  { name: "Panadol 500mg", company: "GSK", generic: "Paracetamol", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 2.8, sell: 3.5, stock: 500, expiryMonths: 24 },
  { name: "Panadol Extra", company: "GSK", generic: "Paracetamol+Caffeine", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 3.8, sell: 4.5, stock: 400, expiryMonths: 22 },
  { name: "Brufen 400mg", company: "Abbott", generic: "Ibuprofen", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 4.5, sell: 5.5, stock: 300, expiryMonths: 24 },
  { name: "Ponstan Forte 500mg", company: "Pfizer", generic: "Mefenamic Acid", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 5.5, sell: 7.0, stock: 250, expiryMonths: 18 },
  { name: "Augmentin 625mg", company: "GSK", generic: "Co-Amoxiclav", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 28, sell: 32, stock: 150, expiryMonths: 20 },
  { name: "Amoxil 500mg", company: "GSK", generic: "Amoxicillin", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 8.5, sell: 11, stock: 200, expiryMonths: 18 },
  { name: "Azomax 500mg", company: "Pfizer", generic: "Azithromycin", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 18, sell: 22, stock: 180, expiryMonths: 24 },
  { name: "Cefspan 400mg", company: "Barrett", generic: "Cefixime", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 19.5, sell: 24, stock: 160, expiryMonths: 20 },
  { name: "Velosef 500mg", company: "GSK", generic: "Cephradine", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 11, sell: 13.5, stock: 200, expiryMonths: 18 },
  { name: "Flagyl 400mg", company: "Sanofi", generic: "Metronidazole", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 2.2, sell: 3.0, stock: 400, expiryMonths: 30 },
  { name: "Risek 20mg", company: "Getz", generic: "Omeprazole", unit: "capsule", baseUnit: "piece", qtyPerUnit: 14, buy: 8.5, sell: 11, stock: 350, expiryMonths: 24 },
  { name: "Risek 40mg", company: "Getz", generic: "Omeprazole", unit: "capsule", baseUnit: "piece", qtyPerUnit: 14, buy: 14.5, sell: 17.5, stock: 250, expiryMonths: 24 },
  { name: "Lowplat 75mg", company: "Getz", generic: "Clopidogrel", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 9.5, sell: 12, stock: 200, expiryMonths: 22 },
  { name: "Surbex Z", company: "Abbott", generic: "Multivitamin", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 22, sell: 26, stock: 200, expiryMonths: 18 },
  { name: "CaC-1000 Plus", company: "GSK", generic: "Calcium+Vit D", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 38, sell: 43, stock: 150, expiryMonths: 20 },
  { name: "Folic Acid 5mg", company: "Zafa", generic: "Folic Acid", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 1.2, sell: 1.8, stock: 500, expiryMonths: 36 },
  { name: "Motilium 10mg", company: "Janssen", generic: "Domperidone", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 3.8, sell: 5.0, stock: 250, expiryMonths: 24 },
  { name: "Arinac Forte", company: "Abbott", generic: "Ibuprofen+Pseudoephedrine", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 3.5, sell: 4.5, stock: 300, expiryMonths: 24 },
  { name: "Rigix 10mg", company: "Getz", generic: "Cetirizine", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 2.2, sell: 3.0, stock: 400, expiryMonths: 24 },
  { name: "Concor 5mg", company: "Merck", generic: "Bisoprolol", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 16.5, sell: 19.5, stock: 150, expiryMonths: 20 },

  // Syrups / Liquids - base ml
  { name: "Brufen Syrup 100ml", company: "Abbott", generic: "Ibuprofen", unit: "bottle", baseUnit: "ml", qtyPerUnit: 100, buy: 0.65, sell: 0.85, stock: 1500, expiryMonths: 18 },
  { name: "Panadol Syrup 60ml", company: "GSK", generic: "Paracetamol", unit: "bottle", baseUnit: "ml", qtyPerUnit: 60, buy: 0.90, sell: 1.15, stock: 1200, expiryMonths: 18 },
  { name: "Hydryllin Syrup 120ml", company: "Searle", generic: "Diphenhydramine", unit: "bottle", baseUnit: "ml", qtyPerUnit: 120, buy: 0.62, sell: 0.79, stock: 1800, expiryMonths: 16 },
  { name: "Mucaine Syrup 120ml", company: "Pfizer", generic: "Oxethazaine+Aluminium", unit: "bottle", baseUnit: "ml", qtyPerUnit: 120, buy: 0.91, sell: 1.12, stock: 1440, expiryMonths: 20 },
  { name: "Gaviscon Syrup 120ml", company: "Reckitt", generic: "Sodium Alginate", unit: "bottle", baseUnit: "ml", qtyPerUnit: 120, buy: 1.54, sell: 1.83, stock: 1200, expiryMonths: 14 },
  { name: "Hydryllin DM Syrup 120ml", company: "Searle", generic: "Dextromethorphan", unit: "bottle", baseUnit: "ml", qtyPerUnit: 120, buy: 0.70, sell: 0.95, stock: 1000, expiryMonths: 18 },
  { name: "Lysovit Syrup 120ml", company: "GSK", generic: "Multivitamin", unit: "bottle", baseUnit: "ml", qtyPerUnit: 120, buy: 1.20, sell: 1.50, stock: 1100, expiryMonths: 20 },
  { name: "Entamizole Syrup 60ml", company: "Sanofi", generic: "Metronidazole", unit: "bottle", baseUnit: "ml", qtyPerUnit: 60, buy: 0.55, sell: 0.75, stock: 900, expiryMonths: 22 },

  // Creams / Tubes - base gram
  { name: "Betnovate-N Cream 20g", company: "GSK", generic: "Betamethasone+Neomycin", unit: "tube", baseUnit: "gram", qtyPerUnit: 20, buy: 2.25, sell: 3.0, stock: 600, expiryMonths: 24 },
  { name: "Polyfax Skin Oint 20g", company: "GSK", generic: "Polymyxin+Bacitracin", unit: "tube", baseUnit: "gram", qtyPerUnit: 20, buy: 2.75, sell: 3.5, stock: 400, expiryMonths: 22 },
  { name: "Betaderm Cream 20g", company: "Atco", generic: "Betamethasone", unit: "tube", baseUnit: "gram", qtyPerUnit: 20, buy: 2.0, sell: 2.8, stock: 350, expiryMonths: 24 },
  { name: "Dermovate Cream 20g", company: "GSK", generic: "Clobetasol", unit: "tube", baseUnit: "gram", qtyPerUnit: 20, buy: 3.5, sell: 4.5, stock: 300, expiryMonths: 20 },
  { name: "Soframycin Skin Cream 20g", company: "Sanofi", generic: "Framycetin", unit: "tube", baseUnit: "gram", qtyPerUnit: 20, buy: 1.80, sell: 2.40, stock: 400, expiryMonths: 24 },

  // Sachets / Others - base piece / ml
  { name: "ORS Sachet Nimkol", company: "GSK", generic: "Oral Rehydration Salt", unit: "sachet", baseUnit: "piece", qtyPerUnit: 1, buy: 18, sell: 25, stock: 800, expiryMonths: 24 },
  { name: "Enervon Sachet", company: "Abbott", generic: "Multivitamin", unit: "sachet", baseUnit: "piece", qtyPerUnit: 1, buy: 22, sell: 28, stock: 500, expiryMonths: 18 },
  { name: "Quench Eye Drops 10ml", company: "Sante", generic: "CMC", unit: "bottle", baseUnit: "ml", qtyPerUnit: 10, buy: 9.5, sell: 12, stock: 500, expiryMonths: 12 },
  { name: "Betnesol-N Eye Drops 10ml", company: "GSK", generic: "Betamethasone+Neomycin", unit: "bottle", baseUnit: "ml", qtyPerUnit: 10, buy: 4.5, sell: 6.0, stock: 400, expiryMonths: 10 },
  { name: "Tobrex Eye Drops 5ml", company: "Alcon", generic: "Tobramycin", unit: "bottle", baseUnit: "ml", qtyPerUnit: 5, buy: 18, sell: 22, stock: 250, expiryMonths: 8 },

  // Injections - base piece
  { name: "Jetepar Injection", company: "Abbott", generic: "Liver Extract", unit: "injection", baseUnit: "piece", qtyPerUnit: 1, buy: 28, sell: 38, stock: 200, expiryMonths: 24 },
  { name: "Decadron Injection", company: "Zafa", generic: "Dexamethasone", unit: "injection", baseUnit: "piece", qtyPerUnit: 1, buy: 18, sell: 28, stock: 300, expiryMonths: 30 },
  { name: "Voren Injection 75mg", company: "Novartis", generic: "Diclofenac", unit: "injection", baseUnit: "piece", qtyPerUnit: 1, buy: 15, sell: 22, stock: 400, expiryMonths: 24 },
  { name: "Transamine 500mg Inj", company: "Hilton", generic: "Tranexamic Acid", unit: "injection", baseUnit: "piece", qtyPerUnit: 1, buy: 42, sell: 55, stock: 150, expiryMonths: 20 },
  { name: "Gravinate Injection", company: "Pfizer", generic: "Dimenhydrinate", unit: "injection", baseUnit: "piece", qtyPerUnit: 1, buy: 12, sell: 18, stock: 250, expiryMonths: 22 },

  // Expiring soon for testing expiry feature
  { name: "Expired Test - Flagyl", company: "Sanofi", generic: "Metronidazole", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 2.2, sell: 3.0, stock: 50, expiryMonths: -1 },
  { name: "Expiring Soon - Panadol", company: "GSK", generic: "Paracetamol", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 2.8, sell: 3.5, stock: 100, expiryMonths: 1 },
  { name: "Expiring Soon - Brufen Syrup", company: "Abbott", generic: "Ibuprofen", unit: "bottle", baseUnit: "ml", qtyPerUnit: 100, buy: 0.65, sell: 0.85, stock: 1000, expiryMonths: 2 },
  { name: "Cipralex 10mg", company: "Lundbeck", generic: "Escitalopram", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 29.5, sell: 34, stock: 100, expiryMonths: 14 },
  { name: "Getryl 2mg", company: "Getz", generic: "Glimepiride", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 5.5, sell: 7.0, stock: 250, expiryMonths: 18 },
  { name: "Ventolin 2mg", company: "GSK", generic: "Salbutamol", unit: "tablet", baseUnit: "tablet", qtyPerUnit: 10, buy: 1.8, sell: 2.5, stock: 350, expiryMonths: 20 },
];

export async function POST() {
  try {
    await dbConnect();
    const owner = await User.findOne({ role: "owner" }).sort({ createdAt: 1 });
    if (!owner) {
      return NextResponse.json({ success: false, error: "Create owner first" }, { status: 400 });
    }
    const userId = owner._id as mongoose.Types.ObjectId;

    await Product.deleteMany({ userId });

    const products = MEDICINES_50.map((m) => {
      const expiryDate = randomExpiry(m.expiryMonths);
      const buyPerBase = m.buy;
      const sellPerBase = m.sell;
      const isTablet = m.baseUnit === "tablet";
      const isPiece = m.baseUnit === "piece";

      return {
        name: m.name,
        company: m.company,
        generic: m.generic,
        batchNo: `YM-${Math.floor(1000 + Math.random() * 9000)}`,
        expiryDate, // ✅ V11 field
        rack: `Rack ${String.fromCharCode(65 + Math.floor(Math.random() * 3))}${Math.floor(Math.random() * 5) + 1}`,

        // ✅ V11 medical model
        unit: m.unit,
        baseUnit: m.baseUnit,
        qtyPerUnit: m.qtyPerUnit,
        subUnit: m.baseUnit,
        stock: m.stock, // stock in baseUnit (tablet count / ml / gram / piece)

        tabletsPerPatta: isTablet? 10 : isPiece? 1 : 10,
        pattaPerBox: isTablet? 10 : 1,

        // pricing per baseUnit
        price: sellPerBase,
        buyPrice: buyPerBase,
        sellPrice: sellPerBase,

        userId,
        synced: true,
        lastSyncedAt: new Date(),
      };
    });

    const inserted = await Product.insertMany(products);

    // counts for response
    const expired = products.filter((p) => p.expiryDate < new Date()).length;
    const expSoon = products.filter((p) => {
      const diff = (p.expiryDate.getTime() - Date.now()) / (1000 * 3600 * 24);
      return diff >= 0 && diff <= 60;
    }).length;

    return NextResponse.json({
      success: true,
      count: inserted.length,
      message: `Yasir Medical V11 - Seeded ${inserted.length} medicines | ${expired} expired | ${expSoon} expiring soon`,
      breakdown: {
        tablet: MEDICINES_50.filter((m) => m.baseUnit === "tablet").length,
        ml: MEDICINES_50.filter((m) => m.baseUnit === "ml").length,
        gram: MEDICINES_50.filter((m) => m.baseUnit === "gram").length,
        piece: MEDICINES_50.filter((m) => m.baseUnit === "piece").length,
        expired,
        expiringSoon: expSoon,
      },
      sample: inserted[0],
    });
  } catch (error) {
    const message = error instanceof Error? error.message : "Unknown error";
    console.error("SEED ERROR:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}