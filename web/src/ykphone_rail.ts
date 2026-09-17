// Slack-style icon rail for the 옆커폰 fork.
//
// A narrow column at the left edge of the app holds the organization
// logo, the primary views (home, direct messages, activity, files and,
// for administrators, the admin panel) and the personal menu; the theme
// is switched in Settings > Preferences. It is mounted inside .column-left next to the left
// sidebar, so upstream's rules for hiding that column (the navbar
// toggle on wide screens, the overlay on narrow ones) cover the rail
// too. The card header at the top of the sidebar (organization name
// and the new-message button) is rendered here as well, since it is
// part of the same layout.
//
// The navbar's history controls (back, forward, Threads) and the
// search placeholder are set up here too.
//
// The DOM event wiring lives in ykphone_threads_ui.ts.

import $ from "jquery";

import render_ykphone_navbar_history from "../templates/ykphone_navbar_history.hbs";
import render_ykphone_rail from "../templates/ykphone_rail.hbs";
import render_ykphone_sidebar_header from "../templates/ykphone_sidebar_header.hbs";

import * as browser_history from "./browser_history.ts";
import * as buddy_data from "./buddy_data.ts";
import {$t} from "./i18n.ts";
import * as left_sidebar_navigation_area from "./left_sidebar_navigation_area.ts";
import {page_params} from "./page_params.ts";
import {current_user, realm} from "./state_data.ts";

export type RailItem = {
    id: string;
    href: string;
    // The rail's own outline glyph, and its filled twin for the active item.
    icon: string;
    filled_icon: string;
    label: string;
    // The item is shown as active while the hash starts with one of
    // these.
    hash_prefixes: string[];
};

export function rail_items(): RailItem[] {
    const items: RailItem[] = [
        {
            id: "home",
            href: "#inbox",
            icon: "ykphone-rail-house",
            filled_icon: "ykphone-rail-house-filled",
            label: $t({defaultMessage: "Home"}),
            hash_prefixes: ["#inbox"],
        },
        {
            id: "dm",
            href: "#ykphone/dms",
            icon: "ykphone-rail-dm",
            filled_icon: "ykphone-rail-dm-filled",
            label: $t({defaultMessage: "DM"}),
            hash_prefixes: ["#ykphone/dms"],
        },
        {
            id: "activity",
            href: "#ykphone/activity",
            icon: "ykphone-rail-bell",
            filled_icon: "ykphone-rail-bell-filled",
            label: $t({defaultMessage: "Activity"}),
            hash_prefixes: ["#ykphone/activity"],
        },
        {
            id: "files",
            href: "#narrow/has/attachment",
            icon: "ykphone-rail-file",
            filled_icon: "ykphone-rail-file-filled",
            label: $t({defaultMessage: "Files"}),
            hash_prefixes: ["#narrow/has/attachment"],
        },
    ];
    if (current_user.is_admin) {
        items.push({
            id: "admin",
            href: "#organization",
            icon: "ykphone-rail-gear",
            filled_icon: "ykphone-rail-gear-filled",
            label: $t({defaultMessage: "Admin"}),
            hash_prefixes: ["#organization"],
        });
    }
    return items;
}

export function active_item_id(hash: string): string | undefined {
    // The logo links to "#", which the app resolves to the home view.
    const effective_hash =
        hash === "" || hash === "#" ? browser_history.get_home_view_hash() : hash;
    return rail_items().find((item) =>
        item.hash_prefixes.some((prefix) => effective_hash.startsWith(prefix)),
    )?.id;
}

export function update_active_item(hash: string): void {
    $("#ykphone-rail .ykphone-rail-item").removeClass("active").removeAttr("aria-current");
    const active_id = active_item_id(hash);
    if (active_id !== undefined) {
        $(`#ykphone-rail .ykphone-rail-item[data-rail-item="${active_id}"]`)
            .addClass("active")
            .attr("aria-current", "page");
    }
}

function refresh_active_item(): void {
    update_active_item(window.location.hash);
}

// Called (through ykphone_ui_hooks) by message_view once a narrow is
// active; the hashchange listener below covers overlays such as
// #organization, whose hashes never activate a narrow.
export function handle_narrow_activated(): void {
    refresh_active_item();
}

export function mount(): void {
    $("#left-sidebar-container").prepend(
        $(
            render_ykphone_rail({
                items: rail_items(),
                avatar_url: current_user.avatar_url_medium,
                // Slack marks its own avatar with the same presence dot
                // as everyone else's. The dot carries the id upstream's
                // buddy_list_presence.update_indicators looks for, so it
                // follows the user's own "presence_enabled" setting with
                // no new hook (presence.get_status short-circuits for
                // one's own id, so it is that setting rather than live
                // presence that moves it). Spectators have no presence
                // and no avatar menu; neither does a realm that turned
                // presence off.
                ...(page_params.is_spectator || realm.realm_presence_disabled
                    ? {}
                    : {
                          my_user_id: current_user.user_id,
                          user_circle_class: buddy_data.get_user_circle_class(current_user.user_id),
                      }),
            }),
        ),
    );
    // The navbar's logo moves into the rail rather than being copied,
    // so realm_logo keeps updating it (theme variant, logo changes).
    // Like Slack's workspace icon it leads to the home view; the
    // tooltip replaces upstream's (delegated on the image, which the
    // theme makes inert to the pointer) with the tile's own label.
    $("#ykphone-rail .ykphone-rail-logo").append(
        $("#top_navbar .column-left .brand")
            .attr("href", "#")
            .addClass("tippy-zulip-tooltip")
            .attr("data-tippy-content", $t({defaultMessage: "Home"}))
            .attr("data-tippy-placement", "right"),
    );
    // The VIEWS header is hidden by the theme (the rail carries most
    // of the views), so the section can no longer be re-expanded by
    // hand; make sure a state saved before never leaves it condensed.
    left_sidebar_navigation_area.force_expand_views();
    // The Threads row (upstream's recent conversations) gets the same
    // icon as the thread pill and the thread button, and leads to the
    // fork's Threads page. The row is rendered once with the sidebar,
    // so both are swapped here.
    $(".top_left_recent_view .zulip-icon-recent")
        .removeClass("zulip-icon-recent")
        .addClass("zulip-icon-threads");
    $(".top_left_recent_view .left-sidebar-navigation-label-container").attr(
        "href",
        "#ykphone/threads",
    );
    // The header is placed inside the search block so that resize.ts,
    // which subtracts that block's height when sizing the channel
    // list, accounts for it without changes.
    $("#left-sidebar-search").prepend(
        $(render_ykphone_sidebar_header({realm_name: realm.realm_name})),
    );
    $(".left-sidebar-search-input").attr(
        "placeholder",
        $t({defaultMessage: "Find a conversation…"}),
    );
    // Slack keeps its history controls at the left of the top bar,
    // where the logo used to be, and names the workspace in the
    // search box.
    $("#top_navbar .column-left").append($(render_ykphone_navbar_history()));
    $("#search_query").attr(
        "data-placeholder-text",
        $t({defaultMessage: "Search {realm_name}"}, {realm_name: realm.realm_name}),
    );
    $(window).on("hashchange", refresh_active_item);
    refresh_active_item();
}
