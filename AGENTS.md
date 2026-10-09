<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Decisions
- tsconfig: noPropertyAccessFromIndexSignature and noUncheckedIndexedAccess disabled — imported chat.ts (982 lines) uses dot access on Record types throughout; relaxing two flags was chosen over rewriting 144 call sites.
- Chat frontend is a static public/chat.html (395KB) that / redirects to; chat backend is src/routes/api/chat.ts (OrcaRouter + InstaVM).
- Cognitive agent layer (dual-process planning, lifecycle phases, reflection, skill learning, distillation, playbook, operator messages) lives in src/lib/cognitive.server.ts and is loaded dynamically by the chat route; learned knowledge persists in Lovable Cloud agent_* tables accessed only server-side, keeping model-loop code and learning logic separate.
- Forward provider reasoning and cognitive model output through reasoning_content SSE deltas, keeping cognitive output separate from the final answer so the existing thinking panel can display every emitted fragment.
