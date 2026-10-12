import { withAuth } from "next-auth/middleware";

export default withAuth({
  pages: {
    signIn: "/login",
  },
});

export const config = {
  matcher: [
    /*
     * Protect only dashboard
     * Exclude:
     * - /api (auth, customers, sales)
     * - /_next/static, /_next/image
     * - /sw.js, /manifest.json, /logo.png, /offline
     * - /login, / (public)
     */
    "/dashboard/:path*",
  ],
};