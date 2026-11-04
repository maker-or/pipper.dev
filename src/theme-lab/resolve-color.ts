import { toHex } from "@/lib/oklch";

let context: CanvasRenderingContext2D | null | undefined;

/**
 * Resolves a token on `element` to hex — whatever CSS form it is declared in
 * (oklch, color-mix, var chains). Null when the token is unset there.
 */
export function resolveTokenHex(element: HTMLElement, name: string): string | null {
  if (!getComputedStyle(element).getPropertyValue(name).trim()) return null;
  if (context === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    context = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!context) return null;
  element.style.color = `var(${name})`;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = "#000000";
  context.fillStyle = getComputedStyle(element).color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return toHex({ r: r / 255, g: g / 255, b: b / 255, a: a / 255 });
}
