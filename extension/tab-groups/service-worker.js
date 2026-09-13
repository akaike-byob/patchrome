// The daemon calls these through its service worker handle. The extension injects nothing into pages.
// chrome.debugger.getTargets only lists targets, it attaches to none, so Chrome shows no debugging bar.

async function tabsOfTargets(targetIds) {
  const tabIdByTarget = new Map((await chrome.debugger.getTargets()).map((target) => [target.id, target.tabId]));
  const tabIds = targetIds.map((targetId) => tabIdByTarget.get(targetId)).filter((tabId) => tabId !== undefined);
  return Promise.all(tabIds.map((tabId) => chrome.tabs.get(tabId)));
}

// A group cannot span windows, and isolated sessions open in their own window, so each window gets a group.
// A tab already in a group keeps that group, so a new tab joins its session's group instead of starting one.
globalThis.patchromeGroupTabs = async ({ targetIds, title, color }) => {
  const tabsByWindow = new Map();
  for (const tab of await tabsOfTargets(targetIds)) tabsByWindow.set(tab.windowId, [...(tabsByWindow.get(tab.windowId) ?? []), tab]);
  for (const tabs of tabsByWindow.values()) {
    const existingGroupId = tabs.find((tab) => tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)?.groupId;
    const groupId = await chrome.tabs.group({ tabIds: tabs.map((tab) => tab.id), ...(existingGroupId === undefined ? {} : { groupId: existingGroupId }) });
    await chrome.tabGroups.update(groupId, { title, color });
  }
};

globalThis.patchromeDescribeTabGroups = async ({ targetIds }) => {
  const tabCountByGroup = new Map();
  for (const tab of await tabsOfTargets(targetIds)) {
    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) continue;
    tabCountByGroup.set(tab.groupId, (tabCountByGroup.get(tab.groupId) ?? 0) + 1);
  }
  return Promise.all([...tabCountByGroup].map(async ([groupId, tabCount]) => {
    const group = await chrome.tabGroups.get(groupId);
    return { title: group.title ?? "", color: group.color, tabCount };
  }));
};

// Tab events wake the worker if Chrome ever suspends it.
chrome.tabs.onCreated.addListener(() => {});
