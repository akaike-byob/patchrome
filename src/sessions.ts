import type { Page } from "patchright";
import { CommandError } from "./protocol.ts";
import { SnapshotGenerations } from "./refs.ts";

export interface Tab {
  id: string;
  session: string;
  page: Page;
  generations: SnapshotGenerations;
  isClosed: boolean;
}

interface Session {
  name: string;
  tabIds: Set<string>;
  currentTabId: string | undefined;
  origins: Set<string>;
  // Set for an --isolated session: its own in-memory Chrome browser context.
  browserContextId: string | undefined;
  // What the agent is doing, shown after the session name in its Chrome tab group title.
  label: string | undefined;
}

// What sessions.json keeps, so a restarted daemon can reopen each session's tabs.
export interface SavedSession {
  name: string;
  isIsolated: boolean;
  label: string | undefined;
  currentTabId: string | undefined;
  tabs: Array<{ id: string; url: string }>;
}

export interface TabSummary {
  id: string;
  session: string;
  url: string;
  isCurrent: boolean;
}

// Page is structural here so unit tests can register fake pages without a browser.
export type TrackedPage = Pick<Page, "on" | "url" | "mainFrame">;

export class SessionRegistry {
  #sessions = new Map<string, Session>();
  #tabs = new Map<string, Tab>();
  #nextTabNumber = 1;
  #onTabAdopted: (tab: Tab) => void;
  #onChanged: () => void;

  // The daemon hangs network recording and routes off onTabAdopted, so popups get them too, and saves
  // sessions.json on onChanged.
  constructor(onTabAdopted: (tab: Tab) => void = () => {}, onChanged: () => void = () => {}) {
    this.#onTabAdopted = onTabAdopted;
    this.#onChanged = onChanged;
  }

  // A restored tab keeps the id it had before the daemon restarted, so an agent's `switch t3` still works.
  adoptPage(sessionName: string, page: TrackedPage, makeCurrent: boolean, restoredTabId?: string): Tab {
    const session = this.#sessionFor(sessionName);
    const restoredNumber = restoredTabId === undefined ? undefined : Number(restoredTabId.slice(1));
    if (restoredNumber !== undefined) this.#nextTabNumber = Math.max(this.#nextTabNumber, restoredNumber + 1);
    const tab: Tab = {
      id: restoredTabId ?? `t${this.#nextTabNumber++}`,
      session: sessionName,
      page: page as Page,
      generations: new SnapshotGenerations(),
      isClosed: false,
    };
    this.#tabs.set(tab.id, tab);
    session.tabIds.add(tab.id);
    if (makeCurrent) session.currentTabId = tab.id;

    page.on("close", () => {
      tab.isClosed = true;
      session.tabIds.delete(tab.id);
      this.#tabs.delete(tab.id);
      this.#onChanged();
    });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      tab.generations.recordNavigation();
      const origin = originOf(page.url());
      if (origin !== undefined) session.origins.add(origin);
      this.#onChanged();
    });
    // A popup belongs to the session whose page opened it, and does not become current by itself.
    page.on("popup", (popup) => {
      this.adoptPage(sessionName, popup, false);
    });
    this.#onTabAdopted(tab);
    this.#onChanged();
    return tab;
  }

  currentTab(sessionName: string): Tab {
    const session = this.#sessions.get(sessionName);
    const tabId = session?.currentTabId;
    if (!session || tabId === undefined) {
      throw new CommandError("tab_gone", `session ${sessionName} has no current tab`, "run `patchrome open <url>`");
    }
    const tab = this.#tabs.get(tabId);
    if (!tab || tab.isClosed) {
      throw new CommandError("tab_gone", `tab ${tabId} was closed`, "run `patchrome open <url>` for a new tab");
    }
    return tab;
  }

  ownedTab(sessionName: string, tabId: string): Tab {
    const tab = this.#tabs.get(tabId);
    if (!tab || tab.isClosed) {
      throw new CommandError("tab_gone", `no open tab ${tabId}`, "run `patchrome tabs` to list this session's tabs");
    }
    if (tab.session !== sessionName) {
      throw new CommandError("bad_args", `tab ${tabId} belongs to another session`, "a session only acts on tabs it opened");
    }
    return tab;
  }

  switchTo(sessionName: string, tabId: string): Tab {
    const tab = this.ownedTab(sessionName, tabId);
    this.#sessionFor(sessionName).currentTabId = tab.id;
    this.#onChanged();
    return tab;
  }

  tabsOf(sessionName: string): TabSummary[] {
    const session = this.#sessions.get(sessionName);
    if (!session) return [];
    return [...session.tabIds].map((id) => this.#summarize(id, session.currentTabId));
  }

  allTabs(): TabSummary[] {
    return [...this.#sessions.values()].flatMap((session) =>
      [...session.tabIds].map((id) => this.#summarize(id, session.currentTabId)),
    );
  }

  openTabsOf(sessionName: string): Tab[] {
    const session = this.#sessions.get(sessionName);
    if (!session) return [];
    return [...session.tabIds].map((id) => this.#tabs.get(id)).filter((tab): tab is Tab => tab !== undefined && !tab.isClosed);
  }

  forget(sessionName: string): void {
    for (const tabId of this.#sessions.get(sessionName)?.tabIds ?? []) this.#tabs.delete(tabId);
    this.#sessions.delete(sessionName);
    this.#onChanged();
  }

  // Tab ids saved before a restart stay reserved, so a new tab never takes the id of one still to be restored.
  reserveTabIds(tabIds: string[]): void {
    for (const tabId of tabIds) this.#nextTabNumber = Math.max(this.#nextTabNumber, Number(tabId.slice(1)) + 1);
  }

  hasSession(sessionName: string): boolean {
    return this.#sessions.has(sessionName);
  }

  browserContextOf(sessionName: string): string | undefined {
    return this.#sessions.get(sessionName)?.browserContextId;
  }

  isolate(sessionName: string, browserContextId: string): void {
    this.#sessionFor(sessionName).browserContextId = browserContextId;
  }

  labelOf(sessionName: string): string | undefined {
    return this.#sessions.get(sessionName)?.label;
  }

  setLabel(sessionName: string, label: string | undefined): void {
    this.#sessionFor(sessionName).label = label;
    this.#onChanged();
  }

  savedSessions(): SavedSession[] {
    return [...this.#sessions.values()].map((session) => ({
      name: session.name,
      isIsolated: session.browserContextId !== undefined,
      label: session.label,
      currentTabId: session.currentTabId,
      tabs: [...session.tabIds].map((id) => ({ id, url: this.#tabs.get(id)?.page.url() ?? "" })),
    }));
  }

  // Web origins the session's tabs have loaded, which is what `state save` keeps.
  originsOf(sessionName: string): string[] {
    return [...(this.#sessions.get(sessionName)?.origins ?? [])];
  }

  sessionNames(): string[] {
    return [...this.#sessions.keys()];
  }

  #sessionFor(name: string): Session {
    let session = this.#sessions.get(name);
    if (!session) {
      session = { name, tabIds: new Set(), currentTabId: undefined, origins: new Set(), browserContextId: undefined, label: undefined };
      this.#sessions.set(name, session);
    }
    return session;
  }

  #summarize(tabId: string, currentTabId: string | undefined): TabSummary {
    const tab = this.#tabs.get(tabId);
    return { id: tabId, session: tab?.session ?? "", url: tab?.page.url() ?? "", isCurrent: tabId === currentTabId };
  }
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
