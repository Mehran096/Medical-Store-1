import { Schema, model, models } from "mongoose";
import bcrypt from "bcryptjs";

export interface IUser {
  email: string;
  password: string;
  name: string;
  role: "owner" | "worker";
  lastLoginAt?: Date;
}

const UserSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: { type: String, unique: true, required: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["owner", "worker"], default: "worker" },
  lastLoginAt: { type: Date }
}, { timestamps: true });

// Hash password - FIXED, no next()
UserSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// Method to compare password
UserSchema.methods.comparePassword = async function(candidate: string) {
  return bcrypt.compare(candidate, this.password);
};

export default models.User || model<IUser>("User", UserSchema);