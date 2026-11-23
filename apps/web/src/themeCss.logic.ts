/**
 * Orders adopted stylesheets so managed plugin sheets always sit after the
 * managed theme sheet while preserving any unmanaged sheets in place.
 */
export function orderAdoptedStyleSheets<T>(
  current: ReadonlyArray<T>,
  managed: {
    readonly themeSheet: T | null;
    readonly pluginSheets: ReadonlyArray<T>;
    readonly removedSheets?: ReadonlySet<T>;
  },
): ReadonlyArray<T> {
  const managedSet = new Set<T>();
  if (managed.themeSheet !== null) managedSet.add(managed.themeSheet);
  for (const sheet of managed.pluginSheets) managedSet.add(sheet);
  if (managed.removedSheets !== undefined) {
    for (const sheet of managed.removedSheets) managedSet.add(sheet);
  }
  const unmanaged = current.filter((sheet) => !managedSet.has(sheet));
  return [
    ...unmanaged,
    ...(managed.themeSheet === null ? [] : [managed.themeSheet]),
    ...managed.pluginSheets,
  ];
}

export function sameStyleSheetOrder<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): boolean {
  return left.length === right.length && left.every((sheet, index) => sheet === right[index]);
}
