// Drag and drop of channel rows between the sidebar's favourites
// section and the other channel sections (HTML5 drag events). The
// decision of what a drop means lives in ykphone_favorites.ts; this
// module is exempt from node coverage like ykphone_threads_ui.
//
// Keyboard users keep the menu item ("Pin channel to top", shown as
// add to favourites); direct message rows are not draggable, since
// Zulip has no favourites for them.

import $ from "jquery";

import * as stream_list from "./stream_list.ts";
import * as ykphone_favorites from "./ykphone_favorites.ts";

// Delegated handlers see selectors relative to #stream_filters.
const ROW_SELECTOR = ".narrow-filter";
const SECTION_SELECTOR = ".stream-list-section-container";
const DRAGGING_CLASS = "ykphone-dragging";
// Our own type, so a channel dropped elsewhere (the compose box, say)
// inserts nothing.
const DRAG_DATA_TYPE = "application/x-ykphone-stream-id";
const DROP_TARGET_CLASS = "ykphone-drop-target";

let dragged_stream_id: number | undefined;

// Whether a dragstart comes from one of our channel rows; upstream
// cancels every other drag in the channel list (click_handlers).
export function is_channel_row_drag(target: Element): boolean {
    return $(target).closest(`#stream_filters ${ROW_SELECTOR}[draggable="true"]`).length > 0;
}

function clear_drop_targets(): void {
    $(`#stream_filters ${SECTION_SELECTOR}`).removeClass(DROP_TARGET_CLASS);
}

function end_drag(): void {
    $(`#stream_filters ${ROW_SELECTOR}`).removeClass(DRAGGING_CLASS);
    clear_drop_targets();
    dragged_stream_id = undefined;
}

export function initialize(): void {
    // Rows are re-rendered whenever the list is rebuilt, so rather than
    // marking every row, the row the pointer presses is made draggable
    // just before a drag could start from it. Upstream marks the row's
    // link draggable="false" (against dragging the URL); the link is
    // where the pointer is, so it is marked too, and the drag carries
    // the channel id instead of the URL.
    $("#stream_filters").on("mousedown", ROW_SELECTOR, function (this: HTMLElement, e) {
        // A drag whose source row was re-rendered mid-way never fires
        // dragend; the next press clears it.
        if (dragged_stream_id !== undefined) {
            end_drag();
        }
        // Only the channel row itself: the expanded topic list and the
        // ⋮ menu live inside the same li, and a zoomed-in channel is not
        // a list to reorder.
        if (
            stream_list.is_zoomed_in() ||
            $(e.target).closest(".channel-header", this).length === 0 ||
            $(e.target).closest(".stream-sidebar-menu-icon", this).length > 0
        ) {
            return;
        }
        this.draggable = true;
        $(this).find(".subscription_block").attr("draggable", "true");
    });

    $("#stream_filters").on("dragstart", ROW_SELECTOR, function (this: HTMLElement, e) {
        const stream_id = Number($(this).attr("data-stream-id"));
        if (Number.isNaN(stream_id)) {
            return;
        }
        dragged_stream_id = stream_id;
        const data_transfer = e.originalEvent?.dataTransfer;
        if (data_transfer) {
            data_transfer.effectAllowed = "move";
            data_transfer.setData(DRAG_DATA_TYPE, stream_id.toString());
        }
        $(this).addClass(DRAGGING_CLASS);
    });

    $("#stream_filters").on("dragend", ROW_SELECTOR, end_drag);

    function allow_drop(this: HTMLElement, e: JQuery.DragEnterEvent | JQuery.DragOverEvent): void {
        const section_id = $(this).attr("data-section-id");
        if (
            dragged_stream_id === undefined ||
            section_id === undefined ||
            !ykphone_favorites.can_drop(dragged_stream_id, section_id)
        ) {
            // Not a drop target: the browser shows the not-allowed cursor.
            clear_drop_targets();
            return;
        }
        e.preventDefault();
        const data_transfer = e.originalEvent?.dataTransfer;
        if (data_transfer) {
            data_transfer.dropEffect = "move";
        }
        clear_drop_targets();
        $(this).addClass(DROP_TARGET_CLASS);
    }
    $("#stream_filters").on("dragenter", SECTION_SELECTOR, allow_drop);
    $("#stream_filters").on("dragover", SECTION_SELECTOR, allow_drop);

    $("#stream_filters").on("dragleave", SECTION_SELECTOR, function (this: HTMLElement, e) {
        // Moving between the section's own children fires dragleave
        // too; only leaving the section clears its highlight.
        const related = e.originalEvent?.relatedTarget;
        if (related instanceof Node && this.contains(related)) {
            return;
        }
        $(this).removeClass(DROP_TARGET_CLASS);
    });

    $("#stream_filters").on("drop", SECTION_SELECTOR, function (this: HTMLElement, e) {
        if (dragged_stream_id === undefined) {
            return;
        }
        // The compose box's upload handler listens for drops on the
        // whole app; this one is ours.
        e.preventDefault();
        e.stopPropagation();
        const section_id = $(this).attr("data-section-id");
        if (section_id !== undefined) {
            ykphone_favorites.handle_drop(dragged_stream_id, section_id);
        }
        end_drag();
    });
}
