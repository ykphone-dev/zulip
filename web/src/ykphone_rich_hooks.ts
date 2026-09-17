// The seam between upstream's compose code and the 옆커폰 rich composer.
//
// Upstream writes Markdown into the compose textarea in a handful of
// places; the rich composer keeps that textarea as the source of truth
// and shows an editor in its place. Most writes reach the editor through
// the textarea itself (ykphone_rich_sync.ts watches its value), but three
// compose_ui functions would otherwise move focus into the hidden
// textarea or edit Markdown text the user cannot see:
//
//   format_text     toolbar buttons and formatting shortcuts
//   replace_syntax  upload placeholders swapped for the uploaded file
//   insert_syntax   everything inserted "where the cursor was"
//
// Each calls the matching function here first; when the rich composer
// owns that textarea it does the work and upstream's code is skipped.
// hotkey.ts and compose_state.ts ask has_focus() where they check for
// focus in the textarea.
//
// This module has no imports, so compose_ui can use it without an
// import cycle; the composer registers its handlers on mount.

export type RichComposeHandlers = {
    owns: (textarea: HTMLTextAreaElement) => boolean;
    has_focus: () => boolean;
    // The reason the message cannot be sent as it is shown, or
    // undefined; with show_banner the composer also says so in the box.
    send_error: (show_banner: boolean) => string | undefined;
    format_text: (type: string, inserted_content: string | undefined) => boolean;
    replace_syntax: (old_syntax: string, new_syntax: string) => boolean;
    insert_text: (content: string, replace_all: boolean, keep_undo: boolean) => void;
};

let handlers: RichComposeHandlers | undefined;

export function register(new_handlers: RichComposeHandlers | undefined): void {
    handlers = new_handlers;
}

function owner(textarea: HTMLTextAreaElement | undefined): RichComposeHandlers | undefined {
    return textarea !== undefined && handlers?.owns(textarea) === true ? handlers : undefined;
}

// Whether keyboard focus is in the rich composer, which upstream treats
// as focus in the compose textarea.
export function has_focus(): boolean {
    return handlers?.has_focus() ?? false;
}

// Why the message cannot be sent as it is shown, if the composer holds
// formatting that Zulip's Markdown cannot carry to the server.
export function send_error(show_banner: boolean): string | undefined {
    return handlers?.send_error(show_banner);
}

// Returns true when the formatting was applied by the rich composer;
// false leaves it to upstream.
export function format_text(
    textarea: HTMLTextAreaElement | undefined,
    type: string,
    inserted_content?: string,
): boolean {
    return owner(textarea)?.format_text(type, inserted_content) ?? false;
}

// Returns whether anything was replaced, or undefined when the textarea
// is not the rich composer's.
export function replace_syntax(
    textarea: HTMLTextAreaElement | undefined,
    old_syntax: string,
    new_syntax: string,
): boolean | undefined {
    return owner(textarea)?.replace_syntax(old_syntax, new_syntax);
}

// Returns true when the rich composer inserted the text: at the cursor,
// or in place of everything with replace_all.
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
