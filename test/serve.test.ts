import { expect, test, describe } from "bun:test";
import { isLoopback, checkAuth, startupError, corsHeaders } from "../src/serve.js";

/*
 * relic indexes every agent session on the machine — private repository contents,
 * absolute paths, whatever anyone pasted into a transcript. These are the rules that
 * decide who can read that, so they are tested as rules rather than exercised through
 * a live socket.
 */
describe("isLoopback", () => {
  test("only the three names that actually mean this machine", () => {
    for (const h of ["127.0.0.1", "::1", "localhost"]) expect(isLoopback(h)).toBe(true);
    // 0.0.0.0 is the one people assume is safe. It binds EVERY interface.
    for (const h of ["0.0.0.0", "100.83.1.5", "192.168.1.10", "::"]) expect(isLoopback(h)).toBe(false);
  });
});

describe("startupError — the refusal that makes the default safe", () => {
  test("a public bind without a token does not start", () => {
    const err = startupError("0.0.0.0", null);
    expect(err).toContain("refusing to bind");
    expect(err).toContain("entire session history");
  });

  test("a mesh address is public too", () => {
    expect(startupError("100.83.1.5", null)).not.toBeNull();
  });

  test("a public bind WITH a token starts", () => {
    expect(startupError("0.0.0.0", "s3cret")).toBeNull();
  });

  test("loopback starts without a token — the OS is already the boundary", () => {
    expect(startupError("127.0.0.1", null)).toBeNull();
  });
});

describe("checkAuth", () => {
  test("no configured token means no check (loopback case)", () => {
    expect(checkAuth(null, null)).toEqual({ ok: true });
  });

  test("a missing header is 401, a wrong token is 403", () => {
    expect(checkAuth("abc", null)).toMatchObject({ ok: false, status: 401 });
    expect(checkAuth("abc", "Bearer xyz")).toMatchObject({ ok: false, status: 403 });
  });

  test("the right token passes, with or without the Bearer prefix", () => {
    expect(checkAuth("abc", "Bearer abc")).toEqual({ ok: true });
    expect(checkAuth("abc", "abc")).toEqual({ ok: true });
    expect(checkAuth("abc", "bearer abc")).toEqual({ ok: true });
  });

  test("a token that is a prefix of the real one is rejected", () => {
    expect(checkAuth("abcdef", "Bearer abc")).toMatchObject({ ok: false, status: 403 });
  });
});

describe("corsHeaders — allow-list only", () => {
  test("an allowed origin is echoed back", () => {
    const h = corsHeaders("http://localhost:5173", ["http://localhost:5173"]);
    expect(h["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
  });

  /*
   * The case the allow-list exists for. A bearer token does not protect a browser
   * endpoint from a page the user happens to visit — the browser would send the
   * request and hand that page the reply.
   */
  test("an unlisted origin gets NO cors headers at all", () => {
    expect(corsHeaders("https://evil.example", ["http://localhost:5173"])).toEqual({});
  });

  test("no origins configured means the browser is not invited", () => {
    expect(corsHeaders("http://localhost:5173", [])).toEqual({});
  });

  test("a request with no Origin header needs no cors", () => {
    expect(corsHeaders(null, ["http://localhost:5173"])).toEqual({});
  });
});
