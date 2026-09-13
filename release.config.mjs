import createPreset, { DEFAULT_COMMIT_TYPES } from "conventional-changelog-conventionalcommits";

// Every merge to main releases. A squash merge's commit title is the PR title, and its prefix picks the bump:
// "feat: ..." is minor, a "!" before the colon or a "BREAKING CHANGE:" footer is major, anything else is patch.
// A title with no prefix is a patch too, listed under "Changes".
const untypedType = "change";

// The preset hides docs, chore, ci and the like, which would leave a release made from one of them with no notes.
// It also accepts "feature" beside "feat"; one spelling keeps the minor rule below to one type.
export const commitTypes = [
  ...DEFAULT_COMMIT_TYPES.filter(({ type }) => type !== "feature").map(({ type, section }) => ({ type, section })),
  { type: untypedType, section: "Changes" },
];

const preset = createPreset({ types: commitTypes });

export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        presetConfig: { types: commitTypes },
        // Rules replace the defaults only for commits they match, and the highest matching release wins, so
        // the empty last rule makes every commit at least a patch.
        releaseRules: [{ breaking: true, release: "major" }, { type: "feat", release: "minor" }, { release: "patch" }],
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
        presetConfig: { types: commitTypes },
        writerOpts: {
          // The conventional parser leaves type and subject empty for a title with no prefix, and the writer
          // drops such commits.
          transform: (commit, context) =>
            preset.writer.transform(
              commit.type ? commit : { ...commit, type: untypedType, subject: commit.header },
              context,
            ),
        },
      },
    ],
    "@semantic-release/npm",
    [
      "@semantic-release/github",
      {
        // Commenting on PRs and issues needs write access to both; the release page lists them already.
        successComment: false,
        failComment: false,
        releasedLabels: false,
      },
    ],
  ],
};
