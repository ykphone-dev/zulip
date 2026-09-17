// Keeps the 옆커폰 rich composer's editor and the compose textarea in
// step.
//
// The textarea stays the source of truth for upstream: everything that
// reads the message (sending, drafts, validation, typing notifications)
// reads its value. So:
//
// - After every editor transaction that changes the document, the
//   document is written to the textarea as Markdown, with an "input"
//   event like the one typing would fire; after every transaction the
//   textarea's selection is set to the Markdown offsets of the editor's.
// - When upstream changes the textarea — by setting its value (clearing
//   the box, restoring a draft), through text-field-edit (which fires
//   "input"), or through the hooks in ykphone_rich_hooks.ts — the new
//   Markdown is parsed and only the part of the document that differs
//   is replaced, so chips, the cursor, undo history and an IME
//   composition elsewhere in the text are left alone.
//
// Nothing here touches the editor's DOM, so it runs in node tests
// against an EditorState.

import type {Node as PMNode} from "prosemirror-model";
import {EditorState, type Selection, TextSelection, type Transaction} from "prosemirror-state";
import {closeHistory} from "prosemirror-history";

import {
    type Anchor,
    type MarkdownContext,
    type SerializeResult,
    offset_to_pos,
    parse_markdown,
    pos_to_offset,
    serialize_markdown,
} from "./ykphone_rich_markdown.ts";

// The part of an EditorView the sync needs.
export type SyncView = {
    readonly state: EditorState;
    readonly composing: boolean;
    dispatch: (tr: Transaction) => void;
    updateState: (state: EditorState) => void;
};

export type SyncOptions = {
    view: SyncView;
    textarea: HTMLTextAreaElement;
    context: () => MarkdownContext;
    // A fresh editor state for `doc`, with the editor's plugins; used
    // where the textarea's own undo history would have been reset.
    create_state: (doc: PMNode) => EditorState;
    // Called when some formatting cannot be written so that the server
    // reads it back as shown.
    on_lossy: (markdown: string) => void;
    // Called after every write to the textarea, with whether the
    // document holds formatting Markdown cannot carry.
    on_flush: (lossy: boolean) => void;
};

export type ComposeSync = {
    markdown: () => string;
    selection_offsets: () => {start: number; end: number};
    // Whether the document holds formatting Markdown cannot carry.
    is_lossy: () => boolean;
    // Called with every transaction the editor applies.
    after_transaction: (tr: Transaction) => void;
    // Writes the document to the textarea now, if it has changed since
    // the last write; called before anything of upstream's reads it.
    flush: () => void;
    // Called when the textarea may have changed from outside.
    check_textarea: (options?: {reset_history?: boolean}) => void;
    insert_text: (content: string, replace_all: boolean, keep_undo: boolean) => void;
    // Replaces all the Markdown, as an undoable step, with the cursor at
    // `caret`.
    set_markdown: (markdown: string, caret: number) => void;
    replace_syntax: (old_syntax: string, new_syntax: string) => boolean;
    select_offsets: (start: number, end: number) => void;
    destroy: () => void;
};

// Transactions made by the sync carry this meta key; the editor does not
// write them back to the textarea.
export const IMPORT_META = "ykphone-rich-import";

// How long after an edit the textarea is written at the latest. Writing
// means serialising the document, so a burst of typing is written once;
// anything that reads the textarea before then gets it written first.
export const WRITE_DELAY_MS = 100;

const serialized = new WeakMap<PMNode, WeakMap<MarkdownContext, SerializeResult>>();

export function serialize_cached(doc: PMNode, ctx: MarkdownContext): SerializeResult {
    let by_context = serialized.get(doc);
    if (by_context === undefined) {
        by_context = new WeakMap();
        serialized.set(doc, by_context);
    }
    let result = by_context.get(ctx);
    if (result === undefined) {
        result = serialize_markdown(doc, ctx);
        by_context.set(ctx, result);
    }
    return result;
}

// Markdown offsets of a selection. At a formatting boundary a position
// has several offsets; the start takes the last (inside an opening
// delimiter), a non-empty selection's end the first (before a closing
// one), so the Markdown selection holds exactly the selected text.
export function offsets_for_selection(
    anchors: Anchor[],
    from: number,
    to: number,
): {start: number; end: number} {
    const start = pos_to_offset(anchors, from);
    if (from === to) {
        return {start, end: start};
    }
    const at_to = anchors.filter((anchor) => anchor.pos === to);
    const end = at_to.length > 0 ? at_to[0]!.off : pos_to_offset(anchors, to);
    return {start, end: Math.max(start, end)};
}

// Replaces only the part of `state`'s document that differs from `doc`.
// Everything on either side of the replaced range is the same in both
// documents, so the slice always fits where it goes; the test over pairs
// of documents checks that the result is `doc` itself.
export function replace_changed(state: EditorState, doc: PMNode): Transaction {
    const tr = state.tr;
    const old_content = state.doc.content;
    const start = old_content.findDiffStart(doc.content);
    if (start === null) {
        return tr;
    }
    let {a: end_old, b: end_new} = old_content.findDiffEnd(doc.content)!;
    // Text that only got shorter or longer leaves the two ends crossed
    // over; widen both so the range makes sense.
    const overlap = start - Math.min(end_old, end_new);
    if (overlap > 0) {
        end_old += overlap;
        end_new += overlap;
    }
    tr.replace(start, end_old, doc.slice(start, end_new));
    return tr;
}

function native_value_descriptor(): PropertyDescriptor {
    return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
}

export function create_sync(options: SyncOptions): ComposeSync {
    const {view, textarea} = options;
    const native = native_value_descriptor();
    // The Markdown the editor and the textarea last agreed on.
    let agreed = serialize_cached(view.state.doc, options.context()).markdown;

    // Writes to the textarea without going through the property defined
    // below, so the composer does not read its own writing back.
    const set_value = (value: string): void => {
        native.set!.call(textarea, value);
    };

    const current = (): SerializeResult => serialize_cached(view.state.doc, options.context());

    const fire_input = (): void => {
        textarea.dispatchEvent(new Event("input", {bubbles: true}));
    };

    const editor_offsets = (): {start: number; end: number} => {
        const {from, to} = view.state.selection;
        return offsets_for_selection(current().anchors, from, to);
    };

    // Set while upstream may still be placing the textarea's cursor after
    // changing its text; the editor's selection is not written back then.
    let following = false;

    const sync_selection = (): void => {
        if (following) {
            return;
        }
        const {start, end} = editor_offsets();
        if (textarea.selectionStart !== start || textarea.selectionEnd !== end) {
            textarea.setSelectionRange(start, end);
        }
    };

    const select_offsets = (start: number, end: number): void => {
        view.dispatch(
            view.state.tr
                .setSelection(selection_at(view.state, start, end))
                .setMeta(IMPORT_META, true)
                .scrollIntoView(),
        );
    };

    // The document has changed since the textarea was last written.
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (!pending) {
            return;
        }
        pending = false;
        const result = current();
        if (result.lossy) {
            options.on_lossy(result.markdown);
        }
        if (result.markdown !== agreed) {
            agreed = result.markdown;
            set_value(result.markdown);
            sync_selection();
            fire_input();
        } else {
            sync_selection();
        }
        options.on_flush(result.lossy);
    };

    // Upstream often moves the textarea's cursor right after changing its
    // text (a list toggled, a placeholder selected); follow it once the
    // code that changed the text has finished.
    const follow_textarea_selection = (): void => {
        if (following) {
            return;
        }
        following = true;
        queueMicrotask(() => {
            following = false;
            const {start, end} = editor_offsets();
            if (
                !view.composing &&
                (textarea.selectionStart !== start || textarea.selectionEnd !== end)
            ) {
                select_offsets(textarea.selectionStart, textarea.selectionEnd);
            }
        });
    };

    const selection_at = (state: EditorState, start: number, end: number): Selection => {
        const {anchors} = serialize_cached(state.doc, options.context());
        const from = offset_to_pos(anchors, start);
        const to = offset_to_pos(anchors, end);
        const size = state.doc.content.size;
        return TextSelection.between(
            state.doc.resolve(Math.min(from, size)),
            state.doc.resolve(Math.min(to, size)),
        );
    };

    const apply_import = (
        markdown: string,
        {reset_history, selection}: {reset_history: boolean; selection?: [number, number]},
    ): void => {
        const doc = parse_markdown(markdown, options.context());
        agreed = markdown;
        if (reset_history) {
            view.updateState(options.create_state(doc));
        } else {
            view.dispatch(
                closeHistory(replace_changed(view.state, doc)).setMeta(IMPORT_META, true),
            );
        }
        // A state made afresh has no cursor of its own; where the
        // document was only edited, an IME composition in it keeps the
        // cursor it is composing at.
        if (selection !== undefined && (reset_history || !view.composing)) {
            select_offsets(...selection);
        }
        sync_selection();
    };

    const check_textarea = ({reset_history = false}: {reset_history?: boolean} = {}): void => {
        // The textarea is the source of truth: what upstream wrote to it
        // replaces an edit not yet written, as it would replace typing
        // in a textarea. Code that only reads it flushes first.
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        pending = false;
        const value = native.get!.call(textarea) as string;
        if (value === agreed) {
            return;
        }
        apply_import(value, {
            reset_history,
            selection: [textarea.selectionStart, textarea.selectionEnd],
        });
        follow_textarea_selection();
    };

    // Upstream sets the value directly to clear the box or restore a
    // draft; a textarea forgets its undo history then, and so does the
    // editor.
    Object.defineProperty(textarea, "value", {
        configurable: true,
        enumerable: true,
        get(this: HTMLTextAreaElement) {
            flush();
            return native.get!.call(this) as string;
        },
        set(this: HTMLTextAreaElement, value: string) {
            native.set!.call(this, value);
            check_textarea({reset_history: true});
        },
    });

    // text-field-edit changes the value with execCommand, which fires
    // "input" but no setter.
    const on_input = (): void => {
        check_textarea();
    };
    textarea.addEventListener("input", on_input);

    return {
        markdown: () => current().markdown,
        selection_offsets: editor_offsets,
        is_lossy: () => current().lossy,
        after_transaction(tr) {
            if (tr.docChanged && tr.getMeta(IMPORT_META) !== true) {
                pending = true;
                timer ??= setTimeout(flush, WRITE_DELAY_MS);
                return;
            }
            if (!pending) {
                sync_selection();
            }
        },
        flush,
        check_textarea,
        insert_text(content, replace_all, keep_undo) {
            flush();
            const markdown = current().markdown;
            const {start, end} = replace_all ? {start: 0, end: markdown.length} : editor_offsets();
            const updated = markdown.slice(0, start) + content + markdown.slice(end);
            const caret = start + content.length;
            set_value(updated);
            apply_import(updated, {reset_history: !keep_undo, selection: [caret, caret]});
            fire_input();
            follow_textarea_selection();
        },
        set_markdown(markdown, caret) {
            flush();
            set_value(markdown);
            apply_import(markdown, {reset_history: false, selection: [caret, caret]});
            fire_input();
        },
        replace_syntax(old_syntax, new_syntax) {
            flush();
            const markdown = current().markdown;
            if (!markdown.includes(old_syntax)) {
                return false;
            }
            const updated = markdown.replace(old_syntax, () => new_syntax);
            set_value(updated);
            // The editor's own mapping keeps the cursor where it was.
            apply_import(updated, {reset_history: false});
            fire_input();
            return updated !== markdown;
        },
        select_offsets,
        destroy() {
            flush();
            textarea.removeEventListener("input", on_input);
            delete (textarea as {value?: string}).value;
        },
    };
}
