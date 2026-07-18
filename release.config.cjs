// 0ver policy (binding): this package stays on 0.x. While major is 0,
// breaking changes release a MINOR and features release a PATCH. No rule
// below may ever say "major": commit-analyzer only falls back to its
// default rules (which contain major) when NO custom rule matches, and the
// `breaking: true` rule in `releaseRules` matches every breaking commit
// first, so a 1.0.0 auto-bump is impossible with this configuration.
// Leaving 0.x is a deliberate, manual decision (edit these rules then).
const rules = [
  { type: "feat", release: "patch", title: "Features" },
  { type: "fix", release: "patch", title: "Bug Fixes" },
  { type: "perf", release: "patch", title: "Performance Improvements" },
  { type: "refactor", release: "patch", title: "Code Refactors" },
  { type: "docs", release: "patch", title: "Documentation" },
  { type: "chore", release: "patch", title: "Other changes" },
];

const sortMap = Object.fromEntries(rules.map((rule, index) => [rule.title, index]));

/**
 * @type {import('semantic-release').GlobalConfig}
 */
module.exports = {
  branches: ["main", { name: "next", prerelease: "next" }],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          // 0ver: breaking -> minor while on 0.x. Never "major" here.
          { breaking: true, release: "minor" },
          { revert: true, release: "patch" },
        ].concat(rules.map(({ type, release }) => ({ type, release }))),
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
        presetConfig: {
          types: rules.map(({ type, title }) => ({
            type,
            section: title,
          })),
        },
        writerOpts: {
          commitGroupsSort: (a, z) => sortMap[a.title] - sortMap[z.title],
        },
      },
    ],
    [
      "@semantic-release/changelog",
      {
        changelogFile: "CHANGELOG.md",
      },
    ],
    "@semantic-release/npm",
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        assets: ["package.json", "CHANGELOG.md", "example/package.json"],
      },
    ],
  ],
};
