# Bashwink TUI usability audit

28 November 2026 · macOS arm64 · Node 22.23.2

## Retest of the current build

Tested source at `32a59a3` and spot-checked the installed `bashwink 0.2.0-alpha.2`. The packaged E2E suite built and installed the same checkout in a temporary prefix. Targeted checks used isolated profiles, macOS pseudo-terminals, and a controlled provider with successful, delayed, and failed responses. Terminal dimensions below are columns × rows.

### Reproduced issues

| ID | Priority | Issue and reproduction |
| --- | --- | --- |
| TUI-01 | High | **`/test` takes the composer offline and cannot be cancelled in place.** Run `/test` with a slow provider. The screen shows a static Testing line. Escape echoes `^[`. Ctrl+C prints `Interrupted.` while the operation keeps running. The fixture printed a failure after 6.9 s and Bashwink exited 130. The slash handler awaits the test without an abort signal or progress callback. |
| TUI-02 | High | **Cancelling discovery or a setup test exits the coding session.** In an open session, run `/model`, pick Ollama, then use `f` to fetch models or `t` at review to test. Press Ctrl+C while the provider is pending. The operation reports cancellation and redraws its step. Dismiss it with Esc and Bashwink exits 130. The setup operation and the session both handle the interrupt. Cancelling the sample test also marks the draft connection `failed`. |
| TUI-03 | High | **Unsent input is lost on routine navigation.** Type a draft, open Commands (Ctrl+P), Sessions (Ctrl+O), or Transcript (Ctrl+T), then dismiss it. The composer returns empty in all three cases. Ctrl+L likewise drops the draft. On a clean profile, submitting a first prompt and then cancelling model setup also leaves an empty composer. Up did not recover that first prompt in the fixture. |
| TUI-04 | High | **Compact setup hides text and actions.** At 40×8, type `ollama` in the provider picker. It accepts the input while hiding the typed characters past the truncated label. Type an endpoint at 40 columns and the wrapped prompt leaves a duplicate on screen. At 40×8 the review shows only `Save and use…` and Yes/No, hiding the `t` test shortcut. The trust confirmation also clipped its question at 50 columns. |
| TUI-05 | High | **Changing only the model restarts provider setup.** With a configured Ollama profile on a custom port, run `/model`. It opens the provider picker. Select Ollama and accept the endpoint default, and the draft points to port 11434 rather than the saved endpoint. The credential step then drops the keep-existing choice. Escape from a field dismisses the wizard. |
| TUI-06 | Medium | **The provider list does not filter as you type.** At 55×16, type `oll`. The same 11 of 48 rows stay visible and the selection highlight disappears. Completing the exact ID `ollama` works. |
| TUI-07 | Medium | **Ollama defaults to an environment key.** On a clean profile, choose Ollama and accept the default endpoint. Enter at Authentication selects the `OLLAMA_API_KEY` field. The no-key choice is third. |
| TUI-08 | Medium | **Discovery mixes detected and suggested models and misstates network activity.** Fetch against a fixture that lists two IDs. The picker renders four entries in the same style, including two suggestions absent from the response. The review still says `0 requests sent until you test or submit`. |
| TUI-09 | Medium | **A successful `/test` does not update verification state.** The fixture returned `Connection verified` and `Tool support: supported`. The saved profile was byte-identical after the test and `/status` showed no connection verification state. Setup can save a verification result when the sample test runs inside the wizard. |
| TUI-10 | Medium | **Backspace can corrupt an emoji in the composer.** Type `再😊` and press Backspace once at 80×24. The composer displays `再�`. The editor removes one UTF-16 code unit, leaving half of the emoji. |
| TUI-11 | Medium | **File autocomplete can get stuck on its first match.** At 40×8, create three files named `qa-first.txt`, `qa-second.txt`, and `qa-third.txt`. Paste a three-line draft ending in `@qa`. Only the first result fits. Down leaves it selected and Tab inserts it, so the other matches require typing more of the filename. |
| TUI-12 | Medium | **The task spinner hides the cancel shortcut at narrow widths.** At 50 columns the provider name and address fill the line, truncating elapsed time and the Esc/Ctrl+C hint. Esc still cancels a waiting task and restores the composer. |
| TUI-13 | High | **The prompt box disappears while a regular message is running.** On the installed build at 80×24 and 40×8, type `hi` and press Enter. While the delayed fixture provider responds, the composer is removed and a Waiting line is shown. After completion the composer returns and accepts the next draft at both widths. |

### Fix status (28 November, after the fix set)

All thirteen issues were addressed in this checkout. The table records what changed and how each
fix is covered; rows marked *headless* are covered by the deterministic screen-model tests, not yet
by a real-terminal scenario.

| ID | Status | Fix | Coverage |
| --- | --- | --- | --- |
| TUI-01 | Fixed | `/test` runs in the composer with one activity row, progress stages and a live cancel that aborts the provider request; the session survives. | headless + `/test` persistence unit test |
| TUI-02 | Fixed | Discovery and the sample test own their cancel key; SIGINT during setup no longer ends the session; cancel returns to the step with settings intact. | headless |
| TUI-03 | Fixed | Draft and cursor travel with every dismissal action and are restored on re-entry; a cancelled turn can restore the first prompt. | headless |
| TUI-04 | Fixed | Label row + scrolling value row for fields, typed value always visible in list widgets, fixed review action bar, two-row confirm at narrow widths. | headless |
| TUI-05 | Fixed | `/model` is a model-only picker that preserves endpoint and credentials; provider changes stay under `/setup` and `/connect`. | headless |
| TUI-06 | Fixed | Lists filter as you type, keep a highlighted selection and show `n of m shown`. | headless |
| TUI-07 | Fixed | Local no-key presets select the no-key option by default. | headless |
| TUI-08 | Fixed | Detected vs suggested labels, and an explicit count of `/models` requests sent. | headless |
| TUI-09 | Fixed | `/test` result persisted (`connectionStatus`, `lastVerifiedAt`, `lastTest`) and reported by `/status` with chat reachability separate from tool support. | headless |
| TUI-10 | Fixed | Grapheme-aware editing; emoji and ZWJ sequences delete whole. | headless |
| TUI-11 | Fixed | Full match list with a scrolling window and `n/m` counter. | headless |
| TUI-12 | Fixed | Activity row reserves the cancel shortcut before truncating. | headless |
| TUI-13 | Fixed | The prompt box stays painted during a turn, with a busy activity row and output written above it. | headless |

Remaining verification gaps: the real-terminal walkthroughs recorded below were run against the
pre-fix build; the fix set was exercised through the deterministic screen model and the installed
package E2E suite. A live hosted provider, Windows, and a PTY scenario that cancels discovery inside
the wizard are still unverified.

### Retest results

- The composer stayed visible and bottom-aligned when pasting and clearing 20 lines at 100×30, 50×12, and 40×8 on both source and installed alpha.2. Cold startup exposed an input row at 80×24, 50×12, 40×8, and 30×6. A source session remained responsive after a wide → narrow → wide resize with an active draft.
- The task spinner stayed on one row at 50 columns and the compact footer displayed `Read-only`. The truncated confirmation and cancel hints are covered above.
- Regular task cancellation returned to the composer at 50 and 100 columns, and the sessions exited 0 via `/exit`. The automated PTY suite also passed its child-process cleanup and terminal exit checks. A full terminal emulator lockup remains unconfirmed.
- `npm run test:standalone` exited 0 with 62/62 passing. `npm run test:standalone:e2e` exited 0 with 12/12 passing. `npm run test:standalone:install` and `npm run test:standalone:independence` both exited 0. The networked suites used loopback fixtures. Hosted-provider behavior, other OSes, and emulator-specific rendering remain unverified.

## Earlier audit before the current TUI refresh

The installed `bashwink` reports `0.2.0-alpha.1`. The source and the temporary package built for the suite report `0.2.0-alpha.2`. The composer layout issue reproduced on both. The remaining targeted checks used the current source with a fresh profile and controlled provider responses. The worst issues were lost drafts, a connection test that looks stuck, and a model switch that requires the full setup wizard.

## Findings

| Priority | Finding and reproduction | Proposed behavior |
| --- | --- | --- |
| High | **Unsent drafts disappear when opening an overlay.** Type a draft, open Commands with Ctrl+P, Sessions with Ctrl+O, or Transcript with Ctrl+T, then Escape. All three returned to an empty composer at 100×30. | Keep draft text and cursor position on overlay entry and restore both on dismiss. Store drafts per session so switching sessions keeps each draft in its own workspace. |
| High | **A long draft takes over the terminal and the composer loses its bottom anchor.** Paste 20 newline-separated lines at 40×8 or 50×12. The lower draft lines fill the viewport along with the footer. Ctrl+C clears the draft and leaves the empty composer near the top with blank rows below. The anchor also shifted at 100×30. Reproduced in both versions using PTY output reconstructed into terminal cells. | Reserve composer and status rows first. Show a bounded, internally scrolling draft with a line-count indicator and keep the editing cursor in view. Keep the transcript independent of the draft height. |
| High | **A slow `/test` looks frozen.** With a delayed provider, it removed the composer and printed a static `Testing…` line. Escape echoed as `^[`. Ctrl+C printed `Interrupted.` but the provider operation continued, printed its failure about 6.9 seconds into the test, and the application exited 130. | Use one cancellable activity state for diagnostics and tasks. Show the current stage and elapsed time, abort the pending request, and return to the current session and draft. |
| High | **Cancelling model discovery interrupts the surrounding session.** During `/model` → fetch, press its advertised Ctrl+C. Bashwink reported both `Interrupted.` and `Model discovery cancelled by user`, then redrew the wizard. Dismissing the wizard subsequently exited the app with code 130. | Route input to the foreground operation. Cancel discovery and return to the model list with the current draft settings intact. |
| High | **Narrow terminals accumulate duplicated setup and activity lines.** At 40 columns, type a URL into the Ollama endpoint field and watch the default URL prompt repeat above the editable value. At 50 columns, a waiting task left multiple spinner frames on screen. At 100 columns the spinner stayed on one row. Escape cancelled the regular task at both widths and restored the composer. | Render within a known row budget. Put the field label above its input, keep the cursor visible while editing a long URL, and constrain activity to one row. |
| High | **Model switching starts over.** With an existing profile, `/model` opens the full provider → endpoint → authentication → model → review flow. The dispatcher also routes `/models`, `/connect` and `/setup` there. Esc on an input exits the setup instead of returning to the previous field. | Give model switching its own picker for the active provider. Keep endpoint and credentials, and put provider changes behind a separate action. In setup, offer Back and Cancel as distinct actions. |
| Medium | **The provider chooser looks searchable but typing only supplies an exact ID.** At 55×16, typing `oll` left the same 11 visible rows out of 48 and removed the selection highlight. The full `ollama` ID worked. The fixed prompt, typed value, and hints compete for the same line. | Use an explicit search field with live results, a match count, and an always-visible selected row. Offer a custom provider as a normal list item. |
| Medium | **Local no-key setup defaults to environment-variable authentication.** On a clean Ollama selection, Enter in Authentication opens the `OLLAMA_API_KEY` field. The no-key option is third. | Select the preset’s credential mode initially. Label the default and show an actionable validation message for a missing variable or key file. |
| Medium | **Discovery makes suggestions look like available models.** A fixture returned two model IDs. The resulting list showed four uniformly styled entries, including two suggestions the endpoint did not return, then the review said `0 requests sent until you test or submit`. | Label models as detected, suggested, or manual. Confirm before discovery sends a request and report its outcome accurately. Keep manual entry available after a failed or unsupported listing. |
| Medium | **Trust and approval mode are hard to read together.** In the 50-column task view, the shortened trust confirmation ended in an ellipsis, and the compact composer showed `accept-edits` while the workspace was read-only. The full transcript explained the distinction, but the area beside input did not. | Show effective access as `Read-only` beside the composer and distinguish it from the selected approval mode. Give the trust question its own full-width row above the choices. |

## Proposed terminal layout

Use one transcript region and one fixed bottom region. The header carries the project and branch when width permits. The bottom region carries the active model, effective permission, activity state, composer, and the keys relevant to the current state. Use the terminal’s default foreground and background as the base, one high-contrast focus accent, and text labels for states so monochrome remains usable. Keep borders, icons and headings sparse so the conversation and editor remain dominant.

At regular sizes, open **Switch model** over the transcript with the active model marked `Current`, an immediately editable search field, and explicit `Refresh from provider` and `Enter model ID` actions. In a narrow split, use an inline list that consumes the transcript region only. Keep the composer visible as a dimmed draft preview while a modal owns input. The modal’s key hints take precedence over composer shortcuts.

Use a short form for initial setup. Choose provider, enter endpoint and credentials, pick a model, then review. Indicate whether the connection is untested, chat-only, or tool-capable. Provide separate actions to test and save. During `Discovering models`, `Testing connection`, `Waiting for model`, `Running command`, and `Waiting for approval`, give the current stage one line that fits the viewport. Restore the same editing context when an operation ends.

Ship in this order:

1. Stabilize the composer and preserve drafts. Verify screen position and cursor after paste, clear, overlay return, and resize at 100×30, 80×24, 50×12 and 40×8.
2. Unify cancellation for task, discovery and diagnostics. Verify cancel aborts the fixture request, restores the expected UI and does not exit the session. Verify timeout presents a recovery action and a long activity line never wraps.
3. Add the model-only picker and improve setup. Verify partial-ID filtering, same-provider switching without credential re-entry, editing a previous step, no-key local defaults, and separate discovered/suggested labels. Repeat the compact-size checks with color disabled and multicolumn text.

## Verification

- GitHub confirmed that remote `main` is identical to local `ed4ec28`. The audit began at `0c227ea`. The intervening commit changed contributor documentation and its validation. Git reported no differences in `packages/bw-cli`, `scripts/standalone` or `package.json`.
- `npm run test:standalone` exited 0 with 58/58 passing after the sandbox allowed test loopback sockets.
- `npm run test:standalone:e2e` exited 0 with 12/12 passing against a temporarily installed current package. The suite used scripted loopback providers.
- Targeted walkthroughs used real macOS PTYs with isolated profiles, a `fetch` fixture and reconstructed terminal cell views. The source workspace ran the coding TUI and setup flows. No live hosted credentials or requests were used.
- The controlled task wait cancelled and returned to input. A terminal emulator or process lockup remains unconfirmed. Live hosted behavior, emulator-specific rendering and other platforms remain open.
