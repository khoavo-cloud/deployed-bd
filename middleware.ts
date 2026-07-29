import { NextResponse, type NextRequest } from "next/server";

/**
 * HTTP basic auth over the whole app.
 *
 * Without this, deploying publishes every lead's name, email and company to
 * anyone with the URL, and leaves two endpoints open: /api/enrich spends Google
 * credits, /api/publish writes to Notion. Neither is rate limited.
 *
 * Set BD_USER and BD_PASSWORD in the Vercel project's environment variables.
 * If BD_PASSWORD is unset the app refuses to serve rather than falling open —
 * a missing variable in production should not silently mean "no password".
 */
export function middleware(req: NextRequest) {
  const user = process.env.BD_USER || "bd";
  const password = process.env.BD_PASSWORD;

  if (!password) {
    return new NextResponse(
      "BD_PASSWORD is not set. Refusing to serve without authentication.",
      { status: 500 },
    );
  }

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    const [given, ...rest] = atob(header.slice(6)).split(":");
    if (given === user && rest.join(":") === password) return NextResponse.next();
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Deployed BD", charset="UTF-8"' },
  });
}

export const config = {
  // Everything except Next's static assets — the API routes especially.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
