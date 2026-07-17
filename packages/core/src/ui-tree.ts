import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { ServeDroidError } from "./errors.js";
import type { DisplayInfo, UiElement } from "./types.js";

interface XmlNode {
  node?: XmlNode | XmlNode[];
  [key: string]: unknown;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function bool(value: unknown): boolean {
  return value === true || value === "true";
}

function parseBounds(value: unknown, display: DisplayInfo) {
  const match = typeof value === "string" ? value.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/u) : null;
  if (!match) return { left: 0, top: 0, right: 0, bottom: 0 };
  const clamp = (number: number) => Math.max(0, Math.min(1, number));
  return {
    left: clamp(Number(match[1]) / display.width),
    top: clamp(Number(match[2]) / display.height),
    right: clamp(Number(match[3]) / display.width),
    bottom: clamp(Number(match[4]) / display.height),
  };
}

function stableId(path: string, node: XmlNode): string {
  return createHash("sha256")
    .update(`${path}\0${scalar(node["resource-id"])}\0${scalar(node.text)}`)
    .digest("hex")
    .slice(0, 16);
}

export function parseUiHierarchy(xml: string, display: DisplayInfo): UiElement[] {
  let document: { hierarchy?: XmlNode };
  try {
    document = parser.parse(xml) as { hierarchy?: XmlNode };
  } catch (error) {
    throw new ServeDroidError("ADB_FAILED", "UIAutomator returned malformed XML.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const root = document.hierarchy;
  if (!root) return [];
  const output: UiElement[] = [];
  const visit = (node: XmlNode, path: string, parentId: string | null): void => {
    const id = stableId(path, node);
    output.push({
      id,
      parentId,
      className: scalar(node.class),
      text: scalar(node.text),
      contentDescription: scalar(node["content-desc"]),
      resourceId: scalar(node["resource-id"]),
      packageName: scalar(node.package),
      bounds: parseBounds(node.bounds, display),
      enabled: bool(node.enabled),
      clickable: bool(node.clickable),
      focusable: bool(node.focusable),
      scrollable: bool(node.scrollable),
      selected: bool(node.selected),
      checked: bool(node.checked),
    });
    const children = Array.isArray(node.node) ? node.node : node.node ? [node.node] : [];
    children.forEach((child, index) => visit(child, `${path}.${index}`, id));
  };
  const roots = Array.isArray(root.node) ? root.node : root.node ? [root.node] : [];
  roots.forEach((node, index) => visit(node, String(index), null));
  return output;
}

export type ElementSelector =
  { id: string } | { resourceId: string } | { text: string } | { contentDescription: string };

export function findElement(elements: readonly UiElement[], selector: ElementSelector): UiElement {
  const entry = Object.entries(selector)[0];
  if (!entry) throw new ServeDroidError("INVALID_ARGUMENT", "Element selector must not be empty.");
  const [key, value] = entry;
  const matches = elements.filter((element) => {
    if (key === "id") return element.id === value;
    if (key === "resourceId") return element.resourceId === value;
    if (key === "text") return element.text === value;
    return element.contentDescription === value;
  });
  if (matches.length === 0) {
    throw new ServeDroidError("ELEMENT_NOT_FOUND", `No element matched ${key}='${value}'.`);
  }
  if (matches.length > 1) {
    throw new ServeDroidError(
      "ELEMENT_AMBIGUOUS",
      `${matches.length} elements matched ${key}='${value}'.`,
    );
  }
  return matches[0]!;
}
