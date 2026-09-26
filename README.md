# Task Handoff Normalizer

Normalize two explicit local task-export shapes into one versioned handoff record. The output retains owner, objective, context reference IDs, acceptance criteria, deadline and current state. It preserves the supplied deadline string alongside a UTC value, so an offset is not lost during normalization. No task is created, assigned, or sent.

## Run

```sh
node bin/task-handoff-normalizer.mjs --root examples --input passing.json
node bin/task-handoff-normalizer.mjs --root examples --input incomplete.json --human
npm run check
```

`--root` is the evidence directory; `--input` is relative to it. Optional `--out report.json` writes the same JSON report inside the root after destination checks. JSON always goes to stdout; `--human` adds a short summary to stderr. `--help` lists options.

## Input and output version 1

The exported document is `{ "schemaVersion": "1", "tasks": [...] }`. Each task chooses exactly one source shape:

| Source | Owner | Objective | Context IDs | Acceptance | Deadline | State |
| --- | --- | --- | --- | --- | --- | --- |
| `board-v1` | `assignee` | `title` | `references` | `completionCriteria` | `dueAt` | `status`: `To Do`, `In Progress`, `Blocked`, `Done` |
| `queue-v1` | `owner` | `objective` | `contextRefs` | `acceptance` | `deadline` | `state`: `todo`, `in-progress`, `blocked`, `done` |

Owner and context references are local aliases: ASCII letters/digits followed by letters, digits, `.`, `_`, or `-`, at most 128 characters. Context arrays may be empty. Acceptance arrays must contain at least one criterion. Objective and criterion text must be nonblank, at most 500 UTF-16 units, and free of control and bidirectional formatting characters. A deadline uses exact `YYYY-MM-DDTHH:mm:ssZ` or `YYYY-MM-DDTHH:mm:ss±HH:mm` form with a valid calendar date and offset no greater than 14 hours. No offset is inferred from a host clock or time zone.

Each normalized task contains `sourceOrdinal`, `owner`, `objective`, `contextRefs`, `acceptance`, `deadline: { original, utc }`, and `currentState`. The original deadline is not rewritten; the UTC value uses `Z`. Valid tasks appear in source order. An unusable task is omitted from `tasks` and located by a finding. The source ordinal and pointer identify the exact record without publishing its invalid payload.

| Rule | Severity and outcome | Meaning |
| --- | --- | --- |
| `input-unreadable`, `input-invalid` | error, incomplete | Export cannot be read/decoded/parsed, or version 1 task list is missing or empty |
| `byte-limit`, `record-limit`, `depth-limit`, `time-limit` | error, incomplete | Processing bound exceeded |
| `source-unknown`, `state-unknown` | error, incomplete | Source adapter or current state is unsupported |
| `owner-missing`, `objective-missing`, `context-invalid`, `acceptance-missing`, `deadline-invalid` | error, incomplete | Required handoff field is absent or unusable |

The JSON report has `schemaVersion`, `tool`, `status`, `summary`, sorted `findings`, and `tasks`. Findings use fixed logical source role `@input` and a JSON Pointer into the exact file named at invocation, not a host path. No malformed field content or parse-error excerpt is copied into findings. The normalized task fields intentionally contain validated source text; handle the report according to the source document's privacy level. This utility does not detect secrets in otherwise valid prose.

Exit `0` means every task normalized. Exit `2` means missing or unsupported evidence, invalid CLI configuration, or output failure. Invalid CLI configuration leaves stdout empty; unreadable input yields an `incomplete` report. Exit `1` is reserved by the catalog report contract for evaluated policy failures; this normalizer has no policy threshold and does not currently emit it.

Limits: 1,048,576 input bytes, 1,000 tasks, nesting depth 16, 20 context IDs and 20 acceptance criteria per task, 128-character aliases, 500-unit prose fields, and 5,000 ms processing time. The exact limit is accepted and the next unit refused. Reads resolve real paths within `--root`; optional output cannot overwrite or alias input through a link or named missing path.

The tool does not fetch linked context, verify ownership, infer missing acceptance, interpret natural-language deadlines, or synchronize a task system. MIT license; see [LICENSE](./LICENSE).
