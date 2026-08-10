import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const PUBLIC_PATHS = [
  /^\/login/,
  /^\/setup/,
  /^\/signup/,
  /^\/invite\//,
  /^\/api\/auth\//,
  /^\/favicon/,
  /^\/_next\//,
];

// Operator surfaces. Members are redirected to chat rather than shown a page
// whose API calls would all 403 — the nav hides these, this closes the URL.
const ADMIN_PATHS = [/^\/admin/, /^\/pipeline/, /^\/tuning/];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((re) => re.test(pathname))) return NextResponse.next();

  const token = request.cookies.get("tesseract_session")?.value;
  const secret = new TextEncoder().encode(
    process.env.AUTH_SECRET || "dev-change-me-to-a-long-random-string"
  );
  let ok = false;
  let role = "";
  if (token) {
    try {
      const { payload } = await jwtVerify(token, secret);
      role = String(payload.role ?? "");
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (ok && role !== "admin" && ADMIN_PATHS.some((re) => re.test(pathname))) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  if (!ok) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|woff2?)$).*)"],
};
