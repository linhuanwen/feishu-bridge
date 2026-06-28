import { describe, it, expect } from "vitest";
import { isSenderAllowed } from "./isSenderAllowed.js";

describe("isSenderAllowed", () => {
  const ALLOWED = ["ou_alice", "ou_bob"];

  it("白名单内的用户返回 true", () => {
    expect(isSenderAllowed("ou_alice", ALLOWED)).toBe(true);
  });

  it("白名单外的用户返回 false", () => {
    expect(isSenderAllowed("ou_eve", ALLOWED)).toBe(false);
  });

  it("空白名单时全部拒绝", () => {
    expect(isSenderAllowed("ou_alice", [])).toBe(false);
  });
});
