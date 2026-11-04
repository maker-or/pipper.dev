// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PROJECT_SHAPES, projectShape } from "../../contracts/projects.ts";
import { projectShapePath } from "@/lib/project-shapes";
import { AddProjectForm } from "./add-project-form";

let host: HTMLDivElement;
let root: Root;
const create = vi.fn();
const pickDirectory = vi.fn();
const onCreated = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [create, pickDirectory, onCreated]) mock.mockReset();
  pickDirectory.mockResolvedValue("/Users/me/code/my-app");
  create.mockImplementation(async (input) => ({ id: "project-1", ...input }));
  Object.defineProperty(window, "omni", {
    configurable: true,
    value: { projects: { create }, dialog: { pickDirectory } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function button(name: string): HTMLButtonElement {
  const match = [...host.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No button named ${name}`);
  return match;
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
}

test("a project is created with the shape the user chose", async () => {
  act(() => root.render(<AddProjectForm onBack={vi.fn()} onCreated={onCreated} />));

  await click(button("Browse"));
  // No shape yet, so the project cannot be created.
  expect(button("Create project").disabled).toBe(true);

  await click(button("4-leaf clover"));
  expect(button("4-leaf clover").getAttribute("aria-checked")).toBe("true");
  await click(button("Create project"));

  expect(create).toHaveBeenCalledWith({
    name: "my-app",
    path: "/Users/me/code/my-app",
    icon: "clover-4",
  });
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ icon: "clover-4" }));
});

test("projects from before shapes keep one stable shape", () => {
  const legacy = { id: "project-legacy", icon: "GithubLogo" };
  expect(PROJECT_SHAPES).toContain(projectShape(legacy));
  expect(projectShape(legacy)).toBe(projectShape({ ...legacy }));
  expect(projectShape({ id: "project-legacy", icon: null })).toBe(projectShape(legacy));
  expect(projectShape({ id: "project-legacy", icon: "bloom" })).toBe(projectShape(legacy));
  expect(projectShape({ id: "project-legacy", icon: "heart" })).toBe("heart");
});

test("every shape is a closed outline inside its box", () => {
  for (const shape of PROJECT_SHAPES) {
    const path = projectShapePath(shape);
    expect(path).toMatch(/^M.*Z$/);
    const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(numbers.every((value) => value >= 0 && value <= 100)).toBe(true);
  }
});
