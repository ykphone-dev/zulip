// DOM wiring for the Slack-style "Create a channel" flow (the 옆커폰
// fork): the small menu behind the sidebar's "+" buttons, the two-step
// dialog and its pill widget. What the dialog decides and sends lives
// in ykphone_channel_create; this module only binds handlers, so it
// is exempt from node coverage.

import $ from "jquery";

import render_ykphone_channel_create_modal from "../templates/ykphone_channel_create_modal.hbs";
import render_ykphone_channel_menu from "../templates/ykphone_channel_menu.hbs";

import * as add_subscribers_pill from "./add_subscribers_pill.ts";
import * as browser_history from "./browser_history.ts";
import * as channel from "./channel.ts";
import * as dialog_widget from "./dialog_widget.ts";
import * as hash_util from "./hash_util.ts";
import {$t, $t_html} from "./i18n.ts";
import * as keydown_util from "./keydown_util.ts";
import * as people from "./people.ts";
import * as popover_menus from "./popover_menus.ts";
import * as stream_data from "./stream_data.ts";
import type {StreamSubscription} from "./sub_store.ts";
import type {CombinedPillContainer} from "./typeahead_helper.ts";
import * as ui_report from "./ui_report.ts";
import * as ui_util from "./ui_util.ts";
import * as user_groups from "./user_groups.ts";
import * as util from "./util.ts";
import * as ykphone_channel_create from "./ykphone_channel_create.ts";
import type {NameCheck} from "./ykphone_channel_create.ts";

const MODAL_ID = "ykphone-channel-create-modal";
const SUBSCRIPTIONS_URL = "/json/users/me/subscriptions";
// A folder's "+" links to upstream's creation form for that folder;
// the folder id is read off that link.
const FOLDER_NEW_URL = /#channels\/folders\/(\d+)\/new$/;

let step: 1 | 2 = 1;
let pill_widget: CombinedPillContainer | undefined;
let created_name = "";
let created_invite_only = false;

function $modal(): JQuery {
    return $(`#${MODAL_ID}`);
}

// The requests outlive a modal closed with Escape while they were in
// flight; their callbacks then have nothing to draw on.
function modal_open(): boolean {
    return $modal().length > 0;
}

function folder_id_from_link(elt: HTMLElement): number | undefined {
    const match = FOLDER_NEW_URL.exec($(elt).attr("href") ?? "");
    if (match === null) {
        return undefined;
    }
    return Number.parseInt(match[1]!, 10);
}

function open_menu({
    reference,
    $link,
    folder_id,
}: {
    // The element the menu is anchored to. A section's "+" hosts a
    // tooltip, and an element with a tooltip cannot host a popover too
    // (see toggle_popover_menu), so the menu hangs off its inner icon.
    reference: HTMLElement;
    // The link that was clicked: it keeps its icon visible while the
    // menu is open and gets the focus back when the menu closes.
    $link: JQuery;
    folder_id: number | undefined;
}): void {
    popover_menus.toggle_popover_menu(
        reference,
        {
            // Separates `hideOnClick` from `onShow` so that a click on
            // the button while the menu is open closes it (see
            // stream_popover).
            delay: [100, 0],
            ...popover_menus.left_sidebar_tippy_options,
            placement: "bottom-start",
            onCreate(instance) {
                instance.setContent(ui_util.parse_html(render_ykphone_channel_menu()));
            },
            onMount(instance) {
                popover_menus.focus_popover(instance);
                popover_menus.popover_instances.stream_settings = instance;
                $link.addClass("ykphone-channel-menu-open");
                $(instance.popper).on("click", ".ykphone-channel-menu-create", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    popover_menus.hide_current_popover_if_visible(instance);
                    open_create_modal(folder_id);
                });
            },
            onShow(instance) {
                popover_menus.on_show_prep(instance);
            },
            onHidden(instance) {
                $link.removeClass("ykphone-channel-menu-open");
                instance.destroy();
                popover_menus.popover_instances.stream_settings = null;
            },
        },
        {get_focus_return_element: () => util.the($link)},
    );
}

function show_name_check(check: NameCheck): void {
    const $container = $modal();
    // Rendered from a Handlebars template (render_channel_name_conflict_error).
    const rendered_error = check.error_html ?? "";
    $container.find(".ykphone-channel-name-error").html(rendered_error);
    $container
        .find(".ykphone-channel-open-existing")
        .prop("hidden", check.existing_stream_id === undefined)
        .attr("data-stream-id", check.existing_stream_id ?? "");
    $container.find(".dialog_submit_button").prop("disabled", !check.valid);
}

function update_name_state(): void {
    const $name = $modal().find<HTMLInputElement>("#ykphone-channel-name");
    show_name_check(ykphone_channel_create.check_name($name.val() ?? ""));
}

function post_render(): void {
    const $container = $modal();
    const $name = $container.find("#ykphone-channel-name");
    $name.on("input", update_name_state);
    update_name_state();
    $name.trigger("focus");

    // The way to a channel that already has the name: the modal is
    // closed first, since a hash change closes it anyway.
    $container.on("click", ".ykphone-channel-open-existing", function (this: HTMLElement) {
        const stream_id = Number.parseInt($(this).attr("data-stream-id")!, 10);
        dialog_widget.close(() => {
            browser_history.go_to_location(hash_util.channel_url_by_user_setting(stream_id));
        });
    });
}

function show_step_1(): void {
    step = 1;
    const $container = $modal();
    $container.find(".ykphone-channel-step-2").prop("hidden", true);
    $container.find(".ykphone-channel-step-1").prop("hidden", false);
    $container.find(".dialog_heading").text($t({defaultMessage: "Create a channel"}));
    $container
        .find(".dialog_submit_button .submit-button-text")
        .text($t({defaultMessage: "Create"}));
    $container
        .find(".dialog_exit_button")
        .text($t({defaultMessage: "Cancel"}))
        .removeClass("ykphone-channel-skip");
    $container.find(".ykphone-channel-add-everyone").prop("hidden", true);
    $container.find("#ykphone-channel-name").trigger("focus");
}

function show_step_2(): void {
    step = 2;
    const $container = $modal();
    $container.find(".ykphone-channel-step-1").prop("hidden", true);
    $container.find(".ykphone-channel-step-2").prop("hidden", false);
    $container.find(".dialog_heading").text(ykphone_channel_create.add_people_title(created_name));
    $container.find(".dialog_submit_button .submit-button-text").text($t({defaultMessage: "Done"}));
    $container
        .find(".dialog_exit_button")
        .text($t({defaultMessage: "Skip"}))
        .addClass("ykphone-channel-skip");

    if (ykphone_channel_create.can_add_everyone(created_invite_only)) {
        const count = ykphone_channel_create.everyone_count();
        $container.find(".ykphone-channel-add-everyone-label").text(
            $t(
                {
                    defaultMessage:
                        "Add everyone ({count, plural, one {# person} other {# people}})",
                },
                {count},
            ),
        );
        $container.find(".ykphone-channel-add-everyone").prop("hidden", false);
    }

    const $pill_container = $container.find(".ykphone-channel-people .pill-container");
    // Built once per dialog: a conflict may send the user back to
    // step 1 and a second creation forward again.
    pill_widget ??= add_subscribers_pill.create({
        $pill_container,
        get_potential_subscribers: () =>
            people.get_realm_users().filter((user) => !people.is_my_user_id(user.user_id)),
        get_user_groups: () => user_groups.get_all_realm_user_groups(),
        with_add_button: false,
    });
    $pill_container.find(".input").trigger("focus");
}

// The request created nothing: a channel of that name already existed
// (the client had not heard of it), and if the request subscribed the
// user to it, they are unsubscribed again. The dialog goes back to
// the name.
function on_conflict(sub: StreamSubscription | undefined, joined: boolean): void {
    if (joined && sub !== undefined) {
        void channel.del({
            url: SUBSCRIPTIONS_URL,
            data: ykphone_channel_create.leave_request_data(sub.name),
        });
    }
    if (!modal_open()) {
        return;
    }
    dialog_widget.hide_dialog_spinner();
    if (step === 2) {
        show_step_1();
    }
    show_name_check(ykphone_channel_create.conflict(sub));
}

function post_create(
    name: string,
    invite_only: boolean,
    description: string,
    folder_id: number | undefined,
): void {
    ykphone_channel_create.begin_creation(name, (sub) => {
        on_conflict(sub, true);
    });
    void channel.post({
        url: SUBSCRIPTIONS_URL,
        data: ykphone_channel_create.create_request_data({
            name,
            description,
            invite_only,
            folder_id,
        }),
        success(data) {
            if (ykphone_channel_create.response_conflict(data, name) !== undefined) {
                ykphone_channel_create.abandon_creation();
                on_conflict(stream_data.get_sub(name), false);
                return;
            }
            created_name = name;
            created_invite_only = invite_only;
            // The subscription event may have landed first and found
            // the channel to be somebody else's; the dialog already
            // shows that.
            if (!modal_open() || !ykphone_channel_create.is_creating(name)) {
                return;
            }
            dialog_widget.hide_dialog_spinner();
            show_step_2();
        },
        error(xhr) {
            ykphone_channel_create.abandon_creation();
            if (!modal_open()) {
                return;
            }
            dialog_widget.hide_dialog_spinner();
            ui_report.error(
                $t_html({defaultMessage: "Could not create the channel."}),
                xhr,
                $modal().find("#dialog_error"),
            );
        },
    });
}

function create_channel(): void {
    const $container = $modal();
    const name = ($container.find<HTMLInputElement>("#ykphone-channel-name").val() ?? "").trim();
    const description = (
        $container.find<HTMLInputElement>("#ykphone-channel-description").val() ?? ""
    ).trim();
    const invite_only =
        $container.find("input[name='ykphone-channel-privacy']:checked").val() === "private";
    const folder_value = $container.find<HTMLSelectElement>("#ykphone-channel-folder").val();
    const folder_id =
        typeof folder_value === "string" && folder_value !== ""
            ? Number.parseInt(folder_value, 10)
            : undefined;

    const check = ykphone_channel_create.check_name(name);
    if (!check.valid) {
        dialog_widget.hide_dialog_spinner();
        show_name_check(check);
        return;
    }

    // The client learns of other people's new channels through
    // events; asking the server just before creating closes most of
    // the gap, and the response and the event close the rest.
    void channel.get({
        url: "/json/streams",
        success(data) {
            if (!modal_open()) {
                return;
            }
            if (ykphone_channel_create.name_taken_on_server(name, data)) {
                dialog_widget.hide_dialog_spinner();
                show_name_check(ykphone_channel_create.conflict(stream_data.get_sub(name)));
                return;
            }
            post_create(name, invite_only, description, folder_id);
        },
        error(xhr) {
            if (!modal_open()) {
                return;
            }
            dialog_widget.hide_dialog_spinner();
            ui_report.error(
                $t_html({defaultMessage: "Could not create the channel."}),
                xhr,
                $modal().find("#dialog_error"),
            );
        },
    });
}

async function add_people(): Promise<void> {
    if (pill_widget?.is_pending()) {
        // Text typed but not yet a pill: turn it into one, or show
        // the invalid outline, and let the user press Done again.
        pill_widget.appendValue(pill_widget.getCurrentText()!);
        dialog_widget.hide_dialog_spinner();
        return;
    }
    // Read at submit time: a group or #channel pill resolves its
    // members asynchronously, so a snapshot taken when the pill was
    // made could still be empty.
    const pill_user_ids =
        pill_widget === undefined ? [] : await add_subscribers_pill.get_pill_user_ids(pill_widget);
    if (!modal_open()) {
        return;
    }
    const add_everyone = $modal().find("#ykphone-channel-add-everyone").prop("checked") === true;
    const principals = ykphone_channel_create.principals_to_add({add_everyone, pill_user_ids});
    if (principals.length === 0) {
        dialog_widget.close();
        return;
    }
    void channel.post({
        url: SUBSCRIPTIONS_URL,
        data: ykphone_channel_create.add_request_data(created_name, principals),
        success() {
            if (modal_open()) {
                dialog_widget.close();
            }
        },
        error(xhr) {
            if (!modal_open()) {
                return;
            }
            dialog_widget.hide_dialog_spinner();
            ui_report.error(
                $t_html({defaultMessage: "Could not add people."}),
                xhr,
                $modal().find("#dialog_error"),
            );
        },
    });
}

export function open_create_modal(folder_id: number | undefined): void {
    step = 1;
    pill_widget = undefined;
    dialog_widget.launch({
        modal_title_text: $t({defaultMessage: "Create a channel"}),
        modal_content_html: render_ykphone_channel_create_modal(
            ykphone_channel_create.form_context(folder_id),
        ),
        modal_submit_button_text: $t({defaultMessage: "Create"}),
        id: MODAL_ID,
        form_id: "ykphone-channel-create-form",
        loading_spinner: true,
        on_click() {
            if (step === 1) {
                create_channel();
            } else {
                void add_people();
            }
        },
        post_render,
        on_hidden() {
            ykphone_channel_create.on_modal_closed();
        },
    });
}

export function initialize(): void {
    // The "Add channels" row at the end of the channel list. Without
    // permission to create, the link keeps taking the user to the
    // channel browser.
    $("#subscribe-to-more-streams").on(
        "click",
        ".ykphone-add-channels",
        function (this: HTMLElement, e) {
            if (!ykphone_channel_create.can_create()) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            open_menu({reference: this, $link: $(this), folder_id: undefined});
        },
    );

    // A section's "+". Upstream's own handler on this element stops
    // the click from toggling the section and lets the link's href
    // open its creation form; both handlers run, and this one keeps
    // the link from being followed. Upstream renders the "+" for
    // anyone who may create some kind of channel, including web-public
    // only, so the permission is checked again here.
    $("#streams_list").on(
        "click",
        ".stream-list-section-container .add-stream-icon-container",
        function (this: HTMLElement, e) {
            if (!ykphone_channel_create.can_create()) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            open_menu({
                reference: util.the($(this).find(".add_stream_icon")),
                $link: $(this),
                folder_id: folder_id_from_link(this),
            });
        },
    );

    // The "+" beside the sidebar filter. Upstream opens its own menu
    // from a handler delegated on body; this one is bound on the
    // element itself, so it runs first and, when the user may create
    // channels, keeps upstream's from running. Otherwise upstream's
    // takes the user to the channel browser.
    const open_from_button = (button: HTMLElement, e: JQuery.TriggeredEvent): void => {
        if (!ykphone_channel_create.can_create()) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        open_menu({reference: button, $link: $(button), folder_id: undefined});
    };
    $("#add_streams_button").on("click", function (this: HTMLElement, e) {
        open_from_button(this, e);
    });
    $("#add_streams_button").on("keydown", function (this: HTMLElement, e) {
        if (keydown_util.is_enter_event(e)) {
            open_from_button(this, e);
        }
    });
}
