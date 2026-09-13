// Chrome's fixed tab group palette.
export const tabGroupColors = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;
export type TabGroupColor = (typeof tabGroupColors)[number];

export interface TabGroupSummary {
  title: string;
  color: TabGroupColor;
  tabCount: number;
}

// The session name leads, so a glance at the tab strip says which agent owns the tabs.
export function tabGroupTitleFor(sessionName: string, label: string | undefined): string {
  return label === undefined || label === "" ? sessionName : `${sessionName}: ${label}`;
}

// A session keeps its colour across restarts and relabels, because the colour comes from the name alone.
export function tabGroupColorFor(sessionName: string): TabGroupColor {
  let hash = 0;
  for (const char of sessionName) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return tabGroupColors[hash % tabGroupColors.length] ?? "grey";
}
