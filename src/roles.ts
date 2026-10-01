/**
 * `embed --roles` — which event roles a run embeds (#129).
 *
 * Measured on a 1-in-50 sample of 2026-08 (6,625 events, 1.44 M EmbeddingGemma tokens):
 * tool_use + tool_result are 63% of the events and 70% of the tokens an embed pays for,
 * while what semantic search is asked for (what was said, decided, explained) lives in
 * user/assistant/reasoning and notes. Embedding time scales with tokens, so a chat-first
 * pass gives a month of semantic search in about a third of the time.
 *
 * A run with --roles writes to the same vectors table as any other run: a later run
 * without it embeds only what is still missing, through the same anti-join. Nothing is
 * re-embedded and nothing is dropped. Without --roles every role is embedded, as before.
 */

/** Named groups. A spec may mix them with plain role names: `--roles chat,note`. */
export const ROLE_GROUPS: Record<string, readonly string[]> = {
  chat: ["user", "assistant", "thinking", "reasoning"],
  tool: ["tool_use", "tool_result"],
  other: ["note", "developer", "system"],
};

/**
 * `"chat,other"` → the sorted, de-duplicated role list; undefined for no spec (every role).
 * A role name that is not a group is taken as given, so a role a future source adds can be
 * named before anything here knows it. An empty spec is an error, not "every role".
 */
export function parseRoles(spec: string | boolean | undefined): string[] | undefined {
  if (spec === undefined || spec === false) return undefined;
  if (spec === true) throw new Error("--roles takes a list: e.g. --roles chat,other (groups: " +
                                     Object.keys(ROLE_GROUPS).join(", ") + ")");
  const out = new Set<string>();
  for (const part of spec.split(",").map(s => s.trim()).filter(Boolean))
    for (const role of ROLE_GROUPS[part] ?? [part]) out.add(role);
  if (!out.size) throw new Error("--roles is empty");
  return [...out].sort();
}

/** The SQL filter for a role list, or "" for every role. */
export function roleFilter(roles: readonly string[] | undefined): string {
  // Quoted as store/lance.ts sqlStr does; not imported, because lance.ts imports this.
  return roles?.length ? `role IN (${roles.map(r => `'${r.replace(/'/g, "''")}'`).join(", ")})` : "";
}
