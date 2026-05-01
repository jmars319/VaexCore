import { execFileSync } from "node:child_process";

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
assert(branch === "main", `release must run from main, currently on ${branch}`);

const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
assert(status.trim() === "", `release requires a clean working tree:\n${status}`);

const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
const ahead = Number(git(["rev-list", "--count", `${upstream}..HEAD`]));
const behind = Number(git(["rev-list", "--count", `HEAD..${upstream}`]));
assert(ahead === 0, `release branch is ${ahead} commit(s) ahead of ${upstream}; push first`);
assert(behind === 0, `release branch is ${behind} commit(s) behind ${upstream}; pull first`);

const commit = git(["rev-parse", "HEAD"]);
assert(/^[0-9a-f]{40}$/.test(commit), "release commit must resolve to a full SHA");

console.log(`release git state ok: ${branch} ${commit}`);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Release git-state check failed: ${message}`);
  }
}
