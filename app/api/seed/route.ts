import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import User from "@/models/User";
import mongoose from "mongoose";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MainUnit = "box" | "bottle" | "tube" | "piece";

type SeedMed = {
  name: string; company: string; generic: string;
  mainUnit: MainUnit;
  pattaPerBox: number; mlPerBottle: number;
  buyPerMain: number; sellPerDefault: number; // sell per Patta if box, per Bottle if bottle
  stock: number; // in mainUnit ONLY
  expiryMonths: number;
};

function randomExpiry(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  d.setDate(15);
  return d;
}

// 50 REAL MEDICINES — V14.2: stock ONLY in box/bottle/tube/piece
const MEDICINES_50: SeedMed[] = [
  // box -> worker adds 1 Box = 10 Patta, default sell per Patta
  { name: "Panadol 500mg", company: "GSK", generic: "Paracetamol", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 280, sellPerDefault: 35, stock: 50, expiryMonths: 24 },
  { name: "Panadol Extra", company: "GSK", generic: "Paracetamol+Caffeine", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 380, sellPerDefault: 45, stock: 40, expiryMonths: 22 },
  { name: "Brufen 400mg", company: "Abbott", generic: "Ibuprofen", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 450, sellPerDefault: 55, stock: 30, expiryMonths: 24 },
  { name: "Ponstan Forte 500mg", company: "Pfizer", generic: "Mefenamic Acid", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 550, sellPerDefault: 70, stock: 25, expiryMonths: 18 },
  { name: "Augmentin 625mg", company: "GSK", generic: "Co-Amoxiclav", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 2800, sellPerDefault: 320, stock: 15, expiryMonths: 20 },
  { name: "Amoxil 500mg", company: "GSK", generic: "Amoxicillin", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 850, sellPerDefault: 110, stock: 20, expiryMonths: 18 },
  { name: "Azomax 500mg", company: "Pfizer", generic: "Azithromycin", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 1800, sellPerDefault: 220, stock: 18, expiryMonths: 24 },
  { name: "Cefspan 400mg", company: "Barrett", generic: "Cefixime", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 1950, sellPerDefault: 240, stock: 16, expiryMonths: 20 },
  { name: "Velosef 500mg", company: "GSK", generic: "Cephradine", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 1100, sellPerDefault: 135, stock: 20, expiryMonths: 18 },
  { name: "Flagyl 400mg", company: "Sanofi", generic: "Metronidazole", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 220, sellPerDefault: 30, stock: 40, expiryMonths: 30 },
  { name: "Risek 20mg", company: "Getz", generic: "Omeprazole", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 850, sellPerDefault: 110, stock: 35, expiryMonths: 24 },
  { name: "Risek 40mg", company: "Getz", generic: "Omeprazole", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 1450, sellPerDefault: 175, stock: 25, expiryMonths: 24 },
  { name: "Lowplat 75mg", company: "Getz", generic: "Clopidogrel", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 950, sellPerDefault: 120, stock: 20, expiryMonths: 22 },
  { name: "Surbex Z", company: "Abbott", generic: "Multivitamin", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 2200, sellPerDefault: 260, stock: 20, expiryMonths: 18 },
  { name: "CaC-1000 Plus", company: "GSK", generic: "Calcium+Vit D", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 3800, sellPerDefault: 430, stock: 15, expiryMonths: 20 },
  { name: "Folic Acid 5mg", company: "Zafa", generic: "Folic Acid", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 120, sellPerDefault: 18, stock: 50, expiryMonths: 36 },
  { name: "Motilium 10mg", company: "Janssen", generic: "Domperidone", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 380, sellPerDefault: 50, stock: 25, expiryMonths: 24 },
  { name: "Arinac Forte", company: "Abbott", generic: "Ibuprofen+Pseudoephedrine", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 350, sellPerDefault: 45, stock: 30, expiryMonths: 24 },
  { name: "Rigix 10mg", company: "Getz", generic: "Cetirizine", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 220, sellPerDefault: 30, stock: 40, expiryMonths: 24 },
  { name: "Concor 5mg", company: "Merck", generic: "Bisoprolol", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 1650, sellPerDefault: 195, stock: 15, expiryMonths: 20 },

  // bottle
  { name: "Brufen Syrup 100ml", company: "Abbott", generic: "Ibuprofen", mainUnit: "bottle", pattaPerBox: 10, mlPerBottle: 100, buyPerMain: 65, sellPerDefault: 85, stock: 15, expiryMonths: 18 },
  { name: "Panadol Syrup 60ml", company: "GSK", generic: "Paracetamol", mainUnit: "bottle", pattaPerBox: 10, mlPerBottle: 60, buyPerMain: 54, sellPerDefault: 69, stock: 20, expiryMonths: 18 },
  { name: "Hydryllin Syrup 120ml", company: "Searle", generic: "Diphenhydramine", mainUnit: "bottle", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 75, sellPerDefault: 95, stock: 15, expiryMonths: 16 },
  { name: "Mucaine Syrup 120ml", company: "Pfizer", generic: "Oxethazaine", mainUnit: "bottle", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 110, sellPerDefault: 135, stock: 12, expiryMonths: 20 },
  { name: "Gaviscon Syrup 120ml", company: "Reckitt", generic: "Sodium Alginate", mainUnit: "bottle", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 185, sellPerDefault: 220, stock: 10, expiryMonths: 14 },
  { name: "Lysovit Syrup 120ml", company: "GSK", generic: "Multivitamin", mainUnit: "bottle", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 144, sellPerDefault: 180, stock: 11, expiryMonths: 20 },
  { name: "Entamizole Syrup 60ml", company: "Sanofi", generic: "Metronidazole", mainUnit: "bottle", pattaPerBox: 10, mlPerBottle: 60, buyPerMain: 33, sellPerDefault: 45, stock: 15, expiryMonths: 22 },
  { name: "Quench Eye Drops 10ml", company: "Sante", generic: "CMC", mainUnit: "bottle", pattaPerBox: 10, mlPerBottle: 10, buyPerMain: 95, sellPerDefault: 120, stock: 50, expiryMonths: 12 },
  { name: "Betnesol-N Eye Drops 10ml", company: "GSK", generic: "Betamethasone", mainUnit: "bottle", pattaPerBox: 10, mlPerBottle: 10, buyPerMain: 45, sellPerDefault: 60, stock: 40, expiryMonths: 10 },

  // tube
  { name: "Betnovate-N Cream 20g", company: "GSK", generic: "Betamethasone", mainUnit: "tube", pattaPerBox: 10, mlPerBottle: 20, buyPerMain: 45, sellPerDefault: 60, stock: 30, expiryMonths: 24 },
  { name: "Polyfax Skin Oint 20g", company: "GSK", generic: "Polymyxin", mainUnit: "tube", pattaPerBox: 10, mlPerBottle: 20, buyPerMain: 55, sellPerDefault: 70, stock: 20, expiryMonths: 22 },
  { name: "Dermovate Cream 20g", company: "GSK", generic: "Clobetasol", mainUnit: "tube", pattaPerBox: 10, mlPerBottle: 20, buyPerMain: 70, sellPerDefault: 90, stock: 15, expiryMonths: 20 },
  { name: "Soframycin Cream 20g", company: "Sanofi", generic: "Framycetin", mainUnit: "tube", pattaPerBox: 10, mlPerBottle: 20, buyPerMain: 36, sellPerDefault: 48, stock: 20, expiryMonths: 24 },

  // piece
  { name: "ORS Sachet", company: "GSK", generic: "Oral Rehydration", mainUnit: "piece", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 18, sellPerDefault: 25, stock: 800, expiryMonths: 24 },
  { name: "Enervon Sachet", company: "Abbott", generic: "Multivitamin", mainUnit: "piece", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 22, sellPerDefault: 28, stock: 500, expiryMonths: 18 },
  { name: "Jetepar Injection", company: "Abbott", generic: "Liver Extract", mainUnit: "piece", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 28, sellPerDefault: 38, stock: 200, expiryMonths: 24 },
  { name: "Decadron Injection", company: "Zafa", generic: "Dexamethasone", mainUnit: "piece", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 18, sellPerDefault: 28, stock: 300, expiryMonths: 30 },
  { name: "Voren Injection 75mg", company: "Novartis", generic: "Diclofenac", mainUnit: "piece", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 15, sellPerDefault: 22, stock: 400, expiryMonths: 24 },
  { name: "Transamine 500mg Inj", company: "Hilton", generic: "Tranexamic Acid", mainUnit: "piece", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 42, sellPerDefault: 55, stock: 150, expiryMonths: 20 },
  { name: "Gravinate Injection", company: "Pfizer", generic: "Dimenhydrinate", mainUnit: "piece", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 12, sellPerDefault: 18, stock: 250, expiryMonths: 22 },

  { name: "Expired Test - Flagyl", company: "Sanofi", generic: "Metronidazole", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 220, sellPerDefault: 30, stock: 5, expiryMonths: -1 },
  { name: "Expiring Soon - Panadol", company: "GSK", generic: "Paracetamol", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 280, sellPerDefault: 35, stock: 10, expiryMonths: 1 },
  { name: "Expiring Soon - Brufen Syrup", company: "Abbott", generic: "Ibuprofen", mainUnit: "bottle", pattaPerBox: 10, mlPerBottle: 100, buyPerMain: 65, sellPerDefault: 85, stock: 10, expiryMonths: 2 },
  { name: "Cipralex 10mg", company: "Lundbeck", generic: "Escitalopram", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 2950, sellPerDefault: 340, stock: 10, expiryMonths: 14 },
  { name: "Getryl 2mg", company: "Getz", generic: "Glimepiride", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 550, sellPerDefault: 70, stock: 25, expiryMonths: 18 },
  { name: "Ventolin 2mg", company: "GSK", generic: "Salbutamol", mainUnit: "box", pattaPerBox: 10, mlPerBottle: 120, buyPerMain: 180, sellPerDefault: 25, stock: 35, expiryMonths: 20 },
];

export async function POST() {
  try {
    await dbConnect();
    const owner = await User.findOne({ role: "owner" }).sort({ createdAt: 1 });
    if (!owner) return NextResponse.json({ success: false, error: "Create owner first" }, { status: 400 });
    const userId = owner._id as mongoose.Types.ObjectId;

    await Product.deleteMany({ userId });

    const products = MEDICINES_50.map((m) => ({
      name: m.name,
      company: m.company,
      generic: m.generic,
      batchNo: `YM-${Math.floor(1000 + Math.random() * 9000)}`,
      expiryDate: randomExpiry(m.expiryMonths),
      rack: `Rack ${String.fromCharCode(65 + Math.floor(Math.random() * 3))}${Math.floor(Math.random() * 5) + 1}`,

      // V14.2 FINAL fields - NO sellUnit
      mainUnit: m.mainUnit, // box/bottle/tube/piece ONLY
      pattaPerBox: m.pattaPerBox,
      mlPerBottle: m.mlPerBottle,
      buyPrice: m.buyPerMain, // per Box/Bottle
      sellPrice: m.sellPerDefault, // per Patta if box else per Bottle/Tube/Piece - default, editable at counter
      stock: m.stock, // in mainUnit ONLY

      userId,
    }));

    const inserted = await Product.insertMany(products);

    const expired = products.filter((p) => p.expiryDate < new Date()).length;
    const expSoon = products.filter((p) => {
      const diff = (p.expiryDate.getTime() - Date.now()) / (1000 * 3600 * 24);
      return diff >= 0 && diff <= 60;
    }).length;

    return NextResponse.json({
      success: true,
      count: inserted.length,
      message: `Yasir Medical V14.2 FINAL - Seeded ${inserted.length} | ${expired} expired | ${expSoon} expiring | Box=10 Patta • Sell Patta editable`,
      breakdown: {
        box: MEDICINES_50.filter((m) => m.mainUnit === "box").length,
        bottle: MEDICINES_50.filter((m) => m.mainUnit === "bottle").length,
        tube: MEDICINES_50.filter((m) => m.mainUnit === "tube").length,
        piece: MEDICINES_50.filter((m) => m.mainUnit === "piece").length,
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