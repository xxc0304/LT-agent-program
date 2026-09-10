# CtxHop device handoff for this project

These instructions apply to the whole `LT-agent-program` repository.

## Purpose and triggers

When the user asks to "同步", "上传到另一台电脑", "换电脑继续", "接力", "恢复会话", or otherwise asks to transfer this project's Codex work between devices, perform the appropriate CtxHop workflow directly. Do not merely print a tutorial unless the user explicitly asks for instructions.

CtxHop is a handoff mechanism, not live concurrent chat synchronization. Treat one device as the active writer for a logical session at a time.

The expected project identity is `manual:LT-agent-program`. Verify that the project, hub, and synchronization domain are already bound; obtain their identifiers from `ctxhop status --json` instead of embedding them in project files.

Use the installed `ctxhop` from `PATH`. On the `QVQ` Windows device, if the current process has a stale `PATH`, use `C:\Users\QVQ\AppData\Local\Programs\CtxHop\ctxhop.exe`.

## Upload from the active device

1. Work from the real repository root. Run `git status --short --branch` and `ctxhop status --json` first.
2. Confirm that CtxHop reports an existing project, hub, and domain binding. If the project is not bound, run `ctxhop project bind --path .` and select/bind the existing `manual:LT-agent-program` project. Never initialize a new synchronization domain.
3. Inspect candidate workspace filenames before upload. Keep local environment files and all authentication material out of the transfer. Preserve the existing local exclusion of `extracted/OpenClaw代码结构分析报告.md`; that file must stay local. Never display sensitive values.
4. Upload the current/relevant Codex session with its workspace and Git state. Prefer `ctxhop push --workspace <native-session-id>` when the current native session ID is known.
5. CtxHop 0.2.0 can make concurrent temporary-stash operations compete when several sessions are pushed together. If multiple sessions need uploading, obtain their native IDs from `ctxhop list --json` and run `ctxhop push --workspace <native-session-id>` sequentially, one process at a time.
6. Verify with `ctxhop status --json`, `ctxhop session list --json`, and `ctxhop doctor --json`. Confirm there are no pending or blocked queue entries and report the logical session ID that can be restored.
7. Wait for the OneDrive CtxHop backend to finish syncing before reporting that handoff is ready. Do not delete the invitation file, the compatibility junction, or safety stashes.

The installed SessionEnd Hook uses `session` scope and uploads ended conversation records automatically. It does not replace `ctxhop push --workspace` when uncommitted files or Git state must travel with the session.

## Restore on the receiving device

1. Work from the corresponding `LT-agent-program` repository root. Run `git status --short --branch`. Never reset, clean, delete, overwrite, or discard existing files or uncommitted work.
2. Run `ctxhop status --json`. If needed, run `ctxhop project bind --path .` and bind the existing `manual:LT-agent-program` project.
3. Run `ctxhop pull --json`, followed by `ctxhop session list --json`.
4. If the user asks for the latest session, select the session with the newest `updatedAt`. If the intended session is genuinely ambiguous, show only the short list of candidate titles, update times, and logical session IDs and ask the user to choose.
5. Always run `ctxhop resume <logical-session-id> --workspace --preview` first. Review the preview and current Git status. Proceed with `ctxhop resume <logical-session-id> --workspace` only when it will not overwrite or discard receiving-device work.
6. Report the restored Codex native session ID. Continue it with `codex resume <native-session-id>` when running the CLI is appropriate; in the desktop app, help the user open the restored task if it does not appear automatically.
7. Verify the restored session and workspace, then report the source logical session ID, restored native session ID, and Git status.

## Interaction and safety

- All private sign-in and decryption input must be entered by the user directly into the official UI or terminal. Never ask the user to paste it into chat, inspect it, echo it, log it, or place it in a command argument.
- If CtxHop displays an interactive decryption prompt, pause only for the user to type the requested phrase directly into the terminal. Do not use the recovery mechanism for normal synchronization.
- Read-only checks and ordinary CtxHop upload, pull, preview, and verification commands may be performed without asking for confirmation when the user has requested synchronization.
- Do not modify project files merely to make a handoff succeed. Never run `git reset`, `git clean`, destructive checkout/restore commands, or delete a stash. If receiving-device work conflicts with the incoming workspace, preserve both and ask the user how to reconcile them.
- Do not expose sensitive values in command output or chat. Report only filenames and the reason they were excluded.
