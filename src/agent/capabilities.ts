/** Application policy, independent of model instructions and saved preferences.
 * Learning material enters through explicit import; agents cannot browse the
 * host filesystem or execute generated HTML. Old records cannot re-enable it. */
const DISABLED_TOOLS = new Set(["read", "ls", "find", "grep", "pdf", "demo"]);

export function restrictAgentTools<T>(tools: Record<string, T>): Record<string, T> {
	return Object.fromEntries(Object.entries(tools).filter(([name, tool]) =>
		!DISABLED_TOOLS.has(name) && !(tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string" && DISABLED_TOOLS.has(tool.name)),
	));
}

export function jobAllowed(kind: string): boolean {
	return kind === "research" || kind === "visual";
}
