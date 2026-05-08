import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import type { ToolRenderer, ToolRenderResult } from "@mariozechner/pi-web-ui";

type DelegateParams = {
  agent?: string;
  task?: string;
};

type DelegateDetails = {
  id?: string;
  agent?: string;
  task?: string;
  turns?: number;
  exitCode?: number;
  status?: "running" | "completed" | string;
};

function textFromResult(result?: ToolResultMessage<DelegateDetails>): string {
  return result?.content
    ?.filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n") ?? "";
}

function statusFrom(result: ToolResultMessage<DelegateDetails> | undefined, isStreaming?: boolean): "running" | "completed" | "failed" {
  if (result?.isError) return "failed";
  if (isStreaming || result?.details?.status === "running") return "running";
  return "completed";
}

function statusClasses(status: "running" | "completed" | "failed"): string {
  if (status === "failed") return "border-red-500/40 bg-red-500/10 text-red-300";
  if (status === "running") return "border-blue-500/40 bg-blue-500/10 text-blue-300";
  return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
}

export class DelegateRenderer implements ToolRenderer<DelegateParams, DelegateDetails> {
  render(
    params: DelegateParams | undefined,
    result: ToolResultMessage<DelegateDetails> | undefined,
    isStreaming?: boolean,
  ): ToolRenderResult {
    const details = result?.details ?? {};
    const agent = params?.agent ?? details.agent ?? "subagent";
    const task = params?.task ?? details.task ?? "";
    const output = textFromResult(result);
    const status = statusFrom(result, isStreaming);
    const title = status === "running" ? "Subagent running" : status === "failed" ? "Subagent failed" : "Subagent completed";

    const content: TemplateResult = html`
      <div class="rounded-md border border-border bg-card text-card-foreground shadow-xs overflow-hidden">
        <div class="p-3 border-b border-border flex items-center gap-2">
          <span class="text-lg" aria-hidden="true">${status === "failed" ? "⚠️" : status === "running" ? "🤖" : "✅"}</span>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold">${title}</div>
            <div class="text-xs text-muted-foreground truncate">delegate → ${agent}</div>
          </div>
          <span class="text-[11px] uppercase tracking-wide rounded-full border px-2 py-0.5 ${statusClasses(status)}">
            ${status}
          </span>
        </div>

        <div class="p-3 space-y-3">
          ${task
            ? html`<div>
                <div class="text-xs font-medium mb-1 text-muted-foreground">Task</div>
                <div class="text-sm whitespace-pre-wrap break-words">${task}</div>
              </div>`
            : ""}

          ${output
            ? html`<div>
                <div class="text-xs font-medium mb-1 text-muted-foreground">
                  ${status === "running" ? "Latest output" : "Output"}
                </div>
                <pre class="text-xs whitespace-pre-wrap break-words bg-muted/40 rounded-md p-2 max-h-72 overflow-auto">${output}</pre>
              </div>`
            : html`<div class="text-xs text-muted-foreground italic">
                ${status === "running" ? "Waiting for subagent output…" : "No subagent output returned."}
              </div>`}

          <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            ${details.id ? html`<span>id: <code>${details.id}</code></span>` : ""}
            ${details.turns != null ? html`<span>turns: ${details.turns}</span>` : ""}
            ${details.exitCode != null ? html`<span>exit: ${details.exitCode}</span>` : ""}
          </div>
        </div>
      </div>
    `;

    return { content, isCustom: true };
  }
}
