// Slack-style icon rail for the 옆커폰 fork.
//
// A narrow column at the left edge of the app holds the organization
// logo, the primary views (home, direct messages, activity and, for
// administrators, the admin panel), a dark-mode toggle and the
// personal menu. It is mounted inside .column-left next to the left
// sidebar, so upstream's rules for hiding that column (the navbar
// toggle on wide screens, the overlay on narrow ones) cover the rail
// too. The card header at the top of the sidebar (organization name
// and the new-message button) is rendered here as well, since it is
// part of the same layout.
//
// The DOM event wiring lives in ykphone_threads_ui.ts.

import $ from "jquery";

import render_ykphone_rail from "../templates/ykphone_rail.hbs";
import render_ykphone_sidebar_header from "../templates/ykphone_sidebar_header.hbs";

import * as browser_history from "./browser_history.ts";
import * as channel from "./channel.ts";
import * as feedback_widget from "./feedback_widget.ts";
import {$t} from "./i18n.ts";
import * as left_sidebar_navigation_area from "./left_sidebar_navigation_area.ts";
import * as settings_config from "./settings_config.ts";
import * as settings_data from "./settings_data.ts";
import {current_user, realm} from "./state_data.ts";
import {user_settings} from "./user_settings.ts";

export type RailItem = {
    id: string;
    href: string;
    icon: string;
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
            icon: "house",
            label: $t({defaultMessage: "Home"}),
            hash_prefixes: ["#inbox"],
        },
        {
            id: "dm",
            href: "#narrow/is/dm",
            icon: "message-square-text",
            label: $t({defaultMessage: "DM"}),
            hash_prefixes: ["#narrow/is/dm", "#narrow/dm/"],
        },
        {
            id: "activity",
            href: "#narrow/is/mentioned",
            icon: "at-sign",
            label: $t({defaultMessage: "Activity"}),
            hash_prefixes: ["#narrow/is/mentioned"],
        },
    ];
    if (current_user.is_admin) {
        items.push({
            id: "admin",
            href: "#organization",
            icon: "gear",
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

// The theme most recently requested from the server, until it
// answers; user_settings only learns the value from the settings
// event, so without this a second click before the event would
// re-send the same value instead of toggling back.
let requested_color_scheme: number | undefined;

// Flips between the light and dark themes; "automatic" counts as
// whichever it currently resolves to. The app applies the change when
// the resulting settings event arrives, like the personal menu's
// theme switch.
export function toggle_color_scheme(): void {
    const {light, dark} = settings_config.color_scheme_values;
    const currently_dark =
        requested_color_scheme === undefined
            ? settings_data.using_dark_theme()
            : requested_color_scheme === dark.code;
    const next_color_scheme = currently_dark ? light.code : dark.code;
    requested_color_scheme = next_color_scheme;
    void channel.patch({
        url: "/json/settings",
        data: {color_scheme: next_color_scheme},
        success() {
            if (requested_color_scheme === next_color_scheme) {
                // The event may still be in flight; the next click
                // should already build on this value.
                user_settings.color_scheme = next_color_scheme;
                requested_color_scheme = undefined;
            }
        },
        error(xhr) {
            if (requested_color_scheme === next_color_scheme) {
                requested_color_scheme = undefined;
            }
            const message = channel.xhr_error_message(
                $t({defaultMessage: "Failed to change the theme."}),
                xhr,
            );
            feedback_widget.show({
                title_text: $t({defaultMessage: "Theme"}),
                populate($container) {
                    $container.text(message);
                },
            });
        },
    });
}

export function clear_for_testing(): void {
    requested_color_scheme = undefined;
}

export function mount(): void {
    $("#left-sidebar-container").prepend(
        $(
            render_ykphone_rail({
                items: rail_items(),
                avatar_url: current_user.avatar_url_medium,
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
    $(window).on("hashchange", refresh_active_item);
    refresh_active_item();
}
