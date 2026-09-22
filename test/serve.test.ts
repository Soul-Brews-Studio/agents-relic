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

/*
 * relic_trace answers a different question from every other tool, and the difference is
 * easy to lose: the cloud is what was ASKED, never what the corpus holds. The most
 * indexed topic on a machine can be the one nobody ever needs to search for.
 */
describe("relic_trace cloud shaping", () => {
  const cloud = (terms: { term: string; n: number }[], min: number, limit: number) =>
    terms.filter(x => x.n >= min).slice(0, limit);

  const TERMS = [
    { term: "herdr", n: 37 }, { term: "provisioner", n: 19 }, { term: "bank", n: 15 },
    { term: "relic", n: 12 }, { term: "asked once", n: 1 }, { term: "also once", n: 1 },
  ];

  test("single-use terms are dropped — a 1:1 cloud is all size-1 noise", () => {
    const out = cloud(TERMS, 2, 60);
    expect(out.map(x => x.term)).not.toContain("asked once");
    expect(out).toHaveLength(4);
  });

  test("min_count 1 keeps them, for 'how many distinct things have I looked for'", () => {
    expect(cloud(TERMS, 1, 60)).toHaveLength(6);
  });

  test("limit trims the tail, keeping the most-asked", () => {
    const out = cloud(TERMS, 2, 2);
    expect(out.map(x => x.term)).toEqual(["herdr", "provisioner"]);
  });
});
