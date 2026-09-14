// Fan-out for the hooks upstream code calls once per event, so that
// files like message_view.ts carry a single line per hook however
// many of our modules need it.

import * as ykphone_rail from "./ykphone_rail.ts";
import * as ykphone_thread_panel from "./ykphone_thread_panel.ts";

export function handle_narrow_activated(): void {
    ykphone_thread_panel.handle_narrow_activated();
    ykphone_rail.handle_narrow_activated();
}
