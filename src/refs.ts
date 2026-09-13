import { CommandError } from "./protocol.ts";

// A ref is `@e12`, or `@f1e12` when Playwright prefixes the frame, resolved against the tab's latest snapshot. Staleness is tracked per tab, not per ref,
// because a stale aria-ref locator does not fail on its own: it waits out the whole timeout.
export function parseRef(input: string): string {
  const match = input.match(/^@?((?:f\d+)?e\d+)$/);
  if (!match?.[1]) {
    throw new CommandError(
      "bad_args",
      `not a ref: ${input}`,
      "refs look like @e12 or @f1e12, taken from the latest snapshot",
    );
  }
  return match[1];
}

export function refsIn(snapshotText: string): Set<string> {
  return new Set([...snapshotText.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map((match) => match[1] ?? ""));
}

export class SnapshotGenerations {
  #navigationCount = 0;
  #snapshotAtNavigation: number | undefined;
  #latestRefs = new Set<string>();
  #latestSnapshot = "";

  recordNavigation(): void {
    this.#navigationCount++;
  }

  recordSnapshot(snapshot: string): void {
    this.#snapshotAtNavigation = this.#navigationCount;
    this.#latestRefs = refsIn(snapshot);
    this.#latestSnapshot = snapshot;
  }

  get latestSnapshot(): string {
    return this.#latestSnapshot;
  }

  // Playwright renumbers frames on every snapshot, so a ref copied from an older snapshot of another
  // page can survive the navigation check and then fail inside Playwright as "Invalid frame".
  assertRefCurrent(ref: string): void {
    this.#assertNoNavigation();
    if (!this.#latestRefs.has(ref)) {
      throw new CommandError(
        "ref_stale",
        `@${ref} is not in the latest snapshot of this tab`,
        "run `patchrome snapshot` and copy a ref from it",
      );
    }
  }

  #assertNoNavigation(): void {
    if (this.#snapshotAtNavigation === undefined) {
      throw new CommandError("ref_stale", "no snapshot taken on this tab", "run `patchrome snapshot` first");
    }
    if (this.#snapshotAtNavigation !== this.#navigationCount) {
      throw new CommandError(
        "ref_stale",
        "the page navigated since the last snapshot",
        "run `patchrome snapshot` again",
      );
    }
  }
}
