import { describe, expect, it } from "vite-plus/test";

import { orderAdoptedStyleSheets, sameStyleSheetOrder } from "./themeCss.logic";

describe("orderAdoptedStyleSheets", () => {
  const unmanagedA = { name: "unmanaged-a" };
  const unmanagedB = { name: "unmanaged-b" };
  const theme = { name: "theme" };
  const pluginA = { name: "plugin-a" };
  const pluginB = { name: "plugin-b" };

  it("places plugin sheets after the theme sheet when theme applies first", () => {
    const afterTheme = orderAdoptedStyleSheets([unmanagedA], {
      themeSheet: theme,
      pluginSheets: [],
    });
    expect(afterTheme).toEqual([unmanagedA, theme]);

    const afterPlugins = orderAdoptedStyleSheets(afterTheme, {
      themeSheet: theme,
      pluginSheets: [pluginA, pluginB],
    });
    expect(afterPlugins).toEqual([unmanagedA, theme, pluginA, pluginB]);
  });

  it("still places plugin sheets after the theme sheet when plugins apply first", () => {
    const afterPlugins = orderAdoptedStyleSheets([unmanagedA], {
      themeSheet: null,
      pluginSheets: [pluginA, pluginB],
    });
    expect(afterPlugins).toEqual([unmanagedA, pluginA, pluginB]);

    const afterTheme = orderAdoptedStyleSheets(afterPlugins, {
      themeSheet: theme,
      pluginSheets: [pluginA, pluginB],
    });
    expect(afterTheme).toEqual([unmanagedA, theme, pluginA, pluginB]);
  });

  it("removes dropped plugin sheets while preserving unmanaged sheets and theme order", () => {
    const current = [unmanagedA, theme, pluginA, pluginB, unmanagedB];
    const next = orderAdoptedStyleSheets(current, {
      themeSheet: theme,
      pluginSheets: [pluginB],
      removedSheets: new Set([pluginA]),
    });
    expect(next).toEqual([unmanagedA, unmanagedB, theme, pluginB]);

    const cleared = orderAdoptedStyleSheets(next, {
      themeSheet: theme,
      pluginSheets: [],
      removedSheets: new Set([pluginB]),
    });
    expect(cleared).toEqual([unmanagedA, unmanagedB, theme]);
  });

  it("detects identical sheet orders", () => {
    expect(sameStyleSheetOrder([unmanagedA, theme, pluginA], [unmanagedA, theme, pluginA])).toBe(
      true,
    );
    expect(sameStyleSheetOrder([theme, pluginA, pluginB], [theme, pluginB, pluginA])).toBe(false);
    expect(sameStyleSheetOrder([theme, pluginA], [theme])).toBe(false);
  });
});
