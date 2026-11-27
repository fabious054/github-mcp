// Files under .github/workflows/ need the `workflow` OAuth scope — issue
// #131, ADR 0023. GitHub refuses to create or change them with a token that
// lacks it, even when the account can write to the repository.

export const WORKFLOWS_DIR = ".github/workflows/";

export function isWorkflowPath(path: string): boolean {
  return path.replace(/^\.?\/+/, "").startsWith(WORKFLOWS_DIR);
}

export const MISSING_WORKFLOW_SCOPE_MESSAGE =
  "GitHub refused the change to a workflow file (.github/workflows/): this account's authorization doesn't include the 'workflow' scope yet (added to the connector on 2026-11-27). Reconnect the connector once to accept it; for an account linked with 'link_account', run 'link_account' again for that account. Nothing was committed.";

// GitHub's answer varies by endpoint: the git push wording ("refusing to
// allow an OAuth App to create or update workflow … without `workflow`
// scope") or a bare 403/404 from the contents and refs APIs.
export function isMissingWorkflowScope(err: unknown, paths: string[] = []): boolean {
  const e = err as { status?: number; message?: string };
  const msg = e?.message ?? "";
  if (/without [`'"]?workflow[`'"]? scope|workflow[`'"]? scope/i.test(msg)) return true;
  return paths.some(isWorkflowPath) && (e?.status === 403 || e?.status === 404);
}

export async function withWorkflowScope<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingWorkflowScope(err, paths)) throw new Error(MISSING_WORKFLOW_SCOPE_MESSAGE);
    throw err;
  }
}
