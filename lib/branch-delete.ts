// Guards for the delete_branch tool (ADR 0010). Pure, so the rules can be
// tested without GitHub. Returns the reason the branch must NOT be deleted, or
// null when deleting is allowed.

export type OpenPr = { number: number; head: string; base: string };

export type DeleteBranchFacts = {
  branch: string;
  defaultBranch: string;
  isProtected: boolean;
  openPrs: OpenPr[]; // open PRs that use the branch as head or base
};

export function deleteBranchRefusal(f: DeleteBranchFacts): string | null {
  if (f.branch === f.defaultBranch) {
    return `'${f.branch}' is the repository's default branch and can't be deleted with this tool.`;
  }
  if (f.isProtected) {
    return `'${f.branch}' is a protected branch on GitHub and can't be deleted with this tool.`;
  }
  if (f.openPrs.length > 0) {
    const list = f.openPrs
      .map((pr) => `#${pr.number} (${pr.head} → ${pr.base})`)
      .join(", ");
    return `'${f.branch}' is used by open pull request(s) ${list}. Deleting it would close them: merge or close the PR(s) first, then delete the branch.`;
  }
  return null;
}
