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
    // Writes CHANGELOG.md into the workspace during prepare. It is deliberately
    // never committed back (see below), so it exists only inside the published
    // npm tarball, which lists it in `files`. The repo's own history is the
    // GitHub Release notes.
    [
      "@semantic-release/changelog",
      {
        changelogFile: "CHANGELOG.md",
      },
    ],
    "@semantic-release/npm",
    "@semantic-release/github",
    // No @semantic-release/git. Pushing a release commit back to `main` requires
    // the release identity to bypass the branch ruleset, which upstream warns
    // "might require elevating the access level of the release user beyond what
    // would otherwise be desired/considered secure". On a user-owned repo the
    // GitHub Actions integration cannot be granted that bypass at all, so the
    // only ways to keep the plugin are a PAT or a GitHub App token, both of
    // which reintroduce the credential this workflow's OIDC publishing removes.
    // semantic-release does not need the commit: versions come from git tags.
  ],
};
