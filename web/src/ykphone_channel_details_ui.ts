// The Slack-style "채널 정보" dialog for the 옆커폰 fork: one modal with
// upstream's tab switcher (정보 / 멤버 / 설정) opened from the pane
// header's title, its member button, the sidebar channel menu and the
// "i" key. What it shows and sends lives in ykphone_channel_details;
// this module only builds the dialog and binds handlers, so it is
// exempt from node coverage.

import $ from "jquery";

import render_ykphone_channel_details from "../templates/ykphone_channel_details.hbs";
import render_ykphone_channel_details_members from "../templates/ykphone_channel_details_members.hbs";

import * as add_subscribers_pill from "./add_subscribers_pill.ts";
import * as channel from "./channel.ts";
import * as components from "./components.ts";
import * as confirm_dialog from "./confirm_dialog.ts";
import * as dialog_widget from "./dialog_widget.ts";
import {$t, $t_html} from "./i18n.ts";
import {page_params} from "./page_params.ts";
import * as peer_data from "./peer_data.ts";
import * as people from "./people.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import * as stream_data from "./stream_data.ts";
import * as stream_settings_api from "./stream_settings_api.ts";
import * as sub_store from "./sub_store.ts";
import type {StreamSubscription} from "./sub_store.ts";
import * as subscriber_api from "./subscriber_api.ts";
import type {CombinedPillContainer} from "./typeahead_helper.ts";
import * as ui_report from "./ui_report.ts";
import * as user_groups from "./user_groups.ts";
import * as ykphone_channel_details from "./ykphone_channel_details.ts";
import type {DetailsTab, NotificationChoice} from "./ykphone_channel_details.ts";
import * as ykphone_pane_header from "./ykphone_pane_header.ts";
import * as ykphone_pins from "./ykphone_pins.ts";
import * as ykphone_thread_panel from "./ykphone_thread_panel.ts";

const MODAL_ID = "ykphone-channel-details-modal";

let shown_stream_id: number | undefined;
let current_tab: DetailsTab = "info";
let toggler: components.Toggle | undefined;
let pill_widget: CombinedPillContainer | undefined;
// Channels whose subscriber list is being fetched for the 멤버 tab.
const fetching_subscribers = new Set<number>();

function $modal(): JQuery {
    return $(`#${MODAL_ID}`);
}

function $dialog_error(): JQuery {
    return $modal().find("#dialog_error");
}

function clear_error(): void {
    $dialog_error().hide().empty();
}

// Who may see the dialog at all: the member list and the settings are a
// logged-in user's, and a spectator's subscriber fetch would never
// answer.
function can_open(sub: StreamSubscription): boolean {
    return !page_params.is_spectator && stream_data.can_view_subscribers(sub);
}

// The dialog may be closed (Escape, a hash change) while a request is
// in flight; its callbacks then have nothing to draw on.
function open_sub(): StreamSubscription | undefined {
    if (shown_stream_id === undefined || $modal().length === 0) {
        return undefined;
    }
    return sub_store.get(shown_stream_id);
}

function search_query(): string {
    return $modal().find<HTMLInputElement>(".ykphone-channel-details-member-search").val() ?? "";
}

function sidebar_toggle_label(): string {
    return ykphone_pane_header.member_list_shown()
        ? $t({defaultMessage: "Hide member list in the sidebar"})
        : $t({defaultMessage: "Show member list in the sidebar"});
}

// Something the user is in the middle of typing: the description
// editor, the "사람 추가" form, or any field of the dialog that holds
// the keyboard. A redraw would throw it away, so events wait.
function editing_in_progress(): boolean {
    const $container = $modal();
    if ($container.length === 0) {
        return false;
    }
    const open_form = [
        ...$container.find(
            ".ykphone-channel-details-description-form, .ykphone-channel-details-add-form",
        ),
    ].some((element) => !(element instanceof HTMLElement && element.hidden));
    if (open_form) {
        return true;
    }
    const focused = document.activeElement;
    return (
        focused instanceof HTMLElement &&
        $container[0]?.contains(focused) === true &&
        focused.matches(
            "input:not([type='radio']):not([type='checkbox']), textarea, [contenteditable='true']",
        )
    );
}

function render_members(sub: StreamSubscription): void {
    const $list = $modal().find(".ykphone-channel-details-member-list");
    $list.html(
        render_ykphone_channel_details_members(
            ykphone_channel_details.members_context(sub, search_query()),
        ),
    );
}

// The dialog's three panes, drawn into the wrapper the modal was
// launched with, so that a change to the channel can draw them again
// without touching the modal around them. The pill widget belongs to
// the container this replaces, so it is built again when the form is
// next opened.
function render_panes(sub: StreamSubscription): void {
    pill_widget = undefined;
    $modal()
        .find(".ykphone-channel-details")
        .html(render_ykphone_channel_details(dialog_context(sub)));
    rendered_markdown.update_elements($modal().find(".ykphone-channel-details-description"));
}

function dialog_context(sub: StreamSubscription): Record<string, unknown> {
    const info = ykphone_channel_details.info_context(sub);
    return {
        info,
        created_by_line: ykphone_channel_details.created_by_line(info),
        members: ykphone_channel_details.members_context(sub, ""),
        settings: ykphone_channel_details.settings_context(sub),
        sidebar_toggle_label: sidebar_toggle_label(),
    };
}

// The subscriber list is fetched only where it is needed; the dialog
// shows a loading line until it lands.
function maybe_fetch_subscribers(stream_id: number): void {
    if (peer_data.has_full_subscriber_data(stream_id) || fetching_subscribers.has(stream_id)) {
        return;
    }
    fetching_subscribers.add(stream_id);
    void (async () => {
        try {
            await peer_data.get_subscribers_with_possible_fetch(stream_id);
        } catch {
            // A failed fetch is forgotten, so re-opening the dialog
            // tries again.
        }
        fetching_subscribers.delete(stream_id);
        const sub = open_sub();
        if (sub?.stream_id === stream_id) {
            render_members(sub);
        }
    })();
}

// The switcher answers with the key it was given; this keeps the
// dialog's own type without an assertion.
function tab_from_key(key: string): DetailsTab {
    switch (key) {
        case "members":
            return "members";
        case "settings":
            return "settings";
        default:
            return "info";
    }
}

// focus: false while a redraw restores the tab the user is on, so that
// the redraw does not take the keyboard away from them.
function show_tab(tab: DetailsTab, {focus = true} = {}): void {
    const $container = $modal();
    for (const pane of $container.find(".ykphone-channel-details-pane")) {
        $(pane).prop("hidden", $(pane).attr("data-details-tab") !== tab);
    }
    if (tab === "members" && focus) {
        $container.find(".ykphone-channel-details-member-search").trigger("focus");
    }
}

function build_tabs(sub: StreamSubscription): void {
    // Building the switcher selects its first tab, which runs the
    // callback below; the tab the dialog was opened for is put back
    // after that.
    const requested_tab = current_tab;
    toggler = components.toggle({
        html_class: "ykphone-channel-details-tabs large allow-overflow",
        selected: 0,
        child_wants_focus: true,
        values: [
            {label: $t({defaultMessage: "About"}), key: "info"},
            {label: $t({defaultMessage: "Members"}), key: "members"},
            {label: $t({defaultMessage: "Settings"}), key: "settings"},
        ],
        callback(_label, key) {
            // The tab the user is on, which a redraw restores. A
            // message about the tab they are leaving goes with it.
            clear_error();
            current_tab = tab_from_key(key);
            show_tab(current_tab);
        },
    });
    $modal().closest(".micromodal").find(".modal__tab-switcher-container").append(toggler.get());
    current_tab = requested_tab;
    sync_settings_tab(sub);
    if (current_tab !== "info") {
        toggler.goto(current_tab);
    }
}

// The 설정 tab is empty for somebody who is neither subscribed nor
// allowed to rename; a disabled tab cannot be selected, so the dialog
// falls back to 정보 rather than showing an empty pane under a
// highlighted 정보.
function sync_settings_tab(sub: StreamSubscription): void {
    if (toggler === undefined) {
        return;
    }
    if (ykphone_channel_details.has_settings(sub)) {
        toggler.enable_tab("settings");
        return;
    }
    toggler.disable_tab("settings");
    if (current_tab === "settings") {
        current_tab = "info";
        toggler.goto("info");
    }
}

function report_error(message: string, xhr: JQuery.jqXHR<unknown>): void {
    if ($modal().length === 0) {
        return;
    }
    ui_report.error(message, xhr, $dialog_error());
}

// ---- 정보 tab ----

function close_description_form(): void {
    const $container = $modal();
    $container.find(".ykphone-channel-details-description-form").prop("hidden", true);
    $container.find(".ykphone-channel-details-description").prop("hidden", false);
    $container.find(".ykphone-channel-details-description-edit").prop("hidden", false);
}

function save_description(sub: StreamSubscription): void {
    const $container = $modal();
    const description =
        $container.find<HTMLTextAreaElement>(".ykphone-channel-details-description-input").val() ??
        "";
    void channel.patch({
        url: `/json/streams/${sub.stream_id}`,
        data: ykphone_channel_details.description_request_data(description),
        success() {
            clear_error();
            // The stream update event redraws the pane (see
            // on_stream_changed); this only puts the form away.
            close_description_form();
            const current = open_sub();
            if (current !== undefined) {
                refresh(current);
            }
        },
        error(xhr) {
            report_error($t_html({defaultMessage: "Could not save the description."}), xhr);
        },
    });
}

function leave_channel(sub: StreamSubscription): void {
    confirm_dialog.launch({
        modal_title_text: $t({defaultMessage: "Leave #{name}?"}, {name: sub.name}),
        modal_content_html: sub.invite_only
            ? ykphone_channel_details.private_leave_confirm_html(sub)
            : ykphone_channel_details.leave_confirm_html(sub),
        id: "ykphone-channel-leave-modal",
        on_click() {
            subscriber_api.remove_user_id_from_stream(
                people.my_current_user_id(),
                sub,
                () => {
                    dialog_widget.close();
                },
                (xhr) => {
                    ui_report.error(
                        $t_html({defaultMessage: "Could not leave the channel."}),
                        xhr,
                        $("#dialog_error"),
                    );
                    dialog_widget.hide_dialog_spinner();
                },
            );
        },
        loading_spinner: true,
    });
}

function archive_channel(sub: StreamSubscription): void {
    confirm_dialog.launch({
        modal_title_text: $t({defaultMessage: "Archive #{name}?"}, {name: sub.name}),
        modal_content_html: $t_html({
            defaultMessage:
                "Archiving a channel hides it from everyone. Its messages are kept, and an administrator can bring it back.",
        }),
        id: "ykphone-channel-archive-modal",
        on_click() {
            // Upstream's own archive lives in the channel-manager
            // overlay (stream_edit.archive_stream), which this dialog
            // replaces; the request is the same one.
            void channel.del({
                url: `/json/streams/${sub.stream_id}`,
                success() {
                    dialog_widget.close();
                },
                error(xhr) {
                    ui_report.error(
                        $t_html({defaultMessage: "Could not archive the channel."}),
                        xhr,
                        $("#dialog_error"),
                    );
                    dialog_widget.hide_dialog_spinner();
                },
            });
        },
        loading_spinner: true,
    });
}

// ---- 멤버 tab ----

function open_add_form(): void {
    const sub = open_sub();
    if (sub === undefined) {
        return;
    }
    const $container = $modal();
    $container.find(".ykphone-channel-details-add-form").prop("hidden", false);
    $container.find(".ykphone-channel-details-add-open").prop("hidden", true);
    const $pill_container = $container.find(".ykphone-channel-details-pill .pill-container");
    // Built for the container that is on screen now: a redraw of the
    // panes replaces it, and a widget bound to the old one would be
    // inert (no typeahead, no pills).
    pill_widget = add_subscribers_pill.create({
        $pill_container,
        get_potential_subscribers() {
            const current = open_sub();
            return current === undefined ? [] : ykphone_channel_details.potential_members(current);
        },
        get_user_groups: () => user_groups.get_all_realm_user_groups(),
        with_add_button: false,
    });
    $pill_container.find(".input").trigger("focus");
}

function close_add_form(): void {
    const $container = $modal();
    $container.find(".ykphone-channel-details-add-form").prop("hidden", true);
    $container.find(".ykphone-channel-details-add-open").prop("hidden", false);
    pill_widget = undefined;
}

async function add_members(): Promise<void> {
    const sub = open_sub();
    if (sub === undefined || pill_widget === undefined) {
        return;
    }
    const widget = pill_widget;
    if (widget.is_pending()) {
        // Text typed but not yet a pill: turn it into one (or show the
        // invalid outline) and let the user press 추가 again.
        widget.appendValue(widget.getCurrentText()!);
        return;
    }
    // Read at submit time: a group or #channel pill resolves its
    // members asynchronously.
    const user_ids = await add_subscribers_pill.get_pill_user_ids(widget);
    if (open_sub() === undefined || pill_widget !== widget) {
        return;
    }
    if (user_ids.length === 0) {
        close_add_form();
        return;
    }
    subscriber_api.add_user_ids_to_stream(
        user_ids,
        sub,
        true,
        () => {
            if (open_sub() === undefined) {
                return;
            }
            clear_error();
            close_add_form();
        },
        (xhr) => {
            report_error($t_html({defaultMessage: "Could not add people."}), xhr);
        },
    );
}

function send_remove_member(sub: StreamSubscription, user_id: number): void {
    subscriber_api.remove_user_id_from_stream(
        user_id,
        sub,
        () => {
            clear_error();
        },
        (xhr) => {
            report_error($t_html({defaultMessage: "Could not remove this person."}), xhr);
        },
    );
}

// Removing yourself is leaving, and asks what the 정보 tab's button
// asks. Removing somebody from a private channel costs them the
// history, so that asks too; removing somebody from a public channel
// is immediate, as it is in Zulip's own subscriber list.
function remove_member(sub: StreamSubscription, user_id: number): void {
    if (people.is_my_user_id(user_id)) {
        leave_channel(sub);
        return;
    }
    if (!sub.invite_only) {
        send_remove_member(sub, user_id);
        return;
    }
    const full_name = people.maybe_get_user_by_id(user_id, true)?.full_name ?? "";
    confirm_dialog.launch({
        modal_title_text: $t(
            {defaultMessage: "Remove {name} from #{channel}?"},
            {name: full_name, channel: sub.name},
        ),
        modal_content_html: $t_html(
            {
                defaultMessage:
                    "#{channel} is private: they will need an invitation to come back, and they lose its history.",
            },
            {channel: sub.name},
        ),
        id: "ykphone-channel-remove-member-modal",
        on_click() {
            subscriber_api.remove_user_id_from_stream(
                user_id,
                sub,
                () => {
                    dialog_widget.close();
                },
                (xhr) => {
                    ui_report.error(
                        $t_html({defaultMessage: "Could not remove this person."}),
                        xhr,
                        $("#dialog_error"),
                    );
                    dialog_widget.hide_dialog_spinner();
                },
            );
        },
        loading_spinner: true,
    });
}

// ---- 설정 tab ----

function update_name_button(sub: StreamSubscription): void {
    const $container = $modal();
    const $input = $container.find<HTMLInputElement>(".ykphone-channel-details-name-input");
    if ($input.length === 0) {
        return;
    }
    const name = $input.val() ?? "";
    $container
        .find(".ykphone-channel-details-name-save")
        .prop("disabled", name.trim() === sub.name || name.trim() === "");
}

function save_name(sub: StreamSubscription): void {
    const $container = $modal();
    const name =
        $container.find<HTMLInputElement>(".ykphone-channel-details-name-input").val() ?? "";
    const error = ykphone_channel_details.name_error(name, sub);
    $container.find(".ykphone-channel-details-name-error").text(error ?? "");
    if (error !== undefined || name.trim() === sub.name) {
        return;
    }
    void channel.patch({
        url: `/json/streams/${sub.stream_id}`,
        data: ykphone_channel_details.rename_request_data(name),
        success() {
            clear_error();
        },
        error(xhr) {
            report_error($t_html({defaultMessage: "Could not rename the channel."}), xhr);
        },
    });
}

function notification_choice_from_value(value: string): NotificationChoice | undefined {
    switch (value) {
        case "all":
        case "mentions":
        case "none":
            return value;
        default:
            return undefined;
    }
}

// A refused change must not leave the control showing something the
// server does not have: the pane is drawn again from the subscription,
// which puts the radio or the checkbox back.
function revert_settings(): void {
    const current = open_sub();
    if (current !== undefined) {
        refresh(current);
    }
}

function set_notification_choice(sub: StreamSubscription, choice: NotificationChoice): void {
    stream_settings_api.bulk_set_stream_property(
        ykphone_channel_details.notification_sub_data(sub.stream_id, choice),
        // The modal's own report area, which the redraw below does not
        // touch (the panes do).
        $dialog_error(),
        {
            failure_msg_html: $t_html({defaultMessage: "Could not save the notification setting."}),
            error_continuation: revert_settings,
        },
    );
}

function set_muted(sub: StreamSubscription, value: boolean): void {
    stream_settings_api.set_stream_property(
        sub,
        {property: "is_muted", value},
        // The modal's own report area, which the redraw below does not
        // touch (the panes do).
        $dialog_error(),
        {
            failure_msg_html: $t_html({defaultMessage: "Could not save the notification setting."}),
            error_continuation: revert_settings,
        },
    );
}

// ---- The dialog ----

// A change to the channel: the panes are drawn again from the
// subscription, keeping the tab the user is on, the member search and
// the scroll. While the user is typing in the dialog only the member
// list is refreshed, so nothing they are working on is thrown away.
function refresh(sub: StreamSubscription): void {
    const $container = $modal();
    $container.closest(".micromodal").find(".dialog_heading").text(`#${sub.name}`);
    sync_settings_tab(sub);
    if (editing_in_progress()) {
        render_members(sub);
        return;
    }
    const query = search_query();
    const $scroller = $container.find(".simplebar-content-wrapper");
    const scroll_top = $scroller.length > 0 ? ($scroller.scrollTop() ?? 0) : 0;
    render_panes(sub);
    $container.find(".ykphone-channel-details-member-search").val(query);
    render_members(sub);
    show_tab(current_tab, {focus: false});
    if ($scroller.length > 0) {
        $scroller.scrollTop(scroll_top);
    }
}

function post_render(): void {
    const sub = open_sub();
    if (sub === undefined) {
        return;
    }
    const $container = $modal();
    render_panes(sub);
    build_tabs(sub);
    show_tab(current_tab);
    maybe_fetch_subscribers(sub.stream_id);

    $container.on("click", ".ykphone-channel-details-description-edit", () => {
        $container.find(".ykphone-channel-details-description").prop("hidden", true);
        $container.find(".ykphone-channel-details-description-edit").prop("hidden", true);
        $container.find(".ykphone-channel-details-description-form").prop("hidden", false);
        $container.find(".ykphone-channel-details-description-input").trigger("focus");
    });
    $container.on("click", ".ykphone-channel-details-description-cancel", () => {
        const current = open_sub();
        if (current !== undefined) {
            $container.find(".ykphone-channel-details-description-input").val(current.description);
        }
        close_description_form();
    });
    $container.on("click", ".ykphone-channel-details-description-save", () => {
        const current = open_sub();
        if (current !== undefined) {
            save_description(current);
        }
    });
    $container.on("click", ".ykphone-channel-details-member-link", () => {
        toggler?.goto("members");
    });
    $container.on("click", ".ykphone-channel-details-leave", () => {
        const current = open_sub();
        if (current !== undefined) {
            leave_channel(current);
        }
    });
    $container.on("click", ".ykphone-channel-details-archive", () => {
        const current = open_sub();
        if (current !== undefined) {
            archive_channel(current);
        }
    });

    $container.on("input", ".ykphone-channel-details-member-search", () => {
        const current = open_sub();
        if (current !== undefined) {
            render_members(current);
        }
    });
    $container.on("click", ".ykphone-channel-details-add-open", () => {
        open_add_form();
    });
    $container.on("click", ".ykphone-channel-details-add-cancel", () => {
        close_add_form();
    });
    $container.on("click", ".ykphone-channel-details-add-save", () => {
        void add_members();
    });
    $container.on("click", ".ykphone-channel-details-member-remove", function (this: HTMLElement) {
        const current = open_sub();
        const user_id = Number(
            $(this).closest(".ykphone-channel-details-member").attr("data-user-id"),
        );
        if (current !== undefined) {
            remove_member(current, user_id);
        }
    });
    $container.on("click", ".ykphone-channel-details-sidebar-toggle", function (this: HTMLElement) {
        // A side panel holds that column, and the toggle would flip the
        // stored setting with nothing visible changing.
        ykphone_thread_panel.close();
        ykphone_pins.close_panel();
        $("#userlist-toggle-button").trigger("click");
        $(this).text(sidebar_toggle_label());
    });

    $container.on("input", ".ykphone-channel-details-name-input", () => {
        const current = open_sub();
        if (current !== undefined) {
            update_name_button(current);
        }
    });
    $container.on("click", ".ykphone-channel-details-name-save", () => {
        const current = open_sub();
        if (current !== undefined) {
            save_name(current);
        }
    });
    $container.on("change", "input[name='ykphone-channel-notifications']", (e) => {
        const current = open_sub();
        const choice = notification_choice_from_value($(e.currentTarget).attr("value") ?? "");
        if (current !== undefined && choice !== undefined) {
            set_notification_choice(current, choice);
        }
    });
    $container.on("change", ".ykphone-channel-details-mute", (e) => {
        const current = open_sub();
        if (current !== undefined) {
            set_muted(current, $(e.currentTarget).prop("checked") === true);
        }
    });
}

export function open(stream_id: number, tab: DetailsTab = "info"): void {
    const sub = sub_store.get(stream_id);
    if (sub === undefined || !can_open(sub)) {
        return;
    }
    shown_stream_id = stream_id;
    current_tab = tab === "settings" && !ykphone_channel_details.has_settings(sub) ? "info" : tab;
    toggler = undefined;
    pill_widget = undefined;
    dialog_widget.launch({
        modal_title_text: `#${sub.name}`,
        // Filled in by post_render, which can draw the panes again
        // when the channel changes under the open dialog.
        modal_content_html: '<div class="ykphone-channel-details"></div>',
        has_tab_switcher: true,
        hide_footer: true,
        id: MODAL_ID,
        post_render,
        on_hidden() {
            // A dialog opened in the meantime owns the state now.
            if (shown_stream_id === stream_id) {
                shown_stream_id = undefined;
                toggler = undefined;
                pill_widget = undefined;
            }
        },
    });
}

// The sidebar's and the pane header's channel menu: the item carries
// the tab it wants.
export function open_from_menu(element: HTMLElement, stream_id: number): void {
    open(stream_id, tab_from_key($(element).attr("data-details-tab") ?? "info"));
}

// The channel changed (a rename, a new description, a mute, somebody
// added or removed, or the user losing access to it).
function on_stream_changed(stream_id: number): void {
    if (shown_stream_id !== stream_id || $modal().length === 0) {
        return;
    }
    const sub = sub_store.get(stream_id);
    if (sub === undefined || !can_open(sub)) {
        // Removed from a private channel, or the channel is gone: the
        // dialog would show a state that no longer exists and every
        // button in it would fail.
        dialog_widget.close();
        return;
    }
    refresh(sub);
}

export function initialize(): void {
    ykphone_channel_details.on_stream_changed(on_stream_changed);
}
