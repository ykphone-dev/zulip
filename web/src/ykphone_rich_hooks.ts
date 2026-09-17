// The seam between upstream's compose code and the 옆커폰 rich editors.
//
// Upstream writes Markdown into a message textarea in a handful of
// places; a rich editor keeps that textarea as the source of truth and
// shows an editor in its place. Most writes reach the editor through
// the textarea itself (ykphone_rich_sync.ts watches its value), but three
// compose_ui functions would otherwise move focus into the hidden
// textarea or edit Markdown text the user cannot see:
//
//   format_text     toolbar buttons and formatting shortcuts
//   replace_syntax  upload placeholders swapped for the uploaded file
//   insert_syntax   everything inserted "where the cursor was"
//
// Each calls the matching function here with its textarea first; when a
// rich editor owns that textarea it does the work and upstream's code is
// skipped.
//
// The compose box's editor is registered with register(); the editors
// of message edit forms and the thread panel's reply box, of which
// several can exist at once, with register_editor(). has_focus() and
// send_error() are about the compose box, as upstream asks them where it
// checks the compose textarea; editor_has_focus() is about any of them.
//
// Editors outside the compose box write to their own recipient, which
// upstream's typeahead and mention warnings would otherwise take from the
// compose box: set_recipient() gives the textarea upstream's typeahead
// reads a recipient of its own, and with_recipient_of() makes
// compose_state answer for it while the typeahead runs.
//
// This module has no imports, so compose_ui can use it without an
// import cycle; the editors register their handlers when they mount.

export type RichComposeHandlers = {
    textarea: HTMLTextAreaElement;
    has_focus: () => boolean;
    // Writes what the editor shows to the textarea, with its cursor.
    flush: () => void;
    // The reason the message cannot be sent as it is shown, or
    // undefined; with show_banner the editor also says so.
    send_error: (show_banner: boolean) => string | undefined;
    format_text: (type: string, inserted_content: string | undefined) => boolean;
    replace_syntax: (old_syntax: string, new_syntax: string) => boolean;
    insert_text: (content: string, replace_all: boolean, keep_undo: boolean) => void;
};

let compose_handlers: RichComposeHandlers | undefined;
const other_editors = new Set<RichComposeHandlers>();

export function register(new_handlers: RichComposeHandlers | undefined): void {
    compose_handlers = new_handlers;
}

// Returns the function that unregisters the editor again.
export function register_editor(handlers: RichComposeHandlers): () => void {
    other_editors.add(handlers);
    return () => {
        other_editors.delete(handlers);
    };
}

function all_editors(): RichComposeHandlers[] {
    return compose_handlers === undefined
        ? [...other_editors]
        : [compose_handlers, ...other_editors];
}

function owner(textarea: HTMLTextAreaElement | undefined): RichComposeHandlers | undefined {
    if (textarea === undefined) {
        return undefined;
    }
    return all_editors().find((handlers) => handlers.textarea === textarea);
}

// Whether keyboard focus is in the compose box's rich editor, which
// upstream treats as focus in the compose textarea.
export function has_focus(): boolean {
    return compose_handlers?.has_focus() ?? false;
}

// Whether keyboard focus is in any rich editor: text is being typed.
export function editor_has_focus(): boolean {
    return all_editors().some((handlers) => handlers.has_focus());
}

// The element upstream should take as focused: the textarea of the rich
// editor that has the focus, written up to date so that its value and
// cursor are the editor's, or `active` itself.
export function focused_element(active: Element | null): Element | null {
    const focused = all_editors().find((handlers) => handlers.has_focus());
    if (focused === undefined) {
        return active;
    }
    focused.flush();
    return focused.textarea;
}

export function registered_editor_count(): number {
    return other_editors.size;
}

// ---- Recipients of editors outside the compose box ----

export type RichRecipient = {
    // undefined: no recipient at all (a saved snippet).
    message_type: "stream" | undefined;
    stream_id: number | undefined;
    topic: string;
    // Where upstream's warnings about the message go.
    banners: HTMLElement | undefined;
};

const recipients = new WeakMap<Element, RichRecipient>();
let current_recipient_value: RichRecipient | undefined;

export function set_recipient(input: Element, recipient: RichRecipient): void {
    recipients.set(input, recipient);
}

export function recipient_for(input: Element | undefined): RichRecipient | undefined {
    return input === undefined ? undefined : recipients.get(input);
}

// Runs `fn` with compose_state answering for the recipient of `input`,
// when it has one of its own.
export function with_recipient_of<T>(input: Element | undefined, fn: () => T): T {
    const previous = current_recipient_value;
    current_recipient_value = recipient_for(input) ?? previous;
    try {
        return fn();
    } finally {
        current_recipient_value = previous;
    }
}

// The recipient compose_state answers for, while a rich editor's
// typeahead runs.
export function current_recipient(): RichRecipient | undefined {
    return current_recipient_value;
}

// Rich editors for plain message fields (the saved snippet forms) are
// made by ykphone_rich_surfaces.ts, which registers how here: the modules
// with those fields are imported by the editor's own dependencies.
let plain_editor_mounter: ((textarea: HTMLTextAreaElement) => void) | undefined;

export function set_plain_editor_mounter(
    mounter: ((textarea: HTMLTextAreaElement) => void) | undefined,
): void {
    plain_editor_mounter = mounter;
}

// Puts a rich editor over `textarea`, a field holding message Markdown.
export function mount_plain_editor(textarea: HTMLTextAreaElement | undefined): void {
    if (textarea !== undefined) {
        plain_editor_mounter?.(textarea);
    }
}

// Why the message in the compose box cannot be sent as it is shown, if
// it holds formatting that Zulip's Markdown cannot carry to the server.
export function send_error(show_banner: boolean): string | undefined {
    return compose_handlers?.send_error(show_banner);
}

// The same for the rich editor owning `textarea`, if one does.
export function send_error_for(
    textarea: HTMLTextAreaElement | undefined,
    show_banner: boolean,
): string | undefined {
    return owner(textarea)?.send_error(show_banner);
}

// Returns true when the formatting was applied by a rich editor; false
// leaves it to upstream.
export function format_text(
    textarea: HTMLTextAreaElement | undefined,
    type: string,
    inserted_content?: string,
): boolean {
    return owner(textarea)?.format_text(type, inserted_content) ?? false;
}

// Returns whether anything was replaced, or undefined when the textarea
// is not a rich editor's.
export function replace_syntax(
    textarea: HTMLTextAreaElement | undefined,
    old_syntax: string,
    new_syntax: string,
): boolean | undefined {
    return owner(textarea)?.replace_syntax(old_syntax, new_syntax);
}

// Returns true when a rich editor inserted the text: at the cursor, or
// in place of everything with replace_all.
export function insert_text(
    textarea: HTMLTextAreaElement | undefined,
    content: string,
    replace_all: boolean,
    replace_all_without_undo_support: boolean,
): boolean {
    const rich = owner(textarea);
    if (rich === undefined) {
        return false;
    }
    rich.insert_text(
        content,
        replace_all || replace_all_without_undo_support,
        !replace_all_without_undo_support,
    );
    return true;
}
