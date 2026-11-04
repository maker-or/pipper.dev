import { expect, test } from "vitest";
import type { Project } from "../../contracts/projects.ts";
import { moveItem, RAIL_TILE_HEIGHT, railSlotHeight, upsertProject } from "./project-order";

const project = (id: string, name = id): Project => ({ id, name, path: `/${id}`, icon: null });

test("a project moves anywhere in the rail, and stays put at either end", () => {
  const list = ["a", "b", "c", "d"];
  expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
  expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
  expect(moveItem(list, 0, -1)).toEqual(list);
  expect(moveItem(list, 3, 4)).toEqual(list);
  expect(moveItem(list, 9, 0)).toEqual(list);
});

test("a renamed project keeps its place and a new one joins the end", () => {
  const list = [project("a"), project("b"), project("c")];
  expect(upsertProject(list, project("b", "renamed")).map((item) => item.name)).toEqual([
    "a",
    "renamed",
    "c",
  ]);
  expect(upsertProject(list, project("d")).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
});

test("the rail fills its height with five or six tiles and scrolls the rest", () => {
  // Tall rail: six tiles, spread to fill it.
  expect(railSlotHeight(900)).toBe(150);
  // Room for exactly five and a bit: five, filling it.
  expect(railSlotHeight(450)).toBe(90);
  // Too short for five: tiles keep their size and the rail scrolls.
  expect(railSlotHeight(300)).toBe(RAIL_TILE_HEIGHT);
});
