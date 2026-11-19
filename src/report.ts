import type { Issue, Status } from "./console.js";
import { oneLine, oneWord } from "./util.js";

/** What an experiment found or how its fix did, in lines baton-mcp reads by their prefix. */
export function reportLines(experiment: string, status: Status): string[] {
  if (status.kind === "find") {
    if (status.verdict !== "found") return [`experiment ${experiment}: find ended (${oneLine(status.reason ?? status.verdict ?? status.state)})`];
    const issues = status.issues ?? [];
    if (issues.length === 0) return [`experiment ${experiment}: found no issues`];
    return [`experiment ${experiment}: found ${issues.length} issue${issues.length === 1 ? "" : "s"}`, ...issues.map(issueLine)];
  }
  const verdict = `${status.verdict ? oneWord(status.verdict) : "no verdict"}${status.reason ? ` (${oneLine(status.reason)})` : ""}`;
  const result = status.result;
  const numbers = result
    ? `; targets ${count(result.targets.before)} -> ${count(result.targets.after)}${result.errors ? `; error ${count(result.errors.before)} -> ${count(result.errors.after)}` : ""}; guard ${held(result.guard, "dropped")}; held-out ${held(result.held_out, "didn't hold")}`
    : "";
  return [`experiment ${experiment}: fix ${oneWord(status.issue ?? "?")}: ${verdict}${numbers}`];
}

// The error goes last: it is the only field that can hold spaces, so the first ": " starts it.
function issueLine(issue: Issue, index: number): string {
  const tasks = issue.tasks.length > 0 ? issue.tasks.map(oneWord).join(",") : "-";
  return `issue ${index + 1}. ${oneWord(issue.issue)} ${oneWord(issue.fix)} tool=${oneWord(issue.tool)} prod_sessions=${issue.prod_sessions} tasks=${tasks} below_bar=${issue.below_bar ? "yes" : "no"} page=${oneWord(issue.url ?? "-")}: ${oneLine(issue.error)}`;
}

const count = ([passed, runs]: [number, number]) => `${passed}/${runs}`;
const held = (value: { held: boolean } | null, otherwise: string) => (value === null ? "none" : value.held ? "held" : otherwise);
