// Read tools historically name their branch selector differently from the
// write tools: `read_file` takes `ref`, `get_tree` takes `tree_sha`, while
// every write tool takes `branch`. Both names are accepted (ADR 0008).
//
// If both are given with different values, the call fails instead of
// silently preferring one: reading the wrong branch without an error is
// exactly the bug this exists to prevent.

export const DEFAULT_REF = "main";

export function pickRef(
  tool: string,
  nativeName: string,
  nativeValue: string | undefined,
  branch: string | undefined
): string {
  if (nativeValue !== undefined && branch !== undefined && nativeValue !== branch) {
    throw new Error(
      `${tool} received both '${nativeName}' ('${nativeValue}') and 'branch' ('${branch}') with different values. Pass only one of them.`
    );
  }
  return nativeValue ?? branch ?? DEFAULT_REF;
}
