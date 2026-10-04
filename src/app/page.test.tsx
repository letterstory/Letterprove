import { describe, expect, it, vi } from "vitest";

const { permanentRedirect } = vi.hoisted(() => ({
  permanentRedirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("next/navigation", () => ({ permanentRedirect }));

import Home from "./page";

describe("the bare app.letterprove.com host", () => {
  it("sends visitors to letterprove.com rather than serving a second homepage", () => {
    expect(() => Home()).toThrow("NEXT_REDIRECT");
    expect(permanentRedirect).toHaveBeenCalledWith("https://letterprove.com");
  });
});
