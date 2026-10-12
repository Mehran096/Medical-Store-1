import mongoose, { Schema, Document, Types } from "mongoose";

export interface IWusoolEntry {
  amount: number;
  date: Date;
  note?: string;
}

export interface ICustomer extends Document {
  name: string;
  normalizedName: string;
  phone: string;
  village: string; // in medical: area/mohallah
  totalUdhar: number;
  totalBusiness: number;
  lastUdharDate: Date;
  saleIds: Types.ObjectId[];
  userId: Types.ObjectId;
  billsCount: number;
  idsGrouped?: Types.ObjectId[];
  isPaid: boolean;
  paidAmount: number;
  paidAt?: Date;
  lastWusoolDate?: Date;
  wusoolHistory: IWusoolEntry[];
  // medicine extra
  age?: number;
  customerType?: string; // patient, walk-in, regular
}

const WusoolHistorySchema = new Schema<IWusoolEntry>(
  {
    amount: { type: Number, required: true },
    date: { type: Date, default: Date.now },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const CustomerSchema = new Schema<ICustomer>(
  {
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    village: { type: String, default: "", trim: true }, // medical store: keep as Area
    totalUdhar: { type: Number, default: 0 },
    totalBusiness: { type: Number, default: 0 },
    lastUdharDate: { type: Date, default: Date.now },
    saleIds: { type: [Schema.Types.ObjectId], ref: "Sale", default: [] },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    billsCount: { type: Number, default: 1 },
    idsGrouped: { type: [Schema.Types.ObjectId], default: [] },
    isPaid: { type: Boolean, default: false },
    paidAmount: { type: Number, default: 0 },
    paidAt: { type: Date },
    lastWusoolDate: { type: Date },
    wusoolHistory: { type: [WusoolHistorySchema], default: [] },
    // medicine extra - optional
    age: { type: Number, default: 0 },
    customerType: { type: String, default: "patient", enum: ["patient", "walk-in", "regular", "doctor"] },
  },
  { timestamps: true }
);

CustomerSchema.pre("validate", function () {
  if (this.name) {
    this.normalizedName = this.name.trim().toLowerCase();
  }
});

// 100% same indexes - khata system unchanged
CustomerSchema.index(
  { userId: 1, normalizedName: 1 },
  {
    unique: true,
    partialFilterExpression: { isPaid: false },
  }
);
CustomerSchema.index({ userId: 1, createdAt: -1 });
CustomerSchema.index({ userId: 1, isPaid: 1 });
CustomerSchema.index({ userId: 1 });

export default mongoose.models.Customer || mongoose.model<ICustomer>("Customer", CustomerSchema);