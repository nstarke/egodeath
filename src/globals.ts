import { GlobalsMap } from './types';

/**
 * Global state: maps original identifiers to obfuscated names.
 * The ___val property holds the obfuscated replacement name.
 */
let globals: GlobalsMap = Object.create(null);

/**
 * Track properties assigned to the window object.
 */
let windowProps: string[] = [];

export function getGlobals(): GlobalsMap {
  return globals;
}

export function setGlobals(g: GlobalsMap): void {
  globals = g;
}

export function resetGlobals(): void {
  globals = Object.create(null);
}

export function getWindowProps(): string[] {
  return windowProps;
}

export function resetWindowProps(): void {
  windowProps = [];
}

export function addWindowProp(prop: string): void {
  windowProps.push(prop);
}

/**
 * Create a null-prototype object with a ___val property.
 * Using null prototype avoids collisions with Object.prototype
 * properties like hasOwnProperty, toString, constructor, etc.
 */
export function createEntry(val: string): GlobalsMap {
  const entry: GlobalsMap = Object.create(null);
  entry.___val = val;
  return entry;
}
