# Integration events

`pi-agent-ask` exposes local `pi.events` events for trusted extensions in the same Pi process. It does not expose a network API or automate terminal keystrokes.

All integration channels use the `pi-agent-ask` prefix. Old `@eko24ive/pi-ask:*` listeners must be updated; there are no aliases.

## Lifecycle channels

- `pi-agent-ask:started`: a validated form opens.
- `pi-agent-ask:completed`: a form resolves.

```ts
type RemoteAskStartedEvent = {
  version: 1;
  flowId: string;
  toolCallId?: string;
  source: "tool" | "ask:resume";
  title?: string;
  questions: AskQuestion[];
  createdAt: number;
};

type RemoteAskCompletedEvent = {
  version: 1;
  flowId: string;
  toolCallId?: string;
  source: "tool" | "ask:resume";
  result: AskResult;
  completedAt: number;
};
```

Use question IDs and option values from the started event. `ask:resume` identifies an interrupted tool form. Recommendation markers are presentation metadata and do not change answer values or labels.

## Submit channels

Submit to `pi-agent-ask:submit`; receive the acknowledgement on `pi-agent-ask:submit-result`.

```ts
type RemoteAskResponse =
  | {
      kind: "answer";
      mode?: "submit" | "elaborate";
      answers: Record<string, {
        values?: string[];
        customText?: string;
        note?: string;
        optionNotes?: Record<string, string>;
      }>;
    }
  | { kind: "cancel" };

pi.events.emit("pi-agent-ask:submit", {
  version: 1,
  requestId: `bridge-${Date.now()}`,
  flowId,
  response: {
    kind: "answer",
    mode: "submit",
    answers: { questionId: { values: ["option-value"] } },
  },
});
```

Question keys and selected values must exist in the started form. An answer replaces the current answer set rather than merging stale UI state. `mode` defaults to `submit`; `elaborate` requests clarification. Labels and indices are recomputed locally. Notes and custom text follow the normal tool contract.

Cancel explicitly with `response: { kind: "cancel" }`. The extension never infers cancellation or approval from labels or button names.

```ts
type RemoteAskSubmitResultEvent =
  | { version: 1; requestId: string; flowId: string; ok: true }
  | {
      version: 1;
      requestId: string;
      flowId: string;
      ok: false;
      error: "flow_not_found" | "invalid_request" | "invalid_answer";
      message: string;
    };
```

Correlate responses with `requestId` and `flowId`. Do not assume ordering between `submit-result` and `completed`. An invalid submit leaves the form open so the UI can correct the response.

Third-party bridges own their UI policy and value mappings. They must use explicit values rather than ask the extension to infer approval semantics.

## Clipboard provider

A trusted extension can supply clipboard image bytes without changing the chat draft. Ask sends this request only when the user invokes image paste inside an answer or note editor:

```ts
// pi-agent-ask:clipboard-request
 type ClipboardRequest = { version: 1; requestId: string };

// pi-agent-ask:clipboard-result
 type ClipboardResult =
  | { version: 1; requestId: string; status: "reading" }
  | { version: 1; requestId: string; status: "empty" }
  | { version: 1; requestId: string; status: "error"; message: string }
  | {
      version: 1;
      requestId: string;
      status: "image";
      image: { mimeType: string; data: string };
    };
```

The provider must emit `reading` **synchronously, before its first await**, then send one final result with the same `requestId`. A synchronous final result also claims the request. With no synchronous claim, Ask immediately removes its listener and uses the built-in clipboard reader. Load order does not matter once both extensions have registered. Load only one clipboard provider.

A claimed request has a 25-second deadline. Empty results and errors are authoritative: Ask does not fall back or reread the clipboard. Abort/disposal, completion, and timeout remove the result listener. Ignore stale work after extension shutdown; do not queue these images for a later chat submission.

`data` is canonical base64 without a data-URI prefix, nonempty and at most 20 MiB decoded. Supported MIME types are `image/png`, `image/jpeg`, `image/webp`, and `image/gif`; convert BMP before replying. Ask creates its own attachment id and preserves the existing question/note association, history, and model image delivery. Invalid image replies show an error rather than invoking fallback.

## Verify locally

The real-Pi tests cover the local lifecycle and submit channels:

```bash
pnpm exec pi-test run -- node --test tests/integration/*.test.ts
```

For a manual check, load this extension and a trusted test bridge. Listen for `pi-agent-ask:started`, display its normalized questions, and emit an explicit response on `pi-agent-ask:submit`. Verify both the returned answer and `pi-agent-ask:submit-result`. See [the tool contract](contract.md) for result semantics.
