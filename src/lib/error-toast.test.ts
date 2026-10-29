import { describe, expect, test } from "vitest";
import { errorToast } from "./error-toast";

describe("errorToast", () => {
  test("strips Electron's IPC wrapper and uses a short message as the title", () => {
    const toast = errorToast(
      "Error invoking remote method 'agent:switchThread': Error: Thread not found: 9d7ac2f4",
    );
    expect(toast.title).toBe("Thread not found: 9d7ac2f4");
    expect("description" in toast).toBe(false);
  });

  test("a long message goes in the description under a generic title", () => {
    const long = `The agent did not accept the message because ${"x".repeat(80)}`;
    expect(errorToast(long)).toMatchObject({ title: "Something went wrong", description: long });
  });

  test("an empty message still says something", () => {
    expect(errorToast("Error: ").title).toBe("Something went wrong.");
  });
});
