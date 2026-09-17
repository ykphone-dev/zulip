// Fan-out for the hooks upstream code calls once per event, so that
// files like message_view.ts carry a single line per hook however
// many of our modules need it.

import type {NarrowActivateOpts} from "./compose_actions.ts";
import * as ykphone_compose_narrow from "./ykphone_compose_narrow.ts";
import * as ykphone_conversation from "./ykphone_conversation.ts";
import * as ykphone_pins_ui from "./ykphone_pins_ui.ts";
import * as ykphone_rail from "./ykphone_rail.ts";
import * as ykphone_thread_panel from "./ykphone_thread_panel.ts";
import * as ykphone_unread_guard from "./ykphone_unread_guard.ts";

export function handle_narrow_activated(opts: NarrowActivateOpts): void {
    ykphone_unread_guard.clear();
    ykphone_thread_panel.handle_narrow_activated();
    ykphone_pins_ui.handle_narrow_activated();
    ykphone_rail.handle_narrow_activated();
    ykphone_conversation.handle_narrow_activated();
    ykphone_compose_narrow.handle_narrow_activated(opts);
}
