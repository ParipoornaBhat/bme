/**
 * Automated tests for Kaggle API route and auth middleware.
 * Verifies:
 * 1. Unauthenticated requests to /api/training-3d/kaggle return 401 Unauthorized.
 * 2. Non-admin requests to /api/training-3d/kaggle return 401 Unauthorized.
 * 3. Route POST rejects unknown or missing actions with 400 Bad Request.
 * 4. Route POST requires explicit confirmations for approve, upload, and run.
 * 5. Route GET returns build stamp and staging status.
 */

import assert from "node:assert";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

try {
  register(new URL("./test_loader.mjs", import.meta.url).href, import.meta.url);
} catch (e) {
  // already registered or not supported
}

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
  console.log("[PASS] Unauthenticated request correctly rejected by middleware with 401 Unauthorized");

  // Test 1b: Non-admin request (cookie present, role not admin) -> 401
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
    console.log("[PASS] Non-admin request correctly rejected by middleware with 401 Unauthorized");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 2. Test In-Route Defense-in-Depth Authentication (GET, POST, DELETE)
  const { GET, POST, DELETE } = await import("./src/app/api/training-3d/kaggle/route.ts");
  const { BUILD_STAMP } = await import("./src/app/api/training-3d/kaggle/buildStamp.ts");

  // Test 2a: In-route unauthenticated checks return 401
  const routeUnauthReq = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
    method: "POST",
    headers: {},
    body: { action: "doctor" },
  });
  const routePostUnauthRes = await POST(routeUnauthReq);
  assert.strictEqual(routePostUnauthRes.status, 401, "Route POST without auth must return 401");
  const routeGetUnauthRes = await GET(new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", { method: "GET" }));
  assert.strictEqual(routeGetUnauthRes.status, 401, "Route GET without auth must return 401");
  const routeDeleteUnauthRes = await DELETE(new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", { method: "DELETE" }));
  assert.strictEqual(routeDeleteUnauthRes.status, 401, "Route DELETE without auth must return 401");
  console.log("[PASS] In-route defense-in-depth correctly rejects unauthenticated GET/POST/DELETE with 401");

  // Test 2b: In-route non-admin checks return 401
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
      body: { action: "doctor" },
    });
    const guestRes = await POST(routeGuestReq);
    assert.strictEqual(guestRes.status, 401, "Route POST with non-admin cookie must return 401");
    console.log("[PASS] In-route defense-in-depth correctly rejects non-admin/guest with 401");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 3. Test Authorized Route Handler Logic
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

    // Test 3a: Unknown action -> 400 Bad Request
    const unknownActionReq = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "POST",
      headers: adminHeaders,
      body: { action: "legacy_or_injected_action" },
    });
    const unknownRes = await POST(unknownActionReq);
    assert.strictEqual(unknownRes.status, 400, "Unknown action must return 400");
    const unknownBody = await unknownRes.json();
    assert(unknownBody.error.includes("Invalid action"), "Error message must state invalid action");
    console.log("[PASS] Route POST rejects unknown action with 400 Bad Request");

    // Test 3b: Missing action -> 400 Bad Request
    const missingActionReq = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "POST",
      headers: adminHeaders,
      body: {},
    });
    const missingRes = await POST(missingActionReq);
    assert.strictEqual(missingRes.status, 400, "Missing action must return 400");
    console.log("[PASS] Route POST rejects missing action with 400 Bad Request");

    // Test 3c: Legacy action 'start' -> 400 Bad Request
    const legacyActionReq = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "POST",
      headers: adminHeaders,
      body: { action: "start" },
    });
    const legacyRes = await POST(legacyActionReq);
    assert.strictEqual(legacyRes.status, 400, "Legacy action 'start' must return 400");
    console.log("[PASS] Legacy action 'start' correctly rejected with 400 Bad Request");

    // Test 3d: Missing confirmation on approve -> 400
    const approveNoConf = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "POST",
      headers: adminHeaders,
      body: { action: "approve" },
    });
    const appRes = await POST(approveNoConf);
    assert.strictEqual(appRes.status, 400, "Approve without confirmApprove must return 400");
    console.log("[PASS] Missing confirmApprove correctly rejected with 400 Bad Request");

    // Test 3e: Missing confirmation on upload -> 400
    const uploadNoConf = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "POST",
      headers: adminHeaders,
      body: { action: "upload" },
    });
    const upRes = await POST(uploadNoConf);
    assert.strictEqual(upRes.status, 400, "Upload without confirmUpload must return 400");
    console.log("[PASS] Missing confirmUpload correctly rejected with 400 Bad Request");

    // Test 3f: Missing confirmation on run -> 400
    const runNoConf = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "POST",
      headers: adminHeaders,
      body: { action: "run", mode: "quick" },
    });
    const runRes = await POST(runNoConf);
    assert.strictEqual(runRes.status, 400, "Run without confirmLaunch must return 400");
    console.log("[PASS] Missing confirmLaunch correctly rejected with 400 Bad Request");

    // Test 3g: Missing confirmation on onetap -> 400
    const onetapNoConf = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "POST",
      headers: adminHeaders,
      body: { action: "onetap", mode: "quick" },
    });
    const onetapRes = await POST(onetapNoConf);
    assert.strictEqual(onetapRes.status, 400, "Onetap without confirmation must return 400");
    console.log("[PASS] Missing onetap confirmation correctly rejected with 400 Bad Request");

    // Test 3g: Route GET returns build stamp
    const getReq = new MockNextRequest("http://localhost:3000/api/training-3d/kaggle", {
      method: "GET",
      headers: adminHeaders,
    });
    const getRes = await GET(getReq);
    assert.strictEqual(getRes.status, 200, "Authorized GET must return 200");
    const getBody = await getRes.json();
    assert.strictEqual(getBody.buildStamp, BUILD_STAMP, "GET must return build stamp");
    assert(getBody.stagingDir.length > 0, "GET must return staging directory path");
    console.log("[PASS] Route GET returns valid status and matching build stamp");

  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\n[SUCCESS] ALL ROUTE & MIDDLEWARE SECURITY TESTS PASSED!");
}

runTests().catch((err) => {
  console.error("\n[FAIL] Test error:", err);
  process.exit(1);
});
