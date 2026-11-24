/**
 * Model-specific system prompt additions.
 *
 * Rules live in ~/.pi/agent/model-prompts.json:
 *   { "rules": [
 *     { "match": "gpt-6*", "prompt": "inline text" },
 *     { "match": "*terra*", "promptFile": "terra.md" }
 *   ] }
 *
 * `promptFile` is read from a path relative to ~/.pi/agent/ (or absolute).
 * `scope: "main"` limits a rule to top-level sessions (those without an
 * <active_agent> tag, i.e. not a subagent). Omit it to apply everywhere.
 * `*`/`?` globs are case-insensitive. A pattern containing "/" matches
 * provider/model; otherwise the bare model id. All matches append in file
 * order, so broad rules can be layered with narrow ones.
 *
 * A missing config file is off. A rule that cannot be applied as written
 * (unreadable or empty prompt file, unsupported scope, no match or prompt) is
 * skipped and reported once with a warning; its valid siblings still apply.
 * Malformed JSON is reported and turns the feature off for that run.
 *
 * This is a normal prompt section: pi writes a patch only when the text
 * changes (one small patch per model switch that runs a turn; none for a
 * switch with no turn), and compaction folds old patches into a checkpoint.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CONFIG_PATH = join(getAgentDir(), "model-prompts.json");
const SECTION = "model_instructions";
type Rule = { match: string; prompt: string; scope?: "main" };

/** Compile a glob to an anchored, case-insensitive RegExp. */
function compile(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const source = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${source}$`, "i");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	return (error as { code?: string } | undefined)?.code === "ENOENT";
}

/** Read a prompt file relative to the config's directory (or absolute). */
function readPromptFile(path: string): { prompt: string } | { problem: string } {
	try {
		const prompt = readFileSync(resolve(dirname(CONFIG_PATH), path), "utf8").trim();
		return prompt ? { prompt } : { problem: "is empty" };
	} catch (error) {
		return { problem: isNotFound(error) ? "does not exist" : errorMessage(error) };
	}
}

/**
 * Read and validate the rules per run. A missing config is off; a rule that
 * cannot be applied is rejected with a warning instead of being silently
 * dropped or widened, and valid siblings are kept.
 */
function loadRules(): { rules: Rule[]; warnings: string[] } {
	const warnings: string[] = [];
	let raw: string;
	try {
		raw = readFileSync(CONFIG_PATH, "utf8");
	} catch (error) {
		if (!isNotFound(error)) warnings.push(`model-prompts: cannot read ${CONFIG_PATH}: ${errorMessage(error)}`);
		return { rules: [], warnings };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		warnings.push(`model-prompts: ${CONFIG_PATH} is not valid JSON: ${errorMessage(error)}`);
		return { rules: [], warnings };
	}

	const entries = Array.isArray(parsed) ? parsed : (parsed as { rules?: unknown } | null)?.rules;
	if (!Array.isArray(entries)) {
		warnings.push(`model-prompts: ${CONFIG_PATH} has no "rules" array; no rules applied`);
		return { rules: [], warnings };
	}

	const rules: Rule[] = [];
	entries.forEach((entry, index) => {
		const ignored = `model-prompts: rule ${index + 1} ignored`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			warnings.push(`${ignored}: expected an object`);
			return;
		}
		const { match, prompt, promptFile, scope } = entry as {
			match?: unknown;
			prompt?: unknown;
			promptFile?: unknown;
			scope?: unknown;
		};
		if (typeof match !== "string" || !match.trim()) {
			warnings.push(`${ignored}: missing "match"`);
			return;
		}
		if (scope !== undefined && scope !== "main") {
			warnings.push(`${ignored}: unsupported "scope" ${JSON.stringify(scope)} (only "main" is supported)`);
			return;
		}
		const limit = scope === "main" ? ({ scope } as const) : {};
		const inline = typeof prompt === "string" ? prompt.trim() : "";
		if (inline) {
			rules.push({ match: match.trim(), prompt: inline, ...limit });
			return;
		}
		const file = typeof promptFile === "string" ? promptFile.trim() : "";
		if (!file) {
			warnings.push(`${ignored}: needs a non-empty "prompt" or "promptFile"`);
			return;
		}
		const resolved = readPromptFile(file);
		if ("problem" in resolved) {
			warnings.push(`${ignored}: prompt file ${JSON.stringify(file)} ${resolved.problem}`);
			return;
		}
		rules.push({ match: match.trim(), prompt: resolved.prompt, ...limit });
	});
	return { rules, warnings };
}

/** Concatenate every matching rule's prompt in file order, preserving layering. */
function promptFor(rules: Rule[], provider: string | undefined, id: string | undefined, isChild: boolean): string {
	if (!id) return "";
	const qualified = provider ? `${provider}/${id}` : id;
	const prompts = new Set<string>();
	for (const { match, prompt, scope } of rules) {
		if (!(isChild && scope === "main") && compile(match).test(match.includes("/") ? qualified : id)) prompts.add(prompt);
	}
	return [...prompts].join("\n\n");
}

export default function (pi: ExtensionAPI) {
	const warned = new Set<string>();
	pi.on("before_agent_start", (event, ctx) => {
		const { rules, warnings } = loadRules();
		for (const message of warnings) {
			if (warned.has(message)) continue;
			warned.add(message);
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else console.warn(message);
		}
		const sections = event.systemPromptOptions.sections;
		// A child session carries the spawning agent's tag in its rendered prompt.
		// The section map here holds only custom sections, so the tag is not visible
		// in it; render the prompt instead.
		const isChild = ctx.getSystemPrompt().includes("<active_agent");
		const text = promptFor(rules, ctx.model?.provider, ctx.model?.id, isChild);
		if (text) sections[SECTION] = text;
		else delete sections[SECTION];
	});
}
