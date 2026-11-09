import { describe, expect, it } from "vitest";
import type { AuthUserRecord } from "./db";
import { LOCAL_USER, isIdentifiableUser, resolveLaunchUser } from "./launch-user.ts";

const signedIn: AuthUserRecord = {
  provider: "clerk",
  provider_user_id: "user_123",
  email: "ada@example.com",
  name: "Ada",
  avatar_url: null,
  created_at: 1,
  updated_at: 1,
  last_seen_at: 1,
};

describe("with sign-in turned off", () => {
  it("opens Pipper for everyone without an account", () => {
    expect(resolveLaunchUser(false, null)).toEqual(LOCAL_USER);
  });

  it("runs an install that signed in before as the local user, so nothing about them is sent", () => {
    const user = resolveLaunchUser(false, signedIn);
    expect(user).toEqual(LOCAL_USER);
    expect(isIdentifiableUser(user)).toBe(false);
  });
});

describe("with sign-in turned on", () => {
  it("requires a completed sign-in", () => {
    expect(resolveLaunchUser(true, null)).toBeNull();
    expect(resolveLaunchUser(true, { ...signedIn, email: null })).toBeNull();
  });

  it("identifies a signed-in user", () => {
    const user = resolveLaunchUser(true, signedIn);
    expect(user).toBe(signedIn);
    expect(isIdentifiableUser(user)).toBe(true);
  });
});
