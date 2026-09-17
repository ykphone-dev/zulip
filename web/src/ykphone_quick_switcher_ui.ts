// The ⌘K quick switcher's modal for the 옆커폰 fork (the data and the
// ranking are in ykphone_quick_switcher.ts). It is an ordinary micromodal,
// so Escape, a click outside and upstream's "a modal is open" checks
// all apply; the text field keeps the keyboard focus, and the arrow
// keys and Enter move through and open the results.
//
// DOM glue only, so it is exempt from node coverage.

import $ from "jquery";
import Micromodal from "micromodal";

import render_ykphone_quick_switcher from "../templates/ykphone_quick_switcher.hbs";
import render_ykphone_quick_switcher_rows from "../templates/ykphone_quick_switcher_rows.hbs";

import * as browser_history from "./browser_history.ts";
import * as modals from "./modals.ts";
import * as ykphone_places from "./ykphone_places.ts";
import * as ykphone_quick_switcher from "./ykphone_quick_switcher.ts";
import * as ykphone_recents from "./ykphone_recents.ts";

const MODAL_ID = "ykphone-quick-switcher";

function $modal(): JQuery {
    return $(`#${MODAL_ID}`);
}

// Micromodal marks a modal hidden as soon as it starts to close; the
// element itself goes once the closing animation ends.
export function is_open(): boolean {
    return $modal().length > 0 && $modal().attr("aria-hidden") !== "true";
}

export function close(): void {
    if (!is_open()) {
        return;
    }
    if (modals.is_active(MODAL_ID)) {
        modals.close(MODAL_ID);
    } else {
        // Still opening (upstream counts a modal as open once its
        // animation has ended): an Enter typed straight away closes it
        // all the same.
        Micromodal.close(MODAL_ID);
    }
}

function $options(): JQuery {
    return $modal().find(".ykphone-quick-switcher-option");
}

function set_active(index: number): void {
    const $all = $options();
    if ($all.length === 0) {
        return;
    }
    const clamped = Math.max(0, Math.min(index, $all.length - 1));
    $all.removeClass("active").attr("aria-selected", "false");
    const $active = $all.eq(clamped).addClass("active").attr("aria-selected", "true");
    $modal()
        .find(".ykphone-quick-switcher-input")
        .attr("aria-activedescendant", $active.attr("id")!);
    $active[0]!.scrollIntoView({block: "nearest"});
}

function active_index(): number {
    return $options().index($options().filter(".active"));
}

function render_results(): void {
    const query = $modal().find<HTMLInputElement>(".ykphone-quick-switcher-input").val() ?? "";
    const items = ykphone_quick_switcher.results(query, ykphone_places.current_view_place());
    $modal()
        .find(".ykphone-quick-switcher-results")
        .html(render_ykphone_quick_switcher_rows({items}))
        .scrollTop(0);
    const $input = $modal().find(".ykphone-quick-switcher-input");
    if (items.length === 0) {
        $input.removeAttr("aria-activedescendant");
    } else {
        $input.attr("aria-activedescendant", "ykphone-quick-switcher-option-0");
    }
}

function go_to($option: JQuery): void {
    const hash = $option.attr("data-hash");
    if (hash === undefined) {
        return;
    }
    // Pages that are not narrows (drafts, settings, the admin pages)
    // would otherwise never reach the History dropdown.
    const place = ykphone_places.page_place_from_id($option.attr("data-page"));
    if (place !== undefined) {
        ykphone_recents.note_visit(place);
    }
    // Close first, so that the focus micromodal gives back (to the
    // compose box, say) is settled before the new view takes it.
    close();
    browser_history.go_to_location(hash);
}

export function open(): void {
    if (is_open()) {
        return;
    }
    // Still fading out from the last time.
    $modal().remove();
    $("body").append($(render_ykphone_quick_switcher()));
    const $input = $modal().find<HTMLInputElement>(".ykphone-quick-switcher-input");

    $input.on("input", () => {
        render_results();
    });
    $input.on("keydown", (e) => {
        // A Korean syllable being composed commits on Enter; that
        // Enter is not the user's choice of a result.
        if (e.originalEvent?.isComposing) {
            return;
        }
        switch (e.key) {
            case "ArrowDown":
                set_active(active_index() + 1);
                break;
            case "ArrowUp":
                set_active(active_index() - 1);
                break;
            case "Enter":
                go_to($options().filter(".active"));
                break;
            default:
                return;
        }
        // The keys are the list's, not the page's hotkeys'.
        e.preventDefault();
        e.stopPropagation();
    });

    const $results = $modal().find(".ykphone-quick-switcher-results");
    $results.on("mousemove", ".ykphone-quick-switcher-option", function (this: HTMLElement) {
        if (!$(this).hasClass("active")) {
            set_active($options().index(this));
        }
    });
    $results.on("click", ".ykphone-quick-switcher-option", function (this: HTMLElement, e) {
        e.preventDefault();
        go_to($(this));
    });

    render_results();
    modals.open(MODAL_ID, {
        autoremove: true,
        on_show() {
            $input.trigger("focus");
        },
    });
    ykphone_quick_switcher.load_threads(() => {
        if (is_open()) {
            render_results();
        }
    });
}
