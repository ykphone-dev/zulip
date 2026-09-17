// Slack's Files view for the 옆커폰 fork: the rail's 파일 item and a
// channel's 파일 tab.
//
// Both are already "has:attachment" narrows in this fork, so the hash,
// the pane header (a channel keeps its 메시지 / 파일 / 고정 tabs), the
// window title and the permissions stay upstream's. What changes is
// what the middle pane shows: instead of a feed of messages that
// happen to carry a file, the fork renders the file list Slack has —
// the file, who shared it, where, and when — with filters for the type,
// the person and the channel. A row opens the message the file was
// shared in.
//
// This module is DOM glue and exempt from node coverage: the rows, the
// names, the marks and the filters are all decided (and tested) in
// ykphone_files.ts, and what is left here is the fetch, the container
// and three event handlers.

import $ from "jquery";
import * as z from "zod/mini";

import render_ykphone_file_rows from "../templates/ykphone_file_rows.hbs";
import render_ykphone_files_bar from "../templates/ykphone_files_bar.hbs";
import render_ykphone_files_pane from "../templates/ykphone_files_pane.hbs";

import * as channel from "./channel.ts";
import type {Filter} from "./filter.ts";
import {$t} from "./i18n.ts";
import type {RawMessage} from "./message_store.ts";
import {raw_message_schema} from "./message_store.ts";
import * as lightbox from "./lightbox.ts";
import * as narrow_state from "./narrow_state.ts";
import {page_params} from "./page_params.ts";
import * as ykphone_conversation from "./ykphone_conversation.ts";
import * as ykphone_files from "./ykphone_files.ts";
import * as ykphone_flags from "./ykphone_flags.ts";

// As many messages as one request brings; older files are reached by
// searching.
const MAX_FILE_MESSAGES = 200;

const messages_response_schema = z.object({messages: z.array(raw_message_schema)});

type View = {stream_id: number | undefined};

let view: View | undefined;
let messages: RawMessage[] = [];
let status: "loading" | "error" | "ready" = "ready";
let filters = ykphone_files.NO_FILE_FILTERS;
let load_generation = 0;

function $view(): JQuery {
    return $("#ykphone-files-view");
}

// The Files view a narrow stands for: every channel, or one channel.
// Spectators keep upstream's feed: Zulip's web-public message API does
// not answer a "has:attachment" narrow without a session, so the list
// would have nothing to show.
function view_for(filter: Filter | undefined): View | undefined {
    if (
        filter === undefined ||
        !ykphone_flags.channels_open_in_general_chat() ||
        page_params.is_spectator
    ) {
        return undefined;
    }
    if (ykphone_conversation.is_files_narrow(filter)) {
        return {stream_id: undefined};
    }
    if (ykphone_conversation.is_channel_files_narrow(filter)) {
        const stream_id = narrow_state.stream_id(filter, true);
        return stream_id === undefined ? undefined : {stream_id};
    }
    return undefined;
}

// The narrow as the API reads it: a channel's id goes out as a number,
// because a string operand names a channel instead.
type ApiTerm = {operator: string; operand: string | number};

function narrow_terms(current: View): ApiTerm[] {
    const terms: ApiTerm[] = [{operator: "has", operand: "attachment"}];
    if (current.stream_id !== undefined) {
        terms.unshift({operator: "channel", operand: current.stream_id});
    }
    return terms;
}

function render_rows(): void {
    const shown = ykphone_files.view_rows(messages, filters);
    $view()
        .find(".ykphone-files-body")
        .html(
            render_ykphone_file_rows({
                loading: status === "loading",
                error: status === "error",
                has_rows: shown.length > 0,
                empty_label:
                    ykphone_files.rows_from_messages(messages).length === 0
                        ? $t({defaultMessage: "No files have been shared yet."})
                        : $t({defaultMessage: "No files match these filters."}),
                rows: shown,
            }),
        );
}

function render_bar(): void {
    const rows = ykphone_files.rows_from_messages(messages);
    const shown = ykphone_files.filter_rows(rows, filters);
    const bar_filters = [
        {
            name: "kind",
            label: $t({defaultMessage: "File type"}),
            options: ykphone_files.kind_options(rows, filters),
        },
        {
            name: "file-sender",
            label: $t({defaultMessage: "Shared by"}),
            options: ykphone_files.sender_options(rows, filters),
        },
    ];
    if (view?.stream_id === undefined) {
        bar_filters.push({
            name: "file-channel",
            label: $t({defaultMessage: "Channel"}),
            options: ykphone_files.channel_options(rows, filters),
        });
    }
    $view()
        .find(".ykphone-files-bar")
        .html(
            render_ykphone_files_bar({
                filters: bar_filters,
                count_label: $t(
                    {defaultMessage: "{count, plural, one {# file} other {# files}}"},
                    {count: shown.length},
                ),
            }),
        );
}

function render(): void {
    render_bar();
    render_rows();
}

function load(current: View): void {
    load_generation += 1;
    const generation = load_generation;
    status = "loading";
    messages = [];
    render();
    void channel.get({
        url: "/json/messages",
        data: {
            anchor: "newest",
            num_before: MAX_FILE_MESSAGES,
            num_after: 0,
            narrow: JSON.stringify(narrow_terms(current)),
            apply_markdown: true,
            client_gravatar: true,
            allow_empty_topic_name: true,
        },
        success(raw_data) {
            if (generation !== load_generation) {
                return;
            }
            // Newest first, as Slack's Files page lists them.
            messages = messages_response_schema.parse(raw_data).messages.toReversed();
            status = "ready";
            render();
        },
        error() {
            if (generation === load_generation) {
                status = "error";
                render();
            }
        },
    });
}

function show(current: View): void {
    view = current;
    // One mechanism for one state: the body class shows the view and
    // hides the feed (see "Files view" in the theme).
    $("body").addClass("ykphone-files-view");
    filters = ykphone_files.NO_FILE_FILTERS;
    load(current);
}

export function hide(): void {
    if (view === undefined) {
        return;
    }
    view = undefined;
    load_generation += 1;
    messages = [];
    $("body").removeClass("ykphone-files-view");
    $view().find(".ykphone-files-body").empty();
}

// Called for every narrow, through ykphone_ui_hooks.
export function handle_narrow_activated(): void {
    const current = view_for(narrow_state.filter());
    if (current === undefined) {
        hide();
        return;
    }
    show(current);
}

export function initialize(): void {
    $("#message_feed_container").before(
        $("<div>")
            .attr("id", "ykphone-files-view")
            .addClass("ykphone-files-view-container")
            .html(render_ykphone_files_pane({})),
    );
    $("body").on(
        "change",
        "#ykphone-files-view .ykphone-filter-select",
        function (this: HTMLElement) {
            const name = $(this).attr("data-ykphone-filter");
            const value = String($(this).val() ?? "");
            const operand = value === "" ? undefined : value;
            switch (name) {
                case "kind":
                    filters = {
                        ...filters,
                        kind: ykphone_files.is_file_kind(value) ? value : "any",
                    };
                    break;
                case "file-sender":
                    filters = {
                        ...filters,
                        sender_id: operand === undefined ? undefined : Number(operand),
                    };
                    break;
                case "file-channel":
                    filters = {
                        ...filters,
                        stream_id: operand === undefined ? undefined : Number(operand),
                    };
                    break;
                default:
                    return;
            }
            render();
            $view()
                .find(`.ykphone-filter-select[data-ykphone-filter="${CSS.escape(name ?? "")}"]`)
                .trigger("focus");
        },
    );
    // Upstream's document click handler refocuses the compose box for
    // any click inside a link while composing, which would scroll the
    // conversation the row is about to open.
    $("body").on("click", "#ykphone-files-view .ykphone-file-row", (e) => {
        e.stopPropagation();
    });
    // An image opens in the lightbox rather than in its message. The
    // thumbnail's own link carries the full-size file, which is what
    // the lightbox reads from the image's parent; with no message row
    // around it the lightbox shows no sender name, and its arrows are
    // hidden because there is no conversation to walk.
    $("body").on("click", ".ykphone-file-preview", function (this: HTMLElement, e) {
        const $image = $(this).find<HTMLImageElement>("img");
        if ($image.length === 0) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        lightbox.handle_inline_media_element_click($image, true);
    });
}
