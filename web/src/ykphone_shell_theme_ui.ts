import $ from "jquery";

import * as channel from "./channel.ts";
import * as settings_ui from "./settings_ui.ts";
import * as ykphone_shell_theme from "./ykphone_shell_theme.ts";

// The theme picker in Settings → Preferences
// (ykphone_theme_picker.hbs): a click shows the theme at once and saves
// it, as the light/dark control above it does; the server tells the
// user's other tabs, which switch through ykphone_shell_theme.handle_event.
export function initialize(): void {
    $("body").on("change", "input.ykphone-theme-swatch-input", function (this: HTMLElement) {
        const $input = $(this);
        const new_theme = String($input.val());
        const previous_theme = ykphone_shell_theme.current_shell_theme();
        if (new_theme === previous_theme || !ykphone_shell_theme.is_shell_theme(new_theme)) {
            return;
        }

        ykphone_shell_theme.apply_shell_theme(new_theme);
        const $status_element = $input.closest(".subsection-parent").find(".alert-notification");
        settings_ui.do_settings_change(
            channel.patch,
            "/json/ykphone/preferences",
            {shell_theme: new_theme},
            $status_element,
            {
                error_continuation() {
                    // Back to the saved theme, unless the user has moved
                    // on to another one in the meantime.
                    if (ykphone_shell_theme.current_shell_theme() === new_theme) {
                        ykphone_shell_theme.apply_shell_theme(previous_theme);
                    }
                },
            },
        );
    });
}
