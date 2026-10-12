import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import User from "@/models/User";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  name: string;
  email: string;
  password: string;
  role?: "owner" | "worker";
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const { name, email, password, role } = body;

    if (!name || !email || !password) {
      return NextResponse.json({ message: "Missing fields" }, { status: 400 });
    }

    if (password.length < 6) {
      return NextResponse.json({ message: "Password must be 6+ characters" }, { status: 400 });
    }

    await dbConnect();

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return NextResponse.json({ message: "User already exists" }, { status: 400 });
    }

    // FIX: pass plain password — model pre('save') will hash it once
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: password,
      role: role || "owner",
    });

    return NextResponse.json(
      {
        message: "Yasir Medical - User created successfully",
        user: { _id: user._id, name: user.name, email: user.email, role: user.role },
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("Yasir Medical register error:", err);
    return NextResponse.json({ message: "Server Error" }, { status: 500 });
  }
}