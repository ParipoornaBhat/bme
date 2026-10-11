/**
 * Automated tests for Kaggle API route and auth middleware.
 * Verifies:
 * 1. Unauthenticated requests to /api/training-3d/kaggle return 401 Unauthorized.
 * 2. Non-admin requests to /api/training-3d/kaggle return 401 Unauthorized.
 * 3. Route POST rejects unknown actions with 400 Bad Request.
 */

import assert from "node:assert";

// Mock NextRequest and NextResponse for isolated testing
class MockHeaders {
  constructor(init = {}) {
    this._map = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), v]));
  }
  get(key) {
    return this._map.get(key.toLowerCase()) ?? null;
  }
}

class MockNextRequest {
  constructor(url, { method = "GET", headers = {}, body = null } = {}) {
    this.url = url;
    this.nextUrl = new URL(url);
    this.method = method;
    this.headers = new MockHeaders(headers);
    this._body = body;
  }
  async json() {
    return this._body ?? {};
  }
}

async function runTests() {
  console.log("Running Kaggle route and middleware security tests...\n");

  // 1. Test Middleware Protection
  const { middleware } = await import("./src/middleware.ts");

  // Test 1a: Unauthenticated request (no cookie) -> 401
  const unauthReq = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
    method: "GET",
    headers: {},
  });
  const unauthRes = await middleware(unauthReq);
  assert.strictEqual(unauthRes.status, 401, "Unauthenticated request must get 401");
  const unauthBody = await unauthRes.json();
  assert.strictEqual(unauthBody.error, "Unauthorized");
  console.log("[PASS] Unauthenticated request correctly rejected with 401 Unauthorized");

  // Test 1b: Non-admin request (cookie present, role not admin) -> 401
  // Mock global fetch to return non-admin profile
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/users/profile")) {
      return {
        ok: true,
        json: async () => ({ activeRole: { name: "radiologist_guest" } }),
      };
    }
    return { ok: false };
  };

  try {
    const nonAdminReq = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "POST",
      headers: { cookie: "session_token=fake_guest_token" },
    });
    const nonAdminRes = await middleware(nonAdminReq);
    assert.strictEqual(nonAdminRes.status, 401, "Non-admin request must get 401");
    console.log("[PASS] Non-admin request correctly rejected with 401 Unauthorized");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 2. Test In-Route Defense-in-Depth Authentication (GET, POST, DELETE)
  const { GET, POST, DELETE } = await import("./src/app/api/training-3d/kaggle/route.ts");

  // Test 2a: In-route unauthenticated checks return 401
  const routeUnauthReq = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
    method: "POST",
    headers: {},
    body: { action: "preflight" },
  });
  const routePostUnauthRes = await POST(routeUnauthReq);
  assert.strictEqual(routePostUnauthRes.status, 401, "Route POST without auth must return 401");
  const routeGetUnauthRes = await GET(new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", { method: "GET" }));
  assert.strictEqual(routeGetUnauthRes.status, 401, "Route GET without auth must return 401");
  const routeDeleteUnauthRes = await DELETE(new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", { method: "DELETE" }));
  assert.strictEqual(routeDeleteUnauthRes.status, 401, "Route DELETE without auth must return 401");
  console.log("[PASS] In-route defense-in-depth correctly rejects unauthenticated GET/POST/DELETE with 401");

  // Test 2b: In-route non-admin / guest checks return 401
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/users/profile")) {
      return {
        ok: true,
        json: async () => ({ activeRole: { name: "guest_viewer" } }),
      };
    }
    return { ok: false };
  };

  try {
    const routeGuestReq = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "POST",
      headers: { cookie: "session_token=guest_token" },
      body: { action: "preflight" },
    });
    const guestRes = await POST(routeGuestReq);
    assert.strictEqual(guestRes.status, 401, "Route POST with non-admin cookie must return 401");
    console.log("[PASS] In-route defense-in-depth correctly rejects non-admin/guest with 401");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 3. Test Authorized Route Handler Logic (Action Validation)
  // Mock global fetch for authorized admin
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/users/profile")) {
      return {
        ok: true,
        json: async () => ({ activeRole: { name: "admin" } }),
      };
    }
    return { ok: false };
  };

  try {
    const adminHeaders = { cookie: "session_token=valid_admin_token" };

    // Test 3a: Unknown action -> 400
    const unknownActionReq = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "POST",
      headers: adminHeaders,
      body: { action: "unauthorized_command_injection" },
    });
    const unknownRes = await POST(unknownActionReq);
    assert.strictEqual(unknownRes.status, 400, "Unknown action must return 400");
    const unknownBody = await unknownRes.json();
    assert(unknownBody.error.includes("Invalid action"), "Error message must state invalid action");
    console.log("[PASS] Route POST with admin role rejects unknown action with 400 Bad Request");

    // Test 3b: Missing action -> 400
    const missingActionReq = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "POST",
      headers: adminHeaders,
      body: {},
    });
    const missingRes = await POST(missingActionReq);
    assert.strictEqual(missingRes.status, 400, "Missing action must return 400");
    console.log("[PASS] Route POST with admin role rejects missing action with 400 Bad Request");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\n[SUCCESS] ALL ROUTE & MIDDLEWARE SECURITY TESTS PASSED!");
}

runTests().catch((err) => {
  console.error("\n[FAIL] Test error:", err);
  process.exit(1);
});
