import { requireAdmin, errorResponse } from "@/lib/auth";
import { githubToken } from "@/lib/github";

// GET /api/github/status — does the configured token work, and what can it
// reach? Mirrors the Confluence test-connection button so a bad token is
// found in Admin rather than at clone time.
export async function GET() {
  try {
    const admin = await requireAdmin();
    const token = githubToken(admin.orgId);
    if (!token) {
      return Response.json({
        configured: false,
        message:
          "No token configured. Public repositories work; private ones need one.",
      });
    }
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "tesseract",
      },
    });
    if (res.status === 401) {
      return Response.json({
        configured: true,
        connected: false,
        error: "GitHub rejected this token. It may be expired or revoked.",
      });
    }
    if (!res.ok) {
      return Response.json({
        configured: true,
        connected: false,
        error: `GitHub returned ${res.status}`,
      });
    }
    const user = (await res.json()) as { login?: string };
    // Classic PATs report their grants here; fine-grained ones send nothing,
    // which is not an error — it just means we cannot pre-check the scope.
    const scopes = res.headers.get("x-oauth-scopes");
    return Response.json({
      configured: true,
      connected: true,
      login: user.login ?? null,
      scopes: scopes || null,
      warning:
        scopes !== null && scopes !== "" && !scopes.split(/,\s*/).includes("repo")
          ? "This token has no 'repo' scope, so private repositories will still fail."
          : null,
      source: process.env.GITHUB_TOKEN && !token ? "environment" : undefined,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
