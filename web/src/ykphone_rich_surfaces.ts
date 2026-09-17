// The 옆커폰 rich editor everywhere a message is written besides the
// compose box: the inline message edit form (one per message being
// edited, read-only for a message the user can only view the source of),
// the thread panel's reply box and the saved snippet forms.
//
// Each editor lives as long as its box is in the page: closing an edit
// form destroys its editor at once, and an editor whose box upstream
// removes (a re-rendered message row, the thread panel emptied, a modal
// closed) is destroyed as soon as it has left the page.
//
// Upstream's typeahead asks compose_state who a message is for. The edit
// form's typeahead finds the message being edited from where its textarea
// is, as upstream's own does; the thread panel's reply goes to its
// thread, and a saved snippet to nobody, which ykphone_rich_hooks tells
// compose_state while their typeahead runs.

import $ from "jquery";

import * as compose_banner from "./compose_banner.ts";
import * as compose_validate from "./compose_validate.ts";
import {$t, $t_html} from "./i18n.ts";
import * as ui_report from "./ui_report.ts";
import {RichEditor, type RichEditorHost, upstream_enter_sends} from "./ykphone_rich_editor.ts";
import * as ykphone_rich_hooks from "./ykphone_rich_hooks.ts";
import type {ThreadInfo} from "./ykphone_threads.ts";

type Mounted = {
    editor: RichEditor;
    unregister: () => void;
    // Undoes what mounting did to the box around the editor.
    clean_up: () => void;
};

const mounted = new Set<Mounted>();
let sweep_timer: ReturnType<typeof setTimeout> | undefined;

// How many editors outside the compose box exist, on the page's body for
// the browser checks (tools/ykphone-rich-checks).
function update_count(): void {
    document.body.dataset["ykphoneRichEditors"] = String(mounted.size);
}

function unmount(entry: Mounted): void {
    if (!mounted.delete(entry)) {
        return;
    }
    entry.unregister();
    entry.editor.destroy();
    entry.clean_up();
    update_count();
}

// An editor mounted on a message row that upstream built but never put
// in the page has nothing to say it left; it is looked for once the code
// that renders rows has finished.
function schedule_sweep(): void {
    sweep_timer ??= setTimeout(() => {
        sweep_timer = undefined;
        for (const entry of mounted) {
            if (!entry.editor.textarea.isConnected) {
                unmount(entry);
            }
        }
    }, 0);
}

function has_editor(textarea: HTMLTextAreaElement): boolean {
    for (const entry of mounted) {
        if (entry.editor.textarea === textarea) {
            return true;
        }
    }
    return false;
}

function mount(host: Omit<RichEditorHost, "on_removed">, clean_up: () => void): void {
    schedule_sweep();
    // Set once the editor exists; the box cannot leave the page before.
    let entry: Mounted | undefined;
    const editor = new RichEditor({
        ...host,
        on_removed() {
            if (entry !== undefined) {
                unmount(entry);
            }
        },
    });
    entry = {editor, unregister: ykphone_rich_hooks.register_editor(editor.handlers), clean_up};
    mounted.add(entry);
    update_count();
    editor.take_initial_focus();
}

// A textarea for upstream's typeahead to read, out of the page, answering
// for `recipient`.
function recipient_input(
    recipient: ykphone_rich_hooks.RichRecipient,
): (text: string, caret: number) => JQuery<HTMLTextAreaElement> {
    const shadow = document.createElement("textarea");
    ykphone_rich_hooks.set_recipient(shadow, recipient);
    return (text, caret) => {
        shadow.value = text;
        shadow.setSelectionRange(caret, caret);
        return $(shadow);
    };
}

function lossy_message(): string {
    return $t({defaultMessage: "This formatting cannot be sent as written."});
}

// ---- The message edit form ----

// Called by message_edit.edit_message once the form is in its row. When
// the row already had a form open, upstream keeps that one (and its
// editor) and the new form never reaches the row.
export function mount_edit_form($form: JQuery, is_editable: boolean): void {
    const form = $form[0];
    const row = form?.closest<HTMLElement>(".message_row");
    const textarea = form?.querySelector<HTMLTextAreaElement>("textarea.message_edit_content");
    const box = form?.querySelector<HTMLElement>(".message_edit_form");
    const container = form?.querySelector<HTMLElement>(".edit-content-container");
    if (
        row === null ||
        row === undefined ||
        textarea === null ||
        textarea === undefined ||
        box === null ||
        box === undefined ||
        container === null ||
        container === undefined
    ) {
        return;
    }
    // Upstream's typeahead finds the message being edited, and the
    // form's banners, from where its textarea is; the shadow it reads
    // sits in the form, out of sight.
    const shadow = document.createElement("textarea");
    shadow.className = "ykphone-rich-typeahead-shadow";
    shadow.hidden = true;
    shadow.tabIndex = -1;
    textarea.after(shadow);
    box.classList.add("ykphone-rich-edit");
    mount(
        {
            textarea,
            box,
            focus_container: container,
            read_only: !is_editable,
            enter_sends: upstream_enter_sends,
            show_send_error(message) {
                compose_banner.show_error_message(
                    message,
                    compose_banner.CLASSNAMES.generic_compose_error,
                    $(box).find(".edit_form_banners"),
                );
            },
            // Upstream disables Save while the message is too long or
            // the time to edit is up; the editor's text reaches the
            // textarea (and the length check) only as Save is pressed.
            send_blocked(show_banner) {
                const $row = $(row);
                if ($row.find(".message_edit_save").prop("disabled") !== true) {
                    return undefined;
                }
                if (show_banner) {
                    compose_validate.validate_message_length($row);
                }
                return compose_validate.get_message_too_long_for_compose_error();
            },
            upstream_keys: true,
            uploads: true,
            widgets: false,
            wildcard_mentions: true,
            typeahead_input(text, caret) {
                shadow.value = text;
                shadow.setSelectionRange(caret, caret);
                return $(shadow);
            },
        },
        () => {
            shadow.remove();
            box.classList.remove("ykphone-rich-edit");
        },
    );
}

// Called by message_edit.end_message_row_edit before the form goes.
export function unmount_edit_forms_in($row: JQuery): void {
    for (const entry of mounted) {
        if ([...$row].some((row) => row.contains(entry.editor.textarea))) {
            unmount(entry);
        }
    }
}

// ---- The thread panel's reply box ----

// Mounts the editor in the thread panel's reply box, if it has none. The
// reply goes to `thread`: its typeahead suggests and warns for the
// thread's channel and topic, and its warnings go to the panel's banners.
// Enter sends the reply with `send`, as in Slack; Shift+Enter starts a
// new line.
export function mount_thread_reply(thread: ThreadInfo, send: () => void): void {
    const textarea = document.querySelector<HTMLTextAreaElement>(
        "#ykphone-thread-panel textarea.ykphone-thread-panel-textarea",
    );
    const composer = textarea?.closest<HTMLElement>(".ykphone-thread-panel-composer");
    const banners = composer?.querySelector<HTMLElement>(".ykphone-thread-panel-banners");
    if (
        textarea === null ||
        textarea === undefined ||
        composer === null ||
        composer === undefined ||
        banners === null ||
        banners === undefined ||
        has_editor(textarea)
    ) {
        return;
    }
    const $error = $(composer).find(".ykphone-thread-panel-send-error");
    composer.classList.add("ykphone-rich-thread-reply");
    mount(
        {
            textarea,
            box: composer,
            focus_container: composer,
            read_only: false,
            enter_sends: (event) => !event.shiftKey,
            send,
            show_send_error(message) {
                $error.text(message);
            },
            upstream_keys: false,
            uploads: false,
            widgets: false,
            wildcard_mentions: true,
            typeahead_input: recipient_input({
                message_type: "stream",
                stream_id: thread.stream_id,
                topic: thread.topic_name,
                banners,
            }),
            on_flush(lossy) {
                // Once the formatting can be sent, the reason it could
                // not goes.
                if (!lossy && $error.text() === lossy_message()) {
                    $error.text("");
                }
            },
        },
        () => {
            composer.classList.remove("ykphone-rich-thread-reply");
        },
    );
}

// ---- Saved snippet forms ----

// The editor for the content field of a saved snippet form. A snippet has
// no recipient: mentions are written as they are, never silent, and no
// wildcard mention is suggested. Enter starts a new line; the form is
// saved with its button, which checks the formatting through
// ykphone_rich_hooks.send_error_for.
function mount_saved_snippet_form(textarea: HTMLTextAreaElement): void {
    const box = textarea.parentElement;
    if (box === null || has_editor(textarea)) {
        return;
    }
    box.classList.add("ykphone-rich-snippet");
    mount(
        {
            textarea,
            box,
            focus_container: box,
            read_only: false,
            enter_sends: () => false,
            show_send_error() {
                ui_report.error(
                    $t_html({defaultMessage: "This formatting cannot be sent as written."}),
                    undefined,
                    $("#dialog_error"),
                );
            },
            upstream_keys: false,
            uploads: false,
            widgets: false,
            wildcard_mentions: false,
            typeahead_input: recipient_input({
                message_type: undefined,
                stream_id: undefined,
                topic: "",
                banners: undefined,
            }),
        },
        () => {
            box.classList.remove("ykphone-rich-snippet");
        },
    );
}

export function initialize(): void {
    ykphone_rich_hooks.set_plain_editor_mounter(mount_saved_snippet_form);
}
