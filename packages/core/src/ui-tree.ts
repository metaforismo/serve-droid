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

function tagEnd(xml: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < xml.length; index += 1) {
    const value = xml[index];
    if (quote) {
      if (value === quote) quote = null;
      continue;
    }
    if (value === '"' || value === "'") {
      quote = value;
      continue;
    }
    if (value === ">") return index;
  }
  return -1;
}

function hasBalancedHierarchyMarkup(xml: string): boolean {
  const stack: string[] = [];
  let rootSeen = false;
  let rootClosed = false;
  let cursor = 0;

  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) break;

    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end < 0) return false;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      if (end < 0) return false;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end < 0) return false;
      cursor = end + 2;
      continue;
    }

    const end = tagEnd(xml, start);
    if (end < 0) return false;
    let tag = xml.slice(start + 1, end).trim();
    if (!tag) return false;
    if (tag.startsWith("!")) {
      cursor = end + 1;
      continue;
    }

    const closing = tag.startsWith("/");
    if (closing) tag = tag.slice(1).trimStart();
    const selfClosing = !closing && tag.endsWith("/");
    const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)/u.exec(tag);
    if (!match) return false;
    const name = match[1]!;

    if (!rootSeen) {
      if (closing || name !== "hierarchy") return false;
      rootSeen = true;
    } else if (rootClosed && !closing) {
      return false;
    }

    if (closing) {
      if (stack.pop() !== name) return false;
      if (stack.length === 0) rootClosed = true;
    } else if (selfClosing) {
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push(name);
    }
    cursor = end + 1;
  }

  return rootSeen && rootClosed && stack.length === 0;
}

export function parseUiHierarchy(xml: string, display: DisplayInfo): UiElement[] {
  if (!hasBalancedHierarchyMarkup(xml)) {
    throw new ServeDroidError("ADB_FAILED", "UIAutomator returned malformed XML.");
  }

  let document: { hierarchy?: XmlNode };
  try {
    document = parser.parse(xml) as { hierarchy?: XmlNode };
  } catch (error) {
    throw new ServeDroidError("ADB_FAILED", "UIAutomator returned malformed XML.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const root = document.hierarchy;
  if (!root) {
    throw new ServeDroidError("ADB_FAILED", "UIAutomator XML did not contain a hierarchy root.");
  }
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
