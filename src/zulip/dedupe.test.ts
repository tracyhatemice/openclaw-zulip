import { describe, it, expect } from "vitest";
import { createDedupeCache } from "./dedupe";

describe("createDedupeCache", () => {
  it("returns false on the first check for a key", () => {
    const cache = createDedupeCache({ ttlMs: 5000, maxSize: 100 });
    expect(cache.check("key-a", 1000)).toBe(false);
  });

  it("returns true on the second check of the same key", () => {
    const cache = createDedupeCache({ ttlMs: 5000, maxSize: 100 });
    cache.check("key-a", 1000);
    expect(cache.check("key-a", 1500)).toBe(true);
  });

  it("returns false for null key", () => {
    const cache = createDedupeCache({ ttlMs: 5000, maxSize: 100 });
    expect(cache.check(null, 1000)).toBe(false);
  });

  it("returns false for undefined key", () => {
    const cache = createDedupeCache({ ttlMs: 5000, maxSize: 100 });
    expect(cache.check(undefined, 1000)).toBe(false);
  });

  it("returns false after TTL has expired", () => {
    const ttlMs = 5000;
    const cache = createDedupeCache({ ttlMs, maxSize: 100 });
    cache.check("key-a", 1000);
    expect(cache.check("key-a", 1000 + ttlMs)).toBe(false);
  });

  it("returns true when TTL has not yet expired", () => {
    const ttlMs = 5000;
    const cache = createDedupeCache({ ttlMs, maxSize: 100 });
    cache.check("key-a", 1000);
    expect(cache.check("key-a", 1000 + ttlMs - 1)).toBe(true);
  });

  it("evicts the oldest entry when maxSize is exceeded", () => {
    const cache = createDedupeCache({ ttlMs: 60000, maxSize: 3 });
    cache.check("a", 1000);
    cache.check("b", 1001);
    cache.check("c", 1002);
    // Adding a fourth key should evict "a" (oldest)
    cache.check("d", 1003);
    // "a" was evicted, so checking it again should return false
    expect(cache.check("a", 1004)).toBe(false);
    // After re-inserting "a" at 1004, "b" (inserted at 1001) is now the oldest.
    // "c" should still be present since it was inserted after "b"
    expect(cache.check("c", 1005)).toBe(true);
  });

  it("always returns false when maxSize is 0", () => {
    const cache = createDedupeCache({ ttlMs: 60000, maxSize: 0 });
    cache.check("key-a", 1000);
    expect(cache.check("key-a", 1001)).toBe(false);
  });

  it("does not collide between different keys", () => {
    const cache = createDedupeCache({ ttlMs: 5000, maxSize: 100 });
    cache.check("key-a", 1000);
    expect(cache.check("key-b", 1001)).toBe(false);
  });

  it("re-checking a key refreshes its timestamp", () => {
    const ttlMs = 5000;
    const cache = createDedupeCache({ ttlMs, maxSize: 100 });
    cache.check("key-a", 1000);
    // Re-check at 4000 — found (4000-1000=3000 < 5000), refreshes timestamp to 4000
    expect(cache.check("key-a", 4000)).toBe(true);
    // At 8999 (4000 + 4999) it should still be alive because timestamp was refreshed
    // But that check also refreshes the timestamp to 8999
    expect(cache.check("key-a", 4000 + ttlMs - 1)).toBe(true);
    // Without the refresh at 8999, the entry would have expired at 9000.
    // But since it was refreshed to 8999, it now expires at 8999 + 5000 = 13999.
    // Verify it's still alive well past the original expiry.
    expect(cache.check("key-a", 13000)).toBe(true);
  });

  it("uses only size-based eviction when ttlMs is 0", () => {
    const cache = createDedupeCache({ ttlMs: 0, maxSize: 2 });
    cache.check("a", 1000);
    cache.check("b", 1001);
    // Both should still be present (within maxSize)
    expect(cache.check("a", 1002)).toBe(true);
    expect(cache.check("b", 1003)).toBe(true);
    // Adding a third should evict the oldest
    cache.check("c", 1004);
    // "a" was re-checked at 1002 and "b" at 1003, so "a" is oldest after "c" is added
    expect(cache.check("a", 1005)).toBe(false);
  });

  it("returns false for empty string key", () => {
    const cache = createDedupeCache({ ttlMs: 5000, maxSize: 100 });
    expect(cache.check("", 1000)).toBe(false);
  });

  it("handles re-insertion after TTL expiry as a new entry", () => {
    const ttlMs = 1000;
    const cache = createDedupeCache({ ttlMs, maxSize: 100 });
    cache.check("key-a", 0);
    // Expired
    expect(cache.check("key-a", 1000)).toBe(false);
    // Now it was re-inserted at 1000, so checking again should be true
    expect(cache.check("key-a", 1500)).toBe(true);
  });

  it("preserves newer entries while evicting expired ones", () => {
    const ttlMs = 1000;
    const cache = createDedupeCache({ ttlMs, maxSize: 100 });
    cache.check("old", 0);
    cache.check("new", 900);
    // At t=1000, "old" is expired but "new" is not
    expect(cache.check("old", 1000)).toBe(false);
    expect(cache.check("new", 1000)).toBe(true);
  });
});
