import { commitTypes } from "../../release.config.mjs";

// The squash commit takes the PR title, and release.config.mjs reads its prefix to pick the version bump. A
// mistyped prefix such as "Feat:" or "feature(cli):" would otherwise ship as a quiet patch.
const title = process.env.PR_TITLE ?? "";
const prefix = title.match(/^(\w+)(\([^)]*\))?(!)?: /);
const validTypes = commitTypes.map(({ type }) => type).filter((type) => type !== "change");

if (prefix && !validTypes.includes(prefix[1])) {
  console.error(`PR title prefix "${prefix[1]}:" is not a known type. Valid types: ${validTypes.join(", ")}.`);
  console.error(
    'Leave the prefix off for a patch release, use "feat:" for minor, and add "!" before the colon for major.',
  );
  process.exit(1);
}
const bump = prefix?.[3] ? "major" : prefix?.[1] === "feat" ? "minor" : "patch";
process.stdout.write(`"${title}" releases a ${bump} version on merge.\n`);
