export interface CachedUser {
  _id: string;
  email: string;
  name: string;
  role: 'owner' | 'worker';
  cachedAt: number;
}

const KEY = 'offline_user';
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

export function cacheUserForOffline(user: { _id: string; email: string; name: string; role: 'owner' | 'worker' }): void {
  if (typeof window === "undefined") return;
  const data: CachedUser = {
    _id: user._id,
    email: user.email,
    name: user.name,
    role: user.role,
    cachedAt: Date.now()
  };
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function getOfflineUser(): CachedUser | null {
  if (typeof window === "undefined") return null;
  try {
    const cached = localStorage.getItem(KEY);
    if (!cached) return null;
    const user = JSON.parse(cached) as CachedUser;
    if (!user?._id || !user?.cachedAt) return null;
    if (Date.now() - user.cachedAt > SEVEN_DAYS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return user;
  } catch {
    return null;
  }
}

export function canLoginOffline(): boolean {
  return !!getOfflineUser();
}

export function clearOfflineUser(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
}