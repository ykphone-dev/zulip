// The 옆커폰 rich composer: the compose box's rich editor, which shows
// formatting and chips instead of Markdown syntax.
//
// The editor itself is ykphone_rich_editor.ts; this module puts it in
// place of #compose-textarea and says what sending means there: upstream's
// Enter-sends setting and send path, the compose banners, and the send
// button's state while the formatting cannot be sent.

import $ from "jquery";

import * as compose_banner from "./compose_banner.ts";
import * as compose_validate from "./compose_validate.ts";
import {RichEditor, upstream_enter_sends} from "./ykphone_rich_editor.ts";
import * as ykphone_rich_hooks from "./ykphone_rich_hooks.ts";
import * as ykphone_rich_typeahead from "./ykphone_rich_typeahead.ts";

let editor: RichEditor | undefined;

// Upstream disables the send button while the message cannot be sent,
// and decides that when the box opens or its recipient changes; the
// formatting can change with every write.
let last_lossy = false;

function on_flush(lossy: boolean): void {
    if (lossy !== last_lossy) {
        last_lossy = lossy;
        compose_validate.validate_and_update_send_button_status();
    }
}

export function mount(): void {
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea#compose-textarea");
    const box = document.querySelector<HTMLElement>("#compose");
    const container = document.querySelector<HTMLElement>("#message-content-container");
    if (textarea === null || box === null || container === null || editor !== undefined) {
        return;
    }
    box.classList.add("ykphone-rich-compose");
    editor = new RichEditor({
        textarea,
        box,
        focus_container: container,
        read_only: false,
        enter_sends: upstream_enter_sends,
        show_send_error(message) {
            compose_banner.show_error_message(
                message,
                compose_banner.CLASSNAMES.generic_compose_error,
                $("#compose_banners"),
                $(textarea),
            );
        },
        upstream_keys: true,
        uploads: true,
        widgets: true,
        wildcard_mentions: true,
        typeahead_input: ykphone_rich_typeahead.compose_input,
        on_flush,
    });
    ykphone_rich_hooks.register(editor.handlers);
    // On a page load into a conversation, upstream has opened the box
    // and focused the textarea before the composer is mounted.
    editor.take_initial_focus();
}
